@echo off
setlocal EnableExtensions EnableDelayedExpansion
REM Finestra sempre aperta (doppio clic): attende un tasto anche in caso di errore.
if not "%CH_BUILD_KEEPOPEN%"=="1" (
  set "CH_BUILD_KEEPOPEN=1"
  cmd /k "set CH_BUILD_KEEPOPEN=1& call "%~f0" %*"
  exit /b 0
)
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

cd /d "%~dp0.."
if errorlevel 1 (
  echo [ERRORE] Impossibile entrare nella cartella del repository.
  set "BAT_RC=1"
  goto :pause_end
)
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

pushd "%ROOT%"
if errorlevel 1 (
  echo [ERRORE] Impossibile aprire %ROOT%
  set "BAT_RC=1"
  goto :pause_end
)
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
mkdir "!OUT!"
if errorlevel 1 (
  echo [ERRORE] Impossibile creare la cartella di output:
  echo   !OUT!
  set "BAT_RC=1"
  goto :pause_end
)


> "!VER_DIR!\ULTIMA_BUILD.txt" (
  echo Ultima build Context Harvester
  echo.
  echo Cartella:
  echo   !OUT!
  echo.
  echo Timestamp UTC: !PKG_STAMP!
  echo Pacchetto creato ^(locale^): !LOCAL_STAMP!
  echo Data/ora ISO UTC: !PKG_ISO!
)

echo [1/4] build-info.json ^(versione + data/ora pacchetto^) ...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; $o=@{version='%PKG_VER%';buildUtc='%PKG_STAMP%';buildIso='%PKG_ISO%';buildLocal='%LOCAL_STAMP%'}; $p=Join-Path '%ROOT%' 'media\build-info.json'; $dir=Split-Path $p; if(-not(Test-Path $dir)){New-Item -ItemType Directory -Path $dir -Force|Out-Null}; $o|ConvertTo-Json|Set-Content -LiteralPath $p -Encoding UTF8"
if errorlevel 1 (
  echo [ERRORE] Generazione media\build-info.json fallita.
  set "BAT_RC=1"
  goto :pause_end
)

echo [2/4] Dipendenze npm + compile TypeScript ...
pushd "%ROOT%"
if errorlevel 1 (
  echo [ERRORE] Impossibile aprire %ROOT%
  set "BAT_RC=1"
  goto :pause_end
)

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
echo [3/4] Creazione VSIX ...
pushd "%ROOT%"
if errorlevel 1 (
  echo [ERRORE] Impossibile aprire %ROOT%
  set "BAT_RC=1"
  goto :pause_end
)

call npx --yes @vscode/vsce@latest package --allow-missing-repository --baseContentUrl "https://github.com/eiendesu/ContextHarvester/blob/main" --baseImagesUrl "https://github.com/eiendesu/ContextHarvester/raw/main" --out "!OUT!\!VSIX_FILE!"
set "VSCE_RC=!ERRORLEVEL!"
popd
if not "!VSCE_RC!"=="0" (
  echo [ERRORE] vsce non ha prodotto il VSIX ^(codice !VSCE_RC!^).
  set "BAT_RC=1"
  goto :pause_end
)

echo.
echo [4/4] Script installazione + LEGGIMI + BUILD_INFO ...
copy /Y "%~dp0Installa-su-VSCode.bat" "!OUT!\" >nul
if errorlevel 1 (
  echo [ERRORE] Copia Installa-su-VSCode.bat fallita
  set "BAT_RC=1"
  goto :pause_end
)
copy /Y "%~dp0Post-Installa-Python.bat" "!OUT!\" >nul
if errorlevel 1 (
  echo [ERRORE] Copia Post-Installa-Python.bat fallita
  set "BAT_RC=1"
  goto :pause_end
)

call :write_readme "!OUT!" "%ROOT%" "!PKG_VER!" "!PKG_STAMP!" "!PKG_ISO!" "!LOCAL_STAMP!" "!RELEASE_BASE!" "!VSIX_FILE!"
call :write_build_info "!OUT!" "!PKG_VER!" "!PKG_STAMP!" "!PKG_ISO!" "!LOCAL_STAMP!"

