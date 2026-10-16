param(
    [Parameter(Mandatory=$true)][string]$SteamPath,
    [Parameter(Mandatory=$true)][string]$ResourcePath
)
$ErrorActionPreference = 'Stop'
$taskSteam = (Resolve-Path -LiteralPath $SteamPath).ProviderPath
$taskResources = (Resolve-Path -LiteralPath $ResourcePath).ProviderPath
if (-not (Test-Path -LiteralPath (Join-Path $taskSteam 'steam.exe') -PathType Leaf)) {
    throw 'steam.exe не найден. Файлы загрузчика не изменены.'
}

function Read-OptionalBytes([string]$Path) {
    $taskAncestor = Split-Path -Parent $Path
    while ($taskAncestor -and $taskAncestor -ne $taskSteam -and $taskAncestor.StartsWith($taskSteam, [StringComparison]::OrdinalIgnoreCase)) {
        if ((Test-Path -LiteralPath $taskAncestor) -and ((Get-Item -LiteralPath $taskAncestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Путь к загрузчику содержит символическую ссылку.' }
        $taskAncestor = Split-Path -Parent $taskAncestor
    }
    if (Test-Path -LiteralPath $Path) {
        if ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Запрещено заменять символическую ссылку: $Path"
        }
        return ,([IO.File]::ReadAllBytes($Path))
    }
    return $null
}
function Same-Bytes($Left, $Right) {
    if ($null -eq $Left -or $null -eq $Right) { return ($null -eq $Left -and $null -eq $Right) }
    if ($Left.Length -ne $Right.Length) { return $false }
    $taskHash = [Security.Cryptography.SHA256]::Create()
    try { return [Convert]::ToBase64String($taskHash.ComputeHash($Left)) -eq [Convert]::ToBase64String($taskHash.ComputeHash($Right)) }
    finally { $taskHash.Dispose() }
}
function Write-Atomic([string]$Path, [byte[]]$Bytes) {
    $taskTemporary = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllBytes($taskTemporary, $Bytes)
        if ([IO.File]::Exists($Path)) { [IO.File]::Replace($taskTemporary, $Path, [NullString]::Value) }
        else { [IO.File]::Move($taskTemporary, $Path) }
    } finally {
        if ([IO.File]::Exists($taskTemporary)) { [IO.File]::Delete($taskTemporary) }
    }
}

function Configure-Lua([string]$Content) {
    if ([string]::IsNullOrWhiteSpace($Content)) {
        return [IO.File]::ReadAllText((Join-Path $taskResources 'opensteamtool.toml'))
    }
    $taskSectionPattern = '(?ms)^[ \t]*\[[ \t]*(?:lua|"lua"|''lua'')[ \t]*\][ \t]*(?:#[^\r\n]*)?\r?\n(?<body>.*?)(?=^[ \t]*\[|\z)'
    $taskSections = [regex]::Matches($Content, $taskSectionPattern)
    if ($taskSections.Count -eq 0) {
        if ($Content -match '(?m)^[ \t]*lua[ \t]*=[ \t]*\{[^}\r\n]*\bpaths[ \t]*=[ \t]*\[[ \t]*["'']config/lua["''][ \t]*,?[ \t]*\]') {
            return $Content
        }
        if ($Content -match '(?m)^\s*(?:(?:lua|"lua"|''lua'')\s*=|\[\s*(?:lua|"lua"|''lua'')\s*\])') {
            throw 'Неподдерживаемая конфигурация Lua в opensteamtool.toml.'
        }
        return $Content.TrimEnd() + "`n`n[lua]`npaths = [`"config/lua`"]`n"
    }
    if ($taskSections.Count -ne 1) { throw 'Обнаружено несколько секций Lua. Конфигурация не изменена.' }
    $taskSection = $taskSections[0]
    $taskBody = $taskSection.Groups['body'].Value
    $taskPathsPattern = '(?ms)^[ \t]*(?:paths|"paths"|''paths'')[ \t]*=[ \t]*\[(?<values>(?:[^"''\[\]]|"(?:\\.|[^"\\])*"|''[^'']*'')*)\][ \t]*(?:#[^\r\n]*)?(?:\r?\n|\z)'
    $taskPaths = [regex]::Matches($taskBody, $taskPathsPattern)
    if ($taskPaths.Count -gt 1) { throw 'Обнаружено несколько путей Lua paths. Конфигурация не изменена.' }
    if ($taskPaths.Count -eq 0) {
        if ($taskBody -match '(?m)^\s*["'']?paths["'']?\s*=') {
            throw 'Неподдерживаемый формат путей Lua. Обновите загрузчик из Eclipse Studio.'
        }
        $taskNewBody = "paths = [`"config/lua`"]`n" + $taskBody
    } else {
        $taskPathMatch = $taskPaths[0]
        $taskValues = [regex]::Replace($taskPathMatch.Groups['values'].Value, '#[^\r\n]*', '')
        if ($taskValues -notmatch '^\s*(?:(?:"(?:\\.|[^"\\])*"|''[^'']*'')\s*,\s*)*(?:(?:"(?:\\.|[^"\\])*"|''[^'']*'')\s*,?\s*)?$') {
            throw 'Некорректный список путей Lua.'
        }
        $taskNewBody = $taskBody.Remove($taskPathMatch.Index, $taskPathMatch.Length).Insert($taskPathMatch.Index, "paths = [`"config/lua`"]`n")
    }
    $taskBodyStart = $taskSection.Groups['body'].Index
    return $Content.Remove($taskBodyStart, $taskBody.Length).Insert($taskBodyStart, $taskNewBody)
}

$taskConfigDir = Join-Path $taskSteam 'config'
if ((Test-Path -LiteralPath $taskConfigDir) -and ((Get-Item -LiteralPath $taskConfigDir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Папка Steam config является ссылкой. Файлы загрузчика не изменены.'
}
[IO.Directory]::CreateDirectory($taskConfigDir) | Out-Null
$taskLockPath = Join-Path $taskConfigDir 'cgs-luatools-loader.lock'
[void](Read-OptionalBytes $taskLockPath)
try { $taskLoaderLock = [IO.File]::Open($taskLockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
catch { throw 'Загрузчик занят другой операцией. Повторите попытку позже.' }
try {
$taskSelectionPath = Join-Path $taskConfigDir 'cgs-luatools-loader.json'
if ((Test-Path -LiteralPath $taskSelectionPath) -and (Get-Item -LiteralPath $taskSelectionPath).Length -gt 16384) { throw 'Некорректный файл выбора загрузчика. Выберите версию заново в Eclipse Studio.' }
$taskOldSelection = Read-OptionalBytes $taskSelectionPath

$taskUtf8 = New-Object Text.UTF8Encoding($false, $true)
function Hash-Bytes([byte[]]$Bytes) {
    $taskHasher = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($taskHasher.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() }
    finally { $taskHasher.Dispose() }
}
function Validate-Selection($Selection) {
    if ($null -eq $Selection -or $Selection.schema -notin @(1,2) -or
        ($Selection.schema -isnot [int] -and $Selection.schema -isnot [long]) -or
        $Selection.variant -cnotin @('standard','compatibility') -or
        @($Selection.PSObject.Properties).Count -ne 3 -or @($Selection.hashes.PSObject.Properties).Count -ne 3) {
        throw 'Неподдерживаемая конфигурация загрузчика. Выберите версию заново в Eclipse Studio.'
    }
    $taskNames = @($Selection.hashes.PSObject.Properties.Name)
    $taskProxy = if ($Selection.schema -eq 1) { 'dwmapi.dll' }
        elseif ($Selection.variant -ceq 'compatibility') { 'bin/dwmapi.dll' }
        elseif ($taskNames -ccontains 'version.dll') { 'version.dll' } else { 'dwmapi.dll' }
    foreach ($taskName in @('OpenSteamTool.dll','xinput1_4.dll',$taskProxy)) {
        if ($taskNames -cnotcontains $taskName -or $Selection.hashes.$taskName -cnotmatch '^[0-9a-f]{64}$') {
            throw 'Некорректный путь DLL или хеш отпечатка.'
        }
    }
}
$taskSelection = $null
if ($null -ne $taskOldSelection) {
    try { $taskSelection = $taskUtf8.GetString($taskOldSelection) | ConvertFrom-Json }
    catch { throw 'Некорректный JSON выбора загрузчика. Выберите версию в Eclipse Studio.' }
    Validate-Selection $taskSelection
}
$taskVariant = if ($null -ne $taskSelection) { $taskSelection.variant } else { 'standard' }
if ($null -eq $taskSelection) {
    if (Same-Bytes (Read-OptionalBytes (Join-Path $taskSteam 'OpenSteamTool.dll')) ([IO.File]::ReadAllBytes((Join-Path $taskResources 'compatibility/OpenSteamTool.dll')))) { $taskVariant = 'compatibility' }
}
$taskVariantResources = if ($taskVariant -eq 'compatibility') { Join-Path $taskResources 'compatibility' } else { $taskResources }
if ($null -eq $taskSelection) {
    $taskSchema = 2
    if ($taskVariant -eq 'compatibility' -and -not [IO.File]::Exists((Join-Path $taskSteam 'bin/dwmapi.dll')) -and
        (Same-Bytes (Read-OptionalBytes (Join-Path $taskSteam 'dwmapi.dll')) ([IO.File]::ReadAllBytes((Join-Path $taskVariantResources 'dwmapi.dll'))))) { $taskSchema = 1 }
    $taskHashes = [ordered]@{}
    foreach ($taskName in @('OpenSteamTool.dll','dwmapi.dll','xinput1_4.dll')) {
        $taskTargetName = if ($taskSchema -eq 2 -and $taskVariant -eq 'compatibility' -and $taskName -eq 'dwmapi.dll') { 'bin/dwmapi.dll' } else { $taskName }
        $taskHashes[$taskTargetName] = Hash-Bytes ([IO.File]::ReadAllBytes((Join-Path $taskVariantResources $taskName)))
    }
    $taskSelection = [pscustomobject]@{schema=$taskSchema;variant=$taskVariant;hashes=[pscustomobject]$taskHashes}
    Validate-Selection $taskSelection
}
$taskCurrent = $true
foreach ($taskProperty in $taskSelection.hashes.PSObject.Properties) {
    $taskInstalled = Read-OptionalBytes (Join-Path $taskSteam $taskProperty.Name)
    if ($null -eq $taskInstalled -or (Hash-Bytes $taskInstalled) -cne $taskProperty.Value) { $taskCurrent = $false }
}
$taskDllBytes = @{}
if (-not $taskCurrent) {
    [string[]]$taskKeys = @($taskSelection.hashes.PSObject.Properties.Name)
    [Array]::Sort($taskKeys, [StringComparer]::Ordinal)
    $taskOrderedHashes = [ordered]@{}
    foreach ($taskKey in $taskKeys) { $taskOrderedHashes[$taskKey] = $taskSelection.hashes.$taskKey }
    $taskCanonical = [ordered]@{schema=[int]$taskSelection.schema;variant=[string]$taskVariant;hashes=$taskOrderedHashes}
    $taskCacheKey = Hash-Bytes ($taskUtf8.GetBytes(($taskCanonical | ConvertTo-Json -Depth 4 -Compress)))
    $taskCache = Join-Path $taskSteam ('config/cgs-luatools-loader-cache/' + $taskVariant + '/' + $taskCacheKey)
    foreach ($taskProperty in $taskSelection.hashes.PSObject.Properties) {
        $taskName = $taskProperty.Name
        $taskBaseName = [IO.Path]::GetFileName($taskName)
        $taskBytes = Read-OptionalBytes (Join-Path $taskVariantResources $taskBaseName)
        if ($null -eq $taskBytes -or (Hash-Bytes $taskBytes) -cne $taskProperty.Value) {
            $taskBytes = Read-OptionalBytes (Join-Path $taskCache $taskBaseName)
        }
        if ($null -eq $taskBytes -or (Hash-Bytes $taskBytes) -cne $taskProperty.Value) {
            throw 'Закреплённые библиотеки повреждены или отсутствуют в кэше. Обновите DLL вручную в Eclipse Studio.'
        }
        if ($taskBytes.Length -lt 1024 -or $taskBytes[0] -ne 77 -or $taskBytes[1] -ne 90) { throw 'Некорректный бинарный файл DLL. Установка отменена.' }
        $taskDllBytes[$taskName] = $taskBytes
        $taskParent = Split-Path -Parent (Join-Path $taskSteam $taskName)
        if ((Test-Path -LiteralPath $taskParent) -and ((Get-Item -LiteralPath $taskParent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Каталог назначения DLL является ссылкой.' }
        [IO.Directory]::CreateDirectory($taskParent) | Out-Null
    }
}
$taskSelectionBytes = if ($null -ne $taskOldSelection) { $taskOldSelection } else { $taskUtf8.GetBytes(($taskSelection | ConvertTo-Json -Depth 4)) }

$taskConfigPath = Join-Path $taskSteam 'opensteamtool.toml'
$taskOldConfig = Read-OptionalBytes $taskConfigPath
$taskUtf8 = New-Object Text.UTF8Encoding($false, $true)
$taskConfigText = if ($null -ne $taskOldConfig) { $taskUtf8.GetString($taskOldConfig).TrimStart([char]0xfeff) } else { '' }
$taskConfigBytes = $taskUtf8.GetBytes((Configure-Lua $taskConfigText))
$taskChanges = @()
foreach ($taskName in (@($taskSelection.hashes.PSObject.Properties.Name) + @('opensteamtool.toml', 'config/cgs-luatools-loader.json'))) {
    if ($taskCurrent -and $taskName -like '*.dll') { continue }
    $taskTarget = Join-Path $taskSteam $taskName
    $taskOriginal = Read-OptionalBytes $taskTarget
    $taskBytes = if ($taskName -eq 'opensteamtool.toml') { $taskConfigBytes }
        elseif ($taskName -eq 'config/cgs-luatools-loader.json') { $taskSelectionBytes }
        else { $taskDllBytes[$taskName] }
    if ($taskName -like '*.dll' -and ($taskBytes.Length -lt 1024 -or $taskBytes[0] -ne 77 -or $taskBytes[1] -ne 90)) {
        throw "Некорректная библиотека DLL: $taskName"
    }
    if (-not (Same-Bytes $taskOriginal $taskBytes)) {
        $taskChanges += [pscustomobject]@{ Name=$taskName; Target=$taskTarget; Original=$taskOriginal; Bytes=$taskBytes }
    }
}
if ($taskChanges.Count -gt 0) {
    $taskBackup = Join-Path $taskSteam ('config\cgs-luatools-backups\' + [guid]::NewGuid().ToString())
    [IO.Directory]::CreateDirectory($taskBackup) | Out-Null
    foreach ($taskChange in $taskChanges) {
        if ($null -ne $taskChange.Original) {
            $taskBackupFile = Join-Path $taskBackup $taskChange.Name
            [IO.Directory]::CreateDirectory((Split-Path -Parent $taskBackupFile)) | Out-Null
            [IO.File]::WriteAllBytes($taskBackupFile, $taskChange.Original)
        }
    }
    $taskCommitted = @()
    try {
        foreach ($taskChange in $taskChanges) {
            if (-not (Same-Bytes (Read-OptionalBytes $taskChange.Target) $taskChange.Original)) {
                throw "Файл изменён сторонним процессом: $($taskChange.Name)"
            }
            Write-Atomic $taskChange.Target $taskChange.Bytes
            $taskCommitted += $taskChange
        }
    } catch {
        $taskFailure = $_.Exception.Message
        $taskRollbackFailures = @()
        for ($taskIndex=$taskCommitted.Count-1; $taskIndex -ge 0; $taskIndex--) {
            $taskChange = $taskCommitted[$taskIndex]
            try {
                if (-not (Same-Bytes (Read-OptionalBytes $taskChange.Target) $taskChange.Bytes)) {
                    throw 'Файл изменён сторонним процессом; откат пропущен.'
                }
                if ($null -eq $taskChange.Original) { [IO.File]::Delete($taskChange.Target) }
                else { Write-Atomic $taskChange.Target $taskChange.Original }
            } catch { $taskRollbackFailures += "$($taskChange.Name): $($_.Exception.Message)" }
        }
        throw "Не удалось обновить загрузчик: $taskFailure. Закройте Steam и обновите загрузчик в Eclipse Studio. Резервная копия: $taskBackup."
    }
}
[IO.Directory]::CreateDirectory((Join-Path $taskSteam 'config\lua')) | Out-Null

$taskLegacy = Join-Path $taskSteam 'config\stplug-in'
if ([IO.Directory]::Exists($taskLegacy)) {
    $taskMarker = Join-Path $taskSteam 'config\cgs-luatools-lua-migration.json'
    $taskMigrated = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    if ([IO.File]::Exists($taskMarker)) {
        foreach ($taskItem in @([IO.File]::ReadAllText($taskMarker) | ConvertFrom-Json)) {
            [void]$taskMigrated.Add([string]$taskItem)
        }
    }
    foreach ($taskSource in Get-ChildItem -LiteralPath $taskLegacy -File) {
        if ($taskSource.Name -notmatch '(?i)\.lua(?:\.disabled)?$') { continue }
        if ($taskSource.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
        $taskKey = ($taskSource.Name -replace '(?i)\.disabled$', '').ToLowerInvariant()
        if ($taskMigrated.Contains($taskKey)) { continue }
        $taskEnabled = Join-Path $taskSteam ('config\lua\' + $taskKey)
        $taskDisabled = $taskEnabled + '.disabled'
        if (-not [IO.File]::Exists($taskEnabled) -and -not [IO.File]::Exists($taskDisabled)) {
            $taskDestination = Join-Path $taskSteam ('config\lua\' + $taskSource.Name)
            [IO.File]::Copy($taskSource.FullName, $taskDestination, $false)
        }
        [void]$taskMigrated.Add($taskKey)
    }
    $taskLedger = ConvertTo-Json -InputObject @($taskMigrated | Sort-Object) -Compress
    $taskLedgerBytes = $taskUtf8.GetBytes($taskLedger)
    if (-not (Same-Bytes (Read-OptionalBytes $taskMarker) $taskLedgerBytes)) {
        Write-Atomic $taskMarker $taskLedgerBytes
    }
}
} finally { $taskLoaderLock.Dispose() }
