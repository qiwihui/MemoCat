import {call,initTheme,themeLabels} from './ui-api.js';
const $=id=>document.getElementById(id),status=text=>{$('status').textContent=text;};
let state;

const themeApi=initTheme((pref,effective)=>{
  const btn=$('popup-theme-btn');
  if(btn){
    btn.title=`外观：${themeLabels[pref]}（点击切换）`;
    const icon=btn.querySelector('.theme-icon');
    if(icon){
      icon.innerHTML=effective==='dark'
        ?'<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'
        :'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41"/>';
    }
  }
});
$('popup-theme-btn').onclick=async()=>{
  const next=await themeApi.cycle();
  status(`外观已切换为：${themeLabels[next.pref]}`);
};

async function refresh(){
  state=await call('state');
  $('conversations').textContent=state.stats.conversations;
  $('messages').textContent=state.stats.messages;
  $('auto').checked=state.settings.autoSave;
  const connected=state.settings.sync.enabled&&Boolean(state.settings.sync.token);
  $('sync-pill').textContent=connected?'● 已连接':'本机';
  $('sync-app').textContent=connected?'同步到 MemoCat':'连接并同步到 MemoCat';
}
$('library').onclick=()=>{void chrome.tabs.create({url:chrome.runtime.getURL('library.html')});};
$('capture').onclick=async()=>{
  $('capture').disabled=true;
  try{
    const r=await call('captureActive');
    if(r.error)throw new Error(r.error);
    status(r.stale?'页面已切换，正在采集当前对话。':r.paused?'此平台已停用，请在资料库设置中开启。':r.suppressed?'此对话已删除，可在页面点击手动保存。':r.busy?'正在保存，请稍候。':`已保存 ${r.count||0} 条消息`);
    await refresh();
  }catch(e){status(e.message);}
  finally{$('capture').disabled=false;}
};
$('auto').onchange=async()=>{
  const checked=$('auto').checked;
  try{
    await call('settings',{patch:{autoSave:checked}});
    status(checked?'已开启支持平台的自动保存。':'已暂停自动保存，历史记录保留。');
  }catch(e){$('auto').checked=!checked;status(e.message);}
};
$('sync-app').onclick=async()=>{
  $('sync-app').disabled=true;
  try{
    const s=state?.settings?.sync;
    const r=!s?.enabled||!s?.token?(await call('connect')).syncState:await call('sync');
    await refresh();
    status(`已同步到 MemoCat（本次交接 ${r.sent} 项）`);
  }catch(e){status(e.message);}
  finally{$('sync-app').disabled=false;}
};
void refresh().catch(e=>status(e.message));
