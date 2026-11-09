// regressions — изолированные регрессии без доступа к Windows, Steam и реальным ключам
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
async function storage(invoke) {
  const events = [];
  const window = { __TAURI__: { core: { invoke: async (cmd, args) => cmd === 'state_bootstrap'
    ? { migrationVerified: true, values: {}, secretConfigured: {} } : invoke(cmd, args) } }, dispatchEvent: e => events.push(e) };
  const localStorage = { length: 0, key() {}, getItem() { return null; }, removeItem() {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'ui/core/storage.js'), 'utf8'),
    { window, localStorage, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } });
  await window.cgsStorage.ready;
  return { state: window.cgsStorage, events };
}
test('storage: чужой успешный ключ не скрывает предыдущую ошибку', async () => {
  let fail = true;
  const { state, events } = await storage(async (_cmd, args) => {
    if ('a' in (args.changes || {}) && fail) throw new Error('disk unavailable');
    return true;
  });
  state.setItem('a', '1'); state.setItem('b', '2');
  await assert.rejects(state.flush(), /a.*disk unavailable/);
  assert.equal(events.length, 1);
  fail = false; state.setItem('a', '3'); await state.flush();
  assert.equal(state.getItem('a'), '3');
});
test('storage: неудачное сохранение секрета не подтверждается обычной записью', async () => {
  const { state } = await storage(async cmd => { if (cmd === 'state_set_secret') throw new Error('DPAPI failure'); return true; });
  await assert.rejects(state.setSecret('ryuu', 'fixture-only'), /DPAPI failure/);
  state.setItem('theme', 'dark');
  await assert.rejects(state.flush(), /ryuuKey/);
  assert.equal(state.isSecretConfigured('ryuu'), false);
});
test('storage: удаление повторяет и подтверждает только собственный ключ', async () => {
  let fail = true;
  const { state } = await storage(async () => { if (fail) throw new Error('write failure'); return true; });
  state.setItem('a', '1'); await assert.rejects(state.flush());
  fail = false; state.removeItem('a'); await state.flush(); assert.equal(state.getItem('a'), null);
});
test('storage: verified-настройка меняет cache только после успешной записи', async () => {
  let fail = true;
  const { state } = await storage(async () => { if (fail) throw new Error('write denied'); return true; });
  await assert.rejects(state.setItemVerified('cgs-run-as-admin', '0'), /write denied/);
  assert.equal(state.getItem('cgs-run-as-admin'), null);
  await assert.rejects(state.flush(), /cgs-run-as-admin/);
  fail = false; await state.setItemVerified('cgs-run-as-admin', '0'); await state.flush();
  assert.equal(state.getItem('cgs-run-as-admin'), '0');
});
test('release: нет выдуманного результата антивируса', () => {
  const text = fs.readFileSync(path.join(root, 'scripts/release.py'), 'utf8');
  assert(!/Status\*\*: Clean|Статус\*\*: Чистый|7\\+70/.test(text));
  assert(text.includes('Not scanned') && text.includes('Не проверено'));
  const skill = fs.readFileSync(path.join(root, '.agents/skills/build/SKILL.md'), 'utf8');
  assert(skill.includes('Not scanned') && !skill.includes('7\\70') && !skill.includes('**Status**: Clean'));
});
test('UEFI: подготовка требует согласия, а откат передаёт отдельное разрешение', () => {
  const text = fs.readFileSync(path.join(root, 'ui/features/vbs.js'), 'utf8');
  const body = text.slice(text.indexOf('async function prepareUefiOptOut()'), text.indexOf('async function disableFaceit()'));
  assert(body.indexOf('if (!accepted) return') < body.indexOf('call("vbs_prepare_uefi_optout"'));
  assert(body.includes('allowUefi: true') && body.includes('ensureAdmin('));
  assert(text.includes('Вернуть исходные UEFI Lock?'));
  assert(text.includes('call("vbs_restore", { allowUefi })'));
});
test('Windows: межпроцессная блокировка берётся до системного задания', () => {
  const jobs = fs.readFileSync(path.join(root, 'src-tauri/src/jobs.rs'), 'utf8');
  const run = jobs.slice(jobs.indexOf('pub fn run<'), jobs.indexOf('pub fn system_resource'));
  assert(run.indexOf('system_lock::Guard::for_resources(resources)?') < run.indexOf('journal.jobs.push'));
  assert(run.indexOf('system_lock::Guard::for_resources(resources)?') < run.indexOf('let result = action()'));
  const mutex = fs.readFileSync(path.join(root, 'src-tauri/src/system_lock.rs'), 'utf8');
  assert(mutex.includes('Global\\EclipseStudioWindowsSystem-v1'));
  assert(mutex.includes('WaitForSingleObject(handle, 0)'));
});
test('UEFI: независимый откат не скрывает повреждение основного снимка VBS', () => {
  const native = fs.readFileSync(path.join(root, 'src-tauri/src/vbs.rs'), 'utf8');
  const start = native.indexOf('// Независимый корректный журнал UEFI');
  const end = native.indexOf('let uefi_restored =', start);
  assert(start >= 0 && end > start);
  const fallback = native.slice(start, end);
  assert(fallback.includes('uefi::restore(app, allow_uefi)?'));
  assert(fallback.includes('Основной снимок VBS сохранён, но не восстановлен:'));
  assert(fallback.includes('vec![format!'));
  assert(!fallback.includes('fs::remove_file'));
});
test('startup: UAC проверяется до UI, с защитой обновления и передачей без цикла', () => {
  const loader = fs.readFileSync(path.join(root, 'ui/core/loader.js'), 'utf8');
  assert(loader.indexOf('await window.cgsStorage.ready') < loader.indexOf('invoke("startup_admin")'));
  assert(loader.indexOf('invoke("startup_admin")') < loader.indexOf('for (const source of'));
  const lib = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8');
  const body = lib.slice(lib.indexOf('fn startup_admin('), lib.indexOf('/// Запуск в роли помощника обновления'));
  assert(body.includes('startup_policy::first_check') && body.includes('updates::has_launch_context()'));
  assert(body.includes('--elevated-handoff') && body.includes('elevation::is_elevated()?'));
  assert(fs.readFileSync(path.join(root, 'src-tauri/build.rs'), 'utf8').includes('level="asInvoker"'));
});

