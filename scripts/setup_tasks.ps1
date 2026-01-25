# Earnings Alerts - Windows Task Scheduler Setup (PowerShell)
# Run this script as Administrator for full functionality

param(
    [switch]$Remove,
    [string]$Time = "06:00"
)

$TaskName = "Earnings Alerts - Daily Check"
$ScriptPath = Join-Path $PSScriptRoot "run.bat"

Write-Host "Earnings Alerts - Task Scheduler Setup" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

# Remove existing task if requested or before creating new one
if ($Remove) {
    Write-Host "Removing existing task..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Task removed." -ForegroundColor Green
    exit 0
}

# Check if running as Administrator
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "WARNING: Not running as Administrator." -ForegroundColor Yellow
    Write-Host "Some features may not work correctly." -ForegroundColor Yellow
    Write-Host "Consider re-running with: Start-Process powershell -Verb RunAs -ArgumentList '-File', '$PSCommandPath'" -ForegroundColor Yellow
    Write-Host ""
}

# Verify run.bat exists
if (-not (Test-Path $ScriptPath)) {
    Write-Host "ERROR: run.bat not found at: $ScriptPath" -ForegroundColor Red
    exit 1
}

Write-Host "Script path: $ScriptPath" -ForegroundColor Gray
Write-Host "Scheduled time: $Time" -ForegroundColor Gray
Write-Host ""

# Remove existing task first
Write-Host "Removing any existing task..." -ForegroundColor Gray
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

# Create the scheduled task
try {
    # Parse time
    $triggerTime = [DateTime]::ParseExact($Time, "HH:mm", $null)

    # Create action
    $action = New-ScheduledTaskAction -Execute $ScriptPath -WorkingDirectory (Split-Path $ScriptPath -Parent)

    # Create trigger - daily at specified time
    $trigger = New-ScheduledTaskTrigger -Daily -At $triggerTime

    # Create principal - run whether logged in or not
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Highest

    # Create settings
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -WakeToRun -StartWhenAvailable

    # Register the task
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

    Write-Host "SUCCESS: Task created!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Task Details:" -ForegroundColor Cyan
    Write-Host "  Name: $TaskName"
    Write-Host "  Time: $Time daily"
    Write-Host "  Features:" -ForegroundColor Gray
    Write-Host "    - Runs whether logged in or not"
    Write-Host "    - Wakes computer to run"
    Write-Host "    - Starts if missed"
    Write-Host ""

    # Show task info
    Get-ScheduledTask -TaskName $TaskName | Format-List TaskName, State, Description

} catch {
    Write-Host "ERROR: Failed to create task" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Write-Host ""
    Write-Host "Try running as Administrator or use the .bat version instead." -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "To test the task manually, run:" -ForegroundColor Gray
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'" -ForegroundColor White
Write-Host ""
Write-Host "To remove the task later, run:" -ForegroundColor Gray
Write-Host "  .\setup_tasks.ps1 -Remove" -ForegroundColor White
