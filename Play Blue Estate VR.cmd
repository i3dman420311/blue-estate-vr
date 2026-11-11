@echo off
setlocal
cd /d "%~dp0"
python "%~dp0play_vr.py" %*
if errorlevel 1 pause
