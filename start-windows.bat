@echo off
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 (
    python launch.py
) else (
    py -3 launch.py
)
if errorlevel 1 (
    echo Please install Python 3.10 or newer and check the error above.
    pause
    exit /b 1
)
