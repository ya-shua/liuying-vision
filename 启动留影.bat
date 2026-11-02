@echo off
title liuying panel
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0eye-panel.ps1"
pause
