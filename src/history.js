import {readdir,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {localDay} from './service.js';
export const shiftDay=(day,n)=>{const d=new Date(day+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
function validDay(day){return /^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(day))&&new Date(day).toISOString().slice(0,10)===day;}
async function directoryBytes(root){let bytes=0;for(const entry of await readdir(root,{withFileTypes:true})){if(entry.isSymbolicLink())continue;const path=join(root,entry.name);if(entry.isDirectory())bytes+=await directoryBytes(path);else if(entry.isFile()){try{bytes+=(await lstat(path)).size;}catch{}}}return bytes;}
export async function historyData(store,params,now=new Date()){
 const days=Number(params.get('days')||7),today=localDay(now.toISOString()),end=params.get('end')||today;
 if(![7,30].includes(days)||!validDay(end)||end>today)throw new Error('历史范围需为7天或30天，结束日期不能晚于今天');
 const start=shiftDay(end,1-days),day=params.get('day')||end;
 if(!validDay(day)||day<start||day>end)throw new Error('所选日期不在当前范围内');
 const offset=Number(params.get('offset')||0);if(!Number.isSafeInteger(offset)||offset<0)throw new Error('分页参数无效');
 const rows=store.db.prepare('SELECT id,source,thread,created,messages FROM ingestion_events ORDER BY created DESC,id DESC').all();
 const window=rows.filter(r=>{const d=localDay(r.created);return d>=start&&d<=end;});
 const sources=[...new Set(window.map(r=>r.source))].sort((a,b)=>a==='codex'?-1:b==='codex'?1:a.localeCompare(b)),daily=Array.from({length:days},(_,i)=>({day:shiftDay(start,i),counts:{}}));
 for(const r of window){const date=localDay(r.created),bucket=daily.find(d=>d.day===date);bucket.counts[r.source]=(bucket.counts[r.source]||0)+r.messages;}
 const selected=window.filter(r=>localDay(r.created)===day);
 const records=selected.slice(offset,offset+50).map(r=>{const c=store.db.prepare('SELECT id,title FROM conversations WHERE source=? AND thread=?').get(r.source,r.thread);return {...r,conversationId:c?.id||null,title:c?.title||'原会话已不可用'};});
 const all=store.all(),distribution=[];let messages=0;
 for(const c of all){let part=distribution.find(p=>p.source===c.meta.channelId);if(!part){part={source:c.meta.channelId,conversations:0,messages:0};distribution.push(part);}part.conversations++;part.messages+=c.records.length;messages+=c.records.length;}
 distribution.sort((a,b)=>b.messages-a.messages);
 return {today,start,end,day,days,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,daily,sources,totals:sources.map(source=>({source,messages:window.filter(r=>r.source===source).reduce((n,r)=>n+r.messages,0)})),records,totalRecords:selected.length,offset,storage:{conversations:all.length,messages,platforms:distribution.length,bytes:await directoryBytes(store.root),distribution}};
}
