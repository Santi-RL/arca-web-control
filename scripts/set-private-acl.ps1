param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Target,
  [Parameter(Mandatory = $true, Position = 1)]
  [ValidateSet('file', 'directory', 'layout', 'repair')]
  [string]$Kind
)

$ErrorActionPreference = 'Stop'
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$administratorsSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$currentPrincipal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
$currentIsAdministrator = $currentPrincipal.IsInRole($administratorsSid)
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
  $administratorOwnedByCurrentToken = $ownerSid -eq $administratorsSid.Value -and $currentIsAdministrator
  if (-not $trustedOwners.Contains($ownerSid) -and -not $administratorOwnedByCurrentToken) {
    throw 'El recurso privado pertenece a una identidad no autorizada.'
  }
  $expectedOwnerSid = $ownerSid
  # Windows puede asignar BUILTIN\Administrators como propietario predeterminado
  # a los objetos creados por un token administrativo. Se admite únicamente
  # cuando ese grupo está habilitado en el token actual y se normaliza de
  # inmediato al SID personal antes de modificar la DACL. No se intenta volver
  # a establecer el propietario cuando ya es el usuario, porque eso requeriría
  # WRITE_OWNER innecesariamente en un proceso sin elevación.
  if ($administratorOwnedByCurrentToken) {
    $acl.SetOwner($currentSid)
    $item.SetAccessControl($acl)
    $acl = Get-Acl -LiteralPath $resolved
    $normalizedOwnerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($normalizedOwnerSid -ne $currentSid.Value) { throw 'No se pudo normalizar el propietario del recurso privado.' }
    $expectedOwnerSid = $currentSid.Value
  }
  if (Test-ExclusiveAcl -Acl $acl -Directory $Directory -ExpectedOwnerSid $expectedOwnerSid) {
    return
  }
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

  $verified = Get-Acl -LiteralPath $resolved
  if (-not (Test-ExclusiveAcl -Acl $verified -Directory $Directory -ExpectedOwnerSid $expectedOwnerSid)) {
    throw 'La ACL privada no coincide con usuario actual y SYSTEM después de protegerla.'
  }
}

function Test-ExclusiveAcl {
  param(
    [Parameter(Mandatory = $true)]
    [Security.AccessControl.FileSystemSecurity]$Acl,
    [Parameter(Mandatory = $true)]
    [bool]$Directory,
    [Parameter(Mandatory = $true)]
    [string]$ExpectedOwnerSid
  )

  if ($Acl.AreAccessRulesProtected -ne $true) { return $false }
  if ($Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $ExpectedOwnerSid) { return $false }
  $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $null = $expected.Add($currentSid.Value)
  $null = $expected.Add($systemSid.Value)
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $ruleCount = 0
  foreach ($rule in @($Acl.Access)) {
    $ruleCount += 1
    $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($rule.IsInherited -or -not $expected.Contains($sid) -or $rule.AccessControlType -ne $allow -or (($rule.FileSystemRights -band $rights) -ne $rights)) {
      return $false
    }
    if ($Directory) {
      $requiredInheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
      if (($rule.InheritanceFlags -band $requiredInheritance) -ne $requiredInheritance) { return $false }
    } elseif ($rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::None) {
      return $false
    }
    if ($rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { return $false }
    $null = $seen.Add($sid)
  }
  return $ruleCount -eq 2 -and $seen.Count -eq $expected.Count
}

if ($Kind -eq 'file' -or $Kind -eq 'repair') {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;

public static class ManejoArcaFileLinks {
  [StructLayout(LayoutKind.Sequential)]
  private struct BY_HANDLE_FILE_INFORMATION {
    public uint FileAttributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandle(IntPtr handle, out BY_HANDLE_FILE_INFORMATION information);

  public static uint GetLinkCount(string path) {
    FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
    try {
      BY_HANDLE_FILE_INFORMATION information;
      if (!GetFileInformationByHandle(stream.SafeFileHandle.DangerousGetHandle(), out information)) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      }
      return information.NumberOfLinks;
    } finally {
      stream.Dispose();
    }
  }
}
'@
}

function Assert-TreeHasNoReparsePointsOrHardLinks {
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
      } elseif ([ManejoArcaFileLinks]::GetLinkCount($child.FullName) -ne 1) {
        throw 'La estructura privada contiene un archivo con hard links fuera de su identidad canónica.'
      }
    }
  }
}

if ($Kind -eq 'layout' -or $Kind -eq 'repair') {
  $root = (Get-RegularItem -LiteralPath $Target -Directory $true).FullName
  $relativeDirectories = @('', 'config', 'profiles', 'issuers', 'sessions', 'learning', 'ledger', 'jobs', 'jobs\private', 'private-import', 'guided', 'logs', 'downloads')
  $managedTopLevelDirectories = @('config', 'profiles', 'issuers', 'sessions', 'learning', 'ledger', 'jobs', 'private-import', 'guided', 'logs', 'downloads')
  foreach ($relativeDirectory in $relativeDirectories) {
    $directory = if ($relativeDirectory -eq '') { $root } else { Join-Path $root $relativeDirectory }
    $null = Get-RegularItem -LiteralPath $directory -Directory $true
  }

  if ($Kind -eq 'repair') {
    # La reparación profunda es mantenimiento explícito. Solo recorre los
    # subárboles administrados; una carpeta histórica o desconocida bajo la
    # raíz nunca forma parte de esta operación.
    $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
    # El preflight se completa para todos los árboles antes de modificar una
    # sola ACL. Así un hardlink no puede trasladar el cambio fuera del runtime.
    foreach ($relativeDirectory in $managedTopLevelDirectories) {
      $directory = Join-Path $root $relativeDirectory
      Assert-TreeHasNoReparsePointsOrHardLinks -Root $directory
    }
  }

  Set-ExclusiveAcl -LiteralPath $root -Directory $true

  if ($Kind -eq 'repair') {
    foreach ($relativeDirectory in $managedTopLevelDirectories) {
      $directory = Join-Path $root $relativeDirectory
      & $icacls $directory '/reset' '/T' '/Q' | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'No se pudo restablecer la ACL de un subárbol administrado.' }
    }
  }

  # La atestación operativa es constante respecto del volumen histórico: solo
  # protege los límites fijos. Los objetos nuevos heredan esas ACE.
  foreach ($relativeDirectory in $relativeDirectories | Where-Object { $_ -ne '' }) {
    $directory = if ($relativeDirectory -eq '') { $root } else { Join-Path $root $relativeDirectory }
    Set-ExclusiveAcl -LiteralPath $directory -Directory $true
  }
} else {
  if ($Kind -eq 'file' -and [ManejoArcaFileLinks]::GetLinkCount((Get-RegularItem -LiteralPath $Target -Directory $false).FullName) -ne 1) {
    throw 'El recurso privado contiene hard links fuera de su identidad canónica.'
  }
  Set-ExclusiveAcl -LiteralPath $Target -Directory ($Kind -eq 'directory')
}

Write-Output 'PRIVATE_ACL_OK=1'
