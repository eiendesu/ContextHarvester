@echo off
REM Scarica vis-network 9.1.x in webview\vendor (offline per WebView VS Code)
setlocal
cd /d "%~dp0..\webview\vendor"
if not exist vis-network mkdir vis-network
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$b='vis-network'; Invoke-WebRequest -Uri 'https://unpkg.com/vis-network@9.1.6/standalone/umd/vis-network.min.js' -OutFile \"$b\vis-network.min.js\" -UseBasicParsing; Invoke-WebRequest -Uri 'https://unpkg.com/vis-network@9.1.6/styles/vis-network.min.css' -OutFile \"$b\vis-network.min.css\" -UseBasicParsing; Write-Host 'OK'"
echo Fatto.
pause
