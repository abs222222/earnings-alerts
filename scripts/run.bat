@echo off
REM Earnings Alerts - Daily Run Script
REM This script is designed to be run by Windows Task Scheduler

REM Change to project directory
cd /d "%~dp0.."

REM Set up logging with date-stamped filename
for /f "tokens=1-3 delims=/" %%a in ("%date%") do (
    set DATESTR=%%c%%a%%b
)
set LOGFILE=data\run_%DATESTR%.log

REM Ensure data directory exists
if not exist "data" mkdir data

REM Log header
echo ========================================== >> %LOGFILE%
echo Run started at %date% %time% >> %LOGFILE%
echo ========================================== >> %LOGFILE%

REM Run the earnings check with any passed arguments
call npm run check %* >> %LOGFILE% 2>&1

REM Log completion
echo. >> %LOGFILE%
echo Run completed at %date% %time% >> %LOGFILE%
echo Exit code: %ERRORLEVEL% >> %LOGFILE%
echo ========================================== >> %LOGFILE%
echo. >> %LOGFILE%
