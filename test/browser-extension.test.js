import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import '../extension/lib/core.js';
import {start} from '../src/server.js';
const core=globalThis.MemoCore;
const message=(id,text,role='user')=>({id,text,role});
const fixture=(messages,extra={})=>({id:'chatgpt:fixture',platform:'chatgpt',url:'https://chatgpt.com/c/fixture',title:'数据库选型',messages,...extra});
test('browser observations merge partial windows, updates and repeated messages without truncating history',()=>{
 const first=core.reconcile(null,fixture([message('a','第一问'),message('b','第一答','assistant')]));
 const second=core.reconcile(first,fixture([message('b','第一答','assistant'),message('c','第二问')]));assert.deepEqual(second.messages.map(m=>m.id),['a','b','c']);
 assert.equal(core.reconcile(second,fixture([message('b','第一答','assistant'),message('c','第二问')])),second);
 const updated=core.reconcile(second,fixture([message('b','完整的第一答','assistant')]));assert.equal(updated.messages[1].text,'完整的第一答');assert.equal(updated.messages.length,3);
 const older=core.reconcile(updated,fixture([message('earlier','前置历史'),message('a','第一问')]));assert.deepEqual(older.messages.map(m=>m.id),['earlier','a','b','c']);
 const repeat=core.reconcile(null,fixture([message('x','重复'),message('y','重复')]));assert.equal(repeat.messages.length,2);
});
test('browser identities and settings reject foreign URLs, duplicate IDs and remote sync endpoints',()=>{
 assert.equal(core.platformFor('https://evil.kimi.com.attacker.example/chat/1'),null);assert.equal(core.platformFor('https://www.kimi.com/chat/1').id,'kimi');
 assert.equal(core.conversationKey('https://chat.deepseek.com/a/chat/s/abc'),'deepseek:abc');assert.equal(core.conversationKey('https://qianwen.com/?sessionId=abc'),'qianwen:abc');assert.notEqual(core.conversationKey('https://yuanbao.tencent.com/chat/agent/first'),core.conversationKey('https://yuanbao.tencent.com/chat/agent/second'));
 assert.throws(()=>core.validateConversation(fixture([message('a','hello')],{id:'chatgpt:other'})),/标识/);
 assert.throws(()=>core.validateConversation(fixture([message('a','hello'),message('a','world')])),/重复/);
 assert.throws(()=>core.validateConversation(fixture([message('a','hello')],{url:'https://attacker.example/c/fixture'})),/来源/);
 for(const url of ['https://cloud.example','http://127.0.0.1.evil.example:3792','http://user@127.0.0.1:3792','http://127.0.0.1:3792/redirect'])assert.throws(()=>core.validateSettings({sync:{enabled:false,url,token:''}}));
 assert.throws(()=>core.validateSettings({sync:{enabled:true,url:'http://127.0.0.1:3792',token:'bad-token'}}));
 core.validateSettings({sync:{enabled:true,url:'http://127.0.0.1:3792',token:''}});
 core.validateSettings({sync:{enabled:true,url:'http://127.0.0.1:3792',token:'a'.repeat(64)}});
});
test('paired browser sync supports auto-pairing from extension, enforces origin/token, survives retries, indexes MCP and propagates deletion',async()=>{
 const root=await mkdtemp(join(tmpdir(),'memo-browser-'));const app=await start({port:0,dataDir:root});
 try{
  const extensionId='a'.repeat(32),origin='chrome-extension://'+extensionId,sourceInstanceId=randomUUID();
  assert.equal((await fetch(app.url+'/api/browser-pair',{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.example','x-memo-extension':extensionId},body:JSON.stringify({protocol:1,sourceInstanceId})})).status,403);
  assert.equal((await fetch(app.url+'/api/browser-pair',{method:'POST',headers:{'content-type':'application/json',origin,'x-memo-extension':'b'.repeat(32)},body:JSON.stringify({protocol:1,sourceInstanceId})})).status,403);
  const pairPreflight=await fetch(app.url+'/api/browser-pair',{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST'}});assert.equal(pairPreflight.status,204);assert.equal(pairPreflight.headers.get('access-control-allow-origin'),origin);
  const paired=await (await fetch(app.url+'/api/browser-pair',{method:'POST',headers:{'content-type':'application/json',origin,'x-memo-extension':extensionId},body:JSON.stringify({protocol:1,sourceInstanceId})})).json();
  assert.equal(paired.ok,true);assert.equal(paired.extensionId,extensionId);assert.equal(paired.token.length,64);
  const headers={'content-type':'application/json','x-memo-extension':extensionId,origin,authorization:'Bearer '+paired.token};
  const c=core.reconcile(null,fixture([message('one','数据库采用 SQLite 本地存储'),message('two','支持全文检索','assistant')]));
  const change={id:c.id,changeId:randomUUID(),sequence:1,action:'upsert',platform:'chatgpt',conversation:c};const input={protocol:1,sourceInstanceId,change};
  const post=(body=input,h=headers)=>fetch(app.url+'/api/browser-sync',{method:'POST',headers:h,body:JSON.stringify(body)});
  assert.equal((await post(input,{...headers,origin:'https://evil.example'})).status,403);assert.equal((await post(input,{...headers,authorization:'Bearer bad'})).status,403);assert.equal((await post(input,{...headers,'x-memo-extension':'b'.repeat(32)})).status,403);
  const preflight=await fetch(app.url+'/api/browser-sync',{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST'}});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),origin);
  assert.equal((await post()).status,200);assert.equal((await (await post()).json()).duplicate,true);assert.equal(app.store.stats().conversations,1);
  const found=await (await fetch(app.url+'/api/conversations?source=browser-chatgpt&q=SQLite')).json();assert.equal(found.total,1);
  const mcp=await (await fetch(app.url+'/mcp/codex',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'recall',arguments:{query:'SQLite',sources:['browser-chatgpt']}}})})).json();assert.match(mcp.result.content[0].text,/SQLite/);
  assert.equal((await fetch(app.url+'/api/state',{headers:{origin}})).status,403);
  const deletion={...input,change:{...change,changeId:randomUUID(),sequence:2,action:'delete',conversation:undefined}};assert.equal((await post(deletion)).status,200);assert.equal(app.store.stats().conversations,0);
  // Late responses/retries of an older write cannot resurrect a deleted conversation.
  await post();assert.equal(app.store.stats().conversations,0);
  await fetch(app.url+'/api/browser/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({rotate:true})});assert.equal((await post()).status,403);
  await fetch(app.url+'/api/browser/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:false})});assert.equal((await post()).status,403);
  // Explicit pairing from the extension re-enables the connection even if previously disabled.
  const repaired=await (await fetch(app.url+'/api/browser-pair',{method:'POST',headers:{'content-type':'application/json',origin,'x-memo-extension':extensionId},body:JSON.stringify({protocol:1,sourceInstanceId})})).json();
  assert.equal(repaired.ok,true);
  const statusAfterPair=await (await fetch(app.url+'/api/browser/config')).json();
  assert.equal(statusAfterPair.enabled,true);assert.equal(statusAfterPair.extensionId,extensionId);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
