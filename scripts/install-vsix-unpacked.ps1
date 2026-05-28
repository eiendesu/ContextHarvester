# Installa VSIX estraendo in cartella estensioni (gestisce lock su python\.venv)
param(
    [Parameter(Mandatory = $true)][string]$VsixPath,
    [Parameter(Mandatory = $true)][string]$ExtensionsRoot
)

$ErrorActionPreference = 'Stop'

function Stop-LocksForPath {
    param([string]$PathPrefix)
    if (-not $PathPrefix) { return }
    $norm = $PathPrefix.TrimEnd('\', '/')
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^(python|python3|node)\.exe$' } |
        ForEach-Object {
            $cmd = $_.CommandLine
            if ($cmd -and ($cmd -like "*$norm*")) {
                Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            }
        }
    Get-Process -Name python*, node* -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            if ($_.Path -and $_.Path.StartsWith($norm, [System.StringComparison]::OrdinalIgnoreCase)) {
                Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
            }
        } catch { }
    }
    Start-Sleep -Seconds 2
}

function Remove-ExtensionDirSafe {
    param([string]$DestPath)
    if (-not (Test-Path -LiteralPath $DestPath)) { return }

    Stop-LocksForPath $DestPath
    $venv = Join-Path $DestPath 'python\.venv'
    if (Test-Path -LiteralPath $venv) {
        Write-Host '[INFO] Rimozione venv precedente (puo essere bloccato da processi Python)...'
        Stop-LocksForPath $venv
        for ($i = 1; $i -le 4; $i++) {
            try {
                Remove-Item -LiteralPath $venv -Recurse -Force -ErrorAction Stop
                break
            } catch {
                Stop-LocksForPath $venv
                Start-Sleep -Seconds 2
            }
        }
    }

    for ($i = 1; $i -le 3; $i++) {
        try {
            Remove-Item -LiteralPath $DestPath -Recurse -Force -ErrorAction Stop
            return
        } catch {
            Stop-LocksForPath $DestPath
            Start-Sleep -Seconds 2
        }
    }

    $leaf = Split-Path $DestPath -Leaf
    $bakName = "${leaf}.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Write-Host ('[AVVISO] Impossibile eliminare ' + $DestPath + ' - rinomino in ' + $bakName)
    Rename-Item -LiteralPath $DestPath -NewName $bakName -Force
    Write-Host ('       Puoi eliminare ' + $bakName + ' piu tardi (dopo riavvio PC se ancora bloccato).')
}

if (-not (Test-Path -LiteralPath $VsixPath)) {
    throw ('VSIX non trovato: ' + $VsixPath)
}
if (-not (Test-Path -LiteralPath $ExtensionsRoot)) {
    New-Item -ItemType Directory -Path $ExtensionsRoot -Force | Out-Null
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$temp = Join-Path $env:TEMP ('ch-vsix-' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $temp -Force | Out-Null
try {
    [System.IO.Compression.ZipFile]::ExtractToDirectory($VsixPath, $temp)
    $src = Join-Path $temp 'extension'
    $pkg = Join-Path $src 'package.json'
    if (-not (Test-Path -LiteralPath $pkg)) {
        throw 'VSIX non valido: manca extension/package.json'
    }
    $j = Get-Content -LiteralPath $pkg -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $j.publisher -or -not $j.name -or -not $j.version) {
        throw 'package.json incompleto nel VSIX'
    }
    $dest = Join-Path $ExtensionsRoot ($j.publisher + '.' + $j.name + '-' + $j.version)
    if (Test-Path -LiteralPath $dest) {
        Remove-ExtensionDirSafe $dest
    }
    Copy-Item -LiteralPath $src -Destination $dest -Recurse -Force
    Write-Host ('[OK] Estensione installata in: ' + $dest)
    $dest
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
