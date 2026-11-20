import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {discover,parseSource,readSourceIndex} from '../src/adapters.js';
import {start} from '../src/server.js';
import '../extension/lib/core.js';

const BASE32='abcdefghijklmnopqrstuvwxyz234567';
function encodeBase32(str){
  const bytes=Buffer.from(str,'utf8');
  let bits=0,val=0,out='';
  for(const b of bytes){
    val=(val<<8)|b;bits+=8;
    while(bits>=5){out+=BASE32[(val>>>(bits-5))&31];bits-=5;}
  }
  if(bits>0)out+=BASE32[(val<<(5-bits))&31];
  return out;
}

test('grok-bot adapter discovers replicas, resolves roster titles, filters sensitive messages and serves MCP recall',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'memo-grokbot-')));
  const appDir=join(root,'app'),persistence=join(appDir,'sand-client-persistence');
  await mkdir(persistence,{recursive:true});
  try{
    const agentId='271ce7db-51e9-4b59-aa00-867f4e7537ac';
    const replicaName=encodeBase32(`sand.client.slice.account.test.transcript.replicas.${agentId}`)+'.blob';
    const rosterName=encodeBase32('sand.client.slice.account.test.roster.last-roster')+'.blob';
    const noiseName=encodeBase32('sand.client.slice.account.test.send-journal')+'.blob';
    const replica={
      schemaVersion:1,
      value:{
        persistedAt:1795000000000,
        entries:[
          {kind:'send-message',id:'t1s0',message:{type:'text',content:'你好，我是 Grok Bot 研究员'},timestampMs:1793547330000},
          {kind:'message',id:'t2u',role:'user',content:'分析 Solana RPC 延迟方案',timestampMs:1793549000000},
          {kind:'send-message',id:'t2s1',message:{type:'widget',widget:{prompt:'选择哪个节点地区？',options:[{label:'Tokyo'}]}},timestampMs:1793549010000},
          {kind:'send-message',id:'t2s2',message:{type:'secret-request',secretRequest:{label:'API Key'}},timestampMs:1793549020000},
          {kind:'send-message',id:'t2s3',message:{type:'user-form',formRequest:{title:'Login'}},timestampMs:1793549030000},
          {kind:'send-message',id:'t2s4',message:{type:'auto-review-approval',approval:{summary:'Claim'}},timestampMs:1793549040000},
          {kind:'send-message',id:'t2s5',message:{type:'local-tool-permission',ask:{action:'run'}},timestampMs:1793549050000},
          {kind:'send-message',id:'t2s6',message:{type:'connector',connector:'Notion'},timestampMs:1793549060000},
          {kind:'user-attachment',id:'t2ua',file_path:'/tmp/a.jpg',timestampMs:1793549070000},
          {kind:'event',id:'ev1',event:{type:'automation-changed'},timestampMs:1793549080000}
        ]
      }
    };
    const roster={schemaVersion:1,value:{rows:[{id:agentId,name:'夜班交易研究员'}]}};
    await writeFile(join(persistence,replicaName),JSON.stringify(replica));
    await writeFile(join(persistence,rosterName),JSON.stringify(roster));
    await writeFile(join(persistence,noiseName),JSON.stringify({schemaVersion:1,value:[]}));

    const files=await discover(appDir,'grok-bot');
    assert.deepEqual(files,[join(persistence,replicaName)]);
    const index=await readSourceIndex(appDir,'grok-bot');
    assert.equal(index.titles.get(agentId),'夜班交易研究员');

    const parsed=parseSource(JSON.stringify(replica),'grok-bot',join(persistence,replicaName));
    assert.equal(parsed.meta.channelId,'grok-bot');
    assert.equal(parsed.meta.threadId,agentId);
    assert.equal(parsed.records.length,3);
    assert.deepEqual(parsed.records.map(r=>[r.role,r.text]),[
      ['assistant','你好，我是 Grok Bot 研究员'],
      ['user','分析 Solana RPC 延迟方案'],
      ['assistant','选择哪个节点地区？']
    ]);

    const app=await start({port:0,dataDir:join(root,'data')});
    try{
      const res=await fetch(app.url+'/api/sources/grok-bot',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:appDir,enabled:true})});
      assert.equal(res.status,200);
      const syncState=await app.service.sync('grok-bot');
      assert.deepEqual(syncState.issues,[]);
      assert.equal(syncState.changed,1);

      const list=await (await fetch(app.url+'/api/conversations?source=grok-bot')).json();
      assert.equal(list.total,1);
      assert.equal(list.items[0].title,'夜班交易研究员');

      const mcp=await (await fetch(app.url+'/mcp/codex',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'recall',arguments:{query:'Solana RPC',sources:['grok-bot']}}})})).json();
      assert.match(mcp.result.content[0].text,/Solana RPC 延迟方案/);
    }finally{await app.close();}
  }finally{await rm(root,{recursive:true,force:true});}
});

