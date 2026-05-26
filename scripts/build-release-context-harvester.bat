@echo off
setlocal EnableExtensions EnableDelayedExpansion
REM ============================================================================
REM  Rilascio Context Harvester: compila estensione + VSIX in cartella versionata.
REM
REM  Struttura output (default: D:\Rilasci\):
REM    <release base>\ContextHarvester\<versione semver>\<timestamp UTC>\
REM    es.  D:\Rilasci\ContextHarvester\0.1.0\20260526-143022\
REM
REM  Configurazione cartella base (priorita):
REM    1) Primo argomento:  scripts\build-release-context-harvester.bat "C:\altro"
REM    2) Variabile ambiente:  CONTEXT_HARVESTER_RELEASE_ROOT
REM    3) Default:            D:\Rilasci
REM
REM  Nella cartella di output trovi:
REM    - context-harvester-<versione>.vsix
REM    - Installa-su-VSCode.bat  ^(copiato: da lanciare sul PC destinazione^)
REM    - LEGGIMI-RILASCIO.txt
REM ============================================================================

set "BAT_RC=0"

cd /d "%~dp0.." || (set "BAT_RC=1" & goto :pause_end)
set "ROOT=%CD%"

set "REL_OUT=%~1"
if "!REL_OUT!"=="" set "REL_OUT=%CONTEXT_HARVESTER_RELEASE_ROOT%"
if "!REL_OUT!"=="" set "REL_OUT=D:\Rilasci"

set "RELEASE_BASE=!REL_OUT!"
set "IS_ABS=0"
echo !REL_OUT! | findstr /i /r "^[A-Za-z]:[\\/]" >nul 2>&1 && set "IS_ABS=1"
if "!IS_ABS!"=="0" echo !REL_OUT! | findstr /r "^\\\\" >nul 2>&1 && set "IS_ABS=1"
if "!IS_ABS!"=="0" set "RELEASE_BASE=%ROOT%\!REL_OUT!"

echo.
echo Repo:          %ROOT%
echo Release base:  !RELEASE_BASE!
echo.

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERRORE] npm non trovato nel PATH.
  set "BAT_RC=1"
  goto :pause_end
)
where node >nul 2>&1
if errorlevel 1 (
  echo [ERRORE] node non trovato nel PATH.
  set "BAT_RC=1"
  goto :pause_end
)

if not exist "%ROOT%\package.json" (
  echo [ERRORE] package.json non trovato in %ROOT%
  set "BAT_RC=1"
  goto :pause_end
)

pushd "%ROOT%" || (set "BAT_RC=1" & goto :pause_end)
for /f "delims=" %%V in ('node -p "require('./package.json').version" 2^>nul') do set "PKG_VER=%%V"
for /f "delims=" %%F in ('node -p "const p=require('./package.json');p.name+'-'+p.version+'.vsix'" 2^>nul') do set "VSIX_FILE=%%F"
popd

if not defined PKG_VER (
  echo [ERRORE] Impossibile leggere versione da package.json
  set "BAT_RC=1"
  goto :pause_end
)
if not defined VSIX_FILE (
  echo [ERRORE] Impossibile derivare nome file VSIX da package.json
  set "BAT_RC=1"
  goto :pause_end
)

for /f "tokens=1,2 delims=#" %%A in ('powershell -NoProfile -Command "$u=(Get-Date).ToUniversalTime(); Write-Output ($u.ToString('yyyyMMdd-HHmmss') + '#' + $u.ToString('o'))"') do (
  set "PKG_STAMP=%%A"
  set "PKG_ISO=%%B"
)

for /f "delims=" %%L in ('powershell -NoProfile -Command "(Get-Date).ToString('yyyy-MM-dd HH:mm:ss')"') do set "LOCAL_STAMP=%%L"

set "VER_DIR=!RELEASE_BASE!\ContextHarvester\!PKG_VER!"
set "OUT=!VER_DIR!\!PKG_STAMP!"

echo Cartella pacchetto:
echo   !OUT!
echo   Timestamp UTC: !PKG_STAMP!
echo.

if exist "!OUT!" (
  echo [AVVISO] Cartella esistente, verra svuotata.
  rmdir /s /q "!OUT!"
)
mkdir "!OUT!" || (set "BAT_RC=1" & goto :pause_end)

