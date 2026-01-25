@echo off
echo Creating Earnings Alerts scheduled task...
echo.
echo NOTE: You will be prompted for your Windows password.
echo This is required for "Run whether logged in or not" option.
echo.

REM Get the directory where this script is located
set SCRIPT_DIR=%~dp0

REM Delete existing task first (ignore errors if it doesn't exist)
schtasks /delete /tn "Earnings Alerts - Daily Check" /f 2>nul

REM Create 6am daily task with:
REM   /ru %USERNAME% - Run as current user
REM   /rl HIGHEST - Run with highest privileges
REM   /z - Wake computer to run
schtasks /create /tn "Earnings Alerts - Daily Check" /tr "%SCRIPT_DIR%run.bat" /sc daily /st 06:00 /ru %USERNAME% /rl HIGHEST /z /f

if %ERRORLEVEL% EQU 0 (
    echo.
    echo SUCCESS: Created "Earnings Alerts - Daily Check" at 6:00 AM
    echo   - Runs whether logged in or not
    echo   - Wakes computer to run
    echo.
) else (
    echo.
    echo FAILED: Could not create task - try running as Administrator
    echo.
)

echo Listing task details:
echo ========================================
schtasks /query /tn "Earnings Alerts - Daily Check" /fo list

pause