test('antigravity adapter reads brain transcripts, skips subagents, cleans tags, ingests media and serves MCP recall',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'memo-antigravity-')));
  const agDir=join(root,'ag'),brain=join(agDir,'brain');
  const mainId='11111111-1111-1111-1111-111111111111';
  const subId='22222222-2222-2222-2222-222222222222';
  const fallbackId='33333333-3333-3333-3333-333333333333';
  await mkdir(join(brain,mainId,'.system_generated/logs'),{recursive:true});
  await mkdir(join(brain,subId,'.system_generated/logs'),{recursive:true});
  await mkdir(join(brain,fallbackId,'.system_generated/logs'),{recursive:true});
  await mkdir(join(brain,'tempmediaStorage'),{recursive:true});
  try{
    const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,31,21,196,137,0,0,0,10,73,68,65,84,120,156,99,0,1,0,0,5,0,1,13,10,45,180,0,0,0,0,73,69,78,68,174,66,96,130]);
    const shotPath=join(agDir,'shot.png');
    await writeFile(shotPath,png);

    const db=new DatabaseSync(join(agDir,'conversation_summaries.db'));
    db.exec('CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text NOT NULL, parent_conversation_id text NOT NULL, nesting_depth integer NOT NULL)');
    db.prepare('INSERT INTO conversation_summaries VALUES(?,?,?,?)').run(mainId,'Antigravity 架构讨论','',0);
    db.prepare('INSERT INTO conversation_summaries VALUES(?,?,?,?)').run(subId,'子代理任务',mainId,1);
    db.close();

    const mainRows=[
      {step_index:0,source:'USER_EXPLICIT',type:'USER_INPUT',created_at:'2026-11-18T08:00:00Z',content:'<CONTEXT_SUMMARY>\nold\n</CONTEXT_SUMMARY>\n<USER_REQUEST>\n实现增量同步索引方案\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nmeta\n</ADDITIONAL_METADATA>',media:[{mime_type:'image/png',uri:shotPath}]},
      {step_index:1,source:'MODEL',type:'PLANNER_RESPONSE',created_at:'2026-11-18T08:00:05Z',content:''},
      {step_index:2,source:'MODEL',type:'GENERIC',created_at:'2026-11-18T08:00:06Z',content:'tool trace output'},
      {step_index:3,source:'SYSTEM',type:'SYSTEM_MESSAGE',created_at:'2026-11-18T08:00:07Z',content:'system note'},
      {step_index:4,source:'MODEL',type:'PLANNER_RESPONSE',created_at:'2026-11-18T08:00:10Z',content:'建议先建立 SQLite 游标表再合并消息。'}
    ].map(JSON.stringify).join('\n');
    await writeFile(join(brain,mainId,'.system_generated/logs/transcript_full.jsonl'),mainRows);
    await writeFile(join(brain,mainId,'.system_generated/logs/transcript.jsonl'),JSON.stringify({step_index:0,source:'USER_EXPLICIT',type:'USER_INPUT',created_at:'2026-11-18T08:00:00Z',content:'<USER_REQUEST>compact</USER_REQUEST>'}));
    await writeFile(join(brain,subId,'.system_generated/logs/transcript_full.jsonl'),JSON.stringify({step_index:0,source:'USER_EXPLICIT',type:'USER_INPUT',created_at:'2026-11-18T08:01:00Z',content:'<USER_REQUEST>subagent prompt</USER_REQUEST>'}));
    await writeFile(join(brain,fallbackId,'.system_generated/logs/transcript.jsonl'),JSON.stringify({step_index:0,source:'USER_EXPLICIT',type:'USER_INPUT',created_at:'2026-11-18T08:02:00Z',content:'无标题会话提问'}));

    const discovered=await discover(agDir,'antigravity');
    assert.deepEqual(discovered,[
      join(brain,mainId,'.system_generated/logs/transcript_full.jsonl'),
      join(brain,subId,'.system_generated/logs/transcript_full.jsonl'),
      join(brain,fallbackId,'.system_generated/logs/transcript.jsonl')
    ].sort());

    const index=await readSourceIndex(agDir,'antigravity');
    assert.equal(index.titles.get(mainId),'Antigravity 架构讨论');
    assert.equal(index.skipped.has(subId),true);

    const parsed=parseSource(mainRows,'antigravity',join(brain,mainId,'.system_generated/logs/transcript_full.jsonl'));
    assert.equal(parsed.meta.threadId,mainId);
    assert.equal(parsed.records.length,2);
    assert.equal(parsed.records[0].text,'实现增量同步索引方案');
    assert.equal(parsed.records[0].images[0].source,shotPath);
    assert.equal(parsed.records[1].text,'建议先建立 SQLite 游标表再合并消息。');

    const app=await start({port:0,dataDir:join(root,'data')});
    try{
      const res=await fetch(app.url+'/api/sources/antigravity',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:agDir,enabled:true})});
      assert.equal(res.status,200);
      const syncState=await app.service.sync('antigravity');
      assert.deepEqual(syncState.issues,[]);
      assert.equal(syncState.changed,2);

      const list=await (await fetch(app.url+'/api/conversations?source=antigravity')).json();
      assert.equal(list.total,2);
      const mainConv=list.items.find(i=>i.thread===mainId);
      assert.equal(mainConv.title,'Antigravity 架构讨论');
      const fullConv=await (await fetch(app.url+'/api/conversations/'+mainConv.id)).json();
      assert.ok(fullConv.records[0].images[0].id);

      const mcp=await (await fetch(app.url+'/mcp/codex',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'recall',arguments:{query:'SQLite 游标表',sources:['antigravity']}}})})).json();
      assert.match(mcp.result.content[0].text,/SQLite 游标表/);
    }finally{await app.close();}
  }finally{await rm(root,{recursive:true,force:true});}
});

