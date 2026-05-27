@echo off
setlocal EnableExtensions EnableDelayedExpansion
if not "%CH_POSTINSTALL_KEEPOPEN%"=="1" (
  set "CH_POSTINSTALL_KEEPOPEN=1"
  cmd /k "set CH_POSTINSTALL_KEEPOPEN=1& call "%~f0" %*"
  exit /b 0
)
REM ============================================================================
REM  Post-installazione Context Harvester (dopo "Installa da VSIX" in VS Code).
REM  Crea/aggiorna il venv Python nell'estensione installata.
REM
REM  Uso:
REM    1) VS Code chiuso (consigliato)
REM    2) Estensioni -> Installa da VSIX -> context-harvester-0.3.0.vsix
REM    3) Doppio clic su questo file (dalla cartella release)
REM    4) Riapri VS Code -> Reload Window
REM ============================================================================

set "INSTALL_RC=0"
title Context Harvester - Post install Python

pushd "%~dp0" 2>nul
if errorlevel 1 (
  echo [ERRORE] Impossibile aprire la cartella dello script.
  set "INSTALL_RC=1"
  goto :fine
)

echo.
echo ============================================================
echo  Context Harvester - Post install Python
echo ============================================================
echo.

if exist "BUILD_INFO.txt" (
  echo --- BUILD_INFO.txt ---
  type "BUILD_INFO.txt"
  echo ----------------------
  echo.
)

set "EXT_DIR="
for /f "delims=" %%D in ('powershell -NoProfile -Command "$ErrorActionPreference='SilentlyContinue'; $name='context-harvester.context-harvester-*'; $dirs=@(); $dirs+=Get-ChildItem -Path (Join-Path $env:USERPROFILE '.vscode\extensions') -Directory -Filter $name -ErrorAction SilentlyContinue; $dirs+=Get-ChildItem -Path (Join-Path $env:USERPROFILE '.cursor\extensions') -Directory -Filter $name -ErrorAction SilentlyContinue; if(-not $dirs){ exit 1 }; $best=$dirs | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1; Write-Output $best.FullName"') do set "EXT_DIR=%%D"

if not defined EXT_DIR (
  echo [ERRORE] Estensione context-harvester non trovata.
  echo Installa prima il VSIX da VS Code: Estensioni - Installa da VSIX
  echo Poi rilancia questo script.
  set "INSTALL_RC=1"
  goto :fine
)

echo Estensione trovata:
echo   !EXT_DIR!
echo.

tasklist /fi "IMAGENAME eq Code.exe" | find /i "Code.exe" >nul 2>&1
if not errorlevel 1 (
  echo [AVVISO] VS Code e ancora in esecuzione. Chiudilo per evitare lock sul venv.
  choice /C SC /N /M "Premi S quando hai chiuso VS Code, C per annullare: "
  if errorlevel 2 (
    set "INSTALL_RC=1"
    goto :fine
  )
)
tasklist /fi "IMAGENAME eq Cursor.exe" | find /i "Cursor.exe" >nul 2>&1
if not errorlevel 1 (
  echo [AVVISO] Cursor e ancora in esecuzione. Chiudilo per evitare lock sul venv.
  choice /C SC /N /M "Premi S quando hai chiuso Cursor, C per annullare: "
  if errorlevel 2 (
    set "INSTALL_RC=1"
    goto :fine
  )
)

set "PY_EXE="
where python >nul 2>&1 && set "PY_EXE=python"
if not defined PY_EXE where python3 >nul 2>&1 && set "PY_EXE=python3"
if not defined PY_EXE (
  echo [ERRORE] Python 3.10+ non trovato nel PATH.
  set "INSTALL_RC=1"
  goto :fine
)

for /f "delims=" %%V in ('!PY_EXE! --version 2^>^&1') do echo [OK] %%V

set "VENV_DIR=!EXT_DIR!\python\.venv"
set "VENV_PY="
if exist "!VENV_DIR!\Scripts\python.exe" set "VENV_PY=!VENV_DIR!\Scripts\python.exe"
if not defined VENV_PY if exist "!VENV_DIR!\bin\python" set "VENV_PY=!VENV_DIR!\bin\python"

if not defined VENV_PY (
  echo Creazione virtualenv...
  !PY_EXE! -m venv "!VENV_DIR!"
  if errorlevel 1 (
    echo [ERRORE] Creazione venv fallita.
    set "INSTALL_RC=1"
    goto :fine
  )
)

if exist "!VENV_DIR!\Scripts\python.exe" (
  set "VENV_PY=!VENV_DIR!\Scripts\python.exe"
) else if exist "!VENV_DIR!\bin\python" (
  set "VENV_PY=!VENV_DIR!\bin\python"
)

if not exist "!VENV_PY!" (
  echo [ERRORE] Python del venv non trovato in !VENV_DIR!
  set "INSTALL_RC=1"
  goto :fine
)

set "REQ=!EXT_DIR!\python\requirements.txt"
if not exist "!REQ!" (
  echo [ERRORE] requirements.txt non trovato: !REQ!
  set "INSTALL_RC=1"
  goto :fine
)

echo Installazione dipendenze pip...
"!VENV_PY!" -m pip install --upgrade pip
"!VENV_PY!" -m pip install -r "!REQ!"
if errorlevel 1 (
  echo [ERRORE] pip install fallito.
  set "INSTALL_RC=1"
  goto :fine
)

echo.
echo [OK] Python pronto.
"!VENV_PY!" -m pip show chromadb | findstr /i "Name Version Location"
echo.
echo Riapri VS Code, Reload Window, poi Rebuild Index nel pannello.

:fine
echo.
echo ------------------------------------------------------------
if not "!INSTALL_RC!"=="0" (
  echo Post-install terminato con ERRORI ^(codice !INSTALL_RC!^).
) else (
  echo Post-install completato.
)
echo ------------------------------------------------------------
echo.
echo Premi un tasto per continuare...
pause >nul 2>&1
if errorlevel 1 pause
popd 2>nul
endlocal & exit /b !INSTALL_RC!