echo.
echo ============================================================
echo  Pacchetto pronto per la distribuzione.
echo.
echo   !OUT!
echo   VSIX:  !VSIX_FILE!
echo   Build: !LOCAL_STAMP!  ^(UTC !PKG_STAMP!^)
echo.
  echo  Sul PC destinazione: copia l INTERA cartella.
  echo  VSIX manuale: usa Post-Installa-Python.bat dopo Installa da VSIX.
echo ============================================================

start "" explorer "!OUT!"
goto :pause_end

:pause_end
echo.
echo ------------------------------------------------------------
if "!BAT_RC!"=="0" (
  echo Build completata.
) else (
  echo Build terminata con ERRORI ^(codice !BAT_RC!^).
  echo Controlla i messaggi [ERRORE] sopra.
)
echo ------------------------------------------------------------
echo.
echo Premi un tasto per continuare...
pause >nul 2>&1
if errorlevel 1 pause
exit /b !BAT_RC!

REM ---------------------------------------------------------------------------
:write_build_info
set "_O=%~1"
set "_V=%~2"
set "_S=%~3"
set "_I=%~4"
set "_L=%~5"
(
  echo Context Harvester — BUILD INFO
  echo ============================================================
  echo Versione estensione:     %_V%
  echo Pacchetto creato ^(locale^): %_L%
  echo Timestamp cartella UTC:  %_S%
  echo Data/ora ISO UTC:        %_I%
  echo.
  echo Sul pannello VS Code vedrai: v%_V% · %_L%
) > "%_O%\BUILD_INFO.txt"
exit /b 0

:write_readme
set "_O=%~1"
set "_R=%~2"
set "_V=%~3"
set "_S=%~4"
set "_I=%~5"
set "_L=%~6"
set "_B=%~7"
set "_X=%~8"
(
  echo Context Harvester — pacchetto di installazione
  echo ============================================================
  echo Versione:              %_V%
  echo Pacchetto creato ^(locale^): %_L%
  echo Timestamp pacchetto UTC: %_S%
  echo Data/ora ISO UTC:        %_I%
  echo File VSIX:               %_X%
  echo Vedi anche:              BUILD_INFO.txt
  echo Cartella base release:   %_B%
  echo.
  echo Generato da: scripts\build-release-context-harvester.bat
  echo Sorgente repo: %_R%
  echo.
  echo INSTALLAZIONE SU UN ALTRO PC
  echo ----------------------------
  echo 1. Copia questa intera cartella sul PC ^(USB, rete, zip^).
  echo.
  echo Metodo A ^(consigliato se usi sempre Installa da VSIX^):
  echo   a. VS Code chiuso
  echo   b. Estensioni - Installa da VSIX - context-harvester-0.3.0.vsix
  echo   c. Doppio clic su Post-Installa-Python.bat
  echo   d. Riapri VS Code - Reload Window
  echo.
  echo Metodo B ^(tutto in uno^):
  echo   Doppio clic su Installa-su-VSCode.bat
  echo    ^(installa VSIX + ambiente Python; chiudi VS Code prima^).
  echo 3. Installa-su-VSCode.bat propone anche:
  echo      - installazione Ollama ^(se assente^)
  echo      - download modelli in ..\ContextHarvesterModelli
  echo        ^(cartella sorella rispetto a questa release^)
  echo      - variabile utente OLLAMA_MODELS puntata a quella cartella
  echo 4. Riavvia VS Code / Cursor ^(e Ollama dal menu Start se hai cambiato OLLAMA_MODELS^).
  echo 5. Apri un workspace e usa il pannello Context Harvester ^(icona sidebar^).
  echo 6. ^(Opzionale^) Functional Analysis + valida community.
  echo 7. ^(Opzionale v4^) Avvia MCP dal pannello, poi Apri Graph View ^(browser su http://127.0.0.1:3456/^).
  echo      La web app e inclusa nel VSIX: python\webapp\ + vis.js in webview\vendor\.
  echo      Per label-first consigliato: ollama pull qwen3:4b ^(opzione durante install^).
  echo 8. ^(Opzionale^) Abilita MCP in Settings ^(genera .vscode/mcp.json^).
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
