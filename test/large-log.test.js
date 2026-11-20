import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,open,writeFile,stat,appendFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {parseSource,readSourceStable} from '../src/adapters.js';
import {Store} from '../src/store.js';
import {Service} from '../src/service.js';

test('stream parser matches existing source semantics across CRLF, late metadata, fallback and tool records',async()=>{
 const root=await mkdtemp(join(tmpdir(),'memo-stream-'));
 try{
  const samples={codex:[{type:'event_msg',payload:{type:'user_message',message:'mirrored'}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'中文 mixed text'}]}},{type:'session_meta',timestamp:'2026-11-17T00:00:00Z',payload:{id:'stream-id'}},{type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'保留正文'}]}}], 'claude-code':[{type:'assistant',message:{content:[{type:'tool_use',input:{data:'noise'}},{type:'text',text:'可见回复'}]}},{type:'user',sessionId:'session-id',uuid:'user-id',message:{content:'正文'}}]};
  for(const [source,rows] of Object.entries(samples)){
   const path=join(root,source+'.jsonl'),raw=rows.map(JSON.stringify).join('\r\n');await writeFile(path,raw);
   const result=await readSourceStable(path,source);
   assert.deepEqual(result.conversation,parseSource(raw,source,path));
   assert.equal(result.version,createHash('sha256').update(raw).digest('hex'));
  }
  const path=join(root,'fallback.jsonl'),raw=JSON.stringify({type:'event_msg',payload:{type:'user_message',message:'fallback'}});await writeFile(path,raw);assert.equal((await readSourceStable(path,'codex')).conversation.records[0].text,'fallback');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('import a real >64MB log end-to-end and retain previous conversation on malformed trailing data',async()=>{
 const root=await mkdtemp(join(tmpdir(),'memo-large-'));let db;
 try{
  const path=join(root,'large.jsonl'),handle=await open(path,'w');
  try{
   await handle.write(JSON.stringify({type:'user',sessionId:'large-session',uuid:'u',timestamp:'2026-11-17T00:00:00Z',message:{content:'超大日志中的用户问题'}})+'\n');
   const noise=JSON.stringify({type:'progress',payload:'x'.repeat(1024*1024)})+'\n';
   for(let i=0;i<65;i++)await handle.write(noise);
   await handle.write(JSON.stringify({type:'assistant',uuid:'a',timestamp:'2026-11-17T00:01:00Z',message:{content:[{type:'tool_use',input:{ignored:true}},{type:'text',text:'末尾的完整回答'}]}})+'\n');
  }finally{await handle.close();}
  assert.ok((await stat(path)).size>64*1024*1024);
  db=new Store(join(root,'library'));db.setSetting('sources',[{id:'claude-code',path:root,enabled:true}]);const service=new Service(db);
  const result=await service.sync();assert.deepEqual(result.issues,[]);assert.equal(result.changed,1);
  const conversation=db.all()[0];assert.equal(conversation.meta.threadId,'large-session');assert.deepEqual(conversation.records.map(r=>r.text),['超大日志中的用户问题','末尾的完整回答']);assert.equal(db.list({q:'完整回答'}).total,1);
  await appendFile(path,'{');const failure=await service.sync();assert.equal(failure.issues.length,1);assert.match(failure.issues[0].error,/第 68 行 JSON/);assert.deepEqual(db.all()[0],conversation);
 }finally{db?.close();await rm(root,{recursive:true,force:true});}
});
