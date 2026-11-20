import {readFile,readdir,mkdir,copyFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
const source=resolve('extension'),destination=resolve('dist/memocat-extension');
const files=['manifest.json','background.js','content.js','ui-api.js','ui.css','library.html','library.js','popup.html','popup.js','sidebar.html','sidebar.js','sidebar.css','lib/core.js','lib/adapters.js','lib/db.js','icons/icon16.png','icons/icon32.png','icons/icon48.png','icons/icon64.png','icons/icon128.png','icons/icon256.png','icons/platforms/chatgpt.png','icons/platforms/claude.png','icons/platforms/gemini.png','icons/platforms/deepseek.png','icons/platforms/yuanbao.png','icons/platforms/doubao.png','icons/platforms/kimi.png','icons/platforms/qianwen.png','icons/platforms/grok.png'];
const manifest=JSON.parse(await readFile(join(source,'manifest.json'),'utf8'));if(manifest.manifest_version!==3)throw new Error('Manifest V3 required');
for(const file of files)await readFile(join(source,file));
for(const file of files.filter(f=>f.endsWith('.js')))execFileSync(process.execPath,['--check',join(source,file)]);
await rm(destination,{recursive:true,force:true});for(const file of files){const path=join(destination,file);await mkdir(resolve(path,'..'),{recursive:true});await copyFile(join(source,file),path);}
const zip=resolve('dist/memocat-extension.zip');await rm(zip,{force:true});execFileSync('/usr/bin/zip',['-q','-r',zip,'.'],{cwd:destination});console.log(`Load unpacked: ${destination}\nZIP: ${zip}\n${files.length} files · version ${manifest.version}`);
