'use strict';
importScripts('lib/core.js','lib/adapters.js','lib/db.js');
let writeGate=Promise.resolve(),syncTask;
const serialize=fn=>{const result=writeGate.then(fn);writeGate=result.catch(()=>{});return result;};
async function settings(){const row=(await chrome.storage.local.get('settings')).settings,d=MemoCore.defaults();return {...d,...row,platforms:{...d.platforms,...row?.platforms},sync:{...d.sync,...row?.sync}};}
const trusted=sender=>sender.id===chrome.runtime.id&&[chrome.runtime.getURL('library.html'),chrome.runtime.getURL('popup.html'),chrome.runtime.getURL('sidebar.html')].includes((sender.url||'').split('#')[0].split('?')[0]);
async function patchSettings(patch){MemoCore.validateSettings(patch);const previous=await settings(),next={...previous,...patch,platforms:{...previous.platforms,...patch.platforms}};if(next.sync)next.sync={...next.sync,url:new URL(next.sync.url).origin};
  // New credentials denote a different receiver. Requeue the full local library.
  if(next.sync.enabled&&next.sync.token&&(!previous.sync.enabled||previous.sync.url!==next.sync.url||previous.sync.token!==next.sync.token))await MemoDB.requeue();
  await chrome.storage.local.set({settings:next});return next;
}
async function pairWithApp(preferredUrl){
  const current=await settings(),sourceInstanceId=await MemoDB.identity();
  const candidates=[];
  for(const raw of [preferredUrl,current.sync.url,'http://127.0.0.1:3792']){
    if(!raw)continue;
    let origin;try{const u=new URL(raw);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.pathname!=='/'||u.search||u.hash||u.username||u.password)throw new Error();origin=u.origin;}catch{if(raw===preferredUrl)throw new Error('仅支持 http://127.0.0.1:端口');continue;}
    if(!candidates.includes(origin))candidates.push(origin);
  }
  let lastError='未检测到正在运行的 MemoCat 应用（请先启动桌面版或本地服务）';
  for(const url of candidates){
    try{
      const response=await fetch(url+'/api/browser-pair',{method:'POST',headers:{'content-type':'application/json','x-memo-extension':chrome.runtime.id},body:JSON.stringify({protocol:1,sourceInstanceId}),signal:AbortSignal.timeout(5000)});
      const result=await response.json().catch(()=>({}));
      if(!response.ok){lastError=result.error||'本地应用拒绝连接';if(response.status===403)break;continue;}
      if(typeof result.token!=='string'||!/^[a-f0-9]{64}$/.test(result.token)){lastError='本地应用返回的配对凭证无效';continue;}
      return await serialize(()=>patchSettings({sync:{enabled:true,url,token:result.token}}));
    }catch{}
  }
  throw new Error(lastError);
}
async function sync(){if(syncTask)return syncTask;syncTask=runSync().finally(()=>{syncTask=null;});return syncTask;}
async function findConversationTab(c){
  const [focused]=await chrome.tabs.query({active:true,lastFocusedWindow:true}).catch(()=>[]);
  const tabs=await chrome.tabs.query({});
  const targetKey=MemoCore.conversationKey(c.url)||(!c.id.includes(':draft:')?c.id:null);
  let targetCanonical=null;try{targetCanonical=MemoCore.canonicalURL(c.url);}catch{}
  const sorted=[...tabs].sort((a,b)=>Number(b.id===focused?.id)-Number(a.id===focused?.id)||Number(Boolean(b.active))-Number(Boolean(a.active)));
  for(const tab of sorted){
    if(!tab?.id||!tab.url)continue;
    try{
      if(targetKey){if(MemoCore.conversationKey(tab.url)===targetKey)return tab;}
      else if(targetCanonical&&MemoCore.canonicalURL(tab.url)===targetCanonical)return tab;
    }catch{}
  }
  return null;
}
async function sendRecaptureToTab(tabId,draftId){
  const payload={type:'captureNow',replace:true,...(draftId?{draftId}:{})};
  for(let attempt=0;attempt<4;attempt++){
    const res=await chrome.tabs.sendMessage(tabId,payload);
    if(!res?.busy||attempt===3)return res;
    await new Promise(r=>setTimeout(r,400));
  }
}
async function waitForTabRecapture(tabId,draftId,timeoutMs=15000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    let tab;try{tab=await chrome.tabs.get(tabId);}catch{return null;}
    if(!tab)return null;
    if(tab.status==='complete'){
      try{
        const res=await sendRecaptureToTab(tabId,draftId);
        if(res&&!res.error&&!res.paused&&!res.stale&&!res.busy&&(res.count||0)>0)return res;
      }catch{}
    }
    await new Promise(r=>setTimeout(r,600));
  }
  return null;
}
async function runSync(){let config=(await settings()).sync;if(!config.enabled)return {enabled:false};const sourceInstanceId=await MemoDB.identity();let sent=0,repaired=false;
  try{
    if(!config.token){config=(await pairWithApp(config.url)).sync;repaired=true;}
    let changes=await MemoDB.all('outbox');
    for(let i=0;i<changes.length;i++){
      const change=changes[i],current=(await settings()).sync;
      if(!current.enabled||current.url!==config.url||current.token!==config.token)throw new Error('连接配置已改变，请重新同步');
      let response=await fetch(config.url+'/api/browser-sync',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+config.token,'x-memo-extension':chrome.runtime.id},body:JSON.stringify({protocol:1,sourceInstanceId,change}),signal:AbortSignal.timeout(15000)});
      if(response.status===403&&!repaired){
        config=(await pairWithApp(config.url)).sync;repaired=true;
        changes=await MemoDB.all('outbox');i=-1;sent=0;continue;
      }
      const result=await response.json();if(!response.ok)throw new Error(result.error||'本地应用拒绝同步');if(result.changeId!==change.changeId)throw new Error('本地应用未确认当前变更');
      // An older response must never acknowledge a newly queued version.
      await MemoDB.ack(change.id,change.changeId);sent++;
    }
    const state={lastSync:new Date().toISOString(),error:null,sent,pending:(await MemoDB.all('outbox')).length};await chrome.storage.local.set({syncState:state});return state;
  }catch(e){const state={lastAttempt:new Date().toISOString(),error:e.message,sent,pending:(await MemoDB.all('outbox')).length};await chrome.storage.local.set({syncState:state});throw e;}
}
async function dispatch(message,sender){if(!message||typeof message.type!=='string')throw new Error('无效消息');
  const ui=trusted(sender);
  if(!ui){
    const platform=MemoCore.platformFor(sender.url);if(sender.id!==chrome.runtime.id||sender.frameId!==0||!sender.tab||!platform)throw new Error('拒绝来源');
    if(message.type==='captureSettings'){const s=await settings();return {autoSave:s.autoSave,enabled:s.platforms[platform.id]};}
    if(message.type!=='observe')throw new Error('页面没有执行此操作的权限');
    const c=MemoCore.validateConversation(message.conversation);
    if(c.platform!==platform.id||new URL(c.url).origin!==new URL(sender.url).origin)throw new Error('采集来源不匹配');
    return serialize(async()=>{const s=await settings();if(!s.platforms[platform.id]||(!s.autoSave&&!message.manual))return {paused:true};
      let currentUrl=sender.url;try{const tab=await chrome.tabs.get(sender.tab.id);if(tab?.url)currentUrl=tab.url;}catch{}
      if(!MemoCore.currentCapture(c,sender.url,currentUrl))return {stale:true};
      const result=await MemoDB.save(c,{manual:message.manual===true,replace:message.manual===true&&message.replace===true});
      if(result.changed)await chrome.storage.local.set({lastChangeAt:Date.now()});
      void sync().catch(()=>{});return {changed:result.changed,suppressed:result.suppressed,count:result.conversation?.messages.length};});
  }
  switch(message.type){
    case 'state':{const rows=await MemoDB.all(),s=await settings(),pending=(await MemoDB.all('outbox')).length;
      const now=new Date(),todayPrefix=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
      const todayNew=rows.filter(c=>{const d=new Date(c.createdAt||c.updatedAt);return !Number.isNaN(d)&&`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`===todayPrefix;}).length;
      const bytes=new TextEncoder().encode(JSON.stringify(rows)).length;
      const platformCounts={};for(const c of rows)platformCounts[c.platform]=(platformCounts[c.platform]||0)+1;
      let activeId=null,activePlatform=null;
      try{const [tab]=await chrome.tabs.query({active:true,lastFocusedWindow:true});const url=tab?.url||sender.tab?.url;if(url){activePlatform=MemoCore.platformFor(url)?.id||null;activeId=MemoCore.conversationKey(url)||null;}}catch{}
      return {settings:s,extensionId:chrome.runtime.id,version:chrome.runtime.getManifest().version,activeId,activePlatform,platformCounts,stats:{conversations:rows.length,todayNew,bytes,messages:rows.reduce((n,c)=>n+c.messages.length,0),platforms:new Set(rows.map(c=>c.platform)).size},syncState:{...(await chrome.storage.local.get('syncState')).syncState,pending}};}
    case 'settings':return serialize(()=>patchSettings(message.patch));
    case 'list':{const q=String(message.q||'').trim().toLocaleLowerCase(),platform=message.platform||'',platforms=Array.isArray(message.platforms)&&message.platforms.length?message.platforms:null,from=message.from||'',to=message.to||'';const terms=q?q.split(/\s+/).filter(Boolean):[];
      const rows=(await MemoDB.all()).filter(c=>{if(platform&&c.platform!==platform)return false;if(platforms&&!platforms.includes(c.platform))return false;const day=c.updatedAt.slice(0,10);if(from&&day<from)return false;if(to&&day>to)return false;if(terms.length){const hay=[c.title,...c.messages.map(m=>m.text)].join('\n').toLocaleLowerCase();if(!terms.every(t=>hay.includes(t)))return false;}return true;}).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
      const offset=Math.max(0,Number(message.offset)||0);
      return {total:rows.length,items:rows.slice(offset,offset+100).map(c=>{const last=c.messages.at(-1)?.text||c.messages[0]?.text||'';let preview=last.slice(0,140);if(terms.length){const matchMsg=c.messages.find(m=>terms.some(t=>m.text.toLocaleLowerCase().includes(t)));if(matchMsg){const idx=matchMsg.text.toLocaleLowerCase().indexOf(terms[0]);const start=Math.max(0,idx-20);preview=(start>0?'…':'')+matchMsg.text.slice(start,start+120)+(start+120<matchMsg.text.length?'…':'');}}return {id:c.id,title:c.title,platform:c.platform,url:c.url,createdAt:c.createdAt,updatedAt:c.updatedAt,count:c.messages.length,preview};})};}
    case 'read':return MemoDB.get('conversations',message.id);
    case 'rename':return serialize(async()=>{const c=await MemoDB.rename(message.id,message.title);await chrome.storage.local.set({lastChangeAt:Date.now()});void sync().catch(()=>{});return c;});
    case 'delete':return serialize(async()=>{const r=await MemoDB.remove(message.id);await chrome.storage.local.set({lastChangeAt:Date.now()});void sync().catch(()=>{});return r;});
    case 'clear':return serialize(async()=>{const r=await MemoDB.clear();await chrome.storage.local.set({lastChangeAt:Date.now()});void sync().catch(()=>{});return r;});
    case 'export':{const rows=await MemoDB.all();return {format:'memocat-browser',version:1,exportedAt:new Date().toISOString(),conversations:message.ids?rows.filter(c=>message.ids.includes(c.id)):rows};}
    case 'import':{const b=message.backup;if(!b||!(b.format==='memocat-browser'||/^memo-[a-z]+-browser$/.test(b.format))||b.version!==1)throw new Error('请选择 MemoCat 浏览器备份 JSON');return serialize(async()=>{const count=await MemoDB.restore(b.conversations);await chrome.storage.local.set({lastChangeAt:Date.now()});return count;});}
    case 'sync':return sync();
    case 'connect':{const next=await pairWithApp(message.url);const state=await sync();return {settings:next,syncState:state};}
    case 'disconnect':{const current=await settings();return serialize(()=>patchSettings({sync:{enabled:false,url:current.sync.url,token:''}}));}
    case 'closeSidebar':{if(sender.tab?.id)await chrome.tabs.sendMessage(sender.tab.id,{type:'closeSidebar'});return true;}
    case 'captureActive':{const [tab]=await chrome.tabs.query({active:true,lastFocusedWindow:true});if(!tab?.id)throw new Error('找不到当前标签页');try{return await chrome.tabs.sendMessage(tab.id,{type:'captureNow'});}catch{throw new Error('请打开受支持的 AI 对话页面；安装扩展后需刷新已有页面。');}}
    case 'recapture':{
      if(!message.id){
        const [tab]=await chrome.tabs.query({active:true,lastFocusedWindow:true});
        if(!tab?.id)throw new Error('找不到当前标签页');
        let res;try{res=await sendRecaptureToTab(tab.id,'');}catch{throw new Error('请打开受支持的 AI 对话页面；安装扩展后需刷新已有页面。');}
        if(res?.error)throw new Error(res.error);
        if(res?.paused)throw new Error('当前平台采集已关闭，请先开启后再重新采集');
        if(res?.stale)throw new Error('当前对话网址仍在变化，请稍后重试');
        if(res?.busy)throw new Error('正在保存当前对话，请稍后重试');
        await Promise.race([sync().catch(()=>{}),new Promise(r=>setTimeout(r,1500))]);
        return {captured:true,opened:false,count:res?.count||0};
      }
      const c=await MemoDB.get('conversations',message.id);
      if(!c)throw new Error('该对话不存在');
      const s=await settings();
      if(!s.platforms[c.platform])throw new Error('该平台采集已在设置中关闭，请先开启后再重新采集');
      const draftId=c.id.includes(':draft:')?c.id.split(':draft:')[1]:'';
      const existing=await findConversationTab(c);
      if(existing){
        let res;try{res=await sendRecaptureToTab(existing.id,draftId);}catch{throw new Error('原对话标签页尚未连接扩展，请先刷新该页面后重试');}
        if(res?.error)throw new Error(res.error);
        if(res?.paused)throw new Error('当前页面暂停采集，请确认平台开关已开启');
        if(res?.stale)throw new Error('原对话页面网址已变化，请打开目标对话后重试');
        if(res?.busy)throw new Error('正在保存当前对话，请稍后重试');
        await Promise.race([sync().catch(()=>{}),new Promise(r=>setTimeout(r,1500))]);
        return {captured:true,opened:false,count:res?.count||0,id:c.id};
      }
      if(!c.url||!MemoCore.platformFor(c.url))throw new Error('该对话没有可访问的原网页地址');
      const tab=await chrome.tabs.create({url:c.url,active:true});
      const res=await waitForTabRecapture(tab.id,draftId,15000);
      if(res){
        await Promise.race([sync().catch(()=>{}),new Promise(r=>setTimeout(r,1500))]);
        return {captured:true,opened:true,count:res.count||0,id:c.id};
      }
      return {captured:false,opened:true,id:c.id};
    }
    default:throw new Error('未知操作');
  }
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{void dispatch(message,sender).then(data=>respond({ok:true,data}),error=>respond({ok:false,error:error.message||'操作失败'}));return true;});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='memo-sync')void sync().catch(()=>{});});
async function initialize(){await MemoDB.identity();await chrome.alarms.create('memo-sync',{periodInMinutes:1});}
chrome.runtime.onInstalled.addListener(details=>{void initialize().then(()=>{if(details.reason==='install')return chrome.tabs.create({url:chrome.runtime.getURL('library.html#settings')});});});
chrome.runtime.onStartup.addListener(()=>{void initialize().then(()=>sync()).catch(()=>{});});

chrome.action.onClicked.addListener(tab=>{if(!tab.id)return;if(!MemoCore.platformFor(tab.url)){void chrome.tabs.create({url:chrome.runtime.getURL('library.html')});return;}void chrome.tabs.sendMessage(tab.id,{type:'toggleSidebar'}).catch(()=>chrome.tabs.create({url:chrome.runtime.getURL('library.html')}));});
