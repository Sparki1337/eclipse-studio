# plugin-safety — проверки на временных фикстурах; Steam, реестр, BCD и реальное состояние не затрагиваются
param([string]$ProjectRoot = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'
$backend = Join-Path $ProjectRoot 'eclipse-manifest/backend'
. (Join-Path $backend 'safe-io.ps1')
$root = Join-Path ([IO.Path]::GetTempPath()) ('eclipse-plugin-fixtures-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root)
$script:checks = 0
function Check($Condition, [string]$Message) { if (!$Condition) { throw $Message }; $script:checks++ }
function Run-Helper([string]$Name, [string[]]$Arguments, [string]$InputText = '') {
    $p = New-Object Diagnostics.Process
    $p.StartInfo.FileName = Join-Path $PSHOME 'powershell.exe'
    $all = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $backend $Name)) + $Arguments
    foreach ($arg in $all) { if ($arg.Contains('"')) { throw 'Invalid fixture argument' } }
    $p.StartInfo.Arguments = ($all | ForEach-Object { '"' + $_ + '"' }) -join ' '
    $p.StartInfo.UseShellExecute = $false; $p.StartInfo.CreateNoWindow = $true
    $p.StartInfo.RedirectStandardInput = $true; $p.StartInfo.RedirectStandardOutput = $true; $p.StartInfo.RedirectStandardError = $true
    $p.StartInfo.StandardOutputEncoding = $script:Utf8
    [void]$p.Start(); $inputBytes = $script:Utf8.GetBytes($InputText); $p.StandardInput.BaseStream.Write($inputBytes, 0, $inputBytes.Length); $p.StandardInput.Close()
    $out = $p.StandardOutput.ReadToEnd(); $err = $p.StandardError.ReadToEnd()
    if (!$p.WaitForExit(30000)) { $p.Kill(); throw 'Fixture helper timed out' }
    $code = $p.ExitCode; $p.Dispose()
    return @{ code = $code; output = $out; error = $err }
}
function Read-State([string]$Directory) {
    $r = Run-Helper 'state-store.ps1' @('-Action', 'Read', '-StateRoot', $Directory, '-LegacyRoot', (Join-Path $root 'legacy'))
    try { return Parse-Json $r.output } catch { throw ('Read helper protocol failed: ' + $r.error) }
}
function Save-State([string]$Directory, [string]$Revision, $State) {
    $reply = Join-Path $root ([Guid]::NewGuid().ToString('N') + '.state-reply.json')
    $inputJson = ConvertTo-Json -InputObject @{ revision = $Revision; state = $State } -Depth 32 -Compress
    $r = Run-Helper 'state-store.ps1' @('-Action', 'Write', '-StateRoot', $Directory, '-LegacyRoot', (Join-Path $root 'legacy'), '-ReplyPath', $reply) $inputJson
    Check (!$r.output.Contains('fixture-ryuu')) 'Secret appeared on stdout'
    Check (!$r.error.Contains('fixture-ryuu')) 'Secret appeared on stderr'
    if (![IO.File]::Exists($reply)) { throw ('Missing write acknowledgement: ' + $r.error) }
    return Read-Json $reply
}
function Files-Action([string]$Action, $Request, [int]$Fault = -1) {
    $token = [Guid]::NewGuid().ToString('N'); $inputFile = Join-Path $root ($token + '.request.json'); $replyFile = Join-Path $root ($token + '.reply.json')
    Write-Json $inputFile $Request
    $r = Run-Helper 'file-transaction.ps1' @('-Action', $Action, '-RequestFile', $inputFile, '-ReplyFile', $replyFile, '-StateRoot', (Join-Path $root 'file-state'), '-FailAfter', $Fault.ToString())
    if (![IO.File]::Exists($replyFile)) { throw ('Missing transaction acknowledgement: ' + $r.error) }
    return Read-Json $replyFile
}
function Make-Zip([string]$Path, $Files) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::Open($Path, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in $Files) {
            $entry = $zip.CreateEntry($file.name); $stream = $entry.Open()
            try { $bytes = $script:Utf8.GetBytes($file.text); $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
        }
    } finally { $zip.Dispose() }
}
try {
    foreach ($file in @('safe-io.ps1', 'state-store.ps1', 'file-transaction.ps1', 'download-package.ps1')) {
        $tokens = $null; $errors = $null
        [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $backend $file), [ref]$tokens, [ref]$errors)
        Check ($errors.Count -eq 0) ('PowerShell syntax: ' + $file)
    }
    $stateRoot = Join-Path $root 'state'; $initial = Read-State $stateRoot
    Check ($initial.success -and !$initial.exists) 'Absent state was not recognized'
    $state = @{ ryuuKey = 'fixture-ryuu-not-a-real-key'; hubcapKey = 'fixture-hubcap'; history = @(); installedGames = @{}; installedVersions = @{}; theme = 'midnight' }
    $written = Save-State $stateRoot 'absent' $state
    Check $written.success 'DPAPI write failed'
    $encryptedPath = Join-Path $stateRoot 'state-v1.dpapi'; $encrypted = [IO.File]::ReadAllBytes($encryptedPath)
    Check (!([Text.Encoding]::UTF8.GetString($encrypted)).Contains('fixture-ryuu')) 'Plaintext persisted'
    Check (![IO.File]::Exists((Join-Path $stateRoot 'state.json'))) 'New plaintext state created'
    $loaded = Read-State $stateRoot
    Check ($loaded.success -and $loaded.state.ryuuKey -eq $state.ryuuKey) 'DPAPI round trip failed'
    $state.theme = 'graphite'
    $updated = Save-State $stateRoot $loaded.revision $state
    Check $updated.success 'Atomic replacement of encrypted state failed'
    $roundTrip = Read-State $stateRoot
    Check ($roundTrip.success -and $roundTrip.state.theme -eq 'graphite') 'Updated state was not acknowledged'
    $encrypted = [IO.File]::ReadAllBytes($encryptedPath)
    $before = Get-HashFile $encryptedPath
    $stale = Save-State $stateRoot 'absent' $state
    Check (!$stale.success -and (Get-HashFile $encryptedPath) -eq $before) 'CAS lost-update protection failed'
    [IO.File]::WriteAllBytes($encryptedPath, [byte[]](1,2,3))
    $bad = Read-State $stateRoot
    Check (!$bad.success -and (New-Object IO.FileInfo($encryptedPath)).Length -eq 3) 'Corrupt state was reset'
    [IO.File]::WriteAllBytes($encryptedPath, $encrypted)
    $migration = Join-Path $root 'migration'; [void][IO.Directory]::CreateDirectory($migration)
    Write-Json (Join-Path $migration 'state.json') $state
    $migrated = Read-State $migration
    Check ($migrated.success -and $migrated.state.ryuuKey -eq $state.ryuuKey) 'Migration failed'
    Check (![IO.File]::Exists((Join-Path $migration 'state.json'))) 'Verified migration left plaintext'
    $brokenRoot = Join-Path $root 'broken'; [void][IO.Directory]::CreateDirectory($brokenRoot)
    [IO.File]::WriteAllText((Join-Path $brokenRoot 'state.json'), '{bad', $script:Utf8)
    $bad = Read-State $brokenRoot
    Check (!$bad.success -and [IO.File]::Exists((Join-Path $brokenRoot 'state.json'))) 'Invalid legacy state was discarded'

    $steam = Join-Path $root 'Steam'; $source = Join-Path $root 'package'
    [void][IO.Directory]::CreateDirectory((Join-Path $steam 'config/lua')); [void][IO.Directory]::CreateDirectory($source)
    [IO.File]::WriteAllText((Join-Path $steam 'config/lua/100.lua'), 'original-lua', $script:Utf8)
    [IO.File]::WriteAllText((Join-Path $source '100.lua'), 'installed-lua', $script:Utf8)
    [IO.File]::WriteAllText((Join-Path $source '10_20.manifest'), 'shared-manifest', $script:Utf8)
    $request = @{ appid = '100'; steamRoot = $steam; sourceRoot = $source }
    $failed = Files-Action 'Install' $request 1
    Check (!$failed.success) 'Fault injection unexpectedly succeeded'
    Check (([IO.File]::ReadAllText((Join-Path $steam 'config/lua/100.lua'))) -eq 'original-lua') 'Rollback lost original Lua'
    Check (![IO.File]::Exists((Join-Path $steam 'depotcache/10_20.manifest'))) 'Rollback left a created manifest'
    $installed = Files-Action 'Install' $request
    Check $installed.success ('Install failed: ' + $installed['message'])
    $manifest = Join-Path $steam 'depotcache/10_20.manifest'
    [IO.File]::WriteAllText($manifest, 'user edit', $script:Utf8)
    $refused = Files-Action 'Remove' @{ appid = '100'; steamRoot = $steam }
    Check (!$refused.success) 'Changed manifest was removed'
    Check (([IO.File]::ReadAllText((Join-Path $steam 'config/lua/100.lua'))) -eq 'installed-lua') 'Preflight modified another file'
    [IO.File]::WriteAllText($manifest, 'shared-manifest', $script:Utf8)
    $other = Join-Path $root 'other-package'; [void][IO.Directory]::CreateDirectory($other)
    [IO.File]::WriteAllText((Join-Path $other '200.lua'), 'other-lua', $script:Utf8)
    [IO.File]::WriteAllText((Join-Path $other '10_20.manifest'), 'shared-manifest', $script:Utf8)
    $second = Files-Action 'Install' @{ appid = '200'; steamRoot = $steam; sourceRoot = $other }
    Check $second.success ('Shared ownership failed: ' + $second['message'])
    $removed = Files-Action 'Remove' @{ appid = '100'; steamRoot = $steam }
    Check $removed.success ('Removal failed: ' + $removed['message'])
    Check ([IO.File]::Exists($manifest)) 'Shared manifest was deleted'
    Check (([IO.File]::ReadAllText((Join-Path $steam 'config/lua/100.lua'))) -eq 'original-lua') 'Original was not restored'
    $again = Files-Action 'Remove' @{ appid = '100'; steamRoot = $steam }
    Check $again.success 'Retry after committed removal failed'
    $last = Files-Action 'Remove' @{ appid = '200'; steamRoot = $steam }
    Check ($last.success -and ![IO.File]::Exists($manifest)) 'Last owner cleanup failed'
    $legacy = Files-Action 'Remove' @{ appid = '300'; steamRoot = $steam }
    Check (!$legacy.success) 'Untracked legacy files were treated as owned'

    foreach ($kind in @('valid', 'traversal', 'foreign', 'duplicate', 'bomb')) {
        $zipPath = Join-Path $root ($kind + '.zip'); $destination = Join-Path $root ($kind + '-unpacked')
        $files = @(@{name = '100.lua'; text = 'lua'})
        if ($kind -eq 'traversal') { $files += @{name = '../escape.manifest'; text = 'escape'} }
        if ($kind -eq 'foreign') { $files += @{name = '999.lua'; text = 'foreign'} }
        if ($kind -eq 'duplicate') { $files += @{name = 'nested/100.lua'; text = 'alias'} }
        if ($kind -eq 'bomb') { $files += @{name = '10_20.manifest'; text = ('x' * 2097152)} }
        Make-Zip $zipPath $files
        $extracted = Files-Action 'Extract' @{ appid = '100'; archive = $zipPath; destination = $destination }
        Check ($extracted.success -eq ($kind -eq 'valid')) ('Archive policy failed: ' + $kind + ' ' + $extracted['message'])
    }
    Check (![IO.File]::Exists((Join-Path $root 'escape.manifest'))) 'Archive escaped staging'
    Write-Host ('PASS: ' + $script:checks + ' plugin safety checks; only temporary fixtures used')
    Remove-Item -LiteralPath $root -Recurse -Force
} catch {
    Write-Host ('FAIL: ' + $_.Exception.Message)
    Write-Host ('Fixture directory retained: ' + $root)
    exit 1
}
