param(
  [ValidatePattern('^\d{1,15}$')][string]$VideoId='70262107',
  [ValidateSet('watch','login')][string]$Target='watch',
  [ValidateRange(10,60)][int]$TimeoutSeconds=40
)
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$chromePath='C:\Program Files\Google\Chrome\Application\chrome.exe'
if(!(Test-Path -LiteralPath $chromePath)){throw 'Installed Google Chrome is unavailable.'}
$runRoot=Join-Path $projectRoot ('private-subtitles\headless-probes\'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N'))
$profileRoot=Join-Path $runRoot 'fresh-profile'
New-Item -ItemType Directory -Path $profileRoot -Force | Out-Null
$stdout=Join-Path $runRoot 'document.html'
$stderr=Join-Path $runRoot 'chrome.stderr.log'
$shot=Join-Path $runRoot 'headless.png'
$watchUrl=if($Target -eq 'login'){'https://www.netflix.com/login'}else{"https://www.netflix.com/watch/$VideoId"}
# This intentionally does NOT reuse, read or copy the user's logged-in profile.
# No extension URLs, remote debugging port, cookie import, or DRM modifications.
$arguments=@('--headless','--no-first-run','--no-default-browser-check',
  "--user-data-dir=`"$profileRoot`"",'--dump-dom','--timeout=20000',
  "--screenshot=`"$shot`"",'--window-size=1280,900',$watchUrl)
$started=(Get-Date).ToUniversalTime().ToString('o')
$process=Start-Process -FilePath $chromePath -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
# On Windows the launcher can exit before its headless child drains stdout.
# Wait for complete artifacts, rather than assuming launcher exit means completion.
$deadline=[DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$finished=$false;$html=''
do {
  try {if(Test-Path -LiteralPath $stdout){$html=[IO.File]::ReadAllText($stdout)}}catch [IO.IOException]{}
  $finished=($html -match '</html>\s*$') -and (Test-Path -LiteralPath $shot)
  if(!$finished){Start-Sleep -Milliseconds 250}
}while(!$finished -and [DateTime]::UtcNow -lt $deadline)
$process.Refresh()
if(!$process.HasExited){$null=$process.WaitForExit(1000)}
if(!$finished){
  # Cleanup only the fresh, unique profile created in this invocation.
  if(!$profileRoot.StartsWith((Join-Path $projectRoot 'private-subtitles\headless-probes\'),[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe cleanup target.'}
  $owned=Get-CimInstance Win32_Process -Filter "name='chrome.exe'" | Where-Object {$_.ExecutablePath -eq $chromePath -and $_.CommandLine -and $_.CommandLine.Contains($profileRoot)}
  foreach($ownedProcess in $owned){Stop-Process -Id $ownedProcess.ProcessId -ErrorAction SilentlyContinue}
}
$titleMatch=[regex]::Match($html,'<title[^>]*>(.*?)</title>','Singleline,IgnoreCase')
$report=[ordered]@{
  startedAt=$started;finishedAt=(Get-Date).ToUniversalTime().ToString('o')
  browserVersion=(Get-Item -LiteralPath $chromePath).VersionInfo.ProductVersion
  mode='headless';target=$Target;videoId=if($Target -eq 'watch'){$VideoId}else{$null};url=$watchUrl;freshProfile=$true
  existingProfileUsed=$false;existingCookiesImported=$false;ottspeedExtensionLoaded=$false
  launcherProcessId=$process.Id;timedOut=(!$finished);exitCode=if($process.HasExited){$process.ExitCode}else{$null}
  htmlBytes=if(Test-Path -LiteralPath $stdout){(Get-Item -LiteralPath $stdout).Length}else{0}
  title=if($titleMatch.Success){[Net.WebUtility]::HtmlDecode($titleMatch.Groups[1].Value)}else{''}
  loginFormPresent=[regex]::IsMatch($html,'name="(?:userLoginId|password)"|data-uia="login-page-container"')
  videoElementPresent=[regex]::IsMatch($html,'<video(?:\s|>)','IgnoreCase')
  concurrentStreamError=[regex]::IsMatch($html,'\bM7020\b')
  documentErrorCodes=@([regex]::Matches($html,'\bNSES-\d{3}\b') | ForEach-Object {$_.Value} | Sort-Object -Unique)
  screenshotSaved=(Test-Path -LiteralPath $shot)
  manifestReceived=$null;fullSubtitleFileAcquired=$false
  limitation='Launch/page-load probe only. No authenticated collector, manifest or whole subtitle validation has run.'
  outputDirectory=$runRoot
}
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $runRoot 'report.json') -Encoding utf8
$report | ConvertTo-Json -Depth 5
