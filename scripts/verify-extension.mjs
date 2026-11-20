/* Real MV3 smoke test in an isolated Edge/Chromium profile. No user accounts or websites are contacted.
   Start a browser with --load-extension=<absolute extension path> --remote-debugging-port=0,
   then pass the port from its temporary DevToolsActivePort file. */
import assert from 'node:assert/strict';
import {writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {start} from '../src/server.js';
const deadline=setTimeout(()=>{console.error('Browser E2E exceeded 180 seconds');process.exit(1);},180000);deadline.unref();
const port=Number(process.argv[2]);if(!port)throw new Error('Usage: node scripts/verify-extension.mjs <debug-port>');
const endpoint=`http://127.0.0.1:${port}`;
class CDP{
 constructor(ws){this.ws=ws;this.n=0;this.calls=new Map();this.events=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const c=this.calls.get(m.id);if(c){this.calls.delete(m.id);clearTimeout(c.timer);m.error?c.reject(new Error(m.error.message)):c.resolve(m.result);}}else for(const handler of this.events.get(m.method)||[])handler(m.params);});}
 static async connect(url){const ws=new WebSocket(url);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});return new CDP(ws);}
 send(method,params={}){return new Promise((resolve,reject)=>{const id=++this.n;const timer=setTimeout(()=>{this.calls.delete(id);reject(new Error('CDP timeout: '+method));},15000);this.calls.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}));});}
 on(event,fn){const rows=this.events.get(event)||[];rows.push(fn);this.events.set(event,rows);}
 async evaluate(expression,contextId){const r=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,...(contextId?{contextId}:{})});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
 close(){this.ws.close();}
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<80;i++){if(await fn())return;await sleep(100);}throw new Error('Timed out waiting for UI condition');}
const targets=()=>fetch(endpoint+'/json/list').then(r=>r.json());
const list=await targets(),library=list.find(t=>t.url.includes('/library.html'));assert.ok(library,'Extension library target missing');
const ui=await CDP.connect(library.webSocketDebuggerUrl),connections=[ui];const errors=[];ui.on('Runtime.exceptionThrown',e=>errors.push(e.exceptionDetails.text));await ui.send('Runtime.enable');
const call=(type,args={})=>ui.evaluate(`chrome.runtime.sendMessage(${JSON.stringify({type,...args})})`);
let result=await call('state');assert.equal(result.ok,true,JSON.stringify(result));const extensionId=result.data.extensionId;
await ui.evaluate(`new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase('MemoCatBrowser');r.onsuccess=()=>resolve(true);r.onerror=()=>reject(r.error);})`);await call('settings',{patch:{autoSave:true,sync:{enabled:false,url:'http://127.0.0.1:3792',token:''}}});
const root=await mkdtemp(join(tmpdir(),'memo-browser-e2e-')),app=await start({port:0,dataDir:root});
const browserInfo=await (await fetch(endpoint+'/json/version')).json(),browser=await CDP.connect(browserInfo.webSocketDebuggerUrl);connections.push(browser);
const target=await browser.send('Target.createTarget',{url:'about:blank'});let pageTarget;for(let i=0;i<20;i++){pageTarget=(await targets()).find(t=>t.id===target.targetId);if(pageTarget)break;await sleep(100);}
const page=await CDP.connect(pageTarget.webSocketDebuggerUrl);connections.push(page);let fixtureHTML='',contentContext;const contexts=[];
page.on('Runtime.executionContextCreated',({context})=>{contexts.push(context);if(context.name===extensionId||context.origin==='chrome-extension://'+extensionId)contentContext=context.id;});
page.on('Runtime.executionContextsCleared',()=>{contexts.length=0;contentContext=undefined;});page.on('Runtime.exceptionThrown',e=>errors.push(e.exceptionDetails.text));await page.send('Runtime.enable');await page.send('Page.enable');
page.on('Fetch.requestPaused',event=>{void page.send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html; charset=utf-8'}],body:Buffer.from(event.resourceType==='Document'?fixtureHTML:'').toString('base64')});});await page.send('Fetch.enable',{patterns:[{urlPattern:'*'}]});
const fixtures=[
 ['chatgpt','https://chatgpt.com/c/fixture','<div data-message-id="q1" data-content-search-unit-key="q1:user"><p>数据库选型 SQLite</p><button>复制</button></div><div data-message-id="a1" data-content-search-unit-key="a1:assistant"><div class="markdown"><p>本机归档，保留全文检索。</p><pre>const safe = "&lt;script&gt;";</pre></div></div>'],
 ['claude','https://claude.ai/chat/fixture','<div data-testid="user-message">Claude question</div><div class="font-claude-response">Claude answer</div>'],
 ['gemini','https://gemini.google.com/app/fixture','<style>user-query,model-response{display:contents}</style><user-query><div class="query-content"><div class="query-text-line">Gemini question</div><div class="query-text-line">second line</div></div></user-query><model-response><div class="response-container"><message-content><div class="markdown-main-panel">Gemini answer</div></message-content></div></model-response>'],
 ['deepseek','https://chat.deepseek.com/a/chat/s/fixture','<div class="_9663006"><div class="fbb737a4">DeepSeek question</div></div><div class="ds-message"><div class="ds-markdown">DeepSeek answer</div></div>'],
 ['yuanbao','https://yuanbao.tencent.com/chat/fixture','<div data-conv-speaker="human"><div class="hyc-content-text">元宝问题</div></div><div data-conv-speaker="ai"><div class="agent-chat__conv--ai__speech_show">元宝回答</div></div>'],
 ['doubao','https://www.doubao.com/chat/fixture','<section><div data-message-id="doubao-q"><div class="text-g-send-msg-bubble-text">豆包问题</div></div><div data-foundation-type="send-message-action-bar"></div></section><section><div data-message-id="doubao-a"><div class="md-box-root">豆包回答</div></div><div data-foundation-type="receive-message-action-bar"></div></section>'],
 ['kimi','https://www.kimi.com/chat/fixture','<div class="chat-content-item-user">Kimi question</div><div class="chat-content-item-assistant">Kimi answer</div>'],
 ['grok','https://x.com/i/grok?conversation=fixture','<div data-testid="primaryColumn"><div class="grok-thread"><div class="items-end" style="align-self:flex-end"><div dir="ltr">Grok question</div></div><div><div class="response-content-markdown"><p>Grok answer</p></div><div><button aria-label="Copy text"></button><button aria-label="Regenerate"></button></div></div></div><form><textarea placeholder="Ask anything"></textarea></form></div>'],
 ['qianwen','https://www.qianwen.com/chat/fixture','<div id="qw-chat-content"><div data-chat-question-wrap="q"><div class="question-text-card">千问问题</div></div><div data-chat-answers-wrap="a"><div class="markdown-pc-special-class">千问回答</div></div></div>']
];
try{
 for(const [id,url,html] of fixtures){fixtureHTML=`<!doctype html><html><head><title>${id} 测试对话</title></head><body>${html}</body></html>`;await page.send('Page.navigate',{url});let saved;
   for(let i=0;i<60;i++){await sleep(150);saved=await call('read',{id:id+':fixture'});if(saved.data)break;}
   assert.ok(saved.data,`Capture missing: ${id}`);assert.equal(saved.data.messages.length,2,id);assert.ok(!saved.data.messages[0].text.includes('复制'));
   if(id==='chatgpt'){
     if(!contentContext)contentContext=contexts.find(c=>c.name.includes(extensionId))?.id;assert.ok(contentContext,'Content script execution context missing: '+JSON.stringify(contexts));
     const denied=await page.evaluate(`chrome.runtime.sendMessage({type:'export'})`,contentContext);assert.equal(denied.ok,false);
     const wrong=await page.evaluate(`chrome.runtime.sendMessage({type:'observe',manual:true,conversation:{id:'claude:fake',platform:'claude',url:'https://claude.ai/chat/fake',title:'forged',messages:[{id:'x',role:'user',text:'forged'}]}})`,contentContext);assert.equal(wrong.ok,false);
     await page.evaluate(`document.querySelector('[data-message-id="a1"] .markdown').textContent='更新后的回复';`);await sleep(2000);
     assert.equal((await call('read',{id:'chatgpt:fixture'})).data.messages.length,2);
     await page.evaluate(`document.querySelector('[data-message-id="q1"]').remove()`);await sleep(2000);assert.equal((await call('read',{id:'chatgpt:fixture'})).data.messages.length,2);
   }
   console.log('Captured fixture:',id);
 }
 console.log('Verified capture and sender isolation');
 fixtureHTML='<!doctype html><html><head><title>Grok Web</title></head><body><div class="items-end"><div class="message-bubble">Grok web prompt</div></div><div class="items-start"><div class="message-bubble"><div class="response-content-markdown">Grok web answer</div></div></div></body></html>';
 await page.send('Page.navigate',{url:'https://grok.com/c/semantic'});let semanticSaved;
 for(let i=0;i<60;i++){await sleep(150);semanticSaved=await call('read',{id:'grok:semantic'});if(semanticSaved.data)break;}
 assert.ok(semanticSaved.data,'Semantic grok.com capture missing');assert.equal(semanticSaved.data.messages[0].role,'user');assert.equal(semanticSaved.data.messages[1].role,'assistant');
 await call('delete',{id:'grok:semantic'});
 fixtureHTML=`<!doctype html><html><head><title>Grok Paired Turns</title></head><body><div data-testid="primaryColumn"><div class="rnw-thread" style="width:720px"><div class="turn"><div style="display:flex;flex-direction:column;align-items:flex-end"><div dir="ltr" style="width:220px;margin-left:auto">第一轮用户提问</div></div><div><div dir="ltr">第一轮 AI 回答</div><div><button aria-label="Copy text"></button><button aria-label="Like"></button><button aria-label="Regenerate"></button></div></div></div><div class="turn"><div style="display:flex;flex-direction:column;align-items:flex-end"><div dir="ltr" style="width:220px;margin-left:auto">第二轮用户提问</div></div><div><div dir="ltr">第二轮 AI 回答</div><div><button aria-label="Copy text"></button><button aria-label="Dislike"></button></div></div></div><div class="turn-user-only"><div dir="ltr" style="margin-left:auto;width:160px">第三轮单独提问</div></div></div></body></html>`;
 await page.send('Page.navigate',{url:'https://x.com/i/grok?conversation=paired'});let pairedSaved;
 for(let i=0;i<60;i++){await sleep(150);pairedSaved=await call('read',{id:'grok:paired'});if(pairedSaved.data)break;}
 assert.ok(pairedSaved.data,'Paired x.com/i/grok capture missing');
 assert.deepEqual(pairedSaved.data.messages.map(m=>[m.role,m.text]),[
   ['user','第一轮用户提问'],
   ['assistant','第一轮 AI 回答'],
   ['user','第二轮用户提问'],
   ['assistant','第二轮 AI 回答'],
   ['user','第三轮单独提问']
 ]);
 await call('delete',{id:'grok:paired'});
 fixtureHTML='<!doctype html><html><head><title>Home / X</title></head><body><main><div>X Home Feed</div></main></body></html>';
 await page.send('Page.navigate',{url:'https://x.com/home'});await sleep(500);
 assert.equal(await page.evaluate(`document.getElementById('memocat-capture')`),null);
 fixtureHTML='<!doctype html><html><head><title>Grok SPA</title></head><body><div data-testid="primaryColumn"><form><textarea placeholder="Ask anything"></textarea></form></div></body></html>';
 await page.send('Page.navigate',{url:'https://x.com/i/grok?conversation=spa'});
 await until(()=>page.evaluate(`document.getElementById('memocat-capture')?.hidden===false`));
 await page.evaluate(`history.pushState({},'','/home');window.dispatchEvent(new Event('popstate'));`);
 await until(()=>page.evaluate(`document.getElementById('memocat-capture')?.hidden===true`));
 fixtureHTML=`<!doctype html><html><head><title>qianwen 测试对话</title></head><body>${fixtures.at(-1)[2]}</body></html>`;
 await page.send('Page.navigate',{url:fixtures.at(-1)[1]});await sleep(500);
 assert.equal(await page.evaluate(`document.getElementById('memocat-capture')?.hidden`),false);
 await ui.evaluate(`(async()=>{const tabs=await chrome.tabs.query({url:'https://www.qianwen.com/*'});if(tabs[0])await chrome.tabs.sendMessage(tabs[0].id,{type:'toggleSidebar'});})()`);
 await until(()=>page.evaluate(`document.getElementById('memocat-sidebar')?.style.right==='0px'`));
 await ui.evaluate(`(async()=>{const tabs=await chrome.tabs.query({url:'https://www.qianwen.com/*'});if(tabs[0])await chrome.tabs.sendMessage(tabs[0].id,{type:'closeSidebar'});})()`);
 await until(()=>page.evaluate(`!document.getElementById('memocat-sidebar')`));
 await call('delete',{id:'qianwen:fixture'});await page.evaluate(`document.querySelector('.question-text-card').textContent='千问问题（手动恢复测试）'`);await sleep(2000);assert.equal((await call('read',{id:'qianwen:fixture'})).data,undefined);
 const manual=await call('captureActive');assert.equal(manual.ok,true,JSON.stringify(manual));assert.equal(manual.data.count,2);
 // Exercise the outbox CAS in real IndexedDB, including updates during an older request.
 const queueSafe=await ui.evaluate(`(async()=>{await import('./lib/db.js');const c=await MemoDB.get('conversations','chatgpt:fixture');const one=structuredClone(c);one.messages[1].text+=' v2';await MemoDB.save(one,{manual:true});const old=await MemoDB.get('outbox',c.id);const two=structuredClone(c);two.messages[1].text+=' v3';await MemoDB.save(two,{manual:true});const latest=await MemoDB.get('outbox',c.id);await MemoDB.ack(c.id,old.changeId);const retained=await MemoDB.get('outbox',c.id);await MemoDB.save(c,{manual:true});return retained?.changeId===latest.changeId;})()`);assert.equal(queueSafe,true);
 const connected=await call('connect',{url:app.url});assert.equal(connected.ok,true,JSON.stringify(connected));
 assert.equal(app.store.stats().conversations,9);assert.equal((await call('state')).data.syncState.pending,0);
 // Verify auto-recovery when desktop rotates its token.
 await fetch(app.url+'/api/browser/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({rotate:true})});
 const resynced=await call('sync');assert.equal(resynced.ok,true,JSON.stringify(resynced));
 assert.equal(app.store.stats().conversations,9);
 const mcp=await (await fetch(app.url+'/mcp/codex',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'recall',arguments:{query:'SQLite',sources:['browser-chatgpt']}}})})).json();assert.match(mcp.result.content[0].text,/SQLite/);
 const mcpGrok=await (await fetch(app.url+'/mcp/codex',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'recall',arguments:{query:'Grok answer',sources:['browser-grok']}}})})).json();assert.match(mcpGrok.result.content[0].text,/Grok answer/);
 const backup=await call('export');assert.equal(backup.data.conversations.length,9);
 await call('delete',{id:'chatgpt:fixture'});await call('sync');assert.equal(app.store.stats().conversations,8);
 const restored=await call('import',{backup:backup.data});assert.equal(restored.ok,true);await call('sync');assert.equal(app.store.stats().conversations,9);
 // Restart the background worker, then read the persisted library.
 const workerTarget=(await browser.send('Target.getTargets')).targetInfos.find(t=>t.type==='service_worker'&&t.url.startsWith('chrome-extension://'+extensionId));assert.ok(workerTarget,'Worker did not start');
 const session=await browser.send('Target.attachToTarget',{targetId:workerTarget.targetId,flatten:true});
 // Worker state remains durable after terminating the service worker.
 await browser.send('Target.detachFromTarget',{sessionId:session.sessionId});await browser.send('Target.closeTarget',{targetId:workerTarget.targetId});await sleep(300);
 assert.equal((await call('export')).data.conversations.length,9);
 console.log('Verified desktop sync, backup and worker restart');await ui.send('Page.navigate',{url:'chrome-extension://'+extensionId+'/library.html'});await until(()=>ui.evaluate(`!!document.getElementById('search')?.oninput && document.getElementById('summary')?.textContent.startsWith('9 段')`));await ui.evaluate(`document.getElementById('search').value='SQLite';document.getElementById('search').dispatchEvent(new Event('input',{bubbles:true}));`);await until(()=>ui.evaluate(`document.querySelectorAll('.conversation').length===1`));assert.equal(await ui.evaluate(`document.querySelectorAll('.conversation').length`),1);await ui.evaluate(`document.querySelector('.conversation').click()`);await until(()=>ui.evaluate(`document.querySelectorAll('.message').length===2`));assert.equal(await ui.evaluate(`document.querySelectorAll('.message').length`),2);
 assert.equal(await ui.evaluate(`document.querySelector('.message-text').textContent`),'数据库选型 SQLite');
 await ui.evaluate(`document.getElementById('search').value='';document.getElementById('search').dispatchEvent(new Event('input',{bubbles:true}));`);await sleep(400);
 console.log('Verified library search and detail');
 // Verify the 3-tab sidebar view (Memories, Detail, Connections, Settings)
 await ui.send('Page.navigate',{url:'chrome-extension://'+extensionId+'/sidebar.html'});
 await until(()=>ui.evaluate(`document.getElementById('stat-total')?.textContent==='9' && document.querySelectorAll('.cm-memory-card').length===9`));
 await ui.evaluate(`document.querySelector('.cm-memory-card[data-id="chatgpt:fixture"]').click()`);
 await until(()=>ui.evaluate(`!document.getElementById('tab-panel-detail').hidden && document.querySelectorAll('.cm-msg-card').length===2`));
 await ui.evaluate(`document.getElementById('nav-connections').click()`);
 await until(()=>ui.evaluate(`!document.getElementById('tab-panel-connections').hidden && document.querySelectorAll('.cm-platform-item').length===9`));
 await ui.evaluate(`document.getElementById('nav-settings').click()`);
 await until(()=>ui.evaluate(`!document.getElementById('tab-panel-settings').hidden && document.getElementById('auto-save-toggle').checked===true`));
 await ui.evaluate(`document.getElementById('nav-memories').click()`);
 await until(()=>ui.evaluate(`!document.getElementById('tab-panel-memories').hidden`));
 console.log('Verified sidebar 3-tab UI');
 await ui.send('Page.navigate',{url:'chrome-extension://'+extensionId+'/library.html'});
 await until(()=>ui.evaluate(`document.getElementById('summary')?.textContent.startsWith('9 段')`));
 assert.equal(await ui.evaluate(`document.querySelectorAll('#platform-filter option').length`),10);
 await call('delete',{id:'chatgpt:fixture'});
 await until(()=>ui.evaluate(`document.querySelectorAll('#platform-filter option').length===9 && !document.querySelector('#platform-filter option[value="chatgpt"]')`));
 await call('import',{backup:backup.data});
 await until(()=>ui.evaluate(`document.querySelectorAll('#platform-filter option').length===10`));
 await call('sync');
 await ui.send('Page.bringToFront');await ui.send('Emulation.setDeviceMetricsOverride',{width:1440,height:950,deviceScaleFactor:1,mobile:false});const screenshot=await ui.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(resolve('extension/preview.png'),Buffer.from(screenshot.data,'base64'));
 await ui.send('Emulation.setDeviceMetricsOverride',{width:480,height:860,deviceScaleFactor:1,mobile:false});assert.ok(await ui.evaluate('document.documentElement.scrollWidth <= innerWidth'));
 await ui.send('Emulation.setDeviceMetricsOverride',{width:1440,height:950,deviceScaleFactor:1,mobile:false});
 // Verify end-to-end recapture (replacing stale merged roles across extension IDB and synced desktop App)
 fixtureHTML=`<!doctype html><html><head><title>grok 测试对话</title></head><body><div data-testid="primaryColumn"><div class="grok-thread"><div class="items-end" style="align-self:flex-end"><div dir="ltr">Grok question recaptured</div></div><div><div class="response-content-markdown"><p>Grok answer recaptured</p></div><div><button aria-label="Copy text"></button><button aria-label="Regenerate"></button></div></div></div></div></body></html>`;
 await call('settings',{patch:{autoSave:false}});
 await page.send('Page.navigate',{url:'https://x.com/i/grok?conversation=fixture'});
 await until(()=>page.evaluate(`!!document.querySelector('[data-testid="primaryColumn"]')`));
 await ui.evaluate(`(async()=>{await import('./lib/db.js');await MemoDB.save({id:'grok:fixture',platform:'grok',url:'https://x.com/i/grok?conversation=fixture',title:'grok 测试对话',messages:[{id:'grok:dom:r1:assistant:0',role:'assistant',text:'Stale merged user+AI'}]},{manual:true,replace:true});})()`);
 await call('sync');
 await ui.send('Page.navigate',{url:'chrome-extension://'+extensionId+'/library.html'});
 await until(()=>ui.evaluate(`!!document.querySelector('.conversation[data-id="grok:fixture"]')`));
 await ui.evaluate(`document.querySelector('.conversation[data-id="grok:fixture"]').click()`);
 await until(()=>ui.evaluate(`document.getElementById('detail-recapture') && document.querySelectorAll('.message').length===1`));
 await ui.evaluate(`document.getElementById('detail-recapture').click()`);
 await until(()=>ui.evaluate(`document.querySelectorAll('.message').length===2 && document.querySelector('.message-text')?.textContent==='Grok question recaptured'`));
 const afterLib=(await call('read',{id:'grok:fixture'})).data;
 assert.deepEqual(afterLib.messages.map(m=>[m.role,m.text]),[['user','Grok question recaptured'],['assistant','Grok answer recaptured']]);
 const appGrokList=await (await fetch(app.url+'/api/conversations?source=browser-grok')).json();
 const appGrokDetail=await (await fetch(app.url+'/api/conversations/'+appGrokList.items[0].id)).json();
 assert.deepEqual(appGrokDetail.records.map(r=>[r.role,r.text]),[['user','Grok question recaptured'],['assistant','Grok answer recaptured']]);
 await page.evaluate(`document.querySelector('.response-content-markdown p').textContent='Grok answer v2'`);
 await ui.send('Page.navigate',{url:'chrome-extension://'+extensionId+'/sidebar.html'});
 await until(()=>ui.evaluate(`!!document.querySelector('.cm-memory-card[data-id="grok:fixture"]')`));
 await ui.evaluate(`document.querySelector('.cm-memory-card[data-id="grok:fixture"]').click()`);
 await until(()=>ui.evaluate(`!document.getElementById('tab-panel-detail').hidden && document.querySelectorAll('.cm-msg-card').length===2`));
 await ui.evaluate(`document.getElementById('detail-recapture-btn').click()`);
 await until(()=>ui.evaluate(`document.querySelectorAll('.cm-msg-body')[1]?.textContent==='Grok answer v2'`));
 const afterSidebar=(await call('read',{id:'grok:fixture'})).data;
 assert.equal(afterSidebar.messages[1].text,'Grok answer v2');
 await call('settings',{patch:{autoSave:true}});
 console.log('Verified Grok paired extraction and end-to-end recapture');
 await page.send('Fetch.disable');
 await page.send('Page.navigate',{url:app.url+'/#connections'});
 // Verify that when the connections page is already open, disconnecting and re-pairing from the extension dynamically updates the app UI without reload.
 await until(()=>page.evaluate(`document.querySelector('input[placeholder="等待浏览器扩展发起连接…"]')?.value===${JSON.stringify(extensionId)}`));
 await page.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='解除绑定').click()`);
 await until(()=>page.evaluate(`document.querySelector('input[placeholder="等待浏览器扩展发起连接…"]')?.value===''`));
 const reconnected=await call('connect',{url:app.url});assert.equal(reconnected.ok,true);
 await until(()=>page.evaluate(`document.querySelector('input[placeholder="等待浏览器扩展发起连接…"]')?.value===${JSON.stringify(extensionId)}`));
 await until(()=>page.evaluate(`document.querySelectorAll('#source-filter option').length===10`));
 assert.equal(await page.evaluate(`document.querySelectorAll('#source-filter option[value^="browser-"]').length`),9);
 assert.equal(await page.evaluate(`document.querySelectorAll('#source-filter option[value="codex"]').length`),0);
 await page.send('Page.navigate',{url:app.url+'/#library'});
 await until(()=>page.evaluate(`document.querySelectorAll('#conversation-list .conv-source-tag .web-source-icon').length===9`));
 assert.equal(await page.evaluate(`![...document.querySelectorAll('.conv-source-tag')].some(n=>n.textContent.includes('· 网页'))`),true);
 console.log('Verified desktop browser connection panel and dynamic source filters');
 assert.deepEqual(errors,[],'Runtime errors');
 console.log('PASS: real MV3 capture (9 adapters), authorization, partial merge, IDB persistence, backup restore, retry-safe sync, desktop MCP and responsive UI.');
}catch(err){
 console.error('E2E failed. errors=',errors);
 try{console.error('UI state=',await ui.evaluate('({summary:document.getElementById("summary")?.textContent,toast:document.getElementById("toast")?.textContent,convs:document.querySelectorAll(".conversation").length,msgs:document.querySelectorAll(".message").length,detail:document.getElementById("detail")?.textContent?.slice(0,200)})'));}catch{}
 throw err;
}finally{for(const c of connections)c.close();await app.close();await rm(root,{recursive:true,force:true});}
