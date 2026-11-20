import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {start} from '../src/server.js';
import {localDay} from '../src/service.js';
test('per-client config persists independently and MCP enforces switches, source scopes and caller contexts',async()=>{
 const root=await mkdtemp(join(tmpdir(),'memo-interop-'));let app=await start({port:0,dataDir:root});
 try{
  const post=(path,data)=>fetch(app.url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
  const rpc=(caller,id,name,args)=>post('/mcp/'+caller,{jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}});
  const now=new Date().toISOString(),day=localDay(now);
  for(const source of ['codex','claude-code'])app.store.save({meta:{channelId:source,threadId:'fixture',title:source,createdAt:now,lastActiveAt:now,sourcePath:'/fixture'},records:[{id:'u',seq:0,role:'user',text:'shared topic '+source,ts:now,sourceRef:'/fixture'}]});
  let result=await (await fetch(app.url+'/api/interop')).json();assert.equal(result.clients.length,3);assert.match(result.clients.find(c=>c.id==='codex').config,/\[mcp_servers.memocat\]/);assert.match(result.clients.find(c=>c.id==='claude-code').config,/claude mcp add/);assert.ok(result.clients.every(c=>c.url.endsWith('/mcp/'+c.id)));
  assert.equal((await post('/api/interop/claude-code',{enabled:false})).status,200);
  const init={jsonrpc:'2.0',id:0,method:'initialize'};assert.equal((await post('/mcp/claude-code',init)).status,403);assert.equal((await post('/mcp/codex',init)).status,200);assert.equal((await post('/mcp/unconfigured',init)).status,404);
  assert.equal((await post('/api/interop/codex',{sources:['claude-code']})).status,200);
  const scoped=await (await rpc('codex',1,'recall',{query:'shared topic'})).json();assert.match(scoped.result.content[0].text,/shared topic claude-code/);assert.ok(!scoped.result.content[0].text.includes('shared topic codex'));
  const processId=scoped.result.content[0].text.match(/process_id: ([\w-]+)/)[1];
  const forbidden=await (await rpc('codex',2,'recall',{query:'shared',sources:['codex']})).json();assert.equal(forbidden.result.isError,true);
  const list=await (await rpc('codex',3,'list_conversations',{from:day,to:day})).json();const listed=JSON.parse(list.result.content[0].text);assert.equal(listed.items.length,1);assert.equal(listed.items[0].channelId,'claude-code');
  await post('/api/interop/claude-code',{enabled:true});const foreign=await (await rpc('claude-code',4,'recall',{query:'shared',process_id:processId})).json();assert.equal(foreign.result.isError,true);
  await post('/api/interop/codex',{sources:[]});const none=await (await rpc('codex',5,'recall',{query:'shared'})).json();assert.equal(none.result.isError,true);
  assert.equal((await post('/api/interop/codex',{sources:['bad']})).status,400);assert.equal((await post('/api/interop/codex',{enabled:'true'})).status,400);
  result=await (await fetch(app.url+'/api/interop')).json();assert.equal(result.clients.find(c=>c.id==='codex').recalls,1);assert.ok(result.clients.find(c=>c.id==='codex').lastRequest);assert.equal(result.clients.find(c=>c.id==='claude-code').sources,null);
  await app.close();app=await start({port:0,dataDir:root});const persisted=await (await fetch(app.url+'/api/interop')).json();assert.deepEqual(persisted.clients.find(c=>c.id==='codex').sources,[]);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
