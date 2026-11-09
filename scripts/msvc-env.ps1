# msvc-env — импорт среды компилятора MSVC в текущий процесс; системные настройки не меняются
$ErrorActionPreference = 'Stop'
if (!(Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    if (!(Test-Path -LiteralPath $vswhere)) { throw 'Visual Studio Build Tools not found' }
    $installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (!$installation) { throw 'x64 C++ compiler not installed' }
    $module = Join-Path $installation 'Common7/Tools/Microsoft.VisualStudio.DevShell.dll'
    if (!(Test-Path -LiteralPath $module)) { throw 'Visual Studio DevShell module not found' }
    Import-Module $module
    Enter-VsDevShell -VsInstallPath $installation -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64' | Out-Null
    if (!(Get-Command cl.exe -ErrorAction SilentlyContinue)) { throw 'Compiler environment initialization failed' }
}
