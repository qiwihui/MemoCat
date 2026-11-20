import {readdir, stat, realpath, readFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {StringDecoder} from 'node:string_decoder';
import {join, basename, extname, dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {extractImages} from './media.js';
export const LOCAL_SOURCES = ['codex', 'claude-code', 'grok-bot', 'antigravity'];
export const hash = text => createHash('sha256').update(text).digest('hex');
const textOf = value => typeof value === 'string' ? value : Array.isArray(value) ? value.filter(x => ['text','input_text','output_text'].includes(x.type)).map(x => x.text || '').join('\n') : '';
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
function decodeBase32(str) {
  let bits=0,val=0;const out=[];
  for(const ch of String(str||'').toLowerCase()){
    if(ch==='=')break;const idx=BASE32.indexOf(ch);if(idx<0)continue;
    val=(val<<5)|idx;bits+=5;
    if(bits>=8){out.push((val>>>(bits-8))&255);bits-=8;}
  }
  return Buffer.from(out).toString('utf8');
}
async function grokBotPersistenceDir(root){
  const nested=join(root,'sand-client-persistence');
  try{if((await stat(nested)).isDirectory())return nested;}catch{}
  return root;
}
function antigravityUserText(raw){
  const source=typeof raw==='string'?raw:'';
  const match=/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(source);
  if(match)return match[1].trim();
  return source.replace(/<(CONTEXT_SUMMARY|ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE)(?:\s[^>]*)?>[\s\S]*?(?:<\/\1\s*>|$)/gi,'').trim();
}
function parseGrokBot(raw,path,title){
  let data;
  try{data=JSON.parse(raw);}catch{throw new Error('Grok Bot 记录 JSON 不完整，保留此前导入版本');}
  if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('Grok Bot 记录 JSON 不完整，保留此前导入版本');
  const baseName=basename(path,'.blob'),decodedKey=decodeBase32(baseName);
  const threadId=/\.transcript\.replicas\.([^.]+)$/.exec(decodedKey)?.[1]||baseName;
  const fallbackTs=Number.isFinite(data.value?.persistedAt)?new Date(data.value.persistedAt).toISOString():'';
  const entries=Array.isArray(data.value?.entries)?data.value.entries:[];
  const records=[];
  for(let i=0;i<entries.length;i++){
    const entry=entries[i];if(!entry||typeof entry!=='object')continue;
    const line=i+1,ts=Number.isFinite(entry.timestampMs)?new Date(entry.timestampMs).toISOString():fallbackTs;
    const ref=`${path}#${entry.id||line}`;
    if(entry.kind==='message'&&['user','assistant'].includes(entry.role)&&typeof entry.content==='string'&&entry.content.trim()){
      records.push({id:entry.id,line,role:entry.role,text:entry.content.trim(),ts,sourceRef:ref});
    }else if(entry.kind==='send-message'&&entry.message&&typeof entry.message==='object'){
      let text='';
      if(entry.message.type==='text'&&typeof entry.message.content==='string')text=entry.message.content;
      else if(entry.message.type==='widget'&&typeof entry.message.widget?.prompt==='string')text=entry.message.widget.prompt;
      if(text.trim())records.push({id:entry.id,line,role:'assistant',text:text.trim(),ts,sourceRef:ref});
    }
  }
  if(!records.length)return null;
  const ids=new Set();const output=records.map((r,seq)=>{
    let rid=r.id||`line:${r.line}`;if(ids.has(rid))rid=`${rid}:${r.line}`;ids.add(rid);
    return {id:rid,seq,role:r.role,text:r.text,ts:r.ts||fallbackTs,sourceRef:r.sourceRef};
  });
  return {meta:{channelId:'grok-bot',threadId,title:title||output.find(r=>r.role==='user')?.text.slice(0,80)||output[0]?.text.slice(0,80)||'未命名会话',createdAt:output[0].ts||fallbackTs,lastActiveAt:output.at(-1).ts||fallbackTs,sourcePath:path},records:output};
}
function sourceParser(source,path,title) {
  let id=source==='antigravity'?(/([^/\\]+)[/\\]\.system_generated[/\\]logs[/\\]transcript(?:_full)?\.jsonl$/.exec(path)?.[1]||basename(path,'.jsonl')):basename(path,'.jsonl');
  let createdAt='',hasMeta=false,hasSessionId=false,subagent=false,hasResponse=false,cwd='';
  const records=[],fallback=[];
  const add=(target,row,line,role,text,nativeId,content,extra)=>{
    text=typeof text==='string'?text:'';const images=extractImages(content,text,cwd,path,extra);
    if(!['user','assistant'].includes(role)||typeof text!=='string'||(!text.trim()&&!images.length))return;
    if(role==='user'&&/^\s*<(system-reminder|task-notification|local-command|command-name|bash-input)/.test(text))return;
    target.push({id:nativeId,line,role,text:text.trim(),ts:row.timestamp||'',sourceRef:`${path}:${line}`,...images.length?{images}:{}});
  };
  return {
    accept(line,lineNumber){
      if(!line.trim())return;let row;
      try{row=JSON.parse(line);}catch{throw new Error(`第 ${lineNumber} 行 JSON 不完整，保留此前导入版本`);}
      if(!row||typeof row!=='object'||Array.isArray(row))throw new Error(`第 ${lineNumber} 行不是有效日志记录`);
      if(!cwd&&typeof row.cwd==='string')cwd=row.cwd;
      if(source==='claude-code'){
        if(!hasSessionId&&row.sessionId){id=row.sessionId;hasSessionId=true;}
        if(!row.isSidechain&&['user','assistant'].includes(row.type))add(records,row,lineNumber,row.message?.role||row.type,textOf(row.message?.content),row.uuid,row.message?.content);
      }else if(source==='antigravity'){
        const ts=row.created_at||row.timestamp||'';
        const nativeId=row.step_index!==undefined?'step:'+row.step_index:undefined;
        const mediaImages=Array.isArray(row.media)?row.media.filter(m=>m?.uri&&(!m.mime_type||String(m.mime_type).startsWith('image/'))).map(m=>m.uri):[];
        if(row.type==='USER_INPUT'&&(!row.source||row.source==='USER_EXPLICIT')){
          add(records,{timestamp:ts},lineNumber,'user',antigravityUserText(row.content),nativeId,undefined,mediaImages);
        }else if(row.type==='PLANNER_RESPONSE'&&(!row.source||row.source==='MODEL')){
          if((typeof row.content==='string'&&row.content.trim())||mediaImages.length){
            add(records,{timestamp:ts},lineNumber,'assistant',typeof row.content==='string'?row.content:'',nativeId,undefined,mediaImages);
          }
        }
      }else{
        if(row.type==='session_meta'&&!hasMeta){hasMeta=true;id=row.payload?.id||id;createdAt=row.timestamp||'';cwd=row.payload?.cwd||cwd;subagent=!!row.payload?.source?.subagent;}
        if(row.type==='response_item'&&row.payload?.type==='message'){
          hasResponse=true;fallback.length=0;
          add(records,row,lineNumber,row.payload.role,textOf(row.payload.content),row.payload.id,row.payload.content);
        }else if(!hasResponse&&row.type==='event_msg'){
          if(row.payload?.type==='user_message')add(fallback,row,lineNumber,'user',row.payload.message||'',undefined,undefined,[...(row.payload.images||[]),...(row.payload.local_images||[])]);
          if(row.payload?.type==='agent_message')add(fallback,row,lineNumber,'assistant',row.payload.message);
        }
      }
    },
    finish(){
      if(subagent)return null;
      const selected=source==='codex'&&!hasResponse?fallback:records;
      if(!selected.length)return null;
      const ids=new Set();const output=selected.map((r,seq)=>{
        let rid=r.id||`line:${r.line}`;if(ids.has(rid))rid=`${rid}:${r.line}`;ids.add(rid);
        return {id:rid,seq,role:r.role,text:r.text,ts:r.ts||createdAt,sourceRef:r.sourceRef,...r.images?{images:r.images}:{}};
      });
      return {meta:{channelId:source,threadId:id,title:title||output.find(r=>r.role==='user')?.text.slice(0,80)||output[0]?.text.slice(0,80)||'未命名会话',createdAt:createdAt||output[0].ts,lastActiveAt:output.at(-1).ts,sourcePath:path},records:output};
    }
  };
}
export function parseSource(raw,source,path,title){if(source==='grok-bot')return parseGrokBot(raw,path,title);const parser=sourceParser(source,path,title);let line=0;for(const value of raw.split('\n'))parser.accept(value,++line);return parser.finish();}
export async function discover(root, source) {
  const result=[]; let count=0;
  if(source==='grok-bot'){
    const dir=await grokBotPersistenceDir(await realpath(root));
    for(const e of await readdir(dir,{withFileTypes:true})){
      if(e.isSymbolicLink()||!e.isFile()||extname(e.name)!=='.blob')continue;
      if(/\.transcript\.replicas\.[^.]+$/.test(decodeBase32(e.name.slice(0,-5))))result.push(join(dir,e.name));
    }
    return result.sort();
  }
  if(source==='antigravity'){
    const real=await realpath(root);let brainDir=real;
    try{const candidate=join(real,'brain');if((await stat(candidate)).isDirectory())brainDir=candidate;}catch{}
    for(const e of await readdir(brainDir,{withFileTypes:true})){
      if(e.isSymbolicLink()||!e.isDirectory()||e.name==='tempmediaStorage')continue;
      const logsDir=join(brainDir,e.name,'.system_generated','logs');
      const full=join(logsDir,'transcript_full.jsonl'),compact=join(logsDir,'transcript.jsonl');
      try{if((await stat(full)).isFile()){result.push(full);continue;}}catch{}
      try{if((await stat(compact)).isFile())result.push(compact);}catch{}
    }
    return result.sort();
  }
  async function walk(dir,depth=0) {
    if (depth>15) return;
    for (const e of await readdir(dir,{withFileTypes:true})) {
      if (++count>100000) throw new Error('来源文件过多，请选择更具体的目录');
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory() && !['node_modules','.git','attachments','plugins'].includes(e.name)) {
        if (source==='codex' && depth===0 && !['sessions','archived_sessions'].includes(e.name)) continue;
        await walk(join(dir,e.name),depth+1);
      } else if (e.isFile() && extname(e.name)==='.jsonl' && !e.name.startsWith('agent-') && (source!=='codex' || e.name.startsWith('rollout-'))) result.push(join(dir,e.name));
    }
  }
  await walk(await realpath(root)); return result.sort();
}
// Read JSONL incrementally: retain visible conversation records, not the entire
// raw file, split strings, or parsed tool payloads. A single long JSON line still
// has to fit in memory, as do the visible conversation and its SQLite encoding.
export async function readSourceStable(path,source,title,{signal}={}) {
  if(source==='grok-bot'){
    const before=await stat(path),buf=await readFile(path,{signal}),digest=createHash('sha256').update(buf).digest('hex'),after=await stat(path);
    if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new Error('文件正在变化，将在下次同步重试');
    return {conversation:parseGrokBot(buf.toString('utf8'),path,title),stamp:`${after.size}:${after.mtimeMs}`,modified:after.mtimeMs,version:digest};
  }
  const before=await stat(path),digest=createHash('sha256'),parser=sourceParser(source,path,title);
  const stream=createReadStream(path,{highWaterMark:256*1024,signal});
  const decoder=new StringDecoder('utf8');let pending='',lineNumber=0;
  const accept=text=>parser.accept(text.endsWith('\r')?text.slice(0,-1):text,++lineNumber);
  try {
    for await(const chunk of stream){
      digest.update(chunk);pending+=decoder.write(chunk);
      let start=0,end;
      while((end=pending.indexOf('\n',start))!==-1){accept(pending.slice(start,end));start=end+1;}
      pending=pending.slice(start);
    }
    pending+=decoder.end();if(pending)accept(pending);
    const after=await stat(path);
    if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new Error('文件正在变化，将在下次同步重试');
    return {conversation:parser.finish(),stamp:`${after.size}:${after.mtimeMs}`,modified:after.mtimeMs,version:digest.digest('hex')};
  }finally{stream.destroy();}
}
export async function readSourceIndex(root,source){
  const titles=new Map(),skipped=new Set();
  if(source==='codex'){
    try{const raw=await readFile(join(root,'session_index.jsonl'),'utf8');for(const l of raw.split('\n').filter(Boolean)){const r=JSON.parse(l);if(r?.id&&r?.thread_name)titles.set(r.id,r.thread_name);}}catch{/* optional title index */}
  }else if(source==='grok-bot'){
    try{
      const dir=await grokBotPersistenceDir(root);
      for(const e of await readdir(dir,{withFileTypes:true})){
        if(e.isSymbolicLink()||!e.isFile()||extname(e.name)!=='.blob')continue;
        if(!decodeBase32(e.name.slice(0,-5)).endsWith('.roster.last-roster'))continue;
        try{
          const parsed=JSON.parse(await readFile(join(dir,e.name),'utf8'));
          for(const row of parsed?.value?.rows||[])if(row?.id&&row?.name)titles.set(row.id,row.name);
        }catch{/* ignore corrupt roster */}
      }
    }catch{/* optional roster index */}
  }else if(source==='antigravity'){
    let dbPath='';
    for(const candidate of [join(root,'conversation_summaries.db'),join(dirname(root),'conversation_summaries.db')]){
      try{if((await stat(candidate)).isFile()){dbPath=candidate;break;}}catch{}
    }
    if(dbPath){
      let db;
      try{
        db=new DatabaseSync(dbPath,{readOnly:true});
        for(const row of db.prepare('SELECT conversation_id, title, parent_conversation_id, nesting_depth FROM conversation_summaries').all()){
          if(!row?.conversation_id)continue;
          if(row.title)titles.set(row.conversation_id,row.title);
          if(row.parent_conversation_id||Number(row.nesting_depth)>0)skipped.add(row.conversation_id);
        }
      }catch{/* optional summary index */}finally{try{db?.close();}catch{}}
    }
  }
  return {titles,skipped};
}
