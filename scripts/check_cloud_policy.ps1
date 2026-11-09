# check_cloud_policy — компиляция и запуск проверок CloudRedirect из tests/*.cpp
param([string]$ProjectRoot = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'msvc-env.ps1')
$temp = Join-Path ([IO.Path]::GetTempPath()) ('eclipse-cloud-policy-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($temp)
Push-Location $temp
try {
    # Портативные проверки CloudRedirect компилируются отдельно от DLL.
    foreach ($taskTest in @(
        @{ Source = 'tests/cloud-path-policy.cpp'; Exe = 'policy.exe'; Error = 'Сборка проверки путей CloudRedirect завершилась ошибкой.' },
        @{ Source = 'tests/cloud-message-layout.cpp'; Exe = 'layout.exe'; Error = 'Сборка проверки разметки protobuf-обёртки завершилась ошибкой.' }
    )) {
        & cl.exe /nologo /std:c++20 /EHsc /W4 /WX (Join-Path $ProjectRoot $taskTest.Source) /Fe:$($taskTest.Exe)
        if ($LASTEXITCODE -ne 0) { throw $taskTest.Error }
        & (Join-Path $temp $taskTest.Exe)
        if ($LASTEXITCODE -ne 0) { throw "Проверка $($taskTest.Source) завершилась с ошибочным кодом." }
    }
} finally { Pop-Location; Remove-Item -LiteralPath $temp -Recurse -Force }
