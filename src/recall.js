import {hash} from './adapters.js';
export function tokenize(text) {
  const tokens=[];
  for(const run of text.toLowerCase().match(/[a-z0-9]+|[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g)||[]) {
    if(/^[a-z0-9]/.test(run) || run.length===1) tokens.push(run);
    else for(let i=0;i<run.length-1;i++) tokens.push(run.slice(i,i+2));
  } return tokens;
}
export const estimate = text => [...text].reduce((n,c)=>n+(c.codePointAt(0)>127 ? 1 : .25),0);
export function unitsOf(conversations) {
  const units=[];
  for(const c of conversations) {
    const runs=[];
    for(const r of c.records) {
      if(!r.text.trim()) continue;
      const last=runs.at(-1);
      if(last?.role===r.role) last.rows.push(r); else runs.push({role:r.role,rows:[r]});
    }
    let order=0;
    for(let i=0;i<runs.length;i++) {
      const pair=runs[i].role==='user' && runs[i+1]?.role==='assistant' ? [runs[i],runs[++i]] : [runs[i]];
      const rows=pair.flatMap(x=>x.rows), text=rows.map(r=>`[${r.role}] ${r.text}`).join('\n\n');
      units.push({id:hash(JSON.stringify([c.meta.channelId,c.meta.threadId,rows])),key:`${c.meta.channelId}:${c.meta.threadId}`,meta:c.meta,order:order++,text,records:rows,fields:pair.map(r=>({name:r.role,text:r.rows.map(x=>x.text).join('\n'),weight:r.role==='user'?2.5:1}))});
    }
  } return units;
}
export function rank(units,queries) {
  const tracks=[...new Set(queries.map(q=>q.trim().toLowerCase()).filter(Boolean))].slice(0,9).map((q,i)=>({terms:[...new Set(tokenize(q))],weight:i===0?1:.72}));
  const allTerms=new Set(tracks.flatMap(t=>t.terms)), df=new Map(), sums={}, counts={};
  const cached=units.map(u=>({u,fields:u.fields.map(f=>{
    const tokens=tokenize(f.text), tf=new Map();
    if(tokens.length){sums[f.name]=(sums[f.name]||0)+tokens.length;counts[f.name]=(counts[f.name]||0)+1;}
    for(const t of tokens) if(allTerms.has(t)) tf.set(t,(tf.get(t)||0)+1);
    return {...f,len:tokens.length,tf};
  })}));
  for(const {fields} of cached) for(const t of new Set(fields.flatMap(f=>[...f.tf.keys()]))) df.set(t,(df.get(t)||0)+1);
  const idf=t=>Math.log(1+(units.length-(df.get(t)||0)+.5)/((df.get(t)||0)+.5));
  return cached.map(({u,fields})=>({...u,score:Math.max(0,...tracks.map(track=>{
    let evidence=0,denom=0;
    for(const t of track.terms){const d=idf(t);denom+=d;let tf=0;
      for(const f of fields) tf+=f.weight*(f.tf.get(t)||0)/Math.max(.01,1-.75+.75*f.len/Math.max(1,(sums[f.name]||0)/(counts[f.name]||1)));
      evidence+=d*tf/(.5+tf);
    } return denom?Math.min(1,evidence/denom)*track.weight:0;
  }))}));
}
export function recall(conversations,input,seen=[]) {
  const excluded=new Set(seen), all=unitsOf(conversations), scored=rank(all,[input.query,...input.alternatives||[]]), groups=new Map();
  for(const u of scored){if(!groups.has(u.key))groups.set(u.key,[]);groups.get(u.key).push(u);}
  const regions=[];
  for(const units of groups.values()) {
    const weights=[.08,.22,.4,.22,.08];
    const smooth=units.map((u,i)=>{let sum=0,w=0;weights.forEach((x,k)=>{if(units[i+k-2]){sum+=units[i+k-2].score*x;w+=x;}});return Math.max(u.score,sum/w);});
    const peaks=units.map((u,i)=>i).filter(i=>units[i].score>0 && smooth[i]>=(smooth[i-1]??-1) && smooth[i]>(smooth[i+1]??-1));
    const spans=[];
    for(const p of peaks){let a=p,b=p;while(a>0&&smooth[a-1]>=smooth[p]*.35)a--;while(b+1<units.length&&smooth[b+1]>=smooth[p]*.35)b++;
      const last=spans.at(-1);if(last&&a<=last.b){last.b=Math.max(last.b,b);if(smooth[p]>smooth[last.p])last.p=p;}else spans.push({a,b,p});}
    for(const {a,b,p} of spans){const members=units.slice(a,b+1).filter(u=>!excluded.has(u.id));if(!members.some(u=>u.score>0))continue;
      regions.push({meta:units[p].meta,score:.8*smooth[p]+.2*smooth.slice(a,b+1).reduce((a,b)=>a+b,0)/(b-a+1),members,pivot:units[p].id});}
  }
  regions.sort((a,b)=>b.score-a.score || JSON.stringify(a.meta).localeCompare(JSON.stringify(b.meta)));
  let budget=9600;const evidence=[];
  for(const region of regions.slice(0,8)) {
    const ordered=[...region.members].sort((a,b)=>(a.id===region.pivot?-1:b.id===region.pivot?1:b.score-a.score));const selected=[];
    for(const u of ordered){if(budget<30)break;const cost=Math.ceil(estimate(u.text));let text=u.text,truncated=false;
      if(cost>budget){text='';let used=0;for(const c of u.text){const cost=c.codePointAt(0)>127?1:.25;if(used+cost>budget-20)break;text+=c;used+=cost;}text+='\n[片段已截断]';truncated=true;}
      budget-=Math.ceil(estimate(text)); selected.push({...u,text,truncated});}
    selected.sort((a,b)=>a.order-b.order);
    if(selected.length)evidence.push({meta:region.meta,score:region.score,unitIds:selected.filter(x=>!x.truncated).map(x=>x.id),text:selected.map(x=>x.text).join('\n\n'),truncated:selected.some(x=>x.truncated)});
  }
  return {evidence,estimatedTokens:9600-budget};
}
