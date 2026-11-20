import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const app=resolve(process.argv[2]);
const server=pathToFileURL(join(app,'Contents/Resources/app/src/server.js')).href;
const code=`import {start} from ${JSON.stringify(server)};
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import assert from 'node:assert/strict';
const directory=await mkdtemp(join(tmpdir(),'memocat-package-'));let app;
try{app=await start({port:0,dataDir:directory});
for(const path of ['/','/app.js','/display-text.js','/marked.js','/purify.js','/api/state','/api/browser/config']){const response=await fetch(app.url+path);assert.equal(response.status,200,path);await response.arrayBuffer();}
console.log('Packaged Electron backend and UI assets verified');
}finally{await app?.close();await rm(directory,{recursive:true,force:true});}`;
execFileSync(join(app,'Contents/MacOS/MemoCat'),['--input-type=module','-e',code],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:'inherit',timeout:30000,cwd:'/private/tmp'});

const env={...process.env,MEMOCAT_VERIFY_PACKAGE:'1'};delete env.ELECTRON_RUN_AS_NODE;
const output=execFileSync(join(app,'Contents/MacOS/MemoCat'),[],{env,encoding:'utf8',timeout:30000,cwd:'/private/tmp'});
const status=JSON.parse(output.split('\n').find(line=>line.startsWith('MEMOCAT_PACKAGE '))?.slice(16)||'{}');
if(!status.packaged||!status.loginApi)throw new Error('Installed desktop startup capability verification failed');
console.log('Packaged app identity and login-item API verified');
