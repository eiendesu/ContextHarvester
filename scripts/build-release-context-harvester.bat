@echo off
setlocal EnableExtensions EnableDelayedExpansion
REM Finestra sempre aperta (doppio clic): attende un tasto anche in caso di errore.
if not "%CH_BUILD_KEEPOPEN%"=="1" (
  set "CH_BUILD_KEEPOPEN=1"
  cmd /k "set CH_BUILD_KEEPOPEN=1& call "%~f0" %*"
  exit /b 0
)
REM ============================================================================
REM  Rilascio Context Harvester: compila estensione + VSIX + pacchetto installazione.
REM
REM  Output (default D:\Rilasci\):
REM    <base>\ContextHarvester\<versione>\<timestamp UTC>\
REM
REM  Contenuto pacchetto (installazione completa con i due .bat):
REM    - context-harvester-<versione>.vsix
REM    - Installa-su-VSCode.bat     (VSIX + Python + Ollama)
REM    - Post-Installa-Python.bat   (solo venv pip / riparazione)
REM    - INSTALLA-QUI.txt, LEGGIMI-RILASCIO.txt, BUILD_INFO.txt
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
echo   Versione: !PKG_VER!
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
  echo Versione: !PKG_VER!
  echo Timestamp UTC: !PKG_STAMP!
  echo Pacchetto creato ^(locale^): !LOCAL_STAMP!
  echo Data/ora ISO UTC: !PKG_ISO!
)

echo [1/7] build-info.json ...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; $o=@{version='%PKG_VER%';buildUtc='%PKG_STAMP%';buildIso='%PKG_ISO%';buildLocal='%LOCAL_STAMP%'}; $p=Join-Path '%ROOT%' 'media\build-info.json'; $dir=Split-Path $p; if(-not(Test-Path $dir)){New-Item -ItemType Directory -Path $dir -Force|Out-Null}; $o|ConvertTo-Json|Set-Content -LiteralPath $p -Encoding UTF8"
if errorlevel 1 (
  echo [ERRORE] Generazione media\build-info.json fallita.
  set "BAT_RC=1"
  goto :pause_end
)

echo [2/7] Vendor 3d-force-graph ^(offline Graph View^) ...
if not exist "%ROOT%\webview\vendor\force-graph\3d-force-graph.min.js" (
  echo [AVVISO] 3d-force-graph.min.js mancante — esegui npm install e copia da node_modules
)
if not exist "%ROOT%\webview\vendor\force-graph\3d-force-graph.min.js" (
  echo [ERRORE] webview\vendor\force-graph\3d-force-graph.min.js mancante.
  set "BAT_RC=1"
  goto :pause_end
)
echo [OK] 3d-force-graph vendor presente.

