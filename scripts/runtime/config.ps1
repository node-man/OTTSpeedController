# Read account-specific connection IDs from private local configuration.
# This helper never reads/decrypts a runtime key or starts a process.
function Get-OTTDeckRuntimeConfiguration {
  param([Parameter(Mandatory=$true)][string]$ProjectDirectory,[string]$TunnelId,[string]$OrganizationId)
  $profilePath = Join-Path $ProjectDirectory 'private-subtitles/bridge/tunnel-profiles/ottspeed.yaml'
  if (Test-Path -LiteralPath $profilePath) {
    $profileText = Get-Content -LiteralPath $profilePath -Raw
    if ($profileText.TrimStart().StartsWith('{')) {
      $profile = $profileText | ConvertFrom-Json
      if (-not $TunnelId) { $TunnelId = $profile.control_plane.tunnel_id }
      if (-not $OrganizationId) { $OrganizationId = $profile.control_plane.organization_id }
    } else {
      if (-not $TunnelId -and $profileText -match '(?m)^\s+tunnel_id:\s*["'']?(tunnel_[a-zA-Z0-9]+)') { $TunnelId = $Matches[1] }
      if (-not $OrganizationId -and $profileText -match '(?m)^\s+organization_id:\s*["'']?(org-[a-zA-Z0-9]+)') { $OrganizationId = $Matches[1] }
    }
  }
  if (-not $TunnelId) { $TunnelId = $env:OTTDECK_TUNNEL_ID }
  if (-not $OrganizationId) { $OrganizationId = $env:CONTROL_PLANE_ORGANIZATION_ID }
  if ($TunnelId -notmatch '^tunnel_[a-zA-Z0-9]+$' -or $OrganizationId -notmatch '^org-[a-zA-Z0-9]+$') {
    throw 'Configure the tunnel and organization in the private profile, or supply TunnelId and OrganizationId. Never put a runtime key in the command line.'
  }
  return [pscustomobject]@{TunnelId=$TunnelId;OrganizationId=$OrganizationId;ProfilePath=$profilePath}
}
