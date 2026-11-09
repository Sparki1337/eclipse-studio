# fix_build_integrity — метка целостности каталога сборки и EXE поднимается до Medium.
# Нужно после сборки в песочнице: Low-процесс не пишет в %LOCALAPPDATA% и падает в setup-хуке (os error 5).
param([string]$ProjectRoot = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'
$target = Join-Path $ProjectRoot 'src-tauri/target'

if (-not (Test-Path -LiteralPath $target)) {
    New-Item -ItemType Directory -Path $target | Out-Null
}

# (OI)(CI) — метка наследуется новыми файлами и каталогами, поэтому пересборка её сохраняет.
& icacls $target /setintegritylevel '(OI)(CI)Medium' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Не удалось изменить метку целостности $target" }

foreach ($profile in @('debug', 'release')) {
    $exe = Join-Path $target "$profile/eclipse-studio.exe"
    if (Test-Path -LiteralPath $exe) {
        & icacls $exe /setintegritylevel Medium | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Не удалось изменить метку целостности $exe" }
    }
}

Write-Host "Метка целостности Medium применена к $target"
Write-Host 'Пересоберите приложение, если EXE ещё не существует: npm run dev'
