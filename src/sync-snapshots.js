import {hash} from './adapters.js';
// Identity deliberately excludes file paths and line numbers. Occurrences within
// each snapshot preserve intentional repeated messages, even without timestamps.
export function messageKey(r){return JSON.stringify([r.role,r.text,r.ts||'',r.images?.map(i=>i.id||i.sourceKey||i.key||i.reason)||[]]);}
export function mergeSnapshots(snapshots){
 const ordered=[...snapshots].sort((a,b)=>a.modified-b.modified||a.conversation.meta.sourcePath.localeCompare(b.conversation.meta.sourcePath));
 const canonical=[...ordered].sort((a,b)=>b.conversation.records.length-a.conversation.records.length||b.modified-a.modified||a.conversation.meta.sourcePath.localeCompare(b.conversation.meta.sourcePath))[0].conversation;
 const records=new Map(),nativeKeys=new Map();let order=0;
 for(const {conversation} of ordered){const occurrences=new Map();for(const r of conversation.records){
  const signature=messageKey(r),n=(occurrences.get(signature)||0)+1;occurrences.set(signature,n);const key=signature+'#'+n,native=r.id&&!r.id.startsWith('line:')&&!r.id.startsWith('merged:')?r.id:null;
  if(native&&nativeKeys.has(native)&&nativeKeys.get(native)!==key)records.delete(nativeKeys.get(native));
  if(native)nativeKeys.set(native,key);
  const previous=records.get(key);records.set(key,{record:{...r,id:native||'merged:'+hash(key)},order:previous?.order??order++});
 }}
 const output=[...records.values()].sort((a,b)=>(Date.parse(a.record.ts)||0)-(Date.parse(b.record.ts)||0)||a.order-b.order).map(({record},seq)=>({...record,seq}));
 return {meta:{...canonical.meta,createdAt:canonical.meta.createdAt||output[0]?.ts||'',lastActiveAt:output.at(-1)?.ts||canonical.meta.lastActiveAt},records:output};
}
