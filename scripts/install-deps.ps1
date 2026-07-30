$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$depsRoot = Join-Path $env:LOCALAPPDATA "ManejoARCA\deps"
$depsNodeModules = Join-Path $depsRoot "node_modules"
$projectNodeModules = Join-Path $projectRoot "node_modules"

New-Item -ItemType Directory -Force -Path $depsRoot | Out-Null

Copy-Item -LiteralPath (Join-Path $projectRoot "package.json") -Destination (Join-Path $depsRoot "package.json") -Force
if (Test-Path (Join-Path $projectRoot "package-lock.json")) {
  Copy-Item -LiteralPath (Join-Path $projectRoot "package-lock.json") -Destination (Join-Path $depsRoot "package-lock.json") -Force
}

Push-Location $depsRoot
try {
  if (Test-Path "package-lock.json") {
    npm ci
  } else {
    npm install
  }
} finally {
  Pop-Location
}

if (-not (Test-Path $depsNodeModules)) {
  throw "No se encontro node_modules en $depsNodeModules"
}

if (Test-Path $projectNodeModules) {
  $item = Get-Item -LiteralPath $projectNodeModules -Force
  if ($item.LinkType -eq "Junction" -or $item.LinkType -eq "SymbolicLink") {
    Remove-Item -LiteralPath $projectNodeModules -Force
  } else {
    $resolvedProject = (Resolve-Path $projectRoot).Path
    $resolvedNodeModules = (Resolve-Path $projectNodeModules).Path
    if (-not $resolvedNodeModules.StartsWith($resolvedProject + [IO.Path]::DirectorySeparatorChar)) {
      throw "Refusing to remove node_modules outside project: $resolvedNodeModules"
    }
    Remove-Item -LiteralPath $projectNodeModules -Recurse -Force
  }
}

New-Item -ItemType Junction -Path $projectNodeModules -Target $depsNodeModules | Out-Null
Write-Output "Dependencias instaladas en $depsRoot"
Write-Output "Junction creado: $projectNodeModules -> $depsNodeModules"
