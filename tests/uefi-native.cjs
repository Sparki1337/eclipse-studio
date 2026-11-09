// uefi-native — только анализ исходников; реальные BCD, EFI, реестр и службы не вызываются
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const source = name => fs.readFileSync(path.join(root, 'src-tauri/src', name), 'utf8');
const adapter = source('uefi_bcd.rs');
const transaction = source('vbs_uefi.rs');
// Проверяем исполняемую часть, а не строки отрицательных проверок внутри Rust-тестов.
const runtime = text => text.split(/\r?\n#\[cfg\(test\)\]/, 1)[0].replace(/^\s*\/\/.*$/gm, '');
assert(!/powershell|scriptblock|include_bytes!.*ps1|call_bcd\(/i.test(runtime(transaction) + runtime(adapter)));
assert(transaction.includes('crate::uefi_bcd::capture()'));
assert(transaction.includes('crate::uefi_bcd::create(plan, || self.guard_write())'));
assert(transaction.includes('crate::uefi_bcd::delete(plan)'));
assert(transaction.includes('crate::uefi_bcd::set_sequence'));
assert(adapter.includes('Presence::Conflict') && adapter.includes('policy::complete(&records)'));
assert(adapter.includes('store.sequence()?.as_deref() != expected'));
assert(adapter.includes('store.sequence()?.as_deref() != desired'));
assert(adapter.includes('volume_at(&drive).as_deref() == Ok(volume.as_str())'));
assert(adapter.includes('child.kill()') && adapter.includes('child.wait()'));
assert(!/Command::new\("(?:cmd|powershell)/i.test(adapter));
const wmi = source('windows_wmi.rs');
assert(wmi.includes('VariantClear') && wmi.includes('SafeArrayGetDim') && wmi.includes('MAX_ITEMS'));
assert(wmi.includes('PhantomData<&\'a Connection>') && wmi.includes('EOAC_DYNAMIC_CLOAKING'));
assert(source('windows_token.rs').includes('RevertToSelf()'));
for (const name of ['saves.rs', 'luatools.rs', 'windows_probe.rs']) {
  const text = source(name).replace(/^\s*\/\/.*$/gm, '');
  assert(!/powershell(?:\.exe)?"|Add-Type|Get-CimInstance|Invoke-CimMethod/.test(text), name);
}
console.log('PASS: нативный UEFI подключён; проверки владения/очереди сохранены; исходники не запускают Windows');
