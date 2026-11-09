# Сборка cgs_cloud_redirect.dll из third_party/cloudredirect в src-tauri/resources/local-cloud/.
# Запускать из x64 Developer PowerShell (нужны cl.exe, C++20, Windows SDK); CMake и .NET не требуются.
# Порт tools/Build-LocalCloud.ps1 из Crocodile Gena Studio 5.6.3.
param([string]$SourceRoot = (Split-Path $PSScriptRoot -Parent), [string]$OutputDirectory = "")
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'msvc-env.ps1')

$taskSource = Join-Path $SourceRoot 'third_party/cloudredirect'
$taskBuild = Join-Path $SourceRoot 'build/local-cloud'
$taskOutput = if ($OutputDirectory) { $OutputDirectory } else { Join-Path $SourceRoot 'src-tauri/resources/local-cloud' }
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
# Хешируем каждый вход сборки и результат. Это локальная провенанс-запись, а не подпись,
# независимая аттестация или гарантия побайтовой воспроизводимости.
$taskInputs = [ordered]@{}
Get-ChildItem -LiteralPath $taskSource -Recurse -File | Where-Object { $_.Extension -in @('.c', '.cpp', '.h', '.hpp') -or $_.Name -in @('CMakeLists.txt', 'LICENSE') } | Sort-Object FullName | ForEach-Object {
    $relative = $_.FullName.Substring($taskSource.Length + 1).Replace('\', '/')
    $taskInputs[$relative] = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
}
$taskProvenance = [ordered]@{
    schema = 1
    component = 'CloudRedirect 2.6.6-cgs-local.2 + Eclipse safety changes'
    upstreamCommit = '4e81e492e4678c1d907fbeaef2625846f6afaad8'
    builtAtUtc = [DateTime]::UtcNow.ToString('o')
    compiler = (Get-Item -LiteralPath (Get-Command cl.exe).Source).VersionInfo.FileVersion
    architecture = 'x64'
    options = @('/LD', '/O2', '/MP4', '/MT', '/EHsc', '/std:c++20', '/utf-8')
    sha256 = $taskHash
    runtimeValidated = $false
    sources = $taskInputs
}
[IO.File]::WriteAllText((Join-Path $taskOutput 'build-provenance.json'), ($taskProvenance | ConvertTo-Json -Depth 8) + "`n", [Text.UTF8Encoding]::new($false))
Write-Host "Готово: $taskDll"
Write-Host "SHA-256: $taskHash"
Write-Host 'Своя сборка побайтово не совпадёт с официальной — это нормально: хеш встроенной DLL программа вычисляет сама, править код не нужно.'
