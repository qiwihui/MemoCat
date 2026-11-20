import {BROWSER_SOURCES} from './browser-bridge.js';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LOCAL_SOURCES,discover,readSourceStable,readSourceIndex} from './adapters.js';
import {recall} from './recall.js';
import {MediaStore} from './media.js';
import {mergeSnapshots} from './sync-snapshots.js';
export function validate(input,list=false){
  if(!input || typeof input!=='object' || Array.isArray(input))throw new Error('参数必须为对象');
  const allowed=new Set(list?['from','to','sources']:['query','alternatives','from','to','sources','process_id']);
  if(Object.keys(input).some(k=>!allowed.has(k)))throw new Error('存在未知参数');
  if(!list && (typeof input.query!=='string'||!input.query.trim()||input.query.length>20000))throw new Error('query 必须为 1–20000 字符');
  if(input.alternatives!==undefined && (!Array.isArray(input.alternatives)||input.alternatives.length>8||input.alternatives.some(x=>typeof x!=='string'||!x.trim())))throw new Error('alternatives 最多 8 个非空字符串');
  if(input.sources!==undefined && (!Array.isArray(input.sources)||input.sources.some(x=>![...LOCAL_SOURCES,'demo',...BROWSER_SOURCES].includes(x))))throw new Error('来源无效');
  for(const k of ['from','to'])if(input[k]!==undefined&&(!/^\d{4}-\d{2}-\d{2}$/.test(input[k]) || !Number.isFinite(Date.parse(input[k])) || new Date(input[k]).toISOString().slice(0,10)!==input[k]))throw new Error('日期无效');
  if(input.from&&input.to&&input.from>input.to)throw new Error('日期范围无效');
  if(list&&(!input.from||!input.to||(Date.parse(input.to)-Date.parse(input.from))/864e5>30))throw new Error('清单需指定最多 31 天的日期范围');
  if(input.process_id!==undefined && (typeof input.process_id!=='string'||!/^[0-9a-f-]{36}$/i.test(input.process_id)))throw new Error('process_id 无效');
  return input;
}
export function localDay(ts){const d=new Date(ts);return Number.isFinite(d.valueOf())?`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`:'';}
export class Service {
  constructor(store){this.store=store;this.media=new MediaStore(join(store.root,'attachments'));this.syncState={running:false,lastRun:null,issues:[]};this.gate=Promise.resolve();}
  sync(sourceId){if(this.syncTask)return this.syncTask;this.syncTask=this.runSync(sourceId).finally(()=>{this.syncTask=null;});return this.syncTask;}
  async runSync(sourceId){this.syncState={running:true,lastRun:null,issues:[],changed:0,scanned:0};
    try{for(const config of this.store.getSetting('sources',[]).filter(s=>s.enabled&&(!sourceId||sourceId===s.id))){
      try {const files=await discover(config.path,config.id);const {titles,skipped}=await readSourceIndex(config.path,config.id);
        const groups=new Map();
        for(const path of files){if(!this.sourceCurrent(config))break;this.syncState.scanned++;try{
          const {conversation:c,modified}=await readSourceStable(path,config.id);if(!this.sourceCurrent(config))break;
          if(c&&!skipped.has(c.meta.threadId)){c.meta.title=titles.get(c.meta.threadId)||c.meta.title;const prior=this.store.db.prepare('SELECT body FROM conversations WHERE source=? AND thread=?').get(c.meta.channelId,c.meta.threadId);const materialized=await this.media.ingest(c,prior?JSON.parse(prior.body):undefined);if(!this.sourceCurrent(config))break;const group=groups.get(c.meta.threadId)||[];group.push({conversation:materialized,modified});groups.set(c.meta.threadId,group);}
        }catch(e){this.syncState.issues.push({source:config.id,path,error:e.message});}}
        for(const snapshots of groups.values()){if(!this.sourceCurrent(config))break;
          // Preserve existing history if a snapshot is unreadable, while still
          // importing healthy logs and new messages from this same source.
          if(this.syncState.issues.some(i=>i.source===config.id)){
            const prior=this.store.db.prepare('SELECT body FROM conversations WHERE source=? AND thread=?').get(config.id,snapshots[0].conversation.meta.threadId);
            if(prior)snapshots.unshift({conversation:JSON.parse(prior.body),modified:Number.NEGATIVE_INFINITY});
          }
          if(this.store.save(mergeSnapshots(snapshots)))this.syncState.changed++;
        }
      }catch(e){this.syncState.issues.push({source:config.id,error:e.message});}finally{const runs=this.store.getSetting('sourceRuns',{});runs[config.id]={lastRun:new Date().toISOString(),issues:this.syncState.issues.filter(i=>i.source===config.id)};this.store.setSetting('sourceRuns',runs);}}
    }finally{this.syncState.running=false;this.syncState.lastRun=new Date().toISOString();}
    return this.syncState;
  }
  sourceCurrent(config){const latest=this.store.getSetting('sources',[]).find(s=>s.id===config.id);return !!latest?.enabled&&latest.path===config.path;}
  async invoke(input,caller='preview',request=randomUUID()){
    validate(input);await this.sync();
    const previous=this.gate;let release;this.gate=new Promise(r=>release=r);await previous;
    try{
      const process=this.store.context(input.process_id,caller);
      const prior=this.store.db.prepare('SELECT * FROM deliveries WHERE process=? AND request=?').get(process,String(request));
      if(prior){const p=JSON.parse(prior.payload);if(p.inputKey!==JSON.stringify(input))throw new Error('请求 ID 与不同参数冲突');if(prior.status==='abandoned')throw new Error('此前交付已取消，请使用新请求 ID');return {...p,deliveryId:prior.id};}
      const conversations=this.store.all(input.sources).map(c=>({...c,records:c.records.filter(r=>{const day=localDay(r.ts);return (!input.from||day>=input.from)&&(!input.to||day<=input.to);})}));
      const result=recall(conversations,input,this.store.seen(process));
      const payload={...result,process_id:process,inputKey:JSON.stringify(input),partial:this.syncState.issues.length>0,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone};
      const row=this.store.prepare(process,String(request),input.query,payload);return {...payload,deliveryId:row.id};
    }finally{release();}
  }
  listConversations(input){validate(input,true);return {timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,items:this.store.all(input.sources).filter(c=>c.records.some(r=>{const d=localDay(r.ts);return d>=input.from&&d<=input.to;})).map(c=>c.meta)};}
}
