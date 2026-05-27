@echo off
setlocal EnableExtensions EnableDelayedExpansion
if not "%CH_INSTALL_KEEPOPEN%"=="1" (
  set "CH_INSTALL_KEEPOPEN=1"
  cmd /k "set CH_INSTALL_KEEPOPEN=1& call "%~f0" %*"
  exit /b 0
)
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

if exist "BUILD_INFO.txt" (
  echo --- BUILD_INFO.txt ---
  type "BUILD_INFO.txt"
  echo ----------------------
  echo.
) else if exist "LEGGIMI-RILASCIO.txt" (
  for /f "tokens=1,* delims=:" %%A in ('findstr /i "Versione Pacchetto creato Timestamp" "LEGGIMI-RILASCIO.txt" 2^>nul') do echo %%A:%%B
  echo.
)

set "VSIX="
for %%F in (context-harvester-*.vsix) do set "VSIX=%%F"
if not defined VSIX (
  echo [ERRORE] Nessun file context-harvester-*.vsix trovato qui.
  echo Copia l'intera cartella di rilascio ^(VSIX + Installa-su-VSCode.bat + LEGGIMI-RILASCIO.txt^).
  echo.
  set "INSTALL_RC=1"
  goto :fine
)

set "CH_VSIX=%CD%\!VSIX!"
set "CODE_EXE="
set "CURSOR_EXE="
set "RUNNING_IDE_EXE="
if exist "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" set "CODE_EXE=%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe"
if not defined CODE_EXE if exist "%ProgramFiles%\Microsoft VS Code\Code.exe" set "CODE_EXE=%ProgramFiles%\Microsoft VS Code\Code.exe"
if not defined CODE_EXE (
  where code >nul 2>&1
  if not errorlevel 1 for /f "delims=" %%i in ('where code 2^>nul') do if not defined CODE_EXE set "CODE_EXE=%%i"
)
if exist "%LOCALAPPDATA%\Programs\cursor\Cursor.exe" set "CURSOR_EXE=%LOCALAPPDATA%\Programs\cursor\Cursor.exe"
if not defined CURSOR_EXE (
  where cursor >nul 2>&1
  if not errorlevel 1 for /f "delims=" %%i in ('where cursor 2^>nul') do if not defined CURSOR_EXE set "CURSOR_EXE=%%i"
)
for /f "delims=" %%P in ('powershell -NoProfile -Command "$p=(Get-CimInstance Win32_Process -Filter \"Name='Cursor.exe' OR Name='Code.exe'\" | Select-Object -First 1 -ExpandProperty ExecutablePath); if($p){Write-Output $p}"') do set "RUNNING_IDE_EXE=%%P"
if defined RUNNING_IDE_EXE (
  echo [INFO] IDE attualmente in esecuzione: !RUNNING_IDE_EXE!
  echo Chiudi VS Code / Cursor prima di installare il VSIX per evitare lock/versioni vecchie.
  choice /C SC /N /M "Premi S quando hai chiuso l IDE, C per annullare: "
  if errorlevel 2 (
    set "INSTALL_RC=1"
    goto :fine
  )
  call :wait_ide_closed
  set "CODE_EXE="
  set "CURSOR_EXE="
  echo !RUNNING_IDE_EXE! | findstr /i "Cursor.exe" >nul 2>&1 && set "CURSOR_EXE=!RUNNING_IDE_EXE!"
  echo !RUNNING_IDE_EXE! | findstr /i "Code.exe" >nul 2>&1 && set "CODE_EXE=!RUNNING_IDE_EXE!"
)

echo Pacchetto VSIX: !VSIX!
echo.
echo [1/3] Installazione estensione ^(CLI IDE, fallback estrazione^)...
set "INSTALL_METHOD="
if defined CURSOR_EXE call :install_with_cli "!CURSOR_EXE!" "Cursor"
if not defined INSTALL_METHOD if defined CODE_EXE call :install_with_cli "!CODE_EXE!" "VS Code"

