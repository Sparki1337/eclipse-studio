# Сборка движка локального облака CloudRedirect (cgs_cloud_redirect.dll) из исходников third_party/cloudredirect.
# Запускайте из x64 Developer PowerShell / «x64 Native Tools Command Prompt» для Visual Studio:
# нужен cl.exe (x64), C++20 и Windows SDK; CMake и .NET не требуются.
# Готовая DLL и LICENSE.txt кладутся в src-tauri/resources/local-cloud/ и вшиваются в EXE через include_bytes!.
# Порт tools/Build-LocalCloud.ps1 из Crocodile Gena Studio 5.6.3.
param([string]$SourceRoot = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'

if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    throw 'cl.exe не найден. Откройте x64 Developer PowerShell для Visual Studio и запустите скрипт снова.'
}

$taskSource = Join-Path $SourceRoot 'third_party/cloudredirect'
$taskBuild = Join-Path $SourceRoot 'build/local-cloud'
$taskOutput = Join-Path $SourceRoot 'src-tauri/resources/local-cloud'
New-Item -ItemType Directory -Force -Path $taskBuild, $taskOutput | Out-Null

# Список исходников берём из CMakeLists.txt, чтобы не расходиться с оригинальным проектом.
# Первая секция PLATFORM_SOURCES — ветка if(WIN32).
$taskCmake = [IO.File]::ReadAllText((Join-Path $taskSource 'CMakeLists.txt'))
$taskFiles = @()
foreach ($taskSection in @('COMMON_SOURCES', 'PROVIDER_SOURCES', 'PLATFORM_SOURCES')) {
    $taskMatch = [regex]::Match($taskCmake, '(?s)set\(' + $taskSection + '\s+(.*?)\)')
    if (-not $taskMatch.Success) { throw "В CMakeLists.txt нет списка исходников $taskSection" }
    $taskFiles += [regex]::Matches($taskMatch.Groups[1].Value, 'src/[\w/]+\.(?:cpp|c)\b') | ForEach-Object { Join-Path $taskSource $_.Value }
}

# Статический CRT (/MT): DLL не зависит от установленного Visual C++ Redistributable
$taskArgs = @('/nologo', '/LD', '/O2', '/MP4', '/MT', '/EHsc', '/std:c++20', '/utf-8', '/DWIN32', '/D_WINDOWS', '/DMINIZ_NO_STDIO',
    ('/FI"' + $taskSource + '/src/common/cgs_version.h"'),
    ('/I"' + $taskSource + '/src/common"'),
    ('/I"' + $taskSource + '/src/providers"'),
    ('/I"' + $taskSource + '/src/platform/win"'))
$taskArgs += $taskFiles | ForEach-Object { '"' + $_ + '"' }
$taskArgs += @('/link',
    ('/OUT:"' + $taskOutput + '/cgs_cloud_redirect.dll"'),
    ('/IMPLIB:"' + $taskBuild + '/cgs_cloud_redirect.lib"'),
    'Shlwapi.lib', 'Advapi32.lib', 'ws2_32.lib', 'winhttp.lib', 'Crypt32.lib', 'Shell32.lib', 'Ole32.lib', 'Psapi.lib', 'User32.lib')

# Аргументы передаём через response-файл: строка команды слишком длинная для cmd
$taskRsp = Join-Path $taskBuild 'compile.rsp'
[IO.File]::WriteAllText($taskRsp, ($taskArgs -join ' '), [Text.UTF8Encoding]::new($false))
Push-Location $taskBuild
try {
    & cl.exe ('@' + $taskRsp)
    if ($LASTEXITCODE -ne 0) { throw 'Сборка cgs_cloud_redirect.dll завершилась с ошибкой.' }
} finally {
    Pop-Location
}

# Лицензия MIT обязана сопровождать бинарный файл
Copy-Item -LiteralPath (Join-Path $taskSource 'LICENSE') -Destination (Join-Path $taskOutput 'LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $taskSource 'LICENSE') -Destination (Join-Path $SourceRoot 'ui/assets/licenses/cloudredirect-MIT.txt') -Force

$taskDll = Join-Path $taskOutput 'cgs_cloud_redirect.dll'
$taskHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $taskDll).Hash.ToLowerInvariant()
Write-Host "Готово: $taskDll"
Write-Host "SHA-256: $taskHash"
Write-Host 'Своя сборка побайтово не совпадёт с официальной — это нормально: хеш встроенной DLL программа вычисляет сама, править код не нужно.'
