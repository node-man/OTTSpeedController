param(
  [string]$TunnelId,
  [string]$OrganizationId,
  [switch]$UseSavedKey
)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'runtime/config.ps1')
$runtimeConfiguration = Get-OTTDeckRuntimeConfiguration -ProjectDirectory $projectDirectory -TunnelId $TunnelId -OrganizationId $OrganizationId
$TunnelId = $runtimeConfiguration.TunnelId
$OrganizationId = $runtimeConfiguration.OrganizationId
$tunnelExecutable = Join-Path $projectDirectory 'tools/tunnel-client/tunnel-client.exe'
$profileDirectory = Join-Path $projectDirectory 'private-subtitles/bridge/tunnel-profiles'
if (-not (Test-Path -LiteralPath $tunnelExecutable)) { throw 'Install the official OpenAI tunnel-client in tools/tunnel-client first.' }
# The credential is either typed locally or decrypted for this Windows user only.
if ($UseSavedKey) {
  $protectedKeyPath = Join-Path $projectDirectory 'private-subtitles/bridge/runtime-key.dpapi'
  $secureRuntimeKey = Get-Content -LiteralPath $protectedKeyPath -Raw | ConvertTo-SecureString
} else {
  $secureRuntimeKey = Read-Host 'DechoNet Tunnels Read + Use runtime API key (hidden)' -AsSecureString
}
$secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureRuntimeKey)
$previousRuntimeKey = $env:CONTROL_PLANE_API_KEY
$previousOrganization = $env:CONTROL_PLANE_ORGANIZATION_ID
try {
  $env:CONTROL_PLANE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
  $env:CONTROL_PLANE_ORGANIZATION_ID = $OrganizationId
  try {
    $tunnelMetadata = Invoke-RestMethod -Uri "https://api.openai.com/v1/tunnels/$TunnelId" -Headers @{ Authorization = "Bearer $env:CONTROL_PLANE_API_KEY"; 'OpenAI-Organization' = $OrganizationId } -TimeoutSec 20
    if ($tunnelMetadata.id -ne $TunnelId) { throw 'Unexpected tunnel identity.' }
  } catch { throw 'Runtime key organization/Tunnels Read + Use validation failed. Check Platform locally; never paste the key into chat.' }
  & $tunnelExecutable runtimes stop ottspeed --json | Out-Null
  & $tunnelExecutable runtimes connect --alias ottspeed --tunnel-id $TunnelId --organization-id $OrganizationId --mcp-server-url 'http://127.0.0.1:43127/mcp' --profile ottspeed --profile-dir $profileDirectory --runtime-api-key 'env:CONTROL_PLANE_API_KEY' --json | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Tunnel runtime did not start.' }
  $profilePath = Join-Path $profileDirectory 'ottspeed.yaml'
  $profileText = Get-Content -LiteralPath $profilePath -Raw
  # The official client currently emits JSON in the .yaml file. A YAML-only
  # regex silently omitted organization_id and left later lookups failing 403.
  if ($profileText.TrimStart().StartsWith('{')) {
    $runtimeConfiguration = $profileText | ConvertFrom-Json
    $runtimeConfiguration.control_plane | Add-Member -NotePropertyName organization_id -NotePropertyValue $OrganizationId -Force
    $profileText = $runtimeConfiguration | ConvertTo-Json -Depth 32
  } elseif ($profileText -match 'organization_id:') { $profileText = $profileText -replace '(?m)^\s+organization_id:.*$', "  organization_id: $OrganizationId" }
  else { $profileText = $profileText -replace 'control_plane:\r?\n', "control_plane:`n  organization_id: $OrganizationId`n" }
  [IO.File]::WriteAllText($profilePath,$profileText,[Text.UTF8Encoding]::new($false))
  & $tunnelExecutable runtimes status ottspeed --json | ConvertFrom-Json | Select-Object alias,process_running,healthy,ready,ui_url | ConvertTo-Json
  Write-Output 'Local runtime started. Actual ChatGPT discovery and translation return still require separate verification.'
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
  $secureRuntimeKey.Dispose()
  $env:CONTROL_PLANE_API_KEY = $previousRuntimeKey
  $env:CONTROL_PLANE_ORGANIZATION_ID = $previousOrganization
}
