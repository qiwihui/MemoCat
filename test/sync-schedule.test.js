import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,utimes,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {start} from '../src/server.js';
import {SyncScheduler} from '../src/sync-schedule.js';
const time='2026-11-17T01:00:00Z';
const meta=()=>({type:'session_meta',timestamp:time,payload:{id:'shared-thread'}});
const message=(text,n=0)=>({type:'response_item',timestamp:new Date(Date.parse(time)+n*1000).toISOString(),payload:{type:'message',role:n%2?'assistant':'user',content:[{type:'input_text',text}]}});
const jsonl=rows=>rows.map(JSON.stringify).join('\n')+'\n';
test('duplicate snapshots merge once, preserve fragments and intentional repeats, stay idempotent after restart and count only added content',async()=>{
 const root=await mkdtemp('/private/tmp/memo-snapshots-');let app=await start({port:0,dataDir:join(root,'data')});
 try{const source=join(root,'source'),dir=join(source,'sessions');await mkdir(dir,{recursive:true});const a=join(dir,'rollout-a.jsonl'),b=join(dir,'rollout-b.jsonl');
 await writeFile(a,jsonl([meta(),message('one'),message('two',1),message('repeat',2),message('repeat',2)]));
 await writeFile(b,jsonl([meta(),{type:'tool-event'},message('one'),message('two',1),message('three',3)]));
 app.store.setSetting('sources',[{id:'codex',path:source,enabled:true}]);
 await app.service.sync();assert.equal(app.service.syncState.changed,1);assert.equal(app.store.stats().messages,5);
 const events=()=>app.store.db.prepare('SELECT messages FROM ingestion_events').all();assert.deepEqual(events().map(e=>e.messages),[5]);
 const saved=JSON.stringify(app.store.all());await app.service.sync();assert.equal(app.service.syncState.changed,0);assert.equal(JSON.stringify(app.store.all()),saved);
 // A copied log with shifted physical lines does not add messages or oscillate.
 await writeFile(join(dir,'rollout-copy.jsonl'),jsonl([meta(),{type:'tool-event'},{type:'tool-event'},message('one'),message('two',1),message('three',3)]));
 await app.service.sync();assert.equal(app.store.stats().messages,5);assert.equal(events().length,1);await app.service.sync();assert.equal(app.service.syncState.changed,0);
 await writeFile(b,jsonl([meta(),{type:'tool-event'},message('one'),message('two',1),message('three',3),message('four',4)]));
 await app.service.sync();assert.equal(app.store.stats().messages,6);assert.deepEqual(events().map(e=>e.messages),[5,1]);
 await app.close();app=await start({port:0,dataDir:join(root,'data')});await app.service.sync();assert.equal(app.service.syncState.changed,0);assert.equal(events().length,2);
 // A broken snapshot must not erase the previously saved full conversation.
 await writeFile(a,'{broken');await app.service.sync();assert.equal(app.store.stats().messages,6);assert.equal(events().length,2);assert.equal(app.service.syncState.issues.length,1);
 await writeFile(b,jsonl([meta(),message('one'),message('two',1),message('three',3),message('four',4),message('five',5)]));await app.service.sync();assert.equal(app.store.stats().messages,7);assert.deepEqual(events().map(e=>e.messages),[5,1,1]);await app.service.sync();assert.equal(app.service.syncState.changed,0);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
test('scheduler rearms after completion, applies changes immediately, cancels disabled runs and persists validation',async()=>{
 let settings={},clock=1000,id=0,calls=0,finish;const timers=new Map();const store={getSetting:(k,d)=>settings[k]??d,setSetting:(k,v)=>{settings[k]=v;}};
 settings.sources=[{enabled:true}];const scheduler=new SyncScheduler(store,{sync:()=>{calls++;return new Promise(r=>finish=r);}},{now:()=>clock,setTimer:(fn,ms)=>{const key=++id;timers.set(key,{fn,ms});return key;},clearTimer:key=>timers.delete(key)});
 assert.equal(scheduler.status().intervalMinutes,5);assert.equal([...timers.values()][0].ms,300000);
 scheduler.configure({enabled:true,intervalMinutes:1});assert.equal(timers.size,1);const pending=[...timers.values()][0].fn();assert.equal(calls,1);assert.equal(scheduler.status().nextRun,null);
 scheduler.configure({enabled:false,intervalMinutes:10});finish();await pending;assert.equal(scheduler.status().nextRun,null);assert.equal(settings.syncSchedule.enabled,false);
 for(const input of [{enabled:true,intervalMinutes:0},{enabled:true,intervalMinutes:1.5},{enabled:true,intervalMinutes:1441},{enabled:'yes',intervalMinutes:5},{enabled:true,intervalMinutes:5,extra:true}])assert.throws(()=>scheduler.configure(input));
 scheduler.configure({enabled:true,intervalMinutes:10});clock+=100;assert.equal(scheduler.status().nextRun,new Date(clock-100+600000).toISOString());scheduler.close();assert.equal(scheduler.status().nextRun,null);
});
test('schedule HTTP config survives a server restart; manual sync remains available when disabled',async()=>{
 const root=await mkdtemp('/private/tmp/memo-schedule-');let app=await start({port:0,dataDir:root});
 try{const post=data=>fetch(app.url+'/api/sync-schedule',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
 assert.equal((await post({enabled:true,intervalMinutes:0})).status,400);
 assert.equal((await post({enabled:false,intervalMinutes:17})).status,200);
 await app.close();app=await start({port:0,dataDir:root});const config=await (await fetch(app.url+'/api/sync-schedule')).json();assert.deepEqual(config,{enabled:false,intervalMinutes:17,nextRun:null});
 assert.equal((await fetch(app.url+'/api/sync',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,202);await app.service.syncTask;
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
