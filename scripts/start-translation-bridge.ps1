param([string]$ExtensionId)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'runtime/config.ps1')
$ExtensionId = Get-OTTDeckExtensionId -ProjectDirectory $projectDirectory -ExtensionId $ExtensionId
$dataDirectory = Join-Path $projectDirectory 'private-subtitles/bridge'
New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
try {
  $existingBridge = Invoke-RestMethod -Uri 'http://127.0.0.1:43127/healthz' -TimeoutSec 2
  if ($existingBridge.service -eq 'ottspeed-translation-bridge' -and $existingBridge.ready) {
    Write-Output 'OTTSpeed bridge is already running at http://127.0.0.1:43127'
    exit 0
  }
  throw 'Port 43127 is used by another service.'
} catch {
  if ($_.Exception.Message -eq 'Port 43127 is used by another service.') { throw }
}
$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
$env:OTTSPEED_EXTENSION_ID = $ExtensionId
$bridgeProcess = Start-Process -FilePath $nodeExecutable -ArgumentList 'scripts/translation-bridge-server.mjs' -WorkingDirectory $projectDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dataDirectory 'server.stdout.log') -RedirectStandardError (Join-Path $dataDirectory 'server.stderr.log')
Set-Content -LiteralPath (Join-Path $dataDirectory 'server.pid') -Value $bridgeProcess.Id
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  Start-Sleep -Milliseconds 200
  if ($bridgeProcess.HasExited) { throw 'Bridge exited; inspect private-subtitles/bridge/server.stderr.log.' }
  try {
    $bridgeHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:43127/healthz' -TimeoutSec 1
    if ($bridgeHealth.service -eq 'ottspeed-translation-bridge' -and $bridgeHealth.ready) {
      Write-Output "OTTSpeed bridge ready at http://127.0.0.1:43127 (PID $($bridgeProcess.Id))"
      exit 0
    }
  } catch { }
}
throw 'Bridge did not become ready. Inspect private-subtitles/bridge/server.stderr.log.'