test('startup: вторая копия блокируется до состояния и фоновых заданий', () => {
  const lib = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8');
  const run = lib.slice(lib.indexOf('pub fn run()'));
  const acquire = run.indexOf('instance_lock::Guard::for_launch()');
  assert(acquire >= 0);
  assert(run.indexOf('updates::init_launch_context()') > acquire);
  assert(run.indexOf('tauri::Builder::default()') > acquire);
  const main = fs.readFileSync(path.join(root, 'src-tauri/src/main.rs'), 'utf8');
  assert(main.indexOf('run_update_helper()') < main.indexOf('eclipse_studio_lib::run()'));
});

const { verifyInstalled, patchedSource } = require('../scripts/check-deepmerge.cjs');
verifyInstalled();
const merge = require('../eclipse-manifest/node_modules/deepmerge');
test('deepmerge patch: ключи прототипа не отравляют результат ни из source, ни из target', () => {
  const poison = JSON.parse('{"__proto__":{"eclipsePoison":true},"constructor":{"prototype":{"eclipsePoison":true}},"prototype":{"eclipsePoison":true},"safe":1}');
  const nullProto = Object.create(null); nullProto.__proto__ = { eclipsePoison: true };
  for (const result of [merge(poison, {}), merge({}, poison), merge(Object.create(null), poison), merge(nullProto, {})]) {
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.equal(result.eclipsePoison, undefined);
    assert(!Object.hasOwn(result, '__proto__')); assert(!Object.hasOwn(result, 'constructor')); assert(!Object.hasOwn(result, 'prototype'));
  }
  assert.equal({}.eclipsePoison, undefined);
});
test('deepmerge patch: массивы, clone, customMerge, all и символы совместимы', () => {
  const symbol = Symbol('fixture'); const source = { a: [1], nested: { x: 2 }, [symbol]: { y: 3 } };
  const combined = merge(source, { a: [2], nested: { z: 4 } });
  assert.deepEqual(combined.a, [1, 2]); assert.deepEqual(combined.nested, { x: 2, z: 4 });
  assert.deepEqual(combined[symbol], { y: 3 }); assert.notEqual(combined.nested, source.nested);
  assert.deepEqual(merge.all([{ a: 1 }, { b: 2 }]), { a: 1, b: 2 });
  assert.deepEqual(merge({ list: [1] }, { list: [2] }, { customMerge: key => key === 'list' ? (_a, b) => b : undefined }), { list: [2] });
  assert.throws(() => merge.all({}), /array/);
});

function gradient() {
  const style = new Map();
  const document = { documentElement: { dataset: {}, style: { setProperty: (k, v) => style.set(k, v) } } };
  const window = { cgsStorage: { getItem: () => null } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'ui/core/gradient.js'), 'utf8'), { window, document });
  return { api: window.cgsGradient, document, style };
}
test('Градиент: повреждённые значения и CSS-код не попадают в стили', () => {
  const { api, document, style } = gradient();
  for (const value of ['{', 'x'.repeat(2049), [], { mode: 'url(x)' }]) assert.equal(api.normalize(value).mode, 'theme');
  api.apply({ mode: 'two', points: [{ x: 'url(https://example.invalid)', y: NaN }, { x: Infinity, y: null }] });
  assert.equal(document.documentElement.dataset.gradientMode, 'two');
  assert.equal(style.get('--gradient-x1'), '15%'); assert.equal(style.get('--gradient-y1'), '0%');
  assert.equal(style.get('--gradient-x2'), '85%'); assert.equal(style.get('--gradient-y2'), '100%');
});
test('Градиент: координаты ограничены и независимы, значения по умолчанию не мутируют', () => {
  const { api } = gradient();
  const value = api.normalize({ mode: 'two', points: [{ x: -1, y: 105 }, { x: 33.333, y: 77.777 }] });
  assert.equal(JSON.stringify(value.points), '[{"x":0,"y":100},{"x":33.3,"y":77.8}]');
  value.points[0].x = 99;
  assert.equal(api.defaults().points[0].x, 15);
});
test('deepmerge patch: неизвестная структура отклоняется вместо слепого исправления', () => {
  assert.throws(() => patchedSource('different upstream source'), /структура/);
});
