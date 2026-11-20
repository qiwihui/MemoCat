import {test} from 'node:test';
import {request} from 'node:http';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseSource} from '../src/adapters.js';
import {tokenize,recall} from '../src/recall.js';
import {Store} from '../src/store.js';
import {start} from '../src/server.js';
const fixture={meta:{channelId:'codex',threadId:'one',title:'数据库方案',createdAt:'2026-11-01T08:00:00Z',lastActiveAt:'2026-11-01T08:01:00Z',sourcePath:'/fixture'},records:[{id:'u',seq:0,role:'user',text:'数据库怎么选择？',ts:'2026-11-01T08:00:00Z',sourceRef:'/fixture:1'},{id:'a',seq:1,role:'assistant',text:'采用 PostgreSQL 数据库。',ts:'2026-11-01T08:01:00Z',sourceRef:'/fixture:2'}]};
test('Codex filters tool events and avoids mirrored event messages',()=>{const raw=[{type:'session_meta',payload:{id:'x'}},{type:'event_msg',payload:{type:'user_message',message:'duplicate'}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'hello'}]}},{type:'response_item',payload:{type:'function_call',arguments:'secret'}}].map(JSON.stringify).join('\n');const c=parseSource(raw,'codex','rollout-x.jsonl');assert.equal(c.records.length,1);assert.equal(c.records[0].text,'hello');assert.throws(()=>parseSource(raw+'\n{','codex','x'),/JSON/);});
test('Claude combines only visible text and skips sidechains',()=>{const raw=[{type:'assistant',uuid:'a',message:{content:[{type:'thinking',thinking:'private'},{type:'text',text:'visible'}]}},{type:'user',isSidechain:true,message:{content:'subagent'}}].map(JSON.stringify).join('\n');assert.equal(parseSource(raw,'claude-code','x').records[0].text,'visible');});
test('CJK bigrams, alternatives, source unit exclusion and estimated budget',()=>{assert.deepEqual(tokenize('数据库 SQL'),['数据','据库','sql']);const result=recall([fixture],{query:'database',alternatives:['数据库']});assert.equal(result.evidence.length,1);assert.equal(recall([fixture],{query:'数据库'},result.evidence[0].unitIds).evidence.length,0);const huge=structuredClone(fixture);huge.records[1].text='数据库'.repeat(10000);assert.ok(recall([huge],{query:'数据库'}).estimatedTokens<=9600);});
test('atomic upsert, persisted delivery and ownership',async()=>{const root=await mkdtemp(join(tmpdir(),'memo-db-'));let db;try{db=new Store(root);db.save(fixture);db.save(fixture);assert.equal(db.stats().conversations,1);const process=db.context(undefined,'codex');assert.throws(()=>db.context(process,'other'));const r=db.prepare(process,'r','数据库',{evidence:[{unitIds:['x']}]});assert.deepEqual(db.seen(process),['x']);db.finish(r.id,'committed');assert.deepEqual(db.seen(process),['x']);const abandoned=db.prepare(process,'aborted','other',{evidence:[{unitIds:['reserved']}]});assert.ok(db.seen(process).includes('reserved'));db.finish(abandoned.id,'abandoned');assert.ok(!db.seen(process).includes('reserved'));db.close();db=new Store(root);assert.equal(db.stats().recalls,1);assert.equal(db.list({q:'数据库'}).total,1);}finally{db?.close();await rm(root,{recursive:true,force:true});}});
test('end to end: import → browse → MCP → dedup → audit; cross origin denied',async()=>{const root=await mkdtemp(join(tmpdir(),'memo-http-'));const app=await start({port:0,dataDir:join(root,'data')});try{
 const source=join(root,'source');await mkdir(source);await writeFile(join(source,'thread.jsonl'),[{type:'user',sessionId:'real',uuid:'u',timestamp:'2026-11-01T08:00:00Z',message:{content:'数据库'}},{type:'assistant',uuid:'a',timestamp:'2026-11-01T08:01:00Z',message:{content:[{type:'text',text:'采用 PostgreSQL'}]}}].map(JSON.stringify).join('\n'));
 const preferences=await (await fetch(app.url+'/api/preferences')).json();assert.equal(preferences.canOpenDataDir,false);assert.equal(preferences.startupSupported,false);
 const post=(p,b,headers={})=>fetch(app.url+p,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(b)});
 assert.equal((await post('/api/open-data',{})).status,409);assert.equal((await post('/api/startup',{enabled:true})).status,409);
 assert.equal((await post('/api/sources',[{id:'claude-code',path:source,enabled:true}])).status,200);await app.service.sync();assert.equal((await (await fetch(app.url+'/api/conversations')).json()).total,1);const dashboard=await (await fetch(app.url+'/api/dashboard')).json();assert.equal(dashboard.total,2);assert.equal(dashboard.distribution[0].source,'claude-code');assert.equal(dashboard.recent[0].messages,2);
 const rpc=async(id,args)=>{const res=await post('/mcp/codex',{jsonrpc:'2.0',id,method:'tools/call',params:{name:'recall',arguments:args}});return (await res.json()).result;};
 const result=await rpc(1,{query:'数据库'});assert.match(result.content[0].text,/PostgreSQL/);const process=result.content[0].text.match(/process_id: ([\w-]+)/)[1];const second=await rpc(2,{query:'数据库',process_id:process});assert.match(second.content[0].text,/没有新的/);assert.equal(app.store.activity().length,2);
 const failed=await rpc(3,{query:'数据库',from:'2026-02-30'});assert.equal(failed.isError,true);
 assert.equal((await post('/api/demo',{}, {origin:'https://evil.example'})).status,403);
 const badHost=await new Promise((resolve,reject)=>{const req=request(app.url+'/api/state',{headers:{host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});assert.equal(badHost,403);
 const list=await post('/mcp/codex',{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'list_conversations',arguments:{from:'2026-11-01',to:'2026-11-01'}}});assert.match(JSON.stringify(await list.json()),/real/);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}});

 test('desktop preferences use only configured data directory and verified startup state',async()=>{const root=await mkdtemp(join(tmpdir(),'memo-desktop-'));let opened,enabled=false;const app=await start({port:0,dataDir:join(root,'library'),desktopActions:{startupSupported:true,getStartup:()=>enabled,setStartup:value=>{enabled=value;},openDataDirectory:path=>{opened=path;}}});try{const prefs=await (await fetch(app.url+'/api/preferences')).json();assert.equal(prefs.canOpenDataDir,true);const post=(path,data)=>fetch(app.url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});await post('/api/open-data',{path:'/untrusted'});assert.equal(opened,join(root,'library'));const response=await post('/api/startup',{enabled:true});assert.deepEqual(await response.json(),{enabled:true});assert.equal((await post('/api/startup',{enabled:'true'})).status,400);}finally{await app.close();await rm(root,{recursive:true,force:true});}});

