import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {start} from '../src/server.js';
import {Store} from '../src/store.js';
import {historyData,shiftDay} from '../src/history.js';
import {localDay} from '../src/service.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6WQAAAABJRU5ErkJggg==','base64');
test('history date windows, pagination, daily aggregation, storage and validation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'memo-history-'));const store=new Store(root);
 try{
  const timestamp=new Date().toISOString(),today=localDay(timestamp);
  store.save({meta:{channelId:'codex',threadId:'one',title:'历史样本',createdAt:timestamp,lastActiveAt:timestamp,sourcePath:'/fixture'},records:[{id:'one',seq:0,role:'user',text:'hello',ts:timestamp,sourceRef:'/fixture'}]});
  const add=store.db.prepare('INSERT INTO ingestion_events(source,thread,created,messages) VALUES(?,?,?,?)');
  for(let i=0;i<60;i++)add.run('codex','one',timestamp,2);
  const data=await historyData(store,new URLSearchParams({days:'7',end:today}));
  assert.equal(data.daily.length,7);assert.equal(data.daily.at(-1).counts.codex,121);assert.equal(data.totalRecords,61);assert.equal(data.records.length,50);assert.equal(data.storage.conversations,1);assert.equal(data.storage.platforms,1);assert.equal(data.storage.messages,1);assert.ok(data.storage.bytes>0);
  const page=await historyData(store,new URLSearchParams({end:today,offset:'50'}));assert.equal(page.records.length,11);assert.equal(new Set([...data.records,...page.records].map(r=>r.id)).size,61);
  const previous=await historyData(store,new URLSearchParams({days:'30',end:shiftDay(today,-7)}));assert.equal(previous.daily.length,30);assert.equal(previous.totalRecords,0);
  await assert.rejects(()=>historyData(store,new URLSearchParams({days:'100'})));await assert.rejects(()=>historyData(store,new URLSearchParams({end:'2026-02-30'})));await assert.rejects(()=>historyData(store,new URLSearchParams({offset:'-1'})));
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('image-only Claude base64 and Codex local images import, cache, serve and survive original deletion',async()=>{
 const root=await mkdtemp(join(tmpdir(),'memo-images-'));const app=await start({port:0,dataDir:join(root,'data')});
 try{
  const claude=join(root,'claude'),codex=join(root,'codex'),image=join(root,'photo.png');await mkdir(claude);await mkdir(codex);await writeFile(image,png);
  await writeFile(join(claude,'session.jsonl'),JSON.stringify({type:'user',sessionId:'claude-image',uuid:'u',message:{content:[{type:'image',source:{type:'base64',media_type:'image/png',data:png.toString('base64')}}]}}));
  await writeFile(join(codex,'rollout-images.jsonl'),[{type:'session_meta',payload:{id:'codex-image',cwd:root}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'查看图片'}, {type:'input_image',image_url:'photo.png'}]}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_image',image_url:'https://example.invalid/photo.png'}]}}].map(JSON.stringify).join('\n'));
  app.store.setSetting('sources',[{id:'claude-code',path:claude,enabled:true},{id:'codex',path:codex,enabled:true}]);await app.service.sync();assert.deepEqual(app.service.syncState.issues,[]);
  const c=app.store.all(['claude-code'])[0];assert.equal(c.records[0].text,'');assert.ok(c.records[0].images[0].id);assert.ok(!JSON.stringify(c).includes('base64'));
  const cd=app.store.all(['codex'])[0],asset=cd.records[0].images[0];assert.equal(asset.id,c.records[0].images[0].id);assert.equal(cd.records[1].images[0].unavailable,true);assert.match(cd.records[1].images[0].reason,/远程/);
  const response=await fetch(app.url+'/api/images/'+asset.id);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
  assert.equal((await fetch(app.url+'/api/images/not-a-hash')).status,404);
  await rm(image);await app.service.sync('codex');const cached=app.store.all(['codex'])[0].records[0].images[0];assert.equal(cached.id,asset.id);assert.equal(cached.unavailable,undefined);
  assert.equal((await fetch(app.url+'/api/images/'+cached.id)).status,200);
  const history=await (await fetch(app.url+'/api/history?days=7')).json();assert.equal(history.storage.messages,3);assert.ok(history.storage.bytes>png.length);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
