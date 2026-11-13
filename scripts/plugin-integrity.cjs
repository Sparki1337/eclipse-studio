// plugin-integrity — SHA-256 связки исходники/lock/Dist с каноническими LF.
// Нормализация применяется только к перечисленным текстовым файлам, не к бинарникам.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const root = path.resolve(__dirname, '../eclipse-manifest');
const sources = [
  'frontend/index.tsx', 'webkit/index.tsx', 'backend/main.lua', 'backend/safe-io.ps1',
  'backend/state-store.ps1', 'backend/file-transaction.ps1', 'backend/download-package.ps1',
  'backend/install-loader.ps1', 'tsconfig.json', 'frontend/tsconfig.json', 'webkit/tsconfig.json',
  'package.json', '.npmrc', 'package-lock.json', 'plugin.json',
  '../scripts/check-deepmerge.cjs', '../scripts/plugin-integrity.cjs', '../.gitattributes',
];
const outputs = ['.millennium/Dist/index.js', '.millennium/Dist/webkit.js'];
function hashText(bytes) {
  const normalized = bytes.toString('utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}
function buildManifest(base = root) {
  const hashes = names => Object.fromEntries(names.map(name => [
    name, hashText(fs.readFileSync(path.join(base, name))),
  ]));
  return {
    schema: 2, algorithm: 'SHA-256', textNormalization: 'LF',
    sources: hashes(sources), outputs: hashes(outputs),
  };
}
if (require.main === module) {
  const manifest = path.join(root, '.millennium/Dist/build-integrity.json');
  const actual = buildManifest();
  if (process.argv[2] === 'write') {
    fs.writeFileSync(manifest, JSON.stringify(actual, null, 2) + '\n');
    console.log('Dist: записана карта SHA-256 с каноническими LF');
  } else if (process.argv[2] === 'check') {
    const expected = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (!isDeepStrictEqual(expected, actual)) {
      throw new Error('Dist не соответствует исходникам/lock-файлу. Запустите npm run build:plugin.');
    }
    console.log('Dist: SHA-256 исходников, lock-файла и обоих bundle совпадает (LF)');
  } else {
    throw new Error('Usage: node scripts/plugin-integrity.cjs write|check');
  }
}
module.exports = { hashText, buildManifest };
