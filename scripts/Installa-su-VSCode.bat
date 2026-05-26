@echo off
setlocal EnableExtensions EnableDelayedExpansion
REM ============================================================================
REM  Installa Context Harvester su questa macchina.
REM  Copia sul PC l'intera cartella di rilascio ^(VSIX + questo file^), poi doppio clic.
REM ============================================================================

set "INSTALL_RC=0"

title Context Harvester - Installazione

pushd "%~dp0" 2>nul
if errorlevel 1 (
  echo [ERRORE] Impossibile aprire la cartella dello script.
  set "INSTALL_RC=1"
  goto :fine
)

echo.
echo ============================================================
echo  Context Harvester - Installazione
echo  Cartella: %CD%
echo ============================================================
echo.

set "VSIX="
for %%F in (context-harvester-*.vsix) do set "VSIX=%%F"
if not defined VSIX (
  echo [ERRORE] Nessun file context-harvester-*.vsix trovato qui.
  echo Copia l'intera cartella di rilascio ^(VSIX + Installa-su-VSCode.bat + LEGGIMI-RILASCIO.txt^).
  echo.
  set "INSTALL_RC=1"
  goto :fine
)

set "CODE_EXE="
if exist "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" (
  set "CODE_EXE=%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe"
  goto :dopo_ide
)
if exist "%ProgramFiles%\Microsoft VS Code\Code.exe" (
  set "CODE_EXE=%ProgramFiles%\Microsoft VS Code\Code.exe"
  goto :dopo_ide
)
where code >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%i in ('where code 2^>nul') do (
    set "CODE_EXE=%%i"
    goto :dopo_ide
  )
)
if exist "%LOCALAPPDATA%\Programs\cursor\Cursor.exe" (
  set "CODE_EXE=%LOCALAPPDATA%\Programs\cursor\Cursor.exe"
  goto :dopo_ide
)
where cursor >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%i in ('where cursor 2^>nul') do (
    set "CODE_EXE=%%i"
    goto :dopo_ide
  )
)

:dopo_ide
if not defined CODE_EXE (
  echo [AVVISO] VS Code / Cursor non trovato automaticamente.
  echo Provo comunque l installazione VSIX nella cartella profilo .vscode\extensions
  set "EXT_TARGET=%USERPROFILE%\.vscode\extensions"
  goto :install_vsix
)

set "EXT_TARGET=%USERPROFILE%\.vscode\extensions"
echo "!CODE_EXE!" | findstr /i "Cursor.exe" >nul 2>&1 && set "EXT_TARGET=%USERPROFILE%\.cursor\extensions"

:install_vsix
echo Destinazione estensioni: !EXT_TARGET!
echo Pacchetto VSIX:          !VSIX!
echo.
echo [1/3] Installazione estensione ^(estrazione VSIX^)...