if not defined INSTALL_METHOD (
  echo [AVVISO] Installazione via CLI non riuscita/non disponibile, uso estrazione VSIX.
  set "EXT_TARGET=%USERPROFILE%\.cursor\extensions"
  if not defined CURSOR_EXE set "EXT_TARGET=%USERPROFILE%\.vscode\extensions"
  echo Destinazione estensioni: !EXT_TARGET!
  set "CH_EXT=!EXT_TARGET!"
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $v=$env:CH_VSIX; $r=$env:CH_EXT; if(-not(Test-Path -LiteralPath $v)){throw 'VSIX non trovato: ' + $v}; if(-not(Test-Path -LiteralPath $r)){New-Item -ItemType Directory -Path $r -Force | Out-Null}; $t=Join-Path $env:TEMP ('ch-vsix-' + [guid]::NewGuid().ToString()); New-Item -ItemType Directory -Path $t -Force | Out-Null; try { Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($v, $t); $e=Join-Path $t 'extension'; if(-not(Test-Path -LiteralPath (Join-Path $e 'package.json'))){ throw 'VSIX non valido' }; $j=Get-Content -LiteralPath (Join-Path $e 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json; if(-not $j.publisher -or -not $j.name -or -not $j.version){ throw 'package.json incompleto' }; $d=Join-Path $r ($j.publisher + '.' + $j.name + '-' + $j.version); if(Test-Path -LiteralPath $d){ Remove-Item -LiteralPath $d -Recurse -Force }; Copy-Item -LiteralPath $e -Destination $d -Recurse; Write-Host ('[OK] Estensione in: ' + $d) } finally { Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue }"
  if errorlevel 1 (
    echo [ERRORE] Installazione VSIX fallita.
    echo Alternativa: nell IDE ^> Estensioni ^> Installa da VSIX ^> seleziona !VSIX!
    set "INSTALL_RC=1"
    goto :fine
  )
  set "INSTALL_METHOD=extract"
)
echo [OK] Metodo installazione: !INSTALL_METHOD!

echo.
echo [AVVISO] Se nel pannello vedi ancora una versione vecchia ^(es. v2^):
echo   1. Estensioni ^> disinstalla "Context Harvester" ^(tutte le versioni^)
echo   2. Rilancia questo script oppure Installa da VSIX
echo   3. Riavvia VS Code / Cursor

set "EXT_DIR="
for /f "delims=" %%D in ('powershell -NoProfile -Command "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $v='%CH_VSIX%'; $t=Join-Path $env:TEMP ('ch-read-' + [guid]::NewGuid()); New-Item -ItemType Directory -Path $t -Force | Out-Null; try { [System.IO.Compression.ZipFile]::ExtractToDirectory($v, $t); $j=Get-Content (Join-Path $t 'extension\package.json') -Raw | ConvertFrom-Json; $name=$j.publisher + '.' + $j.name + '-' + $j.version; $candidates=@(Join-Path $env:USERPROFILE ('.cursor\extensions\' + $name), Join-Path $env:USERPROFILE ('.vscode\extensions\' + $name)); $found=$candidates | Where-Object { Test-Path -LiteralPath $_ }; if($found){ $best=$found | Sort-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc } -Descending | Select-Object -First 1; Write-Output $best } } finally { Remove-Item $t -Recurse -Force -EA SilentlyContinue }"') do set "EXT_DIR=%%D"

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
call :resolve_venv_py

if not exist "!VENV_PY!" (
  echo Creazione virtualenv in python\.venv ...
  !PY_EXE! -m venv "!VENV_DIR!"
  if errorlevel 1 (
    echo [ERRORE] Creazione venv fallita.
    set "INSTALL_RC=1"
    goto :check_ollama
  )
  call :resolve_venv_py
)

if not exist "!VENV_PY!" (
  echo [ERRORE] Python del virtualenv non trovato in !VENV_DIR!
  echo Atteso: Scripts\python.exe ^(Windows^) o bin\python ^(Linux/macOS^).
  set "INSTALL_RC=1"
  goto :check_ollama
)

set "REQ=!EXT_DIR!\python\requirements.txt"
if exist "!REQ!" (
  echo Installazione dipendenze pip ^(chromadb, ollama, networkx, graspologic, mcp^)...
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
echo [3/3] Ollama e modelli AI...
echo.

REM Cartella modelli: una directory sopra questa script, sottocartella ContextHarvesterModelli
set "MODELS_DIR=%~dp0..\ContextHarvesterModelli"
for %%I in ("!MODELS_DIR!") do set "MODELS_DIR=%%~fI"
if not exist "!MODELS_DIR!" (
  echo Creazione cartella modelli: !MODELS_DIR!
  mkdir "!MODELS_DIR!" 2>nul
)
echo Cartella modelli: !MODELS_DIR!

REM Imposta OLLAMA_MODELS per l utente ^(richiede riavvio Ollama dal menu Start^)
for /f "tokens=1,* delims==" %%A in ('setx OLLAMA_MODELS "!MODELS_DIR!" 2^>nul') do (
  if /i "%%A"=="SUCCESS" echo [OK] Variabile utente OLLAMA_MODELS impostata.
)
set "OLLAMA_MODELS=!MODELS_DIR!"

if not exist "!MODELS_DIR!\LEGGIMI.txt" (
  (
    echo Context Harvester - cartella modelli Ollama
    echo =============================================
    echo I modelli scaricati dall installazione vengono salvati qui.
    echo Variabile di sistema utente: OLLAMA_MODELS = questa cartella
    echo.
    echo Dopo aver cambiato OLLAMA_MODELS, esci da Ollama ^(icona tray^) e riaprilo.
    echo Profilo consigliato: laptop-balanced ^(nomic-embed-text, qwen3:8b^)
  ) > "!MODELS_DIR!\LEGGIMI.txt"
)

set "OLLAMA_EXE="
where ollama >nul 2>&1 && set "OLLAMA_EXE=ollama"
if not defined OLLAMA_EXE (
  if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" (
    set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
  )
)

if not defined OLLAMA_EXE (
  echo [AVVISO] Ollama non e installato o non e nel PATH.
  echo.
  choice /C SN /N /M "Scaricare e installare Ollama ora? (S/N): "
  if errorlevel 2 goto :ollama_modelli
  if errorlevel 1 goto :install_ollama
  goto :ollama_modelli
)

for /f "delims=" %%V in ('"!OLLAMA_EXE!" --version 2^>nul') do echo [OK] %%V
goto :ollama_modelli

:install_ollama
echo.
echo Download installer Ollama...
set "OLLAMA_SETUP=%TEMP%\OllamaSetup.exe"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri 'https://ollama.com/download/OllamaSetup.exe' -OutFile '%OLLAMA_SETUP%' -UseBasicParsing; exit 0 } catch { Write-Host $_.Exception.Message; exit 1 }"
if errorlevel 1 (
  echo [ERRORE] Download fallito. Apri manualmente: https://ollama.com/download
  set "INSTALL_RC=1"
  goto :ollama_modelli
)
echo Avvio installazione Ollama ^(accetta il wizard se visibile^)...
start /wait "" "%OLLAMA_SETUP%" 
del "%OLLAMA_SETUP%" 2>nul

