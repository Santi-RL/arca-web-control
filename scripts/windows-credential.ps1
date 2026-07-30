param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('get', 'resolve', 'set', 'set-json', 'update', 'list', 'delete', 'migrate-vault-plan', 'migrate-vault', 'import-json-plan', 'import-json')]
  [string]$Operation,
  [Parameter(Position = 1)]
  [string]$Selector
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]
$null = [Windows.Security.Credentials.PasswordCredential, Windows.Security.Credentials, ContentType = WindowsRuntime]
$vault = New-Object Windows.Security.Credentials.PasswordVault
$prefix = 'ManejoARCA/'
$canonicalPrefix = 'ManejoARCA/CUIT/'

function Normalize-Name([string]$Value) {
  $normalized = $Value.Trim().ToUpperInvariant() -replace '[^A-Z0-9]+', '_'
  return $normalized.Trim('_')
}

function Normalize-Cuit([string]$Value) {
  return ($Value -replace '\D', '')
}

function Assert-ValidCuit([string]$Value) {
  $cuit = Normalize-Cuit $Value
  if ($cuit -notmatch '^\d{11}$') { throw 'El CUIT debe contener exactamente 11 dígitos.' }
  $weights = @(5, 4, 3, 2, 7, 6, 5, 4, 3, 2)
  $sum = 0
  for ($index = 0; $index -lt 10; $index++) {
    $sum += ([int]::Parse($cuit[$index])) * $weights[$index]
  }
  $remainder = 11 - ($sum % 11)
  $verifier = if ($remainder -eq 11) { 0 } elseif ($remainder -eq 10) { 9 } else { $remainder }
  if ($verifier -ne [int]::Parse($cuit[10])) { throw 'El CUIT tiene un dígito verificador inválido.' }
  return $cuit
}

function Resource-ForCuit([string]$Cuit) {
  return "$canonicalPrefix$Cuit"
}

function Get-AllArcaItems {
  try { $all = @($vault.RetrieveAll()) } catch { $all = @() }
  return @($all | Where-Object { $_.Resource.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })
}

function Get-RecordMetadata($Item) {
  $canonical = $Item.Resource.StartsWith($canonicalPrefix, [StringComparison]::OrdinalIgnoreCase)
  if ($canonical) {
    $cuit = Normalize-Cuit $Item.Resource.Substring($canonicalPrefix.Length)
    $displayName = $Item.UserName.Trim()
  } else {
    $cuit = Normalize-Cuit $Item.UserName
    $displayName = $Item.Resource.Substring($prefix.Length).Trim()
  }
  return [pscustomobject]@{
    Item = $Item
    Cuit = $cuit
    DisplayName = $displayName
    StorageVersion = if ($canonical) { 2 } else { 1 }
  }
}

function Get-AllRecords {
  return @(Get-AllArcaItems | ForEach-Object { Get-RecordMetadata $_ })
}

function Get-RecordsByCuit([string]$Cuit) {
  return @(Get-AllRecords | Where-Object { $_.Cuit -eq $Cuit })
}

function Resolve-Identity([string]$Value) {
  if (-not $Value -or -not $Value.Trim()) { throw 'Falta indicar el CUIT o nombre del contribuyente.' }
  $digits = Normalize-Cuit $Value
  if ($Value -match '^\s*[\d\-\.\s]+\s*$') {
    $cuit = Assert-ValidCuit $digits
    $matches = @(Get-RecordsByCuit $cuit)
  } else {
    $normalizedName = Normalize-Name $Value
    $matches = @(Get-AllRecords | Where-Object { (Normalize-Name $_.DisplayName) -eq $normalizedName })
  }
  if ($matches.Count -eq 0) { throw "No existe una credencial para '$Value'." }
  $cuids = @($matches | Select-Object -ExpandProperty Cuit -Unique)
  if ($cuids.Count -gt 1) {
    $options = ($matches | ForEach-Object { "$($_.DisplayName) [$($_.Cuit)]" } | Sort-Object -Unique) -join ', '
    throw "El nombre '$Value' es ambiguo. Indicá el CUIT. Coincidencias: $options"
  }
  return [pscustomobject]@{ Cuit = $cuids[0]; Records = @($matches) }
}

function Select-ReadableRecord($Identity) {
  $canonical = @($Identity.Records | Where-Object { $_.StorageVersion -eq 2 })
  if ($canonical.Count -eq 1) { return $canonical[0] }
  if ($canonical.Count -gt 1 -or $Identity.Records.Count -gt 1) {
    throw "Hay registros duplicados para el CUIT $($Identity.Cuit). Ejecutá la migración o una actualización explícita."
  }
  return $Identity.Records[0]
}

function New-Credential([string]$Cuit, [string]$DisplayName, [string]$Secret) {
  return [Windows.Security.Credentials.PasswordCredential]::new((Resource-ForCuit $Cuit), $DisplayName, $Secret)
}

