# Configure an already-provisioned Workspace Agent token locally; creates no remote access.
param(
  [Parameter(Mandatory=$true)][string]$TriggerId,
  [switch]$Enable,
  [switch]$PromptForToken
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
if ($TriggerId -notmatch '^agtch_[A-Za-z0-9_-]{1,180}$') { throw 'A published API trigger ID (agtch_...) is required.' }
$projectDirectory = Split-Path -Parent $PSScriptRoot
$dataDirectory = Join-Path $projectDirectory 'private-subtitles/bridge'
$configPath = Join-Path $dataDirectory 'workspace-agent.json'
$tokenPath = Join-Path $dataDirectory 'workspace-agent-token.dpapi'
if ((Test-Path -LiteralPath $configPath) -or (Test-Path -LiteralPath $tokenPath)) { throw 'Workspace Agent configuration already exists. Preserve and review it before replacing.' }
if ($PromptForToken) { $secureToken = Read-Host 'Existing Workspace Agent scoped token (hidden)' -AsSecureString }
elseif ($env:OTTSPEED_WORKSPACE_AGENT_TOKEN) { $secureToken = ConvertTo-SecureString $env:OTTSPEED_WORKSPACE_AGENT_TOKEN -AsPlainText -Force }
else { throw 'No token supplied. Nothing was changed; no interactive prompt was opened.' }
try {
  if ($secureToken.Length -lt 16 -or $secureToken.Length -gt 8192) { throw 'Unexpected token length. Nothing was saved.' }
  New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
  $encryptedToken = ConvertFrom-SecureString $secureToken
  $encoding = [Text.UTF8Encoding]::new($false)
  $stream = [IO.File]::Open($tokenPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
  try { $bytes = $encoding.GetBytes($encryptedToken); $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
  $config = @{schemaVersion=1; enabled=[bool]$Enable; triggerId=$TriggerId; useProtectedToken=$true} | ConvertTo-Json
  $stream = [IO.File]::Open($configPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
  try { $bytes = $encoding.GetBytes($config); $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
  Write-Output 'Workspace Agent configuration saved with Windows-user DPAPI protection. No remote request was sent.'
} finally { if ($secureToken) { $secureToken.Dispose() }; $encryptedToken = $null }