set "CH_VSIX=%CD%\!VSIX!"
set "CH_EXT=!EXT_TARGET!"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $v=$env:CH_VSIX; $r=$env:CH_EXT; if(-not(Test-Path -LiteralPath $v)){throw 'VSIX non trovato: ' + $v}; if(-not(Test-Path -LiteralPath $r)){New-Item -ItemType Directory -Path $r -Force | Out-Null}; $t=Join-Path $env:TEMP ('ch-vsix-' + [guid]::NewGuid().ToString()); New-Item -ItemType Directory -Path $t -Force | Out-Null; try { Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($v, $t); $e=Join-Path $t 'extension'; if(-not(Test-Path -LiteralPath (Join-Path $e 'package.json'))){ throw 'VSIX non valido' }; $j=Get-Content -LiteralPath (Join-Path $e 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json; if(-not $j.publisher -or -not $j.name -or -not $j.version){ throw 'package.json incompleto' }; $d=Join-Path $r ($j.publisher + '.' + $j.name + '-' + $j.version); if(Test-Path -LiteralPath $d){ Remove-Item -LiteralPath $d -Recurse -Force }; Copy-Item -LiteralPath $e -Destination $d -Recurse; Write-Host ('[OK] Estensione in: ' + $d); $env:CH_EXT_DIR=$d } finally { Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue }"
if errorlevel 1 (
  echo [ERRORE] Installazione VSIX fallita.
  echo Alternativa: nell IDE ^> Estensioni ^> Installa da VSIX ^> seleziona !VSIX!
  set "INSTALL_RC=1"
  goto :fine
)

REM Leggi cartella estensione installata da file temporaneo PowerShell non persiste env - ricalcola da package.json nel VSIX
set "EXT_DIR="
for /f "delims=" %%D in ('powershell -NoProfile -Command "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $v='%CH_VSIX%'; $t=Join-Path $env:TEMP ('ch-read-' + [guid]::NewGuid()); New-Item -ItemType Directory -Path $t -Force | Out-Null; try { [System.IO.Compression.ZipFile]::ExtractToDirectory($v, $t); $j=Get-Content (Join-Path $t 'extension\package.json') -Raw | ConvertFrom-Json; Write-Output (Join-Path '%EXT_TARGET%' ($j.publisher + '.' + $j.name + '-' + $j.version)) } finally { Remove-Item $t -Recurse -Force -EA SilentlyContinue }"') do set "EXT_DIR=%%D"

set "CH_VSIX="
set "CH_EXT="

if not defined EXT_DIR (
  echo [AVVISO] Impossibile determinare cartella estensione per setup Python.
  goto :check_ollama
)
if not exist "!EXT_DIR!" (
  echo [AVVISO] Cartella estensione non trovata: !EXT_DIR!
  goto :check_ollama
)

echo.
echo [2/3] Ambiente Python dell estensione...
echo Cartella: !EXT_DIR!

set "PY_EXE="
where python >nul 2>&1 && set "PY_EXE=python"
if not defined PY_EXE (
  where python3 >nul 2>&1 && set "PY_EXE=python3"
)
if not defined PY_EXE (
  echo [ERRORE] Python 3.10+ non trovato nel PATH.
  echo Installa da https://www.python.org/downloads/ ^(spunta Add to PATH^).
  echo L estensione e installata ma il backend Python non e pronto.
  set "INSTALL_RC=1"
  goto :check_ollama
)

for /f "delims=" %%V in ('!PY_EXE! --version 2^>^&1') do echo [OK] %%V

set "VENV_DIR=!EXT_DIR!\python\.venv"
set "VENV_PY=!VENV_DIR!\Scripts\python.exe"
if not exist "!VENV_PY!" set "VENV_PY=!VENV_DIR!\bin\python"

if not exist "!VENV_PY!" (
  echo Creazione virtualenv in python\.venv ...
  !PY_EXE! -m venv "!VENV_DIR!"
  if errorlevel 1 (
    echo [ERRORE] Creazione venv fallita.
    set "INSTALL_RC=1"
    goto :check_ollama
  )
)

set "REQ=!EXT_DIR!\python\requirements.txt"
if exist "!REQ!" (
  echo Installazione dipendenze pip ^(chromadb, ollama^)...
  "!VENV_PY!" -m pip install --upgrade pip
  "!VENV_PY!" -m pip install -r "!REQ!"
  if errorlevel 1 (
    echo [ERRORE] pip install fallito. Verifica rete e proxy.
    set "INSTALL_RC=1"
  ) else (
    echo [OK] Dipendenze Python installate.
  )
) else (
  echo [AVVISO] requirements.txt non trovato in !EXT_DIR!\python
)

:check_ollama
echo.
echo [3/3] Verifica Ollama ^(opzionale ma necessario per l uso^)...
where ollama >nul 2>&1
if errorlevel 1 (
  echo [AVVISO] Comando ollama non nel PATH.
  echo Installa da https://ollama.com poi esegui:
  echo   ollama pull nomic-embed-text
  echo   ollama pull qwen2.5:3b
) else (
  for /f "delims=" %%V in ('ollama --version 2^>nul') do echo [OK] %%V
  echo Modelli consigliati:
  echo   ollama pull nomic-embed-text
  echo   ollama pull qwen2.5:3b
)

:fine
echo.
echo ------------------------------------------------------------
if not "!INSTALL_RC!"=="0" (
  echo Installazione terminata con errori ^(codice !INSTALL_RC!^).
  echo Correggi gli avvisi sopra e rilancia questo script se necessario.
) else (
  echo Installazione completata.
  echo Riavvia VS Code / Cursor e apri il pannello Context Harvester dalla sidebar.
)
echo.
echo Leggi LEGGIMI-RILASCIO.txt per dettagli e modelli Ollama.
echo ------------------------------------------------------------
pause
popd 2>nul
endlocal & exit /b %INSTALL_RC%
