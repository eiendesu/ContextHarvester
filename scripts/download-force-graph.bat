@echo off
setlocal EnableExtensions
REM Scarica Three.js + 3d-force-graph in webview\vendor\force-graph (offline per Graph View)
cd /d "%~dp0..\webview\vendor"
if not exist force-graph mkdir force-graph
if exist "%~dp0..\node_modules\three\build\three.module.min.js" (
  copy /Y "%~dp0..\node_modules\three\build\three.module.min.js" force-graph\
  copy /Y "%~dp0..\node_modules\3d-force-graph\dist\3d-force-graph.min.js" force-graph\
  echo [OK] Copiati da node_modules
  goto :end
)
echo Download three + 3d-force-graph da CDN...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; $d='force-graph'; $base='https://cdn.jsdelivr.net/npm'; Invoke-WebRequest -Uri ($base+'/three@0.179.0/build/three.module.min.js') -OutFile (Join-Path $d 'three.module.min.js') -UseBasicParsing; Invoke-WebRequest -Uri ($base+'/3d-force-graph@1.80.0/dist/3d-force-graph.min.js') -OutFile (Join-Path $d '3d-force-graph.min.js') -UseBasicParsing; Write-Host '[OK] three + 3d-force-graph in webview\vendor\force-graph'"
if errorlevel 1 (
  echo [ERRORE] Download fallito. Verifica rete/proxy.
  exit /b 1
)
:end
echo Fatto. Incluso nel VSIX e servito da /vendor/force-graph/
pause