test('per-AI backup switches, isolated paths, scoped sync, idempotent daily statistics',async()=>{
 const root=await mkdtemp(join(tmpdir(),'memo-backup-')),app=await start({port:0,dataDir:join(root,'data')});
 try{
  const claude=join(root,'claude'),codex=join(root,'codex'),alternate=join(root,'alternate');await mkdir(claude);await mkdir(codex);await mkdir(alternate);
  await writeFile(join(claude,'thread.jsonl'),JSON.stringify({type:'user',sessionId:'claude-fixture',uuid:'u',timestamp:'2026-11-01T00:00:00Z',message:{content:'Claude message'}}));
  await writeFile(join(codex,'rollout-fixture.jsonl'),[{type:'session_meta',payload:{id:'codex-fixture'}},{type:'response_item',timestamp:'2026-11-01T00:00:00Z',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Codex message'}]}}].map(JSON.stringify).join('\n'));
  const post=(id,data)=>fetch(app.url+'/api/sources/'+id,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
  assert.equal((await post('claude-code',{path:claude,enabled:true})).status,200);
  assert.equal((await post('codex',{path:codex,enabled:true})).status,200);
  await app.service.sync('codex');assert.equal(app.store.stats().conversations,1);
  let status=await (await fetch(app.url+'/api/source-status')).json();assert.equal(status.items.find(s=>s.id==='codex').todayMessages,1);assert.equal(status.items.find(s=>s.id==='claude-code').lastRun,null);
  await app.service.sync();await app.service.sync();status=await (await fetch(app.url+'/api/source-status')).json();assert.equal(status.items.find(s=>s.id==='codex').todayMessages,1);assert.equal(status.items.find(s=>s.id==='claude-code').todayMessages,1);
  assert.equal((await post('codex',{enabled:false})).status,200);
  assert.equal(app.store.getSetting('sources',[]).find(s=>s.id==='claude-code').enabled,true);
  assert.equal((await post('codex',{path:alternate})).status,200);assert.equal(app.store.getSetting('sources',[]).find(s=>s.id==='codex').enabled,false);
  assert.equal((await post('codex',{path:join(root,'missing'),enabled:true})).status,400);
  assert.equal((await post('codex/sync',{})).status,409);
  assert.equal((await post('claude-code',{enabled:'yes'})).status,400);
  assert.equal((await post('claude-code',{path:'relative'})).status,400);
  await app.service.sync();assert.equal(app.store.stats().conversations,2);
  const enabled=app.store.getSetting('sources',[]).find(s=>s.id==='claude-code');assert.equal(app.service.sourceCurrent(enabled),true);await post('claude-code',{enabled:false});assert.equal(app.service.sourceCurrent(enabled),false);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
