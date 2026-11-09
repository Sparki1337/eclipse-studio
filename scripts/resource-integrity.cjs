// resource-integrity — инвентаризация бинарных ресурсов; не антивирус и не аттестация
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const resources = path.join(root, 'src-tauri/resources');
const manifest = path.join(root, 'docs/binary-resources.json');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    assert(!fs.lstatSync(file).isSymbolicLink(), `Linked resource: ${file}`);
    return entry.isDirectory() ? walk(file) : [file];
  });
}
const binaries = walk(resources).filter(f => /\.(dll|exe|sys)$/i.test(f)).sort();
const actual = binaries.map(file => ({ path: path.relative(root, file).split(path.sep).join('/'), size: fs.statSync(file).size, sha256: sha(file), provenance: /local-cloud[\\/]cgs_cloud_redirect\.dll$/.test(file) ? 'local-source-build; see adjacent build-provenance.json' : 'vendored binary; not rebuilt or independently source-verified in this audit' }));
const provenance = JSON.parse(fs.readFileSync(path.join(resources, 'local-cloud/build-provenance.json'), 'utf8'));
assert.equal(provenance.schema, 1);
assert.equal(provenance.architecture, 'x64');
assert.equal(provenance.sha256, sha(path.join(resources, 'local-cloud/cgs_cloud_redirect.dll')), 'CloudRedirect binary differs from its build record');
const sourceRoot = path.join(root, 'third_party/cloudredirect');
const sourceNames = walk(sourceRoot).filter(f => /\.(?:c|cpp|h|hpp)$/.test(f) || ['CMakeLists.txt', 'LICENSE'].includes(path.basename(f))).map(f => path.relative(sourceRoot, f).split(path.sep).join('/')).sort();
assert.deepEqual(Object.keys(provenance.sources).sort(), sourceNames, 'CloudRedirect source set changed; rebuild it');
for (const name of sourceNames) assert.equal(sha(path.join(sourceRoot, name)), provenance.sources[name], `CloudRedirect build input changed: ${name}`);
const inventory = { schema: 1, algorithm: 'SHA-256', note: 'Только целостность. Совпадение хэша не доказывает соответствие исходникам, подлинность или безопасность.', binaries: actual };
if (process.argv[2] === 'write') {
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify(inventory, null, 2) + '\n');
  console.log(`Записаны хэши ${actual.length} бинарных ресурсов. Сертификация безопасности не подразумевается.`);
} else if (process.argv[2] === 'check') {
  assert.deepEqual(JSON.parse(fs.readFileSync(manifest, 'utf8')), inventory, 'Binary resource inventory changed; review the change before updating it');
  console.log(`PASS: ${actual.length} бинарных ресурсов и входы сборки CloudRedirect совпадают с записями`);
} else throw new Error('Usage: node scripts/resource-integrity.cjs write|check');
