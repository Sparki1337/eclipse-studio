param(
    [Parameter(Mandatory=$true)][ValidateSet('Read', 'Write')][string]$Action,
    [string]$StateRoot = '', [string]$LegacyRoot = '', [string]$ReplyPath = '', [string]$RequestPath = ''
)
. (Join-Path $PSScriptRoot 'safe-io.ps1')
Add-Type -AssemblyName System.Security
if (!$StateRoot) { $StateRoot = Join-Path $env:LOCALAPPDATA 'EclipseManifest' }
if (!$LegacyRoot) { $LegacyRoot = Join-Path $env:LOCALAPPDATA 'CrocodileManifest' }
$path = Get-ChildPath $StateRoot 'state-v1.dpapi'
$mutex = $null
function Assert-State($State) {
    if ($State -isnot [Collections.IDictionary]) { throw 'State must be an object' }
    foreach ($key in @('ryuuKey', 'hubcapKey')) {
        if ($State.ContainsKey($key) -and ($State[$key] -isnot [string] -or $State[$key].Length -gt 16384)) { throw 'Invalid secret field' }
    }
    foreach ($key in @('history', 'installedGames', 'installedVersions')) {
        if ($State.ContainsKey($key) -and $State[$key] -isnot [Array] -and $State[$key] -isnot [Collections.IDictionary]) { throw 'Invalid state collection' }
    }
}
function Unprotect-State([byte[]]$Bytes) {
    $plain = [Security.Cryptography.ProtectedData]::Unprotect($Bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $state = Parse-Json ($script:Utf8.GetString($plain)); Assert-State $state
    return @{ bytes = $plain; state = $state }
}
function Commit-State([byte[]]$Plain) {
    $state = Parse-Json ($script:Utf8.GetString($Plain)); Assert-State $state
    $encrypted = [Security.Cryptography.ProtectedData]::Protect($Plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $verified = Unprotect-State $encrypted
    if ((Get-HashBytes $verified.bytes) -ne (Get-HashBytes $Plain)) { throw 'DPAPI verification failed' }
    Write-Atomic $path $encrypted
    [void](Unprotect-State ([IO.File]::ReadAllBytes($path)))
    return Get-HashFile $path
}
try {
    $mutex = Lock-Root $StateRoot 'state'
    if ($Action -eq 'Read') {
        $legacy = @(@((Get-ChildPath $StateRoot 'state.json'), (Get-ChildPath $LegacyRoot 'state.json')) | Where-Object { [IO.File]::Exists($_) })
        $loaded = $null
        if ([IO.File]::Exists($path)) {
            $loaded = Unprotect-State ([IO.File]::ReadAllBytes($path))
            # Remove a leftover migration input only if its exact content was encrypted.
            foreach ($old in $legacy) {
                [void](Read-Json $old)
                if ((Get-HashFile $old) -ne (Get-HashBytes $loaded.bytes)) { throw 'Conflicting plaintext state; manual review required' }
            }
        } elseif (@($legacy).Count -gt 0) {
            foreach ($old in $legacy) { $state = Read-Json $old; Assert-State $state }
            $plain = [IO.File]::ReadAllBytes($legacy[0])
            foreach ($old in $legacy) { if ((Get-HashFile $old) -ne (Get-HashBytes $plain)) { throw 'Conflicting legacy states; manual review required' } }
            [void](Commit-State $plain); $loaded = Unprotect-State ([IO.File]::ReadAllBytes($path))
        }
        if ($null -ne $loaded) {
            foreach ($old in $legacy) { [IO.File]::Delete($old) }
            $result = @{ success = $true; exists = $true; revision = (Get-HashFile $path); state = $loaded.state }
        } else { $result = @{ success = $true; exists = $false; revision = 'absent' } }
        $json = ConvertTo-Json -InputObject $result -Depth 48 -Compress
        if ($ReplyPath) { Write-Json $ReplyPath $result }
        [Console]::Write($json)
    } else {
        if (!$ReplyPath) { throw 'Write acknowledgement path required' }
        $text = if ($RequestPath) { [IO.File]::ReadAllText($RequestPath, $script:Utf8) } else { [Console]::In.ReadToEnd() }
        if ($text.Length -gt 16777216) { throw 'State input too large' }
        $request = Parse-Json $text
        $current = if ([IO.File]::Exists($path)) { Get-HashFile $path } else { 'absent' }
        if ($request.revision -ne $current) { throw 'State changed concurrently; reload and retry' }
        if ($current -ne 'absent') { [void](Unprotect-State ([IO.File]::ReadAllBytes($path))) }
        Assert-State $request.state
        $plain = $script:Utf8.GetBytes((ConvertTo-Json -InputObject $request.state -Depth 48 -Compress))
        $revision = Commit-State $plain
        Write-Json $ReplyPath @{ success = $true; revision = $revision }
    }
} catch {
    # Never print state, input JSON or secret values, including on parse failures.
    if ($Action -eq 'Write' -and $ReplyPath) {
        try { Write-Json $ReplyPath @{ success = $false; message = 'State update was not acknowledged. Reload before retry; state was not reset.' } } catch {}
    } elseif ($ReplyPath) {
        try { Write-Json $ReplyPath @{ success = $false; message = 'State is unreadable or corrupt; it was not reset.' } } catch {}
    } else { [Console]::Write('{"success":false,"message":"State is unreadable or corrupt; it was not reset."}') }
    exit 1
} finally { if ($null -ne $mutex) { $mutex.ReleaseMutex(); $mutex.Dispose() } }