echo [3/7] RoslynHarvester ^(.NET, per parser C# v5^) ...
set "ROSLYN_PROJ=%ROOT%\tools\RoslynHarvester\RoslynHarvester.csproj"
if exist "!ROSLYN_PROJ!" (
  where dotnet >nul 2>&1
  if errorlevel 1 (
    echo [AVVISO] dotnet non nel PATH — il VSIX includera comunque i sorgenti Roslyn.
    echo          Sul PC destinazione serve .NET 8 SDK oppure si usa il fallback regex.
  ) else (
    dotnet build "!ROSLYN_PROJ!" -c Release -v q
    if errorlevel 1 (
      echo [ERRORE] Build RoslynHarvester fallita.
      set "BAT_RC=1"
      goto :pause_end
    )
    echo [OK] RoslynHarvester compilato.
  )
) else (
  echo [AVVISO] tools\RoslynHarvester non trovato — salto build Roslyn.
)

echo [4/7] Dipendenze npm + compile TypeScript ...
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
echo [5/7] Creazione VSIX ^(estensione + python + webapp + tools/RoslynHarvester^) ...
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

echo [6/7] Verifica contenuto VSIX ...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $z='%OUT%\%VSIX_FILE%'; if(-not(Test-Path $z)){throw 'VSIX mancante'}; $t=Join-Path $env:TEMP ('ch-vsix-check-'+[guid]::NewGuid()); New-Item -ItemType Directory -Path $t -Force|Out-Null; try { [IO.Compression.ZipFile]::ExtractToDirectory($z,$t); $must=@('extension/python/requirements.txt','extension/python/webapp/templates/index.html','extension/tools/RoslynHarvester/RoslynHarvester.csproj','extension/webview/vendor/force-graph/3d-force-graph.min.js','extension/webview/vendor/force-graph/three.module.min.js'); foreach($m in $must){ if(-not(Test-Path (Join-Path $t $m))){ throw ('Manca nel VSIX: '+$m) } }; Write-Host '[OK] VSIX: python, webapp, Roslyn, 3d-force-graph vendor' } finally { Remove-Item $t -Recurse -Force -EA SilentlyContinue }"
if errorlevel 1 (
  echo [ERRORE] Verifica VSIX fallita — pacchetto incompleto.
  set "BAT_RC=1"
  goto :pause_end
)

echo.
echo [7/7] Script installazione + documentazione ...
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
copy /Y "%~dp0install-vsix-unpacked.ps1" "!OUT!\" >nul
if errorlevel 1 (
  echo [ERRORE] Copia install-vsix-unpacked.ps1 fallita
  set "BAT_RC=1"
  goto :pause_end
)
copy /Y "%~dp0INSTALLA-QUI.txt" "!OUT!\" >nul
if errorlevel 1 (
  echo [AVVISO] Copia INSTALLA-QUI.txt fallita
)

call :write_readme "!OUT!" "%ROOT%" "!PKG_VER!" "!PKG_STAMP!" "!PKG_ISO!" "!LOCAL_STAMP!" "!RELEASE_BASE!" "!VSIX_FILE!"
call :write_build_info "!OUT!" "!PKG_VER!" "!PKG_STAMP!" "!PKG_ISO!" "!LOCAL_STAMP!"

echo.
echo ============================================================
echo  Pacchetto di installazione COMPLETO.
echo.
echo   !OUT!
echo.
echo   File principali:
echo     !VSIX_FILE!
echo     Installa-su-VSCode.bat      ^(installazione completa^)
echo     Post-Installa-Python.bat    ^(solo Python / riparazione^)
echo     INSTALLA-QUI.txt
echo.
echo   Sul PC destinazione:
echo     1. Copia l INTERA cartella
echo     2. Chiudi VS Code / Cursor
echo     3. Doppio clic Installa-su-VSCode.bat
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
  echo Installazione: doppio clic Installa-su-VSCode.bat in questa cartella.
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
  echo Context Harvester — pacchetto di installazione completo
  echo ============================================================
  echo Versione:              %_V%
  echo Pacchetto creato ^(locale^): %_L%
  echo Timestamp pacchetto UTC: %_S%
  echo File VSIX:               %_X%
  echo Vedi anche:              BUILD_INFO.txt, INSTALLA-QUI.txt
  echo.
  echo Generato da: scripts\build-release-context-harvester.bat
  echo.
  echo INSTALLAZIONE COMPLETA ^(consigliata^)
  echo -----------------------------------
  echo 1. Copia questa INTERA cartella sul PC destinazione.
  echo 2. Chiudi VS Code e Cursor.
  echo 3. Doppio clic su Installa-su-VSCode.bat
  echo    - installa il VSIX
  echo    - configura Python ^(chiama Post-Installa-Python.bat^)
  echo    - propone installazione Ollama e modelli
  echo 4. Riapri VS Code / Cursor - Reload Window
  echo 5. Rebuild Index + Functional Analysis nel pannello
  echo 6. ^(Opzionale^) Avvia MCP - Apri Graph View ^(http://127.0.0.1:3456/^)
  echo.
  echo SOLO PYTHON ^(VSIX gia installato manualmente^)
  echo -----------------------------------------------
  echo 1. Estensioni - Installa da VSIX - %_X%
  echo 2. Chiudi l IDE
  echo 3. Doppio clic su Post-Installa-Python.bat
  echo 4. Reload Window
  echo.
  echo RIPARAZIONE venv / pip
  echo ---------------------
  echo Rilancia Post-Installa-Python.bat ^(con VS Code chiuso^).
  echo.
  echo Prerequisiti:
  echo   - VS Code 1.96+ o Cursor
  echo   - Python 3.10+ nel PATH
  echo   - Internet per pip alla prima installazione
  echo   - Ollama ^(localhost:11434^) — installabile dallo script
  echo   - .NET 8 SDK ^(opzionale, parser C# Roslyn v5^)
  echo.
  echo Modelli Ollama: cartella sorella ContextHarvesterModelli
  echo   ^(variabile utente OLLAMA_MODELS^)
) > "%_O%\LEGGIMI-RILASCIO.txt"
exit /b 0