function Read-Secret {
  $secure = Read-Host 'Clave fiscal' -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Add-NewCredential([string]$DisplayName, [string]$Cuit, [string]$Secret) {
  if (-not $DisplayName -or -not $DisplayName.Trim()) { throw 'El nombre descriptivo no puede estar vacío.' }
  $existing = @(Get-RecordsByCuit $Cuit)
  if ($existing.Count -gt 0) {
    $names = ($existing | Select-Object -ExpandProperty DisplayName -Unique) -join ', '
    throw "El CUIT $Cuit ya está registrado como '$names'. No se creó otro registro. Usá arca:credentials:update para modificarlo."
  }
  $vault.Add((New-Credential $Cuit $DisplayName.Trim() $Secret))
}

function Read-ImportRecords {
  try { $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json }
  catch { throw 'No se pudo interpretar el lote privado de importación.' }
  if (-not $payload -or $null -eq $payload.records) { throw 'El lote privado de importación no contiene registros.' }
  $sourceRecords = @($payload.records)
  if ($sourceRecords.Count -eq 0) { throw 'El lote privado de importación está vacío.' }
  if ($sourceRecords.Count -gt 10000) { throw 'El lote privado de importación supera el máximo de 10000 registros.' }

  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  $records = @()
  for ($index = 0; $index -lt $sourceRecords.Count; $index++) {
    $source = $sourceRecords[$index]
    $row = $index + 2
    $displayName = ([string]$source.displayName).Trim()
    if (-not $displayName) { throw "La fila $row no tiene contribuyente." }
    if ($displayName.Length -gt 200 -or $displayName -match '[\x00-\x1F\x7F]') { throw "La fila $row contiene un contribuyente inválido." }
    try { $cuit = Assert-ValidCuit ([string]$source.cuit) }
    catch { throw "La fila $row contiene un CUIT inválido." }
    $secret = [string]$source.clave
    if (-not $secret -or -not $secret.Trim()) { throw "La fila $row no tiene clave ARCA." }
    if ($secret.Length -gt 1024 -or $secret -match '[\x00\r\n]') { throw "La fila $row contiene una clave ARCA fuera del límite admitido." }
    if (-not $seen.Add($cuit)) { throw "El lote repite un mismo CUIT; no se escribió ningún registro." }
    $records += [pscustomobject]@{ DisplayName = $displayName; Cuit = $cuit; Secret = $secret }
  }
  return $records
}

function Invoke-CredentialImport($Records, [bool]$Write) {
  return Invoke-WithStoreLock {
    $existing = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($record in @(Get-AllRecords)) { $null = $existing.Add($record.Cuit) }
    $pending = @($Records | Where-Object { -not $existing.Contains($_.Cuit) })
    $skipped = $Records.Count - $pending.Count
    if (-not $Write) {
      return [pscustomobject]@{ dryRun = $true; total = $Records.Count; imported = $pending.Count; skippedExisting = $skipped }
    }

    $added = @()
    try {
      foreach ($record in $pending) {
        $credential = New-Credential $record.Cuit $record.DisplayName $record.Secret
        $vault.Add($credential)
        $added += $credential
      }
    } catch {
      $rollbackFailed = $false
      foreach ($credential in @($added)) {
        try { $vault.Remove($credential) } catch { $rollbackFailed = $true }
      }
      if ($rollbackFailed) { throw 'La importación falló y el rollback no pudo verificarse; revisá el almacén antes de reintentar.' }
      throw 'La importación falló y las altas del lote fueron revertidas.'
    }
    return [pscustomobject]@{ dryRun = $false; total = $Records.Count; imported = $added.Count; skippedExisting = $skipped }
  }
}

function Remove-Records($Records) {
  foreach ($record in @($Records)) { $vault.Remove($record.Item) }
}

function Invoke-WithStoreLock([scriptblock]$Action) {
  $mutex = [Threading.Mutex]::new($false, 'Local\ManejoARCA-CredentialStore-v2')
  $lockAcquired = $false
  try {
    try { $lockAcquired = $mutex.WaitOne(30000) }
    catch [Threading.AbandonedMutexException] { $lockAcquired = $true }
    if (-not $lockAcquired) { throw 'No se pudo obtener el lock exclusivo del almacén de credenciales.' }
    return (& $Action)
  } finally {
    if ($lockAcquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}

switch ($Operation) {
  'set' {
    if (-not $Selector) { throw 'Falta el nombre descriptivo.' }
    $cuit = Assert-ValidCuit (Read-Host 'CUIT (11 dígitos)')
    Invoke-WithStoreLock {
      $existing = @(Get-RecordsByCuit $cuit)
      if ($existing.Count -gt 0) {
        $names = ($existing | Select-Object -ExpandProperty DisplayName -Unique) -join ', '
        throw "El CUIT $cuit ya está registrado como '$names'. No se solicitó la clave ni se creó otro registro."
      }
    }
    $secret = Read-Secret
    Invoke-WithStoreLock { Add-NewCredential $Selector $cuit $secret }
    Write-Output "CREDENTIAL_SAVED=$cuit"
  }
  'set-json' {
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $displayName = if ($payload.displayName) { [string]$payload.displayName } else { [string]$payload.issuerKey }
    $cuit = Assert-ValidCuit ([string]$payload.cuit)
    Invoke-WithStoreLock { Add-NewCredential $displayName $cuit ([string]$payload.clave) }
    Write-Output "CREDENTIAL_SAVED=$cuit"
  }
  'resolve' {
    Invoke-WithStoreLock {
      $identity = Resolve-Identity $Selector
      $record = Select-ReadableRecord $identity
      @{ issuerKey = $identity.Cuit; displayName = $record.DisplayName; cuit = $identity.Cuit; storageVersion = $record.StorageVersion } | ConvertTo-Json -Compress
    }
  }
  'get' {
    Invoke-WithStoreLock {
      $identity = Resolve-Identity $Selector
      $record = Select-ReadableRecord $identity
      $record.Item.RetrievePassword()
      @{ issuerKey = $identity.Cuit; displayName = $record.DisplayName; cuit = $identity.Cuit; clave = $record.Item.Password; storageVersion = $record.StorageVersion } | ConvertTo-Json -Compress
    }
  }
  'list' {
    Invoke-WithStoreLock {
      $items = @(Get-AllRecords | Sort-Object Cuit, DisplayName | ForEach-Object {
        @{ issuerKey = $_.Cuit; displayName = $_.DisplayName; cuit = $_.Cuit; storageVersion = $_.StorageVersion }
      })
      ConvertTo-Json -InputObject $items -Compress
    }
  }
  'update' {
    $preview = Invoke-WithStoreLock {
      $identity = Resolve-Identity $Selector
      $canonical = @($identity.Records | Where-Object { $_.StorageVersion -eq 2 })
      $current = if ($canonical.Count -eq 1) { $canonical[0] } else { $identity.Records[0] }
      [pscustomobject]@{ Cuit = $identity.Cuit; DisplayName = $current.DisplayName }
    }
    $enteredName = Read-Host "Nombre descriptivo [$($preview.DisplayName)]"
    $displayName = if ($enteredName.Trim()) { $enteredName.Trim() } else { $preview.DisplayName }
    $secret = Read-Secret
    Invoke-WithStoreLock {
      $identity = Resolve-Identity $preview.Cuit
      $backups = @($identity.Records | ForEach-Object {
        $_.Item.RetrievePassword()
        [pscustomobject]@{ Resource = $_.Item.Resource; UserName = $_.Item.UserName; Password = $_.Item.Password }
      })
      Remove-Records $identity.Records
      try {
        $vault.Add((New-Credential $identity.Cuit $displayName $secret))
      } catch {
        foreach ($backup in $backups) {
          $vault.Add(([Windows.Security.Credentials.PasswordCredential]::new($backup.Resource, $backup.UserName, $backup.Password)))
        }
        throw
      }
    }
    Write-Output "CREDENTIAL_UPDATED=$($preview.Cuit)"
  }
  'delete' {
    $deletedCuit = Invoke-WithStoreLock {
      $identity = Resolve-Identity $Selector
      Remove-Records $identity.Records
      return $identity.Cuit
    }
    Write-Output "CREDENTIAL_DELETED=$deletedCuit"
  }
  'migrate-vault' {
    Invoke-WithStoreLock {
      $legacy = @(Get-AllRecords | Where-Object { $_.StorageVersion -eq 1 })
      $migrated = @()
      $conflicts = @()
      $invalid = @()
      foreach ($group in @($legacy | Group-Object Cuit)) {
        try { $cuit = Assert-ValidCuit $group.Name } catch { $invalid += $group.Name; continue }
        $canonical = @(Get-RecordsByCuit $cuit | Where-Object { $_.StorageVersion -eq 2 })
        if ($canonical.Count -gt 0 -or $group.Count -ne 1) { $conflicts += $cuit; continue }
        $record = $group.Group[0]
        $record.Item.RetrievePassword()
        $vault.Add((New-Credential $cuit $record.DisplayName $record.Item.Password))
        $vault.Remove($record.Item)
        $migrated += $cuit
      }
      @{ migrated = @($migrated); conflicts = @($conflicts); invalid = @($invalid) } | ConvertTo-Json -Compress
    }
  }
  'migrate-vault-plan' {
    Invoke-WithStoreLock {
      $legacy = @(Get-AllRecords | Where-Object { $_.StorageVersion -eq 1 })
      $migratable = @()
      $conflicts = @()
      $invalid = @()
      foreach ($group in @($legacy | Group-Object Cuit)) {
        try { $cuit = Assert-ValidCuit $group.Name } catch { $invalid += $group.Name; continue }
        $canonical = @(Get-RecordsByCuit $cuit | Where-Object { $_.StorageVersion -eq 2 })
        if ($canonical.Count -gt 0 -or $group.Count -ne 1) { $conflicts += $cuit; continue }
        $migratable += $cuit
      }
      @{ dryRun = $true; migratable = @($migratable); conflicts = @($conflicts); invalid = @($invalid) } | ConvertTo-Json -Compress
    }
  }
  'import-json-plan' {
    $records = @(Read-ImportRecords)
    Invoke-CredentialImport $records $false | ConvertTo-Json -Compress
  }
  'import-json' {
    $records = @(Read-ImportRecords)
    Invoke-CredentialImport $records $true | ConvertTo-Json -Compress
  }
}
