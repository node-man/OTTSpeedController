param([switch]$Once)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$dataDirectory = Join-Path $projectDirectory 'private-subtitles/bridge'
$statePath = Join-Path $dataDirectory 'stack-status.json'
$logPath = Join-Path $dataDirectory 'stack-supervisor.jsonl'
$healthFile = Join-Path $env:USERPROFILE '.local/state/tunnel-client/health/ottspeed.url'
$profilePath = Join-Path $dataDirectory 'tunnel-profiles/ottspeed.yaml'
. (Join-Path $PSScriptRoot 'runtime/config.ps1')
$expectedTunnel = (Get-OTTDeckRuntimeConfiguration -ProjectDirectory $projectDirectory).TunnelId
$powershellExecutable = Join-Path $PSHOME 'powershell.exe'
$mutex = New-Object Threading.Mutex($false, 'Local\OTTSpeed-Translation-Stack')
try { $ownsMutex = $mutex.WaitOne(0) }
catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
if (-not $ownsMutex) { $mutex.Dispose(); exit 0 }
New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null

function Write-StackEvent([string]$eventName) {
  # Never log exceptions, credentials, request payloads or caption contents.
  $entry = @{ at=[DateTime]::UtcNow.ToString('o'); event=$eventName } | ConvertTo-Json -Compress
  [IO.File]::AppendAllText($logPath, $entry + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}
function Test-Bridge {
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:43127/healthz' -TimeoutSec 3
    return ($health.service -eq 'ottspeed-translation-bridge' -and $health.ready)
  } catch { return $false }
}
function Start-StackHelper([string]$scriptName, [string]$extraArguments = '') {
  # Separate redirected files prevent inherited console pipes from keeping a
  # native PowerShell invocation blocked after its launcher has exited.
  $scriptPath = Join-Path $PSScriptRoot $scriptName
  $arguments = '-NoProfile -NonInteractive -File "' + $scriptPath + '" ' + $extraArguments
  $helper = Start-Process -FilePath $powershellExecutable -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dataDirectory ($scriptName + '.stdout.log')) -RedirectStandardError (Join-Path $dataDirectory ($scriptName + '.stderr.log'))
  if (-not $helper.WaitForExit(60000)) { Write-StackEvent 'helper_timeout'; return }
}
function Test-Tunnel {
  try {
    $profile = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json
    if ($profile.control_plane.tunnel_id -ne $expectedTunnel) { return $false }
    $baseUrl = (Get-Content -LiteralPath $healthFile -Raw).Trim()
    if ($baseUrl -notmatch '^http://127\.0\.0\.1:\d+$') { return $false }
    $live = Invoke-WebRequest -UseBasicParsing -Uri ($baseUrl + '/healthz') -TimeoutSec 3
    $ready = Invoke-WebRequest -UseBasicParsing -Uri ($baseUrl + '/readyz') -TimeoutSec 3
    return ($live.StatusCode -eq 200 -and $ready.StatusCode -eq 200)
  } catch { return $false }
}
try {
  Write-StackEvent 'supervisor_started'
  $nextTunnelAttempt = [DateTime]::MinValue
  do {
    $bridgeReady = Test-Bridge
    if (-not $bridgeReady) {
      Start-StackHelper 'start-translation-bridge.ps1'
      $bridgeReady = Test-Bridge
      if ($bridgeReady) { Write-StackEvent 'bridge_started' } else { Write-StackEvent 'bridge_start_failed' }
    }
    $tunnelReady = Test-Tunnel
    if ($bridgeReady -and -not $tunnelReady -and [DateTime]::UtcNow -ge $nextTunnelAttempt) {
      # Existing user-approved DPAPI credential; no new credentials or access.
      Start-StackHelper 'connect-translation-tunnel.ps1' '-UseSavedKey'
      $tunnelReady = Test-Tunnel
      if ($tunnelReady) { Write-StackEvent 'tunnel_started' } else { Write-StackEvent 'tunnel_start_failed' }
      $nextTunnelAttempt = [DateTime]::UtcNow.AddMinutes(5)
    }
    $state = [ordered]@{
      checkedAt=[DateTime]::UtcNow.ToString('o'); supervisorPid=$PID
      tunnelId=$expectedTunnel; bridgeReady=[bool]$bridgeReady; tunnelReady=[bool]$tunnelReady
      scope='Local process readiness only; actual connected-app probes are separate.'
    }
    [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    if (-not $Once) { Start-Sleep -Seconds 30 }
  } while (-not $Once)
} finally {
  Write-StackEvent 'supervisor_stopped'
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