if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" (
  set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
) else (
  where ollama >nul 2>&1 && set "OLLAMA_EXE=ollama"
)
if not defined OLLAMA_EXE (
  echo [AVVISO] Installazione completata ma ollama.exe non trovato.
  echo Riavvia il PC o apri un nuovo prompt, poi rilancia questo script.
  set "INSTALL_RC=1"
  goto :ollama_modelli
)
echo [OK] Ollama installato.
echo IMPORTANTE: esci da Ollama ^(icona tray - Esci^) e riaprilo dal menu Start
echo             cosi usa la cartella modelli: !MODELS_DIR!
timeout /t 3 /nobreak >nul

:ollama_modelli
if not defined OLLAMA_EXE (
  echo.
  echo Salto download modelli ^(Ollama non disponibile^).
  goto :fine
)

echo.
echo Modelli per il profilo laptop-balanced ^(salvati in !MODELS_DIR!^):
echo   - nomic-embed-text   ^(embedding^)
echo   - qwen3:8b           ^(HyDE, re-ranking, classifier, structurer^)
echo   - qwen3:4b           ^(label-first Graph View v4 — opzionale sotto^)
echo.
echo Nota: il re-ranking usa lo stesso LLM ^(prompt 0-10^), non bge-reranker-base
echo       ^(quel nome non esiste nel catalogo Ollama^).
echo.

