# Run only after the user approves creating and storing the tunnel runtime key.
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$bridgeDirectory = Join-Path $projectDirectory 'private-subtitles/bridge'
$pendingKeyPath = Join-Path $bridgeDirectory 'runtime-key.pending.txt'
$protectedKeyPath = Join-Path $bridgeDirectory 'runtime-key.dpapi'
if (Test-Path -LiteralPath $protectedKeyPath) { throw 'An encrypted runtime key already exists. Do not overwrite it silently.' }
$plainRuntimeKey = [IO.File]::ReadAllText($pendingKeyPath).Trim()
if ($plainRuntimeKey -notmatch '^sk-[A-Za-z0-9_-]{20,}$') { throw 'The pending value is not an API key; no value was printed.' }
try {
  $secureRuntimeKey = ConvertTo-SecureString $plainRuntimeKey -AsPlainText -Force
  $encryptedRuntimeKey = ConvertFrom-SecureString $secureRuntimeKey
  [IO.File]::WriteAllText($protectedKeyPath,$encryptedRuntimeKey,[Text.UTF8Encoding]::new($false))
  Write-Output 'Runtime key encrypted with Windows DPAPI for the current Windows user.'
} finally {
  $plainRuntimeKey = $null
  if ($secureRuntimeKey) { $secureRuntimeKey.Dispose() }
  # Exact transient file only; no recursive file operation.
  Remove-Item -LiteralPath $pendingKeyPath -Force
}
