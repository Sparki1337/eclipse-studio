// quality — обязательный шлюз релиза: только локальные проверки
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) throw new Error('Node.js >=22.12.0 required');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// Шлюз релиза не должен наследовать необязательный фильтр точечных UI-тестов.
delete process.env.ECLIPSE_TEST_FILTER;
const offline = process.env.ECLIPSE_OFFLINE === '1' ? ['--offline'] : [];
const steps = [
  ['node', ['scripts/plugin-integrity.cjs', 'check']],
  ['node', ['scripts/resource-integrity.cjs', 'check']],
  ['node', ['tests/integrity-newlines.cjs']],
  ['node', ['scripts/check-deepmerge.cjs']],
  ['node', ['tests/csp.test.cjs']],
  [npm, ['--prefix', 'eclipse-manifest', 'run', 'typecheck']],
  [npm, ['test']],
  ['python', ['tests/ryuu_secret_test.py']],
  ['cargo', ['fmt', '--manifest-path', 'src-tauri/Cargo.toml', '--check']],
  ['cargo', ['fmt', '--manifest-path', 'tests/safety-core/Cargo.toml', '--check']],
  ['cargo', ['test', '--manifest-path', 'tests/safety-core/Cargo.toml', '--locked', ...offline]],
  ['cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', '--locked', ...offline]],
  ['cargo', ['check', '--manifest-path', 'eclipse-hv/Cargo.toml', '--locked', ...offline]],
  ['cargo', ['clippy', '--manifest-path', 'src-tauri/Cargo.toml', '--all-targets', '--locked', ...offline, '--', '-D', 'warnings']],
];
if (process.platform === 'win32') {
  steps.push(['node', ['tests/plugin-download.cjs']]);
  steps.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'tests/plugin-safety.ps1']]);
  steps.push(['node', ['tests/uefi-native.cjs']]);
  steps.push(['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/check_cloud_policy.ps1']]);
} else console.log('Фикстуры DPAPI/MSVC требуют отдельного запуска на Windows.');
for (const [command, args] of steps) {
  console.log(`\n=== ${command} ${args.join(' ')} ===`);
  // Командные скрипты на Windows требуют оболочки; все аргументы здесь — фиксированные литералы.
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: command.endsWith('.cmd') });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('\nQuality gate passed. This is not an antivirus certificate or a system-boot test.');
