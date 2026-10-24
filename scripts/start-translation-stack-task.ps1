$ErrorActionPreference = 'Stop'
$taskName = 'OTTSpeed-Translation-Stack'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$supervisorPath = Join-Path $PSScriptRoot 'translation-stack-supervisor.ps1'
$powershellExecutable = Join-Path $PSHOME 'powershell.exe'
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
  $actions = @($existing.Actions)
  if ($actions.Count -ne 1 -or $actions[0].Arguments -notlike ('*"' + $supervisorPath + '"*')) {
    throw 'The existing task has a different action. Inspect it before changing it.'
  }
  if ($existing.State -eq 'Running') {
    Write-Output "Task $taskName is already running."
    exit 0
  }
}
$action = New-ScheduledTaskAction -Execute $powershellExecutable -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $supervisorPath + '"') -WorkingDirectory $projectDirectory
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
# Demand-start only. No logon trigger, stored password or elevated privileges.
$task = New-ScheduledTask -Action $action -Principal $principal -Settings $settings -Description 'Run the existing loopback OTTSpeed MCP bridge and tunnel independently of the Codex app. Demand-start; no translation/model execution.'
Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "Started $taskName outside the Codex process tree."
