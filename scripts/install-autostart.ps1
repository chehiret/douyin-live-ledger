$ErrorActionPreference = 'Stop'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$scriptPath = Join-Path $PSScriptRoot 'supervisor.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $scriptPath + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'DouyinLiveLedgerLiveLedger' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'DouyinLiveLedger internal live statistics; starts after this Windows user signs in and restarts the backend after process exit.' -Force | Out-Null
Start-ScheduledTask -TaskName 'DouyinLiveLedgerLiveLedger'
Write-Output 'Installed: DouyinLiveLedgerLiveLedger. Starts at Windows sign-in; backend process restarts after exit.'
