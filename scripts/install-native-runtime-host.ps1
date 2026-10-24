param([string]$ExtensionId)
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'runtime/config.ps1')
$ExtensionId = Get-OTTDeckExtensionId -ProjectDirectory $projectDirectory -ExtensionId $ExtensionId
$runtimeConfiguration = Get-OTTDeckRuntimeConfiguration -ProjectDirectory $projectDirectory
$hostDirectory = Join-Path $projectDirectory 'private-subtitles/bridge/native-host'
New-Item -ItemType Directory -Path $hostDirectory -Force | Out-Null
$hostExecutable = Join-Path $hostDirectory 'OTTSpeedRuntimeHost.exe'
$source = Get-Content -LiteralPath (Join-Path $projectDirectory 'native/OTTSpeedRuntimeHost.cs') -Raw
# Versioned executable avoids replacing a host that Chrome may still be using.
$sourceBytes = [Text.Encoding]::UTF8.GetBytes($source)
$sha = [Security.Cryptography.SHA256]::Create()
try { $sourceHash = ([BitConverter]::ToString($sha.ComputeHash($sourceBytes))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
$hostExecutable = Join-Path $hostDirectory ('OTTSpeedRuntimeHost-' + $sourceHash.Substring(0,12) + '.exe')
if (-not (Test-Path -LiteralPath $hostExecutable)) {
  Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $hostExecutable -OutputType ConsoleApplication -ReferencedAssemblies 'System.dll','System.Web.Extensions.dll' -IgnoreWarnings
}
$origin = 'chrome-extension://' + $ExtensionId + '/'
$configuration = @{projectRoot=$projectDirectory;allowedOrigin=$origin;tunnelId=$runtimeConfiguration.TunnelId} | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $hostDirectory 'runtime-host-config.json'),$configuration,[Text.UTF8Encoding]::new($false))
$manifestPath = Join-Path $hostDirectory 'com.ottspeed.runtime.json'
$manifest = @{name='com.ottspeed.runtime';description='Start and inspect the existing local OTTSpeed translation runtime';path=$hostExecutable;type='stdio';allowed_origins=@($origin)} | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText($manifestPath,$manifest,[Text.UTF8Encoding]::new($false))
$registryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.ottspeed.runtime'
New-Item -Path $registryPath -Force | Out-Null
Set-Item -LiteralPath $registryPath -Value $manifestPath
Write-Output 'Installed com.ottspeed.runtime for this Windows user and the specified OTTSpeed extension only. Existing bridge/tunnel processes were not restarted.'
