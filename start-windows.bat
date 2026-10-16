@echo off
title Sourcing Radar
cd /d "%~dp0"
echo Starting Sourcing Radar. Please keep this window open.
if not exist "launch.py" (
    echo ERROR: Extract the entire ZIP first. Do not run this file inside the ZIP.
    pause
    exit /b 1
)
where py >nul 2>nul
if errorlevel 1 (
    python launch.py
) else (
    py -3 launch.py
)
if errorlevel 1 (
    echo Please install Python 3.10 or newer and check the error above.
    echo Python download: https://www.python.org/downloads/
    pause
    exit /b 1
)
echo The program has stopped. Check any messages above.
pause
