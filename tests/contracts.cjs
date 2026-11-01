const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const files=(dir,ext)=>fs.readdirSync(dir,{recursive:true}).filter(n=>n.endsWith(ext)).map(n=>path.join(dir,n));
const lib=fs.readFileSync(path.join(root,'src-tauri/src/lib.rs'),'utf8');
const commands=[...lib.match(/generate_handler!\[([\s\S]*?)\]/)[1].matchAll(/(?:\w+::)?(\w+)\s*,?/g)].map(m=>m[1]);
assert.equal(new Set(commands).size,commands.length,'Повтор команды в обработчике');
let count=0;
for(const file of files(path.join(root,'ui'),'.js')){
 const js=fs.readFileSync(file,'utf8');cp.execFileSync(process.execPath,['--check',file]);
 for(const [,name] of js.matchAll(/(?:call|invoke)\("([a-z_0-9]+)"/g)){assert(commands.includes(name),`${path.relative(root,file)}: ${name} не зарегистрирована`);count++;}
 if(path.basename(file)!=='storage.js')assert(!/\blocalStorage\b/.test(js),`${file}: обход защищённого хранилища`);
 assert(!/\bapiKey\s*:/.test(js),`${file}: API-ключ не должен передаваться из UI`);
}
for (const file of [...files(path.join(root,'scripts'),'.js'),...files(path.join(root,'scripts'),'.cjs')]) cp.execFileSync(process.execPath,['--check',file]);
for (const name of ['ui_dev_server.js','capture_all_screenshots.js']) {
 const source=fs.readFileSync(path.join(root,'scripts',name),'utf8');
 assert(source.includes('dev-mock.cjs') && !source.includes('window.__TAURI__ ='), `${name}: требуется общий мок, не отдельная копия`);
}
const html=fs.readFileSync(path.join(root,'ui/index.html'),'utf8');const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length,'Повтор HTML id');
const registeredBodies=files(path.join(root,'src-tauri/src'),'.rs').map(f=>fs.readFileSync(f,'utf8')).join('\n');
for(const name of commands)assert(new RegExp(`(?:async\\s+)?fn\\s+${name}\\s*\\(`).test(registeredBodies),`${name}: нет функции Rust`);
assert(!html.includes('app_check_update'));assert(html.includes('aria-describedby="modal-message"'));
// Пути: вшитые файлы, ресурсы Tauri, подключения UI и команды сборки должны существовать
const rel=p=>path.relative(root,p).split(path.sep).join('/');
let pathCount=0;const need=(target,where)=>{assert(fs.existsSync(target),`${where}: не найден ${rel(target)}`);pathCount++;};
const crateDir=file=>{let dir=path.dirname(file);while(!fs.existsSync(path.join(dir,'Cargo.toml'))&&dir!==root)dir=path.dirname(dir);return dir;};
const local=ref=>!/^(?:[a-z][\w+.-]*:|#|\/\/)/i.test(ref);
for(const file of ['src-tauri/src','eclipse-hv/src','tests/safety-core/src'].flatMap(dir=>files(path.join(root,dir),'.rs'))){
 const rs=fs.readFileSync(file,'utf8');
 for(const [,literal,fromCrate] of rs.matchAll(/include_(?:bytes|str)!\(\s*(?:"([^"]+)"|concat!\(\s*env!\("CARGO_MANIFEST_DIR"\)\s*,\s*"([^"]+)"\s*\))/g))need(literal?path.resolve(path.dirname(file),literal):path.join(crateDir(file),fromCrate),rel(file));
 for(const [,target] of rs.matchAll(/#\[path\s*=\s*"([^"]+)"\]/g))need(path.resolve(path.dirname(file),target),rel(file));
}
const tauriDir=path.join(root,'src-tauri'),tauri=JSON.parse(fs.readFileSync(path.join(tauriDir,'tauri.conf.json'),'utf8'));
need(path.join(tauriDir,tauri.build.frontendDist,'index.html'),'tauri.conf.json → build.frontendDist');
for(const icon of tauri.bundle?.icon||[])need(path.join(tauriDir,icon),'tauri.conf.json → bundle.icon');
const resources=tauri.bundle?.resources||{};for(const source of Array.isArray(resources)?resources:Object.keys(resources))if(!source.includes('*'))need(path.join(tauriDir,source),'tauri.conf.json → bundle.resources');
const uiDir=path.join(root,'ui'),loaded=new Set();
for(const [,ref] of html.matchAll(/\s(?:src|href)="([^"]+)"/g))if(local(ref)){const target=path.join(uiDir,ref.split(/[?#]/)[0]);need(target,'ui/index.html');loaded.add(target);}
const loaderFile=[...loaded].find(file=>path.basename(file)==='loader.js');assert(loaderFile,'ui/index.html: не подключён loader.js');
const modules=JSON.parse(fs.readFileSync(loaderFile,'utf8').match(/for \(const source of (\[[^\]]*\])\)/)[1]);
for(const name of modules){const target=path.join(uiDir,name);need(target,rel(loaderFile));loaded.add(target);}
for(const file of files(uiDir,'.js'))assert(loaded.has(file),`${rel(file)}: модуль не подключён в index.html или ${rel(loaderFile)}`);
for(const file of files(uiDir,'.css')){const css=fs.readFileSync(file,'utf8');for(const [,ref] of css.matchAll(/(?:url\(\s*['"]?|@import\s+['"])([^'")\s]+)/g))if(local(ref))need(path.resolve(path.dirname(file),ref.split(/[?#]/)[0]),rel(file));}
for(const file of files(uiDir,'.js'))for(const [,ref] of fs.readFileSync(file,'utf8').matchAll(/["'`](\.\/[\w./-]+\.(?:png|jpe?g|gif|svg|ico|webp|ttf|woff2?|mp3|wav|ogg))["'`]/g))need(path.join(uiDir,ref),rel(file));
const commandPaths=(text,base,where)=>{
 for(const [,ref] of text.matchAll(/\b(?:node|python)\s+((?:\.\.\/)*[\w.-]+(?:\/[\w.-]+)+\.(?:c?js|py))/g))need(path.resolve(base,ref),where);
 for(const [,ref] of text.matchAll(/--(?:prefix|manifest-path)\s+([\w./-]+)/g))need(path.resolve(base,ref),where);
};
commandPaths(JSON.stringify(JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).scripts),root,'package.json');
commandPaths(JSON.stringify(JSON.parse(fs.readFileSync(path.join(root,'eclipse-manifest/package.json'),'utf8')).scripts),path.join(root,'eclipse-manifest'),'eclipse-manifest/package.json');
if(fs.existsSync(path.join(root,'.github/workflows')))for(const file of files(path.join(root,'.github/workflows'),'.yml'))commandPaths(fs.readFileSync(file,'utf8'),root,rel(file));
console.log(`Контракты: ${commands.length} команд Rust; ${count} вызовов; синтаксис JS; уникальные id; изоляция хранилища; ${pathCount} путей ресурсов и подключений — OK`);
