# Shares the JSON/YAML identity reader with installation and connection helpers.
. (Join-Path $PSScriptRoot 'config.ps1')
function Test-OTTDeckTunnel {
  param([string]$ProjectDirectory,[string]$ExpectedTunnel,[string]$HealthFile,
    [scriptblock]$Probe = { param($Uri) Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 3 })
  try {
    $configuration = Get-OTTDeckRuntimeConfiguration -ProjectDirectory $ProjectDirectory
    if ($configuration.TunnelId -ne $ExpectedTunnel) { return $false }
    $baseUrl = (Get-Content -LiteralPath $HealthFile -Raw).Trim()
    if ($baseUrl -notmatch '^http://127\.0\.0\.1:\d+$') { return $false }
    $live = & $Probe ($baseUrl + '/healthz')
    $ready = & $Probe ($baseUrl + '/readyz')
    return ($live.StatusCode -eq 200 -and $ready.StatusCode -eq 200)
  } catch { return $false }
}
function Invoke-OTTDeckTunnelCheck {
  param([scriptblock]$Test,[scriptblock]$Reconnect,[bool]$BridgeReady,[DateTime]$NextAttempt)
  $ready = & $Test
  $attempted = $false
  if ($BridgeReady -and -not $ready -and [DateTime]::UtcNow -ge $NextAttempt) {
    & $Reconnect | Out-Null
    $attempted = $true
    $ready = & $Test
    $NextAttempt = [DateTime]::UtcNow.AddMinutes(5)
  }
  return [pscustomobject]@{Ready=[bool]$ready;Attempted=$attempted;NextAttempt=$NextAttempt}
}
