// check-deepmerge — защитная правка deepmerge 4.3.1 (GHSA-gcqx-w48m-w2h4) без копии библиотеки в репо
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../eclipse-manifest');
const SRI = 'sha512-3sUqbMEc77XqpdNO7FRyRog+eW3ph+GYCbj+rK+uYyRMuwsVy0rMiVtPn+QJlKFvWP/1PYpapqYn0Me2knFn+A==';
const FILES = {"dist/cjs.js": {"original": "2e5160f84a1141bd927264afe4d15766f1e6cf07daef182b37ff53fea121de7d", "patched": "125482dc0aa79bcbd27dcd985f6f0bf21e603d1f5fb50889c71b817f0b829915"}, "dist/umd.js": {"original": "f33e6596482d1fb5c7c427f8ef92f2aa849eea9223acd974176b2fb27ddbf73a", "patched": "bf4f1309fd73930b7ebf9edce03190f95386985f8b1bb0326317fc8ee1c0e8d9"}, "index.js": {"original": "12440c84957c1990ea2d5e33dc0091722dc1dc1585c6d20e0c780e568ffa9d30", "patched": "85a72f1ebd389b3fc6d14133feb8b30f5e3d06f7cf08c50fe63ad3eff8f0a8ee"}};
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function patchedSource(source) {
  const first = 'function propertyIsUnsafe(target, key) {\n';
  const second = '\t\tgetKeys(target).forEach(function(key) {\n';
  assert.equal(source.split(first).length, 2, 'Неизвестная структура deepmerge: propertyIsUnsafe');
  assert.equal(source.split(second).length, 2, 'Неизвестная структура deepmerge: target');
  return source.replace(first, first + "\t// Запрещаем служебные ключи независимо от прототипа назначения.\n\tif (key === '__proto__' || key === 'constructor' || key === 'prototype') return true\n")
    .replace(second, second + '\t\t\tif (propertyIsUnsafe(target, key)) return\n');
}
function inside(parent, child) {
  const relative = path.relative(fs.realpathSync(parent), fs.realpathSync(child));
  assert(!relative.startsWith('..') && !path.isAbsolute(relative), 'Зависимость находится вне node_modules');
}
function verifyInstalled(apply = false) {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.devDependencies.deepmerge, '4.3.1', 'Нужен проверенный deepmerge 4.3.1');
  assert.equal(pkg.overrides.deepmerge, '$deepmerge', 'Защитный override удалён');
  assert.equal(lock.packages[''].devDependencies.deepmerge, '4.3.1', 'Lock-файл не соответствует зависимости');
  const entries = Object.entries(lock.packages).filter(([name]) => name.endsWith('/deepmerge'));
  assert(entries.length > 0, 'deepmerge отсутствует в lock-файле');
  const writes = [];
  for (const [name, meta] of entries) {
    assert(name.startsWith('node_modules/') && !name.split('/').includes('..'), 'Неверный путь lock-файла');
    assert.equal(meta.version, '4.3.1', `Непроверенная версия ${name}`);
    assert.equal(meta.integrity, SRI, `Неизвестный npm-архив ${name}`);
    assert.equal(meta.resolved, 'https://registry.npmjs.org/deepmerge/-/deepmerge-4.3.1.tgz');
    assert.equal(meta.link, undefined, 'Неожиданная локальная ссылка deepmerge');
    const dir = path.join(ROOT, name);
    inside(path.join(ROOT, 'node_modules'), dir);
    const actual = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(actual.name, 'deepmerge'); assert.equal(actual.version, '4.3.1');
    assert.equal(actual.main, 'dist/cjs.js');
    for (const [file, digest] of Object.entries(FILES)) {
      const full = path.join(dir, file); inside(dir, full);
      const bytes = fs.readFileSync(full); const current = hash(bytes);
      if (current === digest.patched) continue;
      assert.equal(current, digest.original, `deepmerge изменён посторонним кодом: ${full}`);
      assert(apply, 'Защитный патч не установлен. Выполните npm --prefix eclipse-manifest run postinstall');
      const content = Buffer.from(patchedSource(bytes.toString('utf8')));
      assert.equal(hash(content), digest.patched, 'Правка deepmerge не соответствует ожидаемому хешу');
      writes.push([full, content]);
    }
  }
  // Все исходники проверены до первой записи; незнакомые файлы никогда не перезаписываются.
  for (const [full, content] of writes) {
    const temporary = full + '.eclipse-' + crypto.randomUUID();
    try { fs.writeFileSync(temporary, content, { flag: 'wx' }); fs.renameSync(temporary, full); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    assert.equal(hash(fs.readFileSync(full)), hash(content));
  }
  const consumers = Object.entries(lock.packages).filter(([name, p]) => name && p.dependencies?.deepmerge).map(([name]) => name);
  assert(consumers.length > 0, 'Нет потребителей deepmerge: пересмотрите защитную проверку');
  const allowed = new Set(entries.map(([name]) => fs.realpathSync(path.join(ROOT, name, 'dist/cjs.js'))));
  for (const consumer of ['', ...consumers]) {
    const req = createRequire(path.join(ROOT, consumer, 'package.json'));
    const resolved = req.resolve('deepmerge');
    assert(allowed.has(fs.realpathSync(resolved)), `Обход защитной правки: ${consumer || 'root'}`);
    delete require.cache[resolved];
    const merge = req('deepmerge');
    const attack = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":{"polluted":true}}');
    const nullProto = Object.assign(Object.create(null), attack);
    for (const result of [merge({}, attack), merge(attack, {}), merge(Object.create(null), attack), merge(nullProto, {})]) {
      assert.equal(Object.getPrototypeOf(result), Object.prototype);
      assert.equal(result.polluted, undefined);
      for (const key of ['__proto__', 'constructor', 'prototype']) assert(!Object.hasOwn(result, key));
    }
    assert.deepEqual(merge({ list: [1], nested: { a: 1 } }, { list: [2], nested: { b: 2 } }), { list: [1, 2], nested: { a: 1, b: 2 } });
  }
  return { consumers: consumers.length + 1, patched: writes.length };
}
module.exports = { patchedSource, verifyInstalled, FILES };
if (require.main === module) {
  assert(process.argv.slice(2).every(arg => arg === '--apply'), 'Разрешён только параметр --apply');
  const result = verifyInstalled(process.argv.includes('--apply'));
  console.log(`PASS: deepmerge защищён у ${result.consumers} потребителей; исправлено файлов: ${result.patched}`);
}
