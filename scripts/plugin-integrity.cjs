// plugin-integrity — карта SHA-256: Dist ↔ исходники и lock-файл сборки
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../eclipse-manifest');
const manifest=path.join(root,'.millennium/Dist/build-integrity.json');
const sources=['frontend/index.tsx','webkit/index.tsx','backend/main.lua','backend/safe-io.ps1','backend/state-store.ps1','backend/file-transaction.ps1','backend/download-package.ps1','backend/install-loader.ps1','tsconfig.json','frontend/tsconfig.json','webkit/tsconfig.json','package.json','.npmrc','package-lock.json','plugin.json','../scripts/check-deepmerge.cjs'];
const outputs=['.millennium/Dist/index.js','.millennium/Dist/webkit.js'];
const hashes=names=>Object.fromEntries(names.map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex')]));
const actual={schema:1,algorithm:'SHA-256',sources:hashes(sources),outputs:hashes(outputs)};
if(process.argv[2]==='write'){fs.writeFileSync(manifest,JSON.stringify(actual,null,2)+'\n');console.log('Dist: записана карта SHA-256 исходников и результатов сборки');}
else if(process.argv[2]==='check'){
 const expected=JSON.parse(fs.readFileSync(manifest,'utf8'));
 if(JSON.stringify(expected)!==JSON.stringify(actual))throw new Error('Dist не соответствует исходникам/lock-файлу. Запустите npm run build:plugin.');
 console.log('Dist: SHA-256 исходников, lock-файла и обоих bundle совпадает');
}else throw new Error('Usage: node scripts/plugin-integrity.cjs write|check');