REM Avvia servizio Ollama se non risponde
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { (Invoke-WebRequest -Uri 'http://127.0.0.1:11434' -UseBasicParsing -TimeoutSec 2).StatusCode | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
  echo Avvio Ollama in background...
  start "" /B "!OLLAMA_EXE!" serve >nul 2>&1
  timeout /t 5 /nobreak >nul
)

call :pull_model_if_missing nomic-embed-text
call :pull_model_if_missing qwen3:8b

echo.
choice /C SN /N /M "Scaricare qwen3:4b per Graph View label-first e altri opzionali ^(qwen3:14b^)? (S/N): "
if errorlevel 2 goto :ollama_done
call :pull_model_if_missing qwen3:4b
call :pull_model_if_missing qwen3:14b
goto :ollama_done

:wait_ide_closed
:wait_ide_closed_loop
tasklist /fi "IMAGENAME eq Code.exe" | find /i "Code.exe" >nul 2>&1
if not errorlevel 1 (
  timeout /t 1 /nobreak >nul
  goto :wait_ide_closed_loop
)
tasklist /fi "IMAGENAME eq Cursor.exe" | find /i "Cursor.exe" >nul 2>&1
if not errorlevel 1 (
  timeout /t 1 /nobreak >nul
  goto :wait_ide_closed_loop
)
goto :eof

:install_with_cli
set "_CLI=%~1"
set "_LABEL=%~2"
if not exist "%_CLI%" (
  where %_CLI% >nul 2>&1
  if errorlevel 1 goto :eof
)
echo Provo installazione via %_LABEL% CLI...
"%_CLI%" --install-extension "%CH_VSIX%" --force >nul 2>&1
if errorlevel 1 (
  echo [AVVISO] %_LABEL% CLI non ha installato il VSIX.
  goto :eof
)
echo [OK] VSIX installato via %_LABEL% CLI.
set "INSTALL_METHOD=cli"
goto :eof

:resolve_venv_py
REM Dopo "python -m venv" su Windows esiste Scripts\python.exe; non usare bin\python rimasto in cache.
set "VENV_PY="
if exist "!VENV_DIR!\Scripts\python.exe" (
  set "VENV_PY=!VENV_DIR!\Scripts\python.exe"
  goto :eof
)
if exist "!VENV_DIR!\bin\python" (
  set "VENV_PY=!VENV_DIR!\bin\python"
)
goto :eof

:pull_model_if_missing
set "MODEL_NAME=%~1"
set "MODEL_FOUND=0"
for /f "delims=" %%L in ('"!OLLAMA_EXE!" list 2^>nul') do (
  echo %%L | findstr /i /c:"!MODEL_NAME!" >nul 2>&1 && set "MODEL_FOUND=1"
)
if "!MODEL_FOUND!"=="1" (
  echo [OK] Modello gia presente: !MODEL_NAME!
  goto :eof
)
echo.
echo Modello mancante: !MODEL_NAME!
choice /C SN /N /M "Scaricare !MODEL_NAME! in ContextHarvesterModelli? (S/N): "
if errorlevel 2 (
  echo [SALTATO] !MODEL_NAME!
  goto :eof
)
echo Download !MODEL_NAME! ^(puo richiedere diversi minuti^)...
set "OLLAMA_MODELS=!MODELS_DIR!"
"!OLLAMA_EXE!" pull !MODEL_NAME!
if errorlevel 1 (
  echo [ERRORE] pull !MODEL_NAME! fallito.
  set "INSTALL_RC=1"
) else (
  echo [OK] !MODEL_NAME! scaricato.
)
goto :eof

:ollama_done
echo.
echo Modelli installati ^(ollama list^):
set "OLLAMA_MODELS=!MODELS_DIR!"
"!OLLAMA_EXE!" list 2>nul
echo.
echo Se i modelli non compaiono qui, esci da Ollama dal tray e riaprilo, poi rilancia questo script.

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
echo.
echo Premi un tasto per continuare...
pause >nul 2>&1
if errorlevel 1 pause
popd 2>nul
endlocal & exit /b !INSTALL_RC!
