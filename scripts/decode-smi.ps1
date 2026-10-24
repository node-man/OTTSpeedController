param(
  [Parameter(Mandatory = $true)][string]$SourcePath,
  [Parameter(Mandatory = $true)][string]$DestinationPath
)
$ErrorActionPreference = 'Stop'
$encoding = [System.Text.Encoding]::GetEncoding(949, [System.Text.EncoderExceptionFallback]::new(), [System.Text.DecoderExceptionFallback]::new())
$sourceBytes = [System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $SourcePath).Path)
$text = $encoding.GetString($sourceBytes)
$encodedBytes = $encoding.GetBytes($text)
if (-not [System.Linq.Enumerable]::SequenceEqual[byte]($sourceBytes, $encodedBytes)) { throw 'CP949 byte roundtrip failed' }
$outputPath = [System.IO.Path]::GetFullPath($DestinationPath)
if (Test-Path -LiteralPath $outputPath) { throw 'Destination already exists; preserve the previous decoding snapshot' }
[System.IO.File]::WriteAllText($outputPath, $text, [System.Text.UTF8Encoding]::new($false))
Write-Output 'PASS strict CP949 decoding and exact byte roundtrip; wrote UTF-8 snapshot'