test('browser grok URL rules, host gating and desktop browser sync work cleanly',async()=>{
  const core=globalThis.MemoCore;
  assert.equal(core.platformFor('https://x.com/i/grok?conversation=4055efd8-cdd8-5d37-bf1b-4d51cb43888b')?.id,'grok');
  assert.equal(core.platformFor('https://x.com/i/grok')?.id,'grok');
  assert.equal(core.platformFor('https://grok.com/c/abc')?.id,'grok');
  assert.equal(core.platformFor('https://www.grok.com/chat/abc')?.id,'grok');
  assert.equal(core.platformFor('https://x.com/home'),null);
  assert.equal(core.platformFor('https://x.com/elonmusk'),null);
  assert.equal(core.platformFor('https://x.com/i/grok_other'),null);
  assert.equal(core.platformFor('https://evil.x.com/i/grok'),null);
  assert.equal(core.platformFor('http://grok.com/c/abc'),null);

  const grokUrl='https://x.com/i/grok?conversation=4055efd8-cdd8-5d37-bf1b-4d51cb43888b&tab=x#top';
  assert.equal(core.canonicalURL(grokUrl),'https://x.com/i/grok?conversation=4055efd8-cdd8-5d37-bf1b-4d51cb43888b');
  assert.equal(core.conversationKey(grokUrl),'grok:4055efd8-cdd8-5d37-bf1b-4d51cb43888b');
  assert.equal(core.conversationKey('https://grok.com/c/thread-1?ref=nav'),'grok:thread-1');
  assert.equal(core.conversationKey('https://x.com/i/grok'),null);

  const root=await mkdtemp(join(tmpdir(),'memo-browser-grok-'));
  const app=await start({port:0,dataDir:root});
  try{
    const extensionId='a'.repeat(32),origin='chrome-extension://'+extensionId,sourceInstanceId=randomUUID();
    const paired=await (await fetch(app.url+'/api/browser-pair',{method:'POST',headers:{'content-type':'application/json',origin,'x-memo-extension':extensionId},body:JSON.stringify({protocol:1,sourceInstanceId})})).json();
    const c=core.reconcile(null,{
      id:'grok:4055efd8-cdd8-5d37-bf1b-4d51cb43888b',
      platform:'grok',
      url:grokUrl,
      title:'Grok 问答',
      messages:[{id:'g1',role:'user',text:'解释 Raft 共识'},{id:'g2',role:'assistant',text:'Raft 将共识分解为 Leader 选举与日志复制。'}]
    });
    const syncRes=await fetch(app.url+'/api/browser-sync',{
      method:'POST',
      headers:{'content-type':'application/json','x-memo-extension':extensionId,origin,authorization:'Bearer '+paired.token},
      body:JSON.stringify({protocol:1,sourceInstanceId,change:{id:c.id,changeId:randomUUID(),sequence:1,action:'upsert',platform:'grok',conversation:c}})
    });
    assert.equal(syncRes.status,200);
    const list=await (await fetch(app.url+'/api/conversations?source=browser-grok')).json();
    assert.equal(list.total,1);
    const mcp=await (await fetch(app.url+'/mcp/codex',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'recall',arguments:{query:'Raft 共识',sources:['browser-grok']}}})})).json();
    assert.match(mcp.result.content[0].text,/Leader 选举/);
  }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