> "!VER_DIR!\ULTIMA_BUILD.txt" (
  echo Ultima build Context Harvester
  echo.
  echo Cartella:
  echo   !OUT!
  echo.
  echo Timestamp UTC: !PKG_STAMP!
  echo Avvio script:  !LOCAL_STAMP!
)

echo [1/3] Dipendenze npm + compile TypeScript ...
pushd "%ROOT%" || (set "BAT_RC=1" & goto :pause_end)
if exist package-lock.json (
  call npm ci
) else (
  call npm install
)
if errorlevel 1 (
  popd
  echo [ERRORE] npm install fallito
  set "BAT_RC=1"
  goto :pause_end
)
call npm run compile
if errorlevel 1 (
  popd
  echo [ERRORE] compile fallito
  set "BAT_RC=1"
  goto :pause_end
)
popd

echo.
echo [2/3] Creazione VSIX ...
pushd "%ROOT%" || (set "BAT_RC=1" & goto :pause_end)
call npx --yes @vscode/vsce@latest package --allow-missing-repository --out "!OUT!\!VSIX_FILE!"
set "VSCE_RC=!ERRORLEVEL!"
popd
if not "!VSCE_RC!"=="0" (
  echo [ERRORE] vsce non ha prodotto il VSIX ^(codice !VSCE_RC!^).
  set "BAT_RC=1"
  goto :pause_end
)

echo.
echo [3/3] Script installazione + LEGGIMI ...
copy /Y "%~dp0Installa-su-VSCode.bat" "!OUT!\" >nul
if errorlevel 1 (
  echo [ERRORE] Copia Installa-su-VSCode.bat fallita
  set "BAT_RC=1"
  goto :pause_end
)

call :write_readme "!OUT!" "%ROOT%" "!PKG_VER!" "!PKG_STAMP!" "!PKG_ISO!" "!RELEASE_BASE!" "!VSIX_FILE!"

echo.
echo ============================================================
echo  Pacchetto pronto per la distribuzione.
echo.
echo   !OUT!
echo   VSIX:  !VSIX_FILE!
echo.
echo  Sul PC destinazione: copia l INTERA cartella e lancia
echo    Installa-su-VSCode.bat
echo ============================================================

start "" explorer "!OUT!"
goto :pause_end

:pause_end
echo.
pause
exit /b %BAT_RC%

REM ---------------------------------------------------------------------------
:write_readme
set "_O=%~1"
set "_R=%~2"
set "_V=%~3"
set "_S=%~4"
set "_I=%~5"
set "_B=%~6"
set "_X=%~7"
(
  echo Context Harvester — pacchetto di installazione
  echo ============================================================
  echo Versione:              %_V%
  echo Timestamp pacchetto UTC: %_S%
  echo Data/ora ISO UTC:        %_I%
  echo File VSIX:               %_X%
  echo Cartella base release:   %_B%
  echo.
  echo Generato da: scripts\build-release-context-harvester.bat
  echo Sorgente repo: %_R%
  echo.
  echo INSTALLAZIONE SU UN ALTRO PC
  echo ----------------------------
  echo 1. Copia questa intera cartella sul PC ^(USB, rete, zip^).
  echo 2. Doppio clic su Installa-su-VSCode.bat
  echo    ^(installa VSIX + ambiente Python dell estensione^).
  echo 3. Installa Ollama da https://ollama.com e scarica i modelli:
  echo      ollama pull nomic-embed-text
  echo      ollama pull qwen2.5:3b
  echo 4. Riavvia VS Code / Cursor.
  echo 5. Apri un workspace e usa il pannello Context Harvester ^(icona sidebar^).
  echo.
  echo Prerequisiti sul PC destinazione:
  echo   - VS Code 1.96+ oppure Cursor
  echo   - Python 3.10+ nel PATH ^(python o python3^)
  echo   - Ollama in esecuzione ^(localhost:11434^)
  echo   - Connessione internet per pip alla prima installazione
  echo.
  echo Installazione manuale alternativa:
  echo   code --install-extension %_X%
  echo   ^(poi creare venv in python\.venv sotto la cartella estensione^)
) > "%_O%\LEGGIMI-RILASCIO.txt"
exit /b 0
