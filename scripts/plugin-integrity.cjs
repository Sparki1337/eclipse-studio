const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '../eclipse-manifest');
const manifest = path.join(root, '.millennium/Dist/build-integrity.json');
const sourceFiles = [
  'frontend/index.tsx',
  'webkit/index.tsx',
  'backend/main.lua',
  'backend/safe-io.ps1',
  'backend/state-store.ps1',
  'backend/file-transaction.ps1',
  'backend/download-package.ps1',
  'backend/install-loader.ps1',
  'tsconfig.json',
  'frontend/tsconfig.json',
  'webkit/tsconfig.json',
  'package.json',
  '.npmrc',
  'package-lock.json',
  'plugin.json',
  '../scripts/check-deepmerge.cjs',
];
const outputFiles = ['.millennium/Dist/index.js', '.millennium/Dist/webkit.js'];
const sourceHashing = 'SHA-256 (CRLF and CR normalized to LF)';
const outputHashing = 'SHA-256 (exact file bytes)';

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

function hashes(names, hashBytes) {
  return Object.fromEntries(names.map(name => [
    name,
    hashBytes(fs.readFileSync(path.join(root, name))),
  ]));
}

function buildManifest() {
  return {
    schema: 2,
    algorithm: 'SHA-256',
    sourceHashing,
    outputHashing,
    sources: hashes(sourceFiles, hashText),
    outputs: hashes(outputFiles, sha256),
  };
}

function run() {
  const actual = buildManifest();
  if (process.argv[2] === 'write') {
    fs.writeFileSync(manifest, JSON.stringify(actual, null, 2) + '\n');
    console.log('Dist: записана карта SHA-256 исходников и результатов сборки');
  } else if (process.argv[2] === 'check') {
    const expected = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      throw new Error('Dist не соответствует исходникам/lock-файлу. Запустите npm run build:plugin.');
    }
    console.log('Dist: SHA-256 исходников, lock-файла и обоих bundle совпадает');
  } else {
    throw new Error('Usage: node scripts/plugin-integrity.cjs write|check');
  }
}

if (require.main === module) run();

module.exports = { normalizeText, sha256, hashText };
