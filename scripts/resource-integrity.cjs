// resource-integrity — инвентаризация бинарных ресурсов; не антивирус и не аттестация
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const resources = path.join(root, 'src-tauri/resources');
const manifest = path.join(root, 'docs/binary-resources.json');
const sourceHashing = 'SHA-256 (CRLF and CR normalized to LF)';
const binaryHashing = 'SHA-256 (exact file bytes)';

function normalizeText(bytes) {
  const normalized = Buffer.allocUnsafe(bytes.length);
  let length = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0d) {
      normalized[length++] = 0x0a;
      if (bytes[index + 1] === 0x0a) index += 1;
    } else {
      normalized[length++] = bytes[index];
    }
  }
  return normalized.subarray(0, length);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function hashText(bytes) {
  return sha256(normalizeText(bytes));
}

function shaFile(file) {
  return sha256(fs.readFileSync(file));
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    assert(!fs.lstatSync(file).isSymbolicLink(), 'Linked resource: ' + file);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

function run() {
  const binaries = walk(resources).filter(file => /\.(dll|exe|sys)$/i.test(file)).sort();
  const actual = binaries.map(file => ({
    path: path.relative(root, file).split(path.sep).join('/'),
    size: fs.statSync(file).size,
    sha256: shaFile(file),
    provenance: /local-cloud[\\/]cgs_cloud_redirect\.dll$/.test(file)
      ? 'local-source-build; see adjacent build-provenance.json'
      : 'vendored binary; not rebuilt or independently source-verified in this audit',
  }));
  const provenancePath = path.join(resources, 'local-cloud/build-provenance.json');
  const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
  assert.equal(provenance.schema, 2);
  assert.equal(provenance.architecture, 'x64');
  assert.equal(provenance.sourceHashing, sourceHashing);
  assert.equal(provenance.binaryHashing, binaryHashing);
  const dll = path.join(resources, 'local-cloud/cgs_cloud_redirect.dll');
  assert.equal(provenance.sha256, shaFile(dll), 'CloudRedirect binary differs from its build record');

  const sourceRoot = path.join(root, 'third_party/cloudredirect');
  const sourceNames = walk(sourceRoot)
    .filter(file => /\.(?:c|cpp|h|hpp)$/.test(file) || ['CMakeLists.txt', 'LICENSE'].includes(path.basename(file)))
    .map(file => path.relative(sourceRoot, file).split(path.sep).join('/'))
    .sort();
  assert.deepEqual(Object.keys(provenance.sources).sort(), sourceNames, 'CloudRedirect source set changed; rebuild it');
  for (const name of sourceNames) {
    assert.equal(hashText(fs.readFileSync(path.join(sourceRoot, name))), provenance.sources[name], 'CloudRedirect build input changed: ' + name);
  }

  const inventory = {
    schema: 1,
    algorithm: 'SHA-256',
    note: 'Только целостность. Совпадение хэша не доказывает соответствие исходникам, подлинность или безопасность.',
    binaries: actual,
  };
  if (process.argv[2] === 'write') {
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, JSON.stringify(inventory, null, 2) + '\n');
    console.log('Записаны хэши ' + actual.length + ' бинарных ресурсов. Сертификация безопасности не подразумевается.');
  } else if (process.argv[2] === 'check') {
    assert.deepEqual(JSON.parse(fs.readFileSync(manifest, 'utf8')), inventory, 'Binary resource inventory changed; review the change before updating it');
    console.log('PASS: ' + actual.length + ' бинарных ресурсов и входы сборки CloudRedirect совпадают с записями');
  } else {
    throw new Error('Usage: node scripts/resource-integrity.cjs write|check');
  }
}

if (require.main === module) run();

module.exports = { normalizeText, sha256, hashText };
