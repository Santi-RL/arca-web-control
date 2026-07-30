param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Target,
  [Parameter(Mandatory = $true, Position = 1)]
  [ValidateSet('file', 'directory', 'layout')]
  [string]$Kind
)

$ErrorActionPreference = 'Stop'
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$allow = [Security.AccessControl.AccessControlType]::Allow
$rights = [Security.AccessControl.FileSystemRights]::FullControl
$trustedOwners = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$null = $trustedOwners.Add($currentSid.Value)
$null = $trustedOwners.Add($systemSid.Value)

function Get-RegularItem {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LiteralPath,
    [Parameter(Mandatory = $true)]
    [bool]$Directory
  )

  $item = Get-Item -LiteralPath $LiteralPath -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'El recurso privado no puede ser un enlace o junction.'
  }
  if ($Directory -ne [bool]$item.PSIsContainer) {
    throw 'El recurso privado no coincide con el tipo esperado.'
  }
  return $item
}

function Set-ExclusiveAcl {
  param(
    [Parameter(Mandatory = $true)]
    [string]$LiteralPath,
    [Parameter(Mandatory = $true)]
    [bool]$Directory
  )

  $item = Get-RegularItem -LiteralPath $LiteralPath -Directory $Directory
  $resolved = $item.FullName
  $acl = Get-Acl -LiteralPath $resolved
  $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if (-not $trustedOwners.Contains($ownerSid)) { throw 'El recurso privado pertenece a una identidad no autorizada.' }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($existingRule in @($acl.Access)) {
    $null = $acl.RemoveAccessRuleSpecific($existingRule)
  }
  $inheritance = if ($Directory) {
    [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    [Security.AccessControl.InheritanceFlags]::None
  }
  $propagation = [Security.AccessControl.PropagationFlags]::None
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($currentSid, $rights, $inheritance, $propagation, $allow))
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($systemSid, $rights, $inheritance, $propagation, $allow))
  $item.SetAccessControl($acl)

  $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $null = $expected.Add($currentSid.Value)
  $null = $expected.Add($systemSid.Value)
  $verified = Get-Acl -LiteralPath $resolved
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($rule in @($verified.Access)) {
    $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if (-not $expected.Contains($sid) -or $rule.AccessControlType -ne $allow -or (($rule.FileSystemRights -band $rights) -ne $rights)) {
      throw 'La ACL privada conserva una entrada no autorizada.'
    }
    $null = $seen.Add($sid)
  }
  if ($seen.Count -ne $expected.Count) { throw 'La ACL privada no contiene todas las identidades requeridas.' }
  if ($verified.AreAccessRulesProtected -ne $true) { throw 'La ACL privada conserva herencia habilitada.' }
  $verifiedOwnerSid = $verified.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if (-not $trustedOwners.Contains($verifiedOwnerSid)) { throw 'El recurso privado pertenece a una identidad no autorizada.' }
}

function Assert-TreeHasNoReparsePoints {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Root
  )

  $pending = [Collections.Generic.Stack[string]]::new()
  $pending.Push($Root)
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    foreach ($child in @(Get-ChildItem -LiteralPath $directory -Force)) {
      if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'La estructura privada contiene un enlace o junction no permitido.'
      }
      if ($child.PSIsContainer) {
        $pending.Push($child.FullName)
      }
    }
  }
}

if ($Kind -eq 'layout') {
  $root = (Get-RegularItem -LiteralPath $Target -Directory $true).FullName
  $relativeDirectories = @('', 'profiles', 'issuers', 'sessions', 'learning', 'ledger', 'jobs', 'jobs\private', 'logs', 'downloads')
  Set-ExclusiveAcl -LiteralPath $root -Directory $true
  foreach ($relativeDirectory in $relativeDirectories) {
    $directory = if ($relativeDirectory -eq '') { $root } else { Join-Path $root $relativeDirectory }
    $null = Get-RegularItem -LiteralPath $directory -Directory $true
  }

  # Se inspecciona sin recursión automática para no seguir reparse points. Una
  # vez cerrada la raíz a usuario + SYSTEM, no hay una carrera con terceros.
  Assert-TreeHasNoReparsePoints -Root $root
  $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
  foreach ($child in @(Get-ChildItem -LiteralPath $root -Force)) {
    & $icacls $child.FullName '/reset' '/T' '/Q' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo restablecer la ACL de un recurso privado existente.' }
  }

  # Los límites fijos quedan protegidos explícitamente; sus descendientes
  # heredan exclusivamente las ACE del usuario actual y SYSTEM.
  foreach ($relativeDirectory in $relativeDirectories) {
    $directory = if ($relativeDirectory -eq '') { $root } else { Join-Path $root $relativeDirectory }
    Set-ExclusiveAcl -LiteralPath $directory -Directory $true
  }
} else {
  Set-ExclusiveAcl -LiteralPath $Target -Directory ($Kind -eq 'directory')
}

Write-Output 'PRIVATE_ACL_OK=1'
