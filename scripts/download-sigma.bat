@echo off
setlocal EnableExtensions
REM Scarica Graphology + Sigma.js in webview\vendor\sigma (offline per Graph View)
cd /d "%~dp0..\webview\vendor"
if not exist sigma mkdir sigma
echo Download graphology + sigma...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; $d='sigma'; $base='https://unpkg.com'; Invoke-WebRequest -Uri ($base+'/graphology@0.25.4/dist/graphology.umd.min.js') -OutFile (Join-Path $d 'graphology.umd.min.js') -UseBasicParsing; Invoke-WebRequest -Uri ($base+'/sigma@2.4.0/build/sigma.min.js') -OutFile (Join-Path $d 'sigma.min.js') -UseBasicParsing; Write-Host '[OK] graphology + sigma in webview\vendor\sigma'"
if errorlevel 1 (
  echo [ERRORE] Download fallito. Verifica rete/proxy.
  exit /b 1
)
echo Fatto. Incluso nel VSIX e servito da /vendor/sigma/
pause
