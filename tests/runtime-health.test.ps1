$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../scripts/runtime/health.ps1')
$root = Join-Path $PSScriptRoot ('../test-results/runtime-health-' + [Guid]::NewGuid().ToString('N'))
$profiles = Join-Path $root 'private-subtitles/bridge/tunnel-profiles'
New-Item -ItemType Directory -Path $profiles -Force | Out-Null
$health = Join-Path $root 'health.url'
Set-Content -LiteralPath $health -Value 'http://127.0.0.1:12345'
$script:probes = @()
$script:reconnects = 0
$probe = { param($Uri) $script:probes += $Uri; return @{StatusCode=200} }
foreach ($profile in @('{"control_plane":{"tunnel_id":"tunnel_synthetic","organization_id":"org-synthetic"}}', "control_plane:`n  tunnel_id: tunnel_synthetic`n  organization_id: org-synthetic`n")) {
  Set-Content -LiteralPath (Join-Path $profiles 'ottspeed.yaml') -Value $profile
  $check = Invoke-OTTDeckTunnelCheck -BridgeReady $true -NextAttempt ([DateTime]::MinValue) -Reconnect { $script:reconnects++ } -Test {
    Test-OTTDeckTunnel -ProjectDirectory $root -ExpectedTunnel 'tunnel_synthetic' -HealthFile $health -Probe $probe
  }
  if (-not $check.Ready -or $check.Attempted -or $script:reconnects -ne 0) { throw 'Healthy JSON/YAML tunnel was reconnected.' }
}
if ($script:probes.Count -ne 4) { throw 'Both endpoints must be probed for each format.' }
if (Test-OTTDeckTunnel -ProjectDirectory $root -ExpectedTunnel 'tunnel_wrong' -HealthFile $health -Probe $probe) { throw 'Wrong tunnel accepted.' }
if ($script:probes.Count -ne 4) { throw 'Wrong tunnel must not be probed.' }
$check = Invoke-OTTDeckTunnelCheck -BridgeReady $true -NextAttempt ([DateTime]::MinValue) -Reconnect { $script:reconnects++ } -Test { $false }
if ($check.Ready -or -not $check.Attempted -or $script:reconnects -ne 1) { throw 'Failed tunnel retry was not bounded.' }
$null = Invoke-OTTDeckTunnelCheck -BridgeReady $true -NextAttempt $check.NextAttempt -Reconnect { $script:reconnects++ } -Test { $false }
if ($script:reconnects -ne 1) { throw 'Retry backoff was ignored.' }
Write-Output 'Runtime JSON/YAML health and no-reconnect regressions passed.'
