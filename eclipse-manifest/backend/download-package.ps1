# Streaming HTTPS download. Keys arrive only on stdin, never in files or arguments.
param(
    [Parameter(Mandatory=$true)][string]$OutputFile,
    [Parameter(Mandatory=$true)][string]$ReplyFile,
    [ValidateRange(1,90)][int]$TimeoutSeconds = 90,
    [ValidateRange(4,67108864)][long]$MaximumBytes = 67108864,
    [string]$RequestPath = '',
    [switch]$AllowLoopbackFixture
)
. (Join-Path $PSScriptRoot 'safe-io.ps1')
Add-Type -AssemblyName System.Net.Http
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$client = $null; $handler = $null; $cancel = $null; $response = $null; $stream = $null; $file = $null; $partial = ''
$status = 0; $success = $false; $reply = @{ success = $false; status = 0; bytes_written = 0; message = 'Download rejected or interrupted; no archive was committed.' }
try {
    Assert-NoLinks $OutputFile
    if ([IO.File]::Exists($OutputFile) -or [IO.Directory]::Exists($OutputFile)) { throw 'Output already exists' }
    $text = if ($RequestPath) { [IO.File]::ReadAllText($RequestPath, $script:Utf8) } else { [Console]::In.ReadToEnd() }
    if ($text.Length -gt 1048576) { throw 'Request too large' }
    $request = Parse-Json $text; $origin = [Uri]$request.url
    function Assert-Url([Uri]$Url) {
        if ($Url.UserInfo -or !$Url.IsAbsoluteUri) { throw 'Invalid URL' }
        if ($AllowLoopbackFixture) {
            if ($Url.Scheme -ne 'http' -or $Url.Host -ne '127.0.0.1') { throw 'Fixture must stay on IPv4 loopback' }
        } elseif ($Url.Scheme -ne 'https') { throw 'HTTPS required' }
    }
    Assert-Url $origin
    if (!$AllowLoopbackFixture -and $origin.Host -notin @('generator.ryuu.lol', 'hubcapmanifest.com')) { throw 'Unknown package service' }
    if ($request.headers -isnot [Collections.IDictionary]) { throw 'Invalid headers' }
    foreach ($name in $request.headers.Keys) {
        $value = [string]$request.headers[$name]
        if ($name -notmatch '^[A-Za-z0-9-]+$' -or $value.Length -gt 16384 -or $value -match '[\r\n]') { throw 'Invalid header' }
    }
    $handler = [Net.Http.HttpClientHandler]::new(); $handler.AllowAutoRedirect = $false; $handler.UseCookies = $false
    if ($AllowLoopbackFixture) { $handler.UseProxy = $false }
    $client = [Net.Http.HttpClient]::new($handler); $client.Timeout = [Threading.Timeout]::InfiniteTimeSpan
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $cancel = [Threading.CancellationTokenSource]::new(); $cancel.CancelAfter([TimeSpan]::FromSeconds($TimeoutSeconds))
    $current = $origin
    for ($redirects = 0; $redirects -le 5; $redirects++) {
        Assert-Url $current
        $message = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $current)
        try {
            [void]$message.Headers.TryAddWithoutValidation('User-Agent', 'EclipseManifest/0.5.4')
            # Custom API-key headers must not leak to a redirected CDN/origin.
            if ($current.GetLeftPart([UriPartial]::Authority) -eq $origin.GetLeftPart([UriPartial]::Authority)) {
                foreach ($name in $request.headers.Keys) { [void]$message.Headers.TryAddWithoutValidation([string]$name, [string]$request.headers[$name]) }
            }
            $response = $client.SendAsync($message, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancel.Token).GetAwaiter().GetResult()
        } finally { $message.Dispose() }
        $status = [int]$response.StatusCode
        if ($status -in @(301,302,303,307,308)) {
            if ($redirects -eq 5 -or !$response.Headers.Location) { throw 'Invalid redirect chain' }
            $next = [Uri]::new($current, $response.Headers.Location); $response.Dispose(); $response = $null; $current = $next; continue
        }
        break
    }
    if ($status -lt 200 -or $status -ge 300) { throw 'Service rejected download' }
    $length = $response.Content.Headers.ContentLength
    if ($null -ne $length -and ($length -gt $MaximumBytes -or $length -lt 4)) { throw 'Archive length outside budget' }
    $metadata = @{}
    # Header names belong to distinct .NET collections; querying Content-Length
    # through HttpResponseHeaders throws, even for a valid response.
    foreach ($header in $response.Headers) {
        if ($header.Key -ieq 'etag') { $metadata.etag = ($header.Value -join ',') }
    }
    foreach ($header in $response.Content.Headers) {
        if ($header.Key -in @('last-modified', 'content-length')) { $metadata[$header.Key.ToLowerInvariant()] = ($header.Value -join ',') }
    }
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($OutputFile)); Assert-NoLinks $OutputFile
    $partial = $OutputFile + '.' + [Guid]::NewGuid().ToString('N') + '.partial'
    $file = [IO.FileStream]::new($partial, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 65536, [IO.FileOptions]::WriteThrough)
    $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $buffer = New-Object byte[] 65536; [long]$written = 0
    while ($true) {
        $read = $stream.ReadAsync($buffer, 0, $buffer.Length, $cancel.Token)
        $remaining = [int][Math]::Max(1, $TimeoutSeconds * 1000 - $watch.ElapsedMilliseconds)
        if (!$read.Wait($remaining)) { $cancel.Cancel(); throw 'Download deadline reached' }
        $count = $read.GetAwaiter().GetResult()
        if ($count -eq 0) { break }
        $written += $count
        if ($written -gt $MaximumBytes) { throw 'Archive stream exceeds budget' }
        $file.Write($buffer, 0, $count)
    }
    if ($written -lt 4 -or ($null -ne $length -and $written -ne $length)) { throw 'Truncated archive' }
    $file.Flush($true); $file.Dispose(); $file = $null
    Assert-NoLinks $OutputFile; [IO.File]::Move($partial, $OutputFile); $partial = ''
    $reply = @{ success = $true; status = $status; bytes_written = $written; headers = $metadata }
    $success = $true
} catch {
    # Parse/HTTP exceptions can include request details; never echo them or keys.
    $reply.status = $status
    if ($AllowLoopbackFixture) { $reply.fixtureErrorLine = $_.InvocationInfo.ScriptLineNumber; $reply.fixtureErrorType = $_.Exception.GetType().FullName }
} finally {
    if ($null -ne $file) { $file.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
    if ($null -ne $response) { $response.Dispose() }
    if ($null -ne $cancel) { $cancel.Dispose() }
    if ($null -ne $client) { $client.Dispose() } elseif ($null -ne $handler) { $handler.Dispose() }
    if ($partial -and [IO.File]::Exists($partial)) { [IO.File]::Delete($partial) }
}
try { Write-Json $ReplyFile $reply } catch { exit 1 }
if (!$success) { exit 1 }
