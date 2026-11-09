# Shared fail-closed file primitives; compatible with Windows PowerShell 5.1.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:Utf8 = New-Object System.Text.UTF8Encoding($false, $true)
[Console]::InputEncoding = $script:Utf8
[Console]::OutputEncoding = $script:Utf8
function Get-HashBytes([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Get-HashFile([string]$Path) {
    Assert-NoLinks $Path
    $stream = [IO.File]::OpenRead($Path); $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
}
function Assert-NoLinks([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if ([IO.File]::Exists($cursor) -or [IO.Directory]::Exists($cursor)) {
            if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Reparse points are not allowed'
            }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }; $cursor = $parent
    }
}
function Get-ChildPath([string]$Root, [string]$Name) {
    if (!$Name -or [IO.Path]::IsPathRooted($Name) -or $Name.Length -gt 240) { throw 'Invalid relative path' }
    foreach ($part in ($Name -split '[/\\]')) {
        if (!$part -or $part -eq '.' -or $part -eq '..' -or $part -match '[<>:"|?*\x00-\x1f]' -or
            $part.EndsWith('.') -or $part.EndsWith(' ') -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') {
            throw 'Unsafe path component'
        }
    }
    $base = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    $path = [IO.Path]::GetFullPath([IO.Path]::Combine($base, $Name))
    if (!$path.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { throw 'Path escapes its root' }
    Assert-NoLinks $path; return $path
}
function Write-Atomic([string]$Path, [byte[]]$Bytes) {
    Assert-NoLinks $Path
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path))
    Assert-NoLinks $Path
    $temp = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        $stream = New-Object IO.FileStream($temp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 65536, [IO.FileOptions]::WriteThrough)
        try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        if ((Get-HashFile $temp) -ne (Get-HashBytes $Bytes)) { throw 'Atomic write verification failed' }
        Assert-NoLinks $Path
        if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temp, $Path, [NullString]::Value) }
        else { [IO.File]::Move($temp, $Path) }
        if ((Get-HashFile $Path) -ne (Get-HashBytes $Bytes)) { throw 'Committed file verification failed' }
    } finally { if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) } }
}
function Convert-Maps($Value) {
    if ($null -eq $Value) { return $null }
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        $map = @{}; foreach ($p in $Value.PSObject.Properties) { $map[$p.Name] = Convert-Maps $p.Value }; return $map
    }
    if ($Value -is [Array]) { $list = @(); foreach ($v in $Value) { $list += ,(Convert-Maps $v) }; return ,$list }
    return $Value
}
function Parse-Json([string]$Text) { return Convert-Maps (ConvertFrom-Json -InputObject $Text -ErrorAction Stop) }
function Read-Json([string]$Path) {
    Assert-NoLinks $Path
    $size = (New-Object IO.FileInfo($Path)).Length
    if ($size -lt 2 -or $size -gt 16777216) { throw 'Invalid JSON file size' }
    return Parse-Json ([IO.File]::ReadAllText($Path, $script:Utf8))
}
function Write-Json([string]$Path, $Value) { Write-Atomic $Path ($script:Utf8.GetBytes((ConvertTo-Json -InputObject $Value -Depth 48 -Compress))) }
function Lock-Root([string]$Root, [string]$Kind) {
    $id = Get-HashBytes ($script:Utf8.GetBytes([IO.Path]::GetFullPath($Root).ToLowerInvariant()))
    $mutex = New-Object Threading.Mutex($false, ('Local\EclipseManifest-' + $Kind + '-' + $id))
    try { $held = $mutex.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $held = $true }
    if (!$held) { $mutex.Dispose(); throw 'Another operation is still running' }
    return $mutex
}
