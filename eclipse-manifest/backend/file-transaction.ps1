param(
    [Parameter(Mandatory=$true)][ValidateSet('Extract', 'Install', 'Remove')][string]$Action,
    [Parameter(Mandatory=$true)][string]$RequestFile,
    [Parameter(Mandatory=$true)][string]$ReplyFile,
    [string]$StateRoot = '', [int]$FailAfter = -1
)
. (Join-Path $PSScriptRoot 'safe-io.ps1')
$mutex = $null
function Assert-AppId([string]$AppId) {
    if ($AppId -notmatch '^[1-9][0-9]{0,9}$' -or [uint64]$AppId -gt [uint32]::MaxValue) { throw 'Invalid AppID' }
}
function Assert-Target([string]$Name) {
    if ($Name -cnotmatch '^(config/lua/[1-9][0-9]{0,9}\.lua|depotcache/[0-9]+_[0-9]+\.manifest)$') { throw 'Unowned target path' }
}
function Get-Current([string]$Path) {
    Assert-NoLinks $Path
    if ([IO.Directory]::Exists($Path)) { throw 'Expected a file' }
    if ([IO.File]::Exists($Path)) { return Get-HashFile $Path }; return ''
}
function Put-Blob([string]$Path) {
    $hash = Get-HashFile $Path; $blob = Get-ChildPath $script:BlobRoot ($hash + '.bin')
    if ([IO.File]::Exists($blob)) { if ((Get-HashFile $blob) -ne $hash) { throw 'Backup blob is corrupt' } }
    else { Write-Atomic $blob ([IO.File]::ReadAllBytes($Path)) }
    return $hash
}
function Blob-Bytes([string]$Hash) {
    if ($Hash -notmatch '^[a-f0-9]{64}$') { throw 'Invalid backup hash' }
    $path = Get-ChildPath $script:BlobRoot ($Hash + '.bin')
    if ((Get-HashFile $path) -ne $Hash) { throw 'Backup hash mismatch' }
    return ,([IO.File]::ReadAllBytes($path))
}
function Set-Target([string]$Name, [string]$Hash, [string]$Expected) {
    Assert-Target $Name
    $path = Get-ChildPath $script:SteamRoot $Name
    if ((Get-Current $path) -ne $Expected) { throw 'Target changed concurrently; preserved' }
    if ($Hash) { Write-Atomic $path (Blob-Bytes $Hash) }
    elseif ([IO.File]::Exists($path)) { [IO.File]::Delete($path) }
    if ((Get-Current $path) -ne $Hash) { throw 'Target verification failed' }
}
function Undo-Journal($Journal) {
    if ($Journal.steamRoot -ne $script:SteamRoot -or $Journal.version -ne 1) { throw 'Invalid recovery journal' }
    foreach ($entry in @($Journal.entries)) {
        Assert-Target $entry.name
        $current = Get-Current (Get-ChildPath $script:SteamRoot $entry.name)
        if ($current -ne $entry.before -and $current -ne $entry.after) { throw 'Recovery conflict; journal and files preserved' }
        if ($entry.before) { [void](Blob-Bytes $entry.before) }
    }
    $entries = @($Journal.entries); [Array]::Reverse($entries)
    foreach ($entry in $entries) {
        $current = Get-Current (Get-ChildPath $script:SteamRoot $entry.name)
        if ($current -ne $entry.before) { Set-Target $entry.name $entry.before $entry.after }
    }
}
function Extract-Package($Request) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    Assert-AppId $Request.appid
    Assert-NoLinks $Request.archive; Assert-NoLinks $Request.destination
    if ((New-Object IO.FileInfo($Request.archive)).Length -gt 67108864) { throw 'Archive exceeds 64 MiB' }
    [void][IO.Directory]::CreateDirectory($Request.destination)
    $archive = [IO.Compression.ZipFile]::OpenRead($Request.archive)
    try {
        if ($archive.Entries.Count -gt 4096) { throw 'Archive has too many entries' }
        $names = @{}; $accepted = @(); [long]$total = 0
        foreach ($entry in $archive.Entries) {
            $relative = $entry.FullName.Replace('\', '/').TrimEnd('/')
            if (!$relative) { continue }
            [void](Get-ChildPath $Request.destination $relative)
            if (($entry.ExternalAttributes -band 0x400) -ne 0 -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Archive link is forbidden' }
            if ($entry.FullName.EndsWith('/')) { continue }
            $total += $entry.Length
            if ($entry.Length -gt 33554432 -or $total -gt 268435456 -or ($entry.Length -gt 1048576 -and $entry.Length -gt 200 * [Math]::Max(1, $entry.CompressedLength))) { throw 'Archive expansion budget exceeded' }
            $name = [IO.Path]::GetFileName($relative)
            if ($name -match '^[0-9]+\.lua$' -and $name -cne ($Request.appid + '.lua')) { throw 'Archive contains another AppID Lua' }
            if ($name -cne ($Request.appid + '.lua') -and $name -cnotmatch '^[0-9]+_[0-9]+\.manifest$') {
                if ($name -match '(?i)\.(lua|manifest)$') { throw 'Invalid package filename' }; continue
            }
            if ($names.ContainsKey($name.ToLowerInvariant())) { throw 'Duplicate package destination' }
            $names[$name.ToLowerInvariant()] = $true; $accepted += @{ entry = $entry; name = $name }
        }
        if (!$Request.ContainsKey('manifestsOnly') -or !$Request.manifestsOnly) {
            if (!$names.ContainsKey($Request.appid + '.lua')) { throw 'Requested AppID Lua is missing' }
        }
        foreach ($item in $accepted) {
            $stream = $item.entry.Open(); $memory = New-Object IO.MemoryStream
            try {
                $buffer = New-Object byte[] 65536; [long]$read = 0
                while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $read += $count; if ($read -gt $item.entry.Length -or $read -gt 33554432) { throw 'ZIP entry exceeds declared size' }
                    $memory.Write($buffer, 0, $count)
                }
                if ($read -ne $item.entry.Length) { throw 'Truncated ZIP entry' }
                Write-Atomic (Get-ChildPath $Request.destination $item.name) $memory.ToArray()
            } finally { $stream.Dispose(); $memory.Dispose() }
        }
        return @{ success = $true; files = @($accepted | ForEach-Object { $_.name }) }
    } finally { $archive.Dispose() }
}
try {
    $request = Read-Json $RequestFile
    if ($Action -eq 'Extract') { $result = Extract-Package $request }
    else {
        Assert-AppId $request.appid
        $script:SteamRoot = [IO.Path]::GetFullPath($request.steamRoot).TrimEnd('\', '/')
        Assert-NoLinks $script:SteamRoot
        if (![IO.Directory]::Exists($script:SteamRoot)) { throw 'Steam directory not found' }
        if (!$StateRoot) { $StateRoot = Join-Path $env:LOCALAPPDATA 'EclipseManifest' }
        $steamId = Get-HashBytes ($script:Utf8.GetBytes($script:SteamRoot.ToLowerInvariant()))
        $store = Get-ChildPath $StateRoot ('transactions/' + $steamId)
        $script:BlobRoot = Get-ChildPath $store 'blobs'
        $journalPath = Get-ChildPath $store 'pending.json'; $ledgerPath = Get-ChildPath $store 'ownership.json'
        $mutex = Lock-Root $script:SteamRoot 'files'
        $ledger = @{ version = 1; steamRoot = $script:SteamRoot; transaction = ''; files = @{}; games = @{}; removedGames = @{} }
        if ([IO.File]::Exists($ledgerPath)) { $ledger = Read-Json $ledgerPath }
        if ($ledger.version -ne 1 -or $ledger.steamRoot -ne $script:SteamRoot -or $ledger.files -isnot [Collections.IDictionary] -or $ledger.games -isnot [Collections.IDictionary]) { throw 'Invalid ownership ledger' }
        if (!$ledger.ContainsKey('removedGames')) { $ledger.removedGames = @{} }
        foreach ($name in $ledger.files.Keys) {
            Assert-Target $name; $owned = $ledger.files[$name]
            if ($owned.hash -notmatch '^[a-f0-9]{64}$' -or $owned.owners -isnot [Array]) { throw 'Invalid ownership record' }
            foreach ($owner in $owned.owners) { Assert-AppId $owner }
            if ($owned.original) { [void](Blob-Bytes $owned.original) }
        }
        if ([IO.File]::Exists($journalPath)) {
            $pending = Read-Json $journalPath
            if ($ledger.transaction -ne $pending.id) { Undo-Journal $pending }
            [IO.File]::Delete($journalPath)
        }
        $changes = @(); $names = @(); $manifests = @()
        if ($Action -eq 'Install') {
            Assert-NoLinks $request.sourceRoot
            $entries = @([IO.Directory]::GetFiles($request.sourceRoot))
            if ($entries.Count -gt 4096) { throw 'Too many staged files' }
            foreach ($source in $entries) {
                $name = [IO.Path]::GetFileName($source)
                if ($name -ceq ($request.appid + '.lua')) { $relative = 'config/lua/' + $name }
                elseif ($name -cmatch '^[0-9]+_[0-9]+\.manifest$') { $relative = 'depotcache/' + $name; $manifests += $name }
                else { throw 'Unexpected staged file' }
                Assert-Target $relative
                $target = Get-ChildPath $script:SteamRoot $relative
                $before = Get-Current $target; $after = Put-Blob $source
                if ($ledger.files.ContainsKey($relative)) {
                    $owned = $ledger.files[$relative]
                    if ($before -and $before -ne $owned.hash) { throw 'Installed file was modified; preserved' }
                    $others = @($owned.owners | Where-Object { $_ -ne $request.appid })
                    if ($others.Count -gt 0 -and $after -ne $owned.hash) { throw 'Shared manifest version conflict' }
                    $owned.owners = @($others) + @($request.appid); $owned.hash = $after
                } else {
                    if ($before) { [void](Put-Blob $target) }
                    $owned = @{ original = $before; hash = $after; owners = @($request.appid) }
                    $ledger.files[$relative] = $owned
                }
                $names += $relative; $changes += @{ name = $relative; before = $before; after = $after }
            }
            if ($names -notcontains ('config/lua/' + $request.appid + '.lua')) { throw 'Requested Lua missing from staged package' }
            # An update must not silently abandon previously owned files.
            if ($ledger.games.ContainsKey($request.appid)) {
                foreach ($old in @($ledger.games[$request.appid])) {
                    if ($names -notcontains $old) { throw 'Package removes previously owned files; remove the old package first' }
                }
            }
            $ledger.games[$request.appid] = @($names)
            $ledger.removedGames.Remove($request.appid)
        } else {
            if (!$ledger.games.ContainsKey($request.appid)) {
                if ($ledger.removedGames.ContainsKey($request.appid)) {
                    Write-Json $ReplyFile @{ success = $true; changedCount = 0 }; exit 0
                }
                throw 'No verified ownership record; legacy files preserved'
            }
            foreach ($relative in @($ledger.games[$request.appid])) {
                Assert-Target $relative
                if (!$ledger.files.ContainsKey($relative)) { throw 'Incomplete ownership record' }
                $owned = $ledger.files[$relative]
                if ($owned.owners -notcontains $request.appid) { throw 'Owner mismatch' }
                $before = Get-Current (Get-ChildPath $script:SteamRoot $relative)
                if ($before -and $before -ne $owned.hash) { throw 'Installed file was modified; preserved for review' }
                $others = @($owned.owners | Where-Object { $_ -ne $request.appid })
                if ($others.Count -gt 0) { $owned.owners = @($others); continue }
                if ($before) { [void](Put-Blob (Get-ChildPath $script:SteamRoot $relative)) }
                $changes += @{ name = $relative; before = $before; after = $owned.original }
                $ledger.files.Remove($relative)
            }
            $ledger.games.Remove($request.appid)
            $ledger.removedGames[$request.appid] = $true
        }
        $id = [Guid]::NewGuid().ToString('N')
        $journal = @{ version = 1; id = $id; steamRoot = $script:SteamRoot; entries = @($changes) }
        Write-Json $journalPath $journal
        try {
            $done = 0
            foreach ($change in $changes) {
                Set-Target $change.name $change.after $change.before
                $done++; if ($FailAfter -ge 0 -and $done -ge $FailAfter) { throw 'Injected fixture failure' }
            }
            $ledger.transaction = $id; Write-Json $ledgerPath $ledger
        } catch {
            # Never undo a transaction whose durable ledger has already committed.
            $committed = $false
            if ([IO.File]::Exists($ledgerPath)) {
                try { $onDisk = Read-Json $ledgerPath; $committed = $onDisk.transaction -eq $id } catch {}
            }
            if (!$committed) { Undo-Journal $journal; [IO.File]::Delete($journalPath) }
            throw
        }
        # The durable ledger is the commit point; a leftover journal is recoverable.
        [IO.File]::Delete($journalPath)
        $result = @{ success = $true; manifestFiles = @($manifests); luaCount = 1; manifestCount = $manifests.Count; changedCount = $changes.Count }
    }
    Write-Json $ReplyFile $result
} catch {
    try { Write-Json $ReplyFile @{ success = $false; message = $_.Exception.Message; recoveryPreserved = $true } } catch {}
    exit 1
} finally { if ($null -ne $mutex) { $mutex.ReleaseMutex(); $mutex.Dispose() } }
