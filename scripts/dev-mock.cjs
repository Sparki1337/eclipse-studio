// Единственный источник поведения Tauri для тестов, dev-server и снимков.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
module.exports = function devMock(catalog = []) {
  const lib = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8');
  const commands = [...lib.match(/generate_handler!\[([\s\S]*?)\]/)[1].matchAll(/(?:\w+::)?(\w+)\s*,?/g)].map(match => match[1]);
  const config = { commands, responses: { files_catalog: { cached: false, files: catalog } } };
  return `if(!sessionStorage.getItem('__native_state')){localStorage.setItem('cgs-splash','0');localStorage.setItem('cgs-theme','graphite');localStorage.setItem('accent','white');}\nwindow.__CGS_MOCK_CONFIG__=${JSON.stringify(config)};\n` + fs.readFileSync(path.join(root, 'tests/tauri-mock.js'), 'utf8');
};
