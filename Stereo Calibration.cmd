@echo off
cd /d "%~dp0"
python stereo_calibration.py
if errorlevel 1 pause
