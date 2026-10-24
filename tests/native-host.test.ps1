# Windows-only synthetic tests. No registry writes, real keys or live services.
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$fixtureDirectory = Join-Path $projectDirectory ('test-results/native-host-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureDirectory -Force | Out-Null
. (Join-Path $projectDirectory 'scripts/runtime/config.ps1')
$profileDirectory = Join-Path $fixtureDirectory 'private-subtitles/bridge/tunnel-profiles'
New-Item -ItemType Directory -Path $profileDirectory -Force | Out-Null
$profilePath = Join-Path $profileDirectory 'ottspeed.yaml'
[IO.File]::WriteAllText($profilePath,'{"control_plane":{"tunnel_id":"tunnel_synthetic123","organization_id":"org-synthetic123"}}')
$resolved = Get-OTTDeckRuntimeConfiguration -ProjectDirectory $fixtureDirectory
if ($resolved.TunnelId -ne 'tunnel_synthetic123' -or $resolved.OrganizationId -ne 'org-synthetic123') { throw 'JSON profile identity changed.' }
[IO.File]::WriteAllText($profilePath,"control_plane:`n  tunnel_id: tunnel_synthetic456`n  organization_id: org-synthetic456`n")
$resolved = Get-OTTDeckRuntimeConfiguration -ProjectDirectory $fixtureDirectory
if ($resolved.TunnelId -ne 'tunnel_synthetic456') { throw 'YAML profile identity changed.' }
$invalidRejected = $false
try { Get-OTTDeckRuntimeConfiguration -ProjectDirectory $fixtureDirectory -TunnelId 'invalid' | Out-Null } catch { $invalidRejected = $true }
if (-not $invalidRejected) { throw 'Invalid runtime identity accepted.' }

$executable = Join-Path $fixtureDirectory 'host.exe'
$source = Get-Content -LiteralPath (Join-Path $projectDirectory 'native/OTTSpeedRuntimeHost.cs') -Raw
Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $executable -OutputType ConsoleApplication -ReferencedAssemblies 'System.dll','System.Web.Extensions.dll' -IgnoreWarnings
$origin='chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'
$configuration=@{projectRoot=$fixtureDirectory;allowedOrigin=$origin;tunnelId='tunnel_synthetic123'} | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $fixtureDirectory 'runtime-host-config.json'),$configuration,[Text.UTF8Encoding]::new($false))
function Invoke-HostFixture([string]$Action,[string]$OriginValue=$origin,[switch]$Extra) {
  $start=New-Object Diagnostics.ProcessStartInfo
  $start.FileName=$executable
  $start.Arguments=$OriginValue
  $start.UseShellExecute=$false
  $start.CreateNoWindow=$true
  $start.RedirectStandardInput=$true
  $start.RedirectStandardOutput=$true
  $start.RedirectStandardError=$true
  $process=[Diagnostics.Process]::Start($start)
  try {
    $request=@{action=$Action}
    if ($Extra) { $request.command='forbidden' }
    $bytes=[Text.Encoding]::UTF8.GetBytes(($request | ConvertTo-Json -Compress))
    $inputStream=$process.StandardInput.BaseStream
    $length=[BitConverter]::GetBytes([int]$bytes.Length)
    $inputStream.Write($length,0,2)
    $inputStream.Write($length,2,2)
    $inputStream.Write($bytes,0,$bytes.Length)
    $inputStream.Flush()
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(5000)) { throw 'Synthetic native host did not exit.' }
    $reader=New-Object IO.BinaryReader($process.StandardOutput.BaseStream)
    $count=$reader.ReadInt32()
    if ($count -le 0 -or $count -gt 65536) { throw 'Invalid native frame size.' }
    $result=[Text.Encoding]::UTF8.GetString($reader.ReadBytes($count)) | ConvertFrom-Json
    if ($process.StandardError.ReadToEnd()) { throw 'Native host emitted unexpected stderr.' }
    return $result
  } finally { $process.Dispose() }
}
if ((Invoke-HostFixture 'status').state -ne 'stopped') { throw 'Missing service was reported ready.' }
if ((Invoke-HostFixture 'stop').errorCode -ne 'invalid_request') { throw 'Unknown action was accepted.' }
if ((Invoke-HostFixture 'ensure' -Extra).errorCode -ne 'invalid_request') { throw 'Arbitrary command was accepted.' }
if ((Invoke-HostFixture 'status' -OriginValue 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/').errorCode -ne 'forbidden_origin') { throw 'Different extension was accepted.' }
Write-Output 'PASS Windows runtime profile resolution, native compile/framing and command/origin restrictions.'
