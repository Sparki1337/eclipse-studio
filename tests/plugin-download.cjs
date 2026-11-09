// plugin-download — фиктивные архивы по loopback, пустые учётные данные, временные файлы
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const secret = 'fixture-download-key-not-real';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-download-fixture-'));
let forwarded, sent = 0;
const remote = http.createServer((req, res) => { forwarded = req.headers['x-api-key']; res.end('PK-fixture'); });
const server = http.createServer((req, res) => {
  sent++;
  if (req.url === '/headers-limit') { res.writeHead(200, { 'Content-Length': 2048 }); res.end(); }
  else if (req.url === '/chunked-limit') { res.write(Buffer.alloc(4096)); res.end(); }
  else if (req.url === '/stall-header') { /* Deliberately no response; the helper must cancel. */ }
  else if (req.url === '/stall-body') { res.writeHead(200, { 'Content-Length': 64 }); res.write('PK12'); }
  else if (req.url === '/redirect') { res.writeHead(302, { Location: `http://127.0.0.1:${remote.address().port}/valid` }); res.end(); }
  else { assert.equal(req.headers['x-api-key'], secret); res.setHeader('ETag', '"fixture-etag"'); res.end('PK-fixture'); }
});
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); }
async function run(name, timeout = 3, before) {
  const output = path.join(temp, name + '.zip'), reply = path.join(temp, name + '.reply.json');
  if (before) fs.writeFileSync(output, before);
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'eclipse-manifest/backend/download-package.ps1'), '-OutputFile', output, '-ReplyFile', reply, '-MaximumBytes', '1024', '-TimeoutSeconds', String(timeout), '-AllowLoopbackFixture'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/${name}`, headers: { 'x-api-key': secret } }));
  const deadline = setTimeout(() => child.kill(), 15000);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); }).finally(() => clearTimeout(deadline));
  assert(!stdout.includes(secret) && !stderr.includes(secret), 'Credential appeared in process output');
  assert(fs.existsSync(reply), `No helper reply (${code}): ${stderr}`);
  const result = JSON.parse(fs.readFileSync(reply, 'utf8'));
  assert(!fs.readFileSync(reply, 'utf8').includes(secret), 'Credential appeared in acknowledgement');
  if (before) assert.equal(fs.readFileSync(output, 'utf8'), before, 'Existing file changed');
  else if (result.success) assert.equal(fs.readFileSync(output, 'utf8'), 'PK-fixture');
  else assert(!fs.existsSync(output), 'Failed archive was published');
  assert(!fs.readdirSync(temp).some(file => file.startsWith(name + '.zip.') && file.endsWith('.partial')), 'Partial archive left behind');
  return result;
}
(async () => {
  try {
    await listen(server); await listen(remote);
    const valid = await run('valid'); assert(valid.success && valid.bytes_written === 10 && valid.headers.etag === '"fixture-etag"', JSON.stringify(valid));
    assert.equal((await run('headers-limit')).success, false);
    assert.equal((await run('chunked-limit')).success, false);
    for (const name of ['stall-header', 'stall-body']) {
      const start = Date.now(); assert.equal((await run(name, 1)).success, false); assert(Date.now() - start < 8000, `${name} did not cancel`);
    }
    assert.equal((await run('redirect')).success, true); assert.equal(forwarded, undefined, 'Key forwarded to a redirected origin');
    const count = sent; assert.equal((await run('existing', 3, 'user-original')).success, false); assert.equal(sent, count, 'Existing file should fail before HTTP');
    console.log('PASS: 7 bounded-download fixtures (size, cancellation, redirects, ownership, no key leaks)');
  } finally {
    for (const item of [server, remote]) { item.closeAllConnections(); await new Promise(resolve => item.close(resolve)); }
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
