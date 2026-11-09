const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const plugin = require('../scripts/plugin-integrity.cjs');
const resources = require('../scripts/resource-integrity.cjs');

const textVariants = [
  Buffer.from('alpha\nbeta\n', 'utf8'),
  Buffer.from('alpha\r\nbeta\r\n', 'utf8'),
  Buffer.from('alpha\rbeta\r', 'utf8'),
];
const pluginHashes = textVariants.map(plugin.hashText);
const resourceHashes = textVariants.map(resources.hashText);
assert.ok(pluginHashes.every(hash => hash === pluginHashes[0]));
assert.ok(resourceHashes.every(hash => hash === resourceHashes[0]));
assert.deepEqual(resourceHashes, pluginHashes);
assert.notEqual(plugin.hashText(Buffer.from('alpha!\nbeta\n', 'utf8')), pluginHashes[0]);

const bytesWithNewlines = Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0x0d, 0x41]);
assert.notEqual(plugin.sha256(bytesWithNewlines), plugin.hashText(bytesWithNewlines));
assert.notEqual(resources.sha256(bytesWithNewlines), resources.hashText(bytesWithNewlines));

const pluginRoot = path.resolve(__dirname, '../eclipse-manifest');
const pluginManifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.millennium/Dist/build-integrity.json'), 'utf8'));
assert.equal(pluginManifest.schema, 2);
assert.equal(pluginManifest.sourceHashing, 'SHA-256 (CRLF and CR normalized to LF)');
assert.equal(pluginManifest.outputHashing, 'SHA-256 (exact file bytes)');
for (const [name, digest] of Object.entries(pluginManifest.outputs)) {
  assert.equal(plugin.sha256(fs.readFileSync(path.join(pluginRoot, name))), digest);
}

const lock = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../eclipse-manifest/package-lock.json'), 'utf8'));
const esbuild = lock.packages['node_modules/esbuild'];
assert.ok(esbuild && Object.keys(esbuild.optionalDependencies || {}).length > 0);
for (const [name, version] of Object.entries(esbuild.optionalDependencies)) {
  assert.equal(lock.packages['node_modules/' + name]?.version, version, 'Missing locked optional package: ' + name);
}

console.log('PASS: канонические хэши текста, точные хэши outputs и optional-записи lockfile');
