# Internal child process: stdout is captured by the Node bridge, never logged.
param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$secretPointer = [IntPtr]::Zero
try {
  $secureToken = [IO.File]::ReadAllText($Path).Trim() | ConvertTo-SecureString
  $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer))
} catch { [Console]::Error.Write('Protected Workspace Agent credential unavailable.'); exit 1 }
finally {
  if ($secretPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer) }
  if ($secureToken) { $secureToken.Dispose() }
}
