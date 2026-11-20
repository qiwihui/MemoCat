import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const binary=process.env.MEMO_BROWSER_BINARY||'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';await access(binary);
const profile=await mkdtemp(join(tmpdir(),'memo-extension-test-'));
const browser=spawn(binary,['--headless=new','--disable-crash-reporter','--no-first-run','--no-default-browser-check','--user-data-dir='+profile,'--remote-debugging-port=0','--disable-extensions-except='+resolve('extension'),'--load-extension='+resolve('extension'),'about:blank'],{stdio:'ignore'});
let exited=false;browser.on('exit',()=>{exited=true;});
try{
 let port;for(let i=0;i<100;i++){try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);if(port)break;}catch{}if(exited)throw new Error('测试浏览器启动失败');await new Promise(r=>setTimeout(r,100));}if(!port)throw new Error('未找到临时测试浏览器端口');
 // Wait for the first-install library tab, rather than assuming startup timing.
 for(let i=0;i<100;i++){const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();if(targets.some(t=>t.url.includes('/library.html')))break;await new Promise(r=>setTimeout(r,100));}
 const test=spawn(process.execPath,['scripts/verify-extension.mjs',String(port)],{stdio:'inherit'});const code=await new Promise((resolve,reject)=>{test.on('error',reject);test.on('exit',resolve);});if(code!==0)process.exitCode=code||1;
}finally{
 if(!exited){browser.kill('SIGTERM');await new Promise(resolve=>{const timer=setTimeout(()=>{browser.kill('SIGKILL');resolve();},5000);browser.once('exit',()=>{clearTimeout(timer);resolve();});});}
 await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100});
}
