// csp.test — реальная проверка CSP Chromium на локальном фикстуре UI (только чтение)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const ui = path.join(root, 'ui');
const csp = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8')).app.security.csp;
const commands = [...fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8').matchAll(/^\s+(?:[a-z_]+::)?([a-z_0-9]+),\s*$/gm)].map(m => m[1]);
const mock = fs.readFileSync(path.join(__dirname, 'tauri-mock.js'), 'utf8');
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let name;
  try { name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400).end(); return; }
  const file = path.resolve(ui, '.' + (name === '/' ? '/index.html' : name));
  if (!file.startsWith(ui + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': (types[path.extname(file)] || 'application/octet-stream') + (/\.(?:html|js|css|json)$/.test(file) ? '; charset=utf-8' : ''), 'Content-Security-Policy': csp });
    res.end(data);
  });
});
(async () => {
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const executablePath = process.env.CHROMIUM || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
    browser = await chromium.launch({ executablePath });
    const context = await browser.newContext();
    await context.route(/^https?:\/\/(?!127\.0\.0\.1:)/, route => route.abort());
    await context.addInitScript({ content: `window.__cspViolations=[];document.addEventListener('securitypolicyviolation',event=>window.__cspViolations.push(event.effectiveDirective));try{localStorage.setItem('cgs-language','en')}catch(_){};window.__CGS_MOCK_CONFIG__=${JSON.stringify({ commands })};\n${mock}` });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
    await page.locator('#app-splash').waitFor({ state: 'hidden', timeout: 15000 });
    for (const view of ['settings', 'vbs', 'home']) {
      const tab = page.locator(`.nav-item[data-view="${view}"]`);
      if (await tab.count()) await tab.click();
    }
    await page.waitForTimeout(200);
    assert.deepEqual(errors, [], 'UI script errors under CSP');
    assert.deepEqual(await page.evaluate(() => window.__cspViolations), [], 'Normal UI violated CSP');
    await page.evaluate(async () => {
      const script = document.createElement('script'); script.textContent = 'window.__cspInlineRan=true'; document.head.appendChild(script);
      try { await fetch('https://csp-blocked.invalid/fixture'); } catch { /* Expected CSP rejection; no network request allowed. */ }
    });
    await page.waitForFunction(() => window.__cspViolations.includes('connect-src') && window.__cspViolations.some(v => v.startsWith('script-src')));
    assert.equal(await page.evaluate(() => !!window.__cspInlineRan), false, 'Inline script executed');
    console.log('PASS: UI works with CSP; inline scripts and external fetch are blocked');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
