import {call,element as el,download,platform,initTheme,themeLabels} from './ui-api.js';
const $=id=>document.getElementById(id);

let state=null,currentId=null,currentConversation=null,offset=0,listTicket=0,detailTicket=0,searchTimer=null;
let filter={from:'',to:'',platform:'',quick:''};

const themeApi=initTheme((pref,effective)=>{
  const select=$('sidebar-theme-select');
  if(select&&select.value!==pref)select.value=pref;
  const btn=$('sidebar-theme-btn');
  if(btn){
    btn.title=`外观主题：${themeLabels[pref]}（点击切换）`;
    const icon=btn.querySelector('.cm-theme-icon');
    if(icon){
      icon.innerHTML=effective==='dark'
        ?'<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'
        :'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41"/>';
    }
  }
});

$('sidebar-theme-btn').onclick=async()=>{
  const next=await themeApi.cycle();
  toast(`外观已切换为：${themeLabels[next.pref]}`);
};
$('sidebar-theme-select').onchange=async e=>{
  await themeApi.set(e.target.value);
  toast(`外观已切换为：${themeLabels[e.target.value]}`);
};

function toast(text){
  const node=$('toast');
  node.textContent=text;
  node.hidden=false;
  clearTimeout(toast.timer);
  toast.timer=setTimeout(()=>{node.hidden=true;},3200);
}

function formatPromptText(c){
  let qNum=0;
  const turns=c.messages.map(m=>`${m.role==='user'?`[提问 #${++qNum}]`:'[AI 回复]'}\n${m.text}`).join('\n\n');
  return `以下是来自 MemoCat 扩展的对话上下文（平台：${platform(c.platform)}）：\n\n<conversation_context title="${c.title||'未命名对话'}" url="${c.url||''}">\n${turns}\n</conversation_context>\n\n请基于以上上下文继续协助我：`;
}

async function recaptureById(id,triggerBtn){
  if(!id)return;
  if(triggerBtn)triggerBtn.disabled=true;
  toast('正在重新采集…');
  try{
    const r=await call('recapture',{id});
    if(r?.captured){
      await refresh();
      toast(`已重新采集 ${r.count||0} 条消息`);
    }else if(r?.opened){
      toast('已打开原对话页面，待页面加载完成后可再次点击重新采集');
    }
  }catch(e){
    toast(e.message);
  }finally{
    if(triggerBtn)triggerBtn.disabled=false;
  }
}

function formatDay(iso){
  if(!iso)return '';
  const d=new Date(iso);
  if(Number.isNaN(d.getTime()))return '';
  return d.toLocaleDateString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit'});
}

function formatDateTime(iso){
  if(!iso)return '';
  const d=new Date(iso);
  if(Number.isNaN(d.getTime()))return '';
  return d.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
}

function formatBytes(bytes){
  if(!Number.isFinite(bytes)||bytes<=0)return '0 B';
  if(bytes<1024)return bytes+' B';
  if(bytes<1048576)return (bytes/1024).toFixed(2)+' KB';
  return (bytes/1048576).toFixed(2)+' MB';
}

function confirmDialog(title,desc,okLabel='确认删除'){
  $('confirm-modal-title').textContent=title;
  $('confirm-modal-desc').textContent=desc;
  $('confirm-ok').textContent=okLabel;
  $('confirm-modal').hidden=false;
  return new Promise(resolve=>{
    const done=val=>{$('confirm-modal').hidden=true;resolve(val);};
    $('confirm-cancel').onclick=()=>done(false);
    $('confirm-ok').onclick=()=>done(true);
  });
}

function switchTab(tab){
  const map={
    memories:$('tab-panel-memories'),
    detail:$('tab-panel-detail'),
    connections:$('tab-panel-connections'),
    settings:$('tab-panel-settings')
  };
  for(const [k,panel] of Object.entries(map))panel.hidden=k!==tab;
  const navTab=tab==='detail'?'memories':tab;
  for(const name of ['memories','connections','settings']){
    const btn=$('nav-'+name);
    const active=name===navTab;
    btn.classList.toggle('active',active);
    if(active)btn.setAttribute('aria-current','page');
    else btn.removeAttribute('aria-current');
  }
  if(tab==='memories'){
    currentId=null;
    currentConversation=null;
    void refresh();
  }
}

$('nav-memories').onclick=()=>switchTab('memories');
$('nav-connections').onclick=()=>switchTab('connections');
$('nav-settings').onclick=()=>switchTab('settings');

$('open-library').onclick=()=>chrome.tabs.create({url:chrome.runtime.getURL('library.html')});
$('open-full-library').onclick=()=>chrome.tabs.create({url:chrome.runtime.getURL('library.html')});
$('close-sidebar').onclick=()=>{void call('closeSidebar').catch(()=>{window.close();});};

$('topbar-capture-btn').onclick=async()=>{
  const btn=$('topbar-capture-btn');
  btn.disabled=true;
  try{
    const r=await call('captureActive');
    if(r.error)throw new Error(r.error);
    toast(r.paused?'当前平台已停用或未开启':r.suppressed?'此对话已删除':r.busy?'正在保存，请稍候':`已保存 ${r.count||0} 条消息`);
    await refresh();
  }catch(e){toast(e.message);}
  finally{btn.disabled=false;}
};

// 初始化平台开关列表与快速筛选胶囊
let lastSidebarPlatformSig=null;
function renderSidebarPlatformPills(active){
  const host=$('sidebar-platform-pills');
  if(!host)return;
  host.replaceChildren();
  if(!active.length)return;
  const makePill=(val,text)=>{
    const btn=el('button','cm-platform-pill'+(filter.platform===val?' active':''),text);
    btn.type='button';
    btn.dataset.platform=val;
    btn.onclick=()=>{
      filter.platform=val;
      $('filter-platform').value=val;
      updateSidebarPillActive();
      void loadList().catch(e=>toast(e.message));
    };
    return btn;
  };
  host.append(makePill('','全部'));
  for(const p of active)host.append(makePill(p.id,p.name));
}
function updateSidebarPillActive(){
  for(const btn of document.querySelectorAll('#sidebar-platform-pills .cm-platform-pill')){
    btn.classList.toggle('active',(btn.dataset.platform||'')===filter.platform);
  }
}
function syncPlatformFilter(counts={}){
  const active=MemoCore.platforms.filter(p=>(counts[p.id]||0)>0);
  const sig=active.map(p=>`${p.id}:${counts[p.id]}`).join(',');
  if(sig===lastSidebarPlatformSig)return;
  lastSidebarPlatformSig=sig;
  const select=$('filter-platform'),prev=select.value;
  const allOpt=el('option','','全部平台');allOpt.value='';
  select.replaceChildren(allOpt);
  for(const p of active){
    const opt=el('option','',p.name);
    opt.value=p.id;
    select.append(opt);
  }
  if(prev&&active.some(p=>p.id===prev))select.value=prev;
  else if(prev){select.value='';filter.platform='';void loadList();}
  renderSidebarPlatformPills(active);
}

function initPlatforms(){
  const select=$('filter-platform');
  const listHost=$('platform-list');
  const allOpt=el('option','','全部平台');allOpt.value='';
  select.replaceChildren(allOpt);
  listHost.replaceChildren();
  for(const p of MemoCore.platforms){
    const btn=el('button','cm-platform-item');
    btn.type='button';
    btn.dataset.platform=p.id;
    btn.setAttribute('role','switch');
    btn.setAttribute('aria-label',p.name+' 自动保存');

    const idWrap=el('span','cm-platform-id');
    const img=el('img','cm-platform-logo');
    img.src=`icons/platforms/${p.id}.png`;
    img.alt='';
    idWrap.append(img,el('span','cm-platform-name',p.name));

    const track=el('span','cm-platform-track');
    track.setAttribute('aria-hidden','true');
    btn.append(idWrap,track);
    btn.onclick=async()=>{
      if(!state)return;
      const nextVal=!state.settings.platforms[p.id];
      btn.disabled=true;
      try{
        await call('settings',{patch:{platforms:{[p.id]:nextVal}}});
        await refreshState();
      }catch(e){
        toast(e.message);
      }finally{
        btn.disabled=false;
      }
    };
    listHost.append(btn);
  }
}
initPlatforms();

async function refreshState(){
  state=await call('state');
  $('stat-total').textContent=String(state.stats.conversations||0);
  $('stat-today').textContent=String(state.stats.todayNew||0);
  $('about-version').textContent=state.version||'0.5.0';
  syncPlatformFilter(state.platformCounts||{});

  $('auto-save-toggle').checked=Boolean(state.settings.autoSave);
  $('platform-global-paused').hidden=Boolean(state.settings.autoSave);

  for(const btn of document.querySelectorAll('.cm-platform-item')){
    const pid=btn.dataset.platform;
    const on=state.settings.platforms[pid]!==false;
    btn.classList.toggle('is-off',!on);
    btn.setAttribute('aria-checked',String(on));
  }

  const sync=state.settings.sync||{};
  const syncState=state.syncState||{};
  const connected=Boolean(sync.enabled&&sync.token);
  if(document.activeElement!==$('conn-url-input')){
    $('conn-url-input').value=sync.url||'http://127.0.0.1:3792';
  }
  $('conn-saved-summary').textContent=`已保存 ${state.stats.conversations||0} 段对话`;
  if(connected){
    $('conn-address-summary').textContent=syncState.error
      ? `${sync.url} · 同步异常：${syncState.error}`
      : `${sync.url}${syncState.lastSync?' · 最近同步 '+formatDateTime(syncState.lastSync):' · 已配对连接'}`;
    $('conn-primary-btn').textContent='打开 MemoCat 工作台';
    $('conn-sync-now-btn').hidden=false;
    $('conn-unlink-btn').hidden=false;
  }else{
    $('conn-address-summary').textContent='配对后，自动同步对话到本机 MemoCat 资料库';
    $('conn-primary-btn').textContent='一键连接 MemoCat 并同步';
    $('conn-sync-now-btn').hidden=true;
    $('conn-unlink-btn').hidden=true;
  }

  const maxBytes=1024*1024*1024;
  const used=state.stats.bytes||0;
  $('storage-usage').textContent=`${formatBytes(used)} / 1 GB`;
  $('storage-bar').style.width=`${Math.min(100,Math.max(used>0?1:0,(used/maxBytes)*100))}%`;
}

function appendHighlighted(container,text,query){
  const clean=String(text||'');
  const q=String(query||'').trim();
  if(!q){container.textContent=clean;return;}
  const terms=[...new Set(q.split(/\s+/).filter(Boolean))].sort((a,b)=>b.length-a.length);
  if(!terms.length){container.textContent=clean;return;}
  const esc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const re=new RegExp(terms.map(esc).join('|'),'giu');
  let last=0;
  for(const m of clean.matchAll(re)){
    if(m.index>last)container.append(document.createTextNode(clean.slice(last,m.index)));
    const mark=el('mark','cm-hit',m[0]);
    container.append(mark);
    last=m.index+m[0].length;
  }
  if(last<clean.length)container.append(document.createTextNode(clean.slice(last)));
}

async function loadList(append=false){
  const ticket=++listTicket;
  if(!append)offset=0;
  const q=$('search-input').value.trim();
  const hasFilter=Boolean(q||filter.from||filter.to||filter.platform);
  $('clear-search').hidden=!hasFilter;
  $('filter-toggle').classList.toggle('active',Boolean(filter.from||filter.to||filter.platform));

  const data=await call('list',{
    q,
    platform:filter.platform,
    from:filter.from,
    to:filter.to,
    offset
  });
  if(ticket!==listTicket)return;

  const list=$('memories-list');
  if(!append)list.replaceChildren();

  if(!data.items.length&&!append){
    const empty=el('div','cm-empty');
    empty.append(
      el('strong','',hasFilter?'没有找到匹配的对话记忆':'还没有保存任何记忆'),
      el('p','',hasFilter?'尝试更换搜索词或清空筛选条件':'访问支持的 AI 聊天页面开始记录对话')
    );
    list.append(empty);
    $('load-more').hidden=true;
    return;
  }

  for(const item of data.items){
    const isCurrent=Boolean(state?.activeId&&item.id===state.activeId);
    const card=el('div','cm-memory-card'+(isCurrent?' is-current':''));
    card.dataset.id=item.id;

    const top=el('div','cm-card-top');
    const title=el('h3','cm-card-title');
    appendHighlighted(title,item.title||'未命名对话',q);

    const actions=el('div','cm-card-actions');
    const recaptureBtn=el('button','cm-card-act');
    recaptureBtn.type='button';
    recaptureBtn.title='重新采集此对话';
    recaptureBtn.setAttribute('aria-label','重新采集此对话');
    recaptureBtn.innerHTML='<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';
    recaptureBtn.onclick=e=>{
      e.stopPropagation();
      void recaptureById(item.id,recaptureBtn);
    };

    const openBtn=el('button','cm-card-act');
    openBtn.type='button';
    openBtn.title='跳转原网页';
    openBtn.innerHTML='<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
    openBtn.onclick=e=>{
      e.stopPropagation();
      if(item.url)chrome.tabs.create({url:item.url});
    };

    const delBtn=el('button','cm-card-act danger');
    delBtn.type='button';
    delBtn.title='删除';
    delBtn.innerHTML='<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    delBtn.onclick=async e=>{
      e.stopPropagation();
      if(!await confirmDialog('确认删除','确定要删除这条对话记忆吗？已同步的桌面端副本也会一并删除。'))return;
      await call('delete',{id:item.id});
      await refresh();
      toast('已删除对话');
    };
    actions.append(recaptureBtn,openBtn,delBtn);
    top.append(title,actions);

    const summary=el('p','cm-card-summary');
    appendHighlighted(summary,item.preview||'无内容',q);

    const meta=el('div','cm-card-meta');
    const left=el('div','cm-meta-left');
    left.append(el('span','cm-platform-tag',platform(item.platform)));
    const countSpan=el('span','cm-msg-count');
    countSpan.innerHTML=`<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`;
    countSpan.append(el('span','',String(item.count||0)));
    left.append(countSpan);
    if(isCurrent){
      left.append(el('span','cm-current-badge','Current'));
    }
    meta.append(left,el('span','',formatDay(item.updatedAt)));

    card.append(top,summary,meta);
    card.onclick=()=>{void showDetail(item.id);};
    list.append(card);
  }

  offset+=data.items.length;
  $('load-more').hidden=offset>=data.total;
}

async function showDetail(id){
  const ticket=++detailTicket;
  const c=await call('read',{id});
  if(ticket!==detailTicket)return;
  if(!c){
    toast('该对话已不存在');
    await refresh();
    return;
  }
  currentId=c.id;
  currentConversation=c;
  cancelTitleEdit();

  $('detail-title').textContent=c.title||'未命名对话';
  $('detail-platform').textContent=platform(c.platform);
  $('detail-count').textContent=String(c.messages.length);
  $('detail-updated').textContent=formatDay(c.updatedAt);
  $('detail-current-badge').hidden=!(state?.activeId&&state.activeId===c.id);

  const container=$('detail-messages');
  container.replaceChildren();
  const q=$('search-input').value.trim();

  let qNum=0;
  for(const m of c.messages){
    const isUser=m.role==='user';
    const card=el('article','cm-msg-card '+(isUser?'user':'ai'));
    const head=el('div','cm-msg-head'),headLeft=el('div','cm-msg-head-left');
    headLeft.append(
      el('span','cm-msg-sender',isUser?`提问 #${++qNum}`:'AI 回复'),
      el('span','cm-msg-time',formatDateTime(m.at||c.updatedAt))
    );
    const copySingle=el('button','cm-msg-copy','复制');
    copySingle.type='button';
    copySingle.onclick=async()=>{
      await navigator.clipboard.writeText(m.text||'');
      toast('已复制该条消息');
    };
    head.append(headLeft,copySingle);

    const needsCollapse=!q&&m.text.length>260;
    const body=el('div','cm-msg-body'+(needsCollapse?' collapsed':''));
    appendHighlighted(body,m.text,q);
    card.append(head,body);

    if(needsCollapse){
      const toggle=el('button','cm-expand-btn');
      toggle.type='button';
      toggle.innerHTML='<span>展开全文</span> <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
      toggle.onclick=()=>{
        const collapsed=body.classList.toggle('collapsed');
        toggle.querySelector('span').textContent=collapsed?'展开全文':'收起';
      };
      card.append(toggle);
    }
    container.append(card);
  }

  switchTab('detail');
  container.scrollTop=0;
}

$('detail-back').onclick=()=>switchTab('memories');

function startTitleEdit(){
  if(!currentConversation)return;
  $('detail-title-input').value=currentConversation.title||'';
  $('detail-title').hidden=true;
  $('detail-title-input').hidden=false;
  $('detail-title-input').focus();
  $('detail-title-input').select();
}
function cancelTitleEdit(){
  $('detail-title-input').hidden=true;
  $('detail-title').hidden=false;
}
async function saveTitleEdit(){
  if($('detail-title-input').hidden||!currentConversation)return;
  const nextTitle=$('detail-title-input').value.trim();
  if(!nextTitle||nextTitle===currentConversation.title){
    cancelTitleEdit();
    return;
  }
  try{
    const updated=await call('rename',{id:currentConversation.id,title:nextTitle});
    currentConversation=updated;
    $('detail-title').textContent=updated.title;
    cancelTitleEdit();
    toast('已更新标题');
  }catch(e){
    toast(e.message);
  }
}
$('detail-edit-title').onclick=()=>{
  if(!$('detail-title-input').hidden)void saveTitleEdit();
  else startTitleEdit();
};
$('detail-title').ondblclick=startTitleEdit;
$('detail-title-input').onkeydown=e=>{
  if(e.key==='Enter'){e.preventDefault();void saveTitleEdit();}
  if(e.key==='Escape'){e.preventDefault();cancelTitleEdit();}
};
$('detail-title-input').onblur=()=>{void saveTitleEdit();};

$('detail-copy-inline').onclick=async()=>{
  if(!currentConversation)return;
  await navigator.clipboard.writeText(MemoCore.markdown(currentConversation));
  toast('已复制对话内容');
};
$('detail-recapture-btn').onclick=()=>{
  if(currentConversation)void recaptureById(currentConversation.id,$('detail-recapture-btn'));
};
$('detail-recapture').onclick=()=>{
  $('detail-more-menu').hidden=true;
  if(currentConversation)void recaptureById(currentConversation.id,$('detail-recapture-btn'));
};
$('detail-more-btn').onclick=e=>{
  e.stopPropagation();
  $('detail-more-menu').hidden=!$('detail-more-menu').hidden;
};
$('detail-copy').onclick=async()=>{
  $('detail-more-menu').hidden=true;
  if(!currentConversation)return;
  await navigator.clipboard.writeText(MemoCore.markdown(currentConversation));
  toast('已复制对话内容');
};
$('detail-copy-prompt').onclick=async()=>{
  $('detail-more-menu').hidden=true;
  if(!currentConversation)return;
  await navigator.clipboard.writeText(formatPromptText(currentConversation));
  toast('已复制为上下文 Prompt');
};
$('detail-open-origin').onclick=()=>{
  $('detail-more-menu').hidden=true;
  if(currentConversation?.url)chrome.tabs.create({url:currentConversation.url});
};
$('detail-export-md').onclick=()=>{
  $('detail-more-menu').hidden=true;
  if(!currentConversation)return;
  const safe=(currentConversation.title||'conversation').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,80);
  download(MemoCore.markdown(currentConversation),`${safe}.md`,'text/markdown');
  toast('已导出 Markdown');
};
$('detail-delete').onclick=async()=>{
  $('detail-more-menu').hidden=true;
  if(!currentConversation)return;
  if(!await confirmDialog('确认删除','确定要删除这条对话记忆吗？已同步的桌面端副本也会一并删除。'))return;
  await call('delete',{id:currentConversation.id});
  toast('已删除对话');
  switchTab('memories');
};

$('search-input').oninput=()=>{
  clearTimeout(searchTimer);
  searchTimer=setTimeout(()=>{void loadList().catch(e=>toast(e.message));},160);
};
$('clear-search').onclick=()=>{
  $('search-input').value='';
  filter={from:'',to:'',platform:'',quick:''};
  $('filter-from').value='';
  $('filter-to').value='';
  $('filter-platform').value='';
  updateQuickButtons();
  updateSidebarPillActive();
  void loadList().catch(e=>toast(e.message));
};
$('filter-toggle').onclick=e=>{
  e.stopPropagation();
  $('filter-dropdown').hidden=!$('filter-dropdown').hidden;
};
$('filter-dropdown').onclick=e=>e.stopPropagation();

function setQuickRange(days,tag){
  const end=new Date(),start=new Date();
  start.setDate(end.getDate()-days);
  const fmt=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  $('filter-from').value=fmt(start);
  $('filter-to').value=fmt(end);
  filter.quick=tag;
  updateQuickButtons();
}
function updateQuickButtons(){
  $('date-week').classList.toggle('active',filter.quick==='week');
  $('date-month').classList.toggle('active',filter.quick==='month');
}
$('date-week').onclick=()=>setQuickRange(7,'week');
$('date-month').onclick=()=>setQuickRange(30,'month');
$('apply-filter').onclick=()=>{
  const from=$('filter-from').value,to=$('filter-to').value;
  if(from&&to&&from>to){toast('开始日期不能晚于结束日期');return;}
  filter.from=from;
  filter.to=to;
  filter.platform=$('filter-platform').value;
  updateSidebarPillActive();
  $('filter-dropdown').hidden=true;
  void loadList().catch(e=>toast(e.message));
};
$('reset-filter').onclick=()=>{
  filter={from:'',to:'',platform:'',quick:''};
  $('filter-from').value='';
  $('filter-to').value='';
  $('filter-platform').value='';
  updateQuickButtons();
  updateSidebarPillActive();
  $('filter-dropdown').hidden=true;
  void loadList().catch(e=>toast(e.message));
};
$('load-more').onclick=()=>{void loadList(true).catch(e=>toast(e.message));};

$('conn-primary-btn').onclick=async()=>{
  const btn=$('conn-primary-btn');
  const sync=state?.settings?.sync;
  const connected=Boolean(sync?.enabled&&sync?.token);
  btn.disabled=true;
  try{
    if(connected){
      await call('sync').catch(()=>{});
      await refreshState();
      chrome.tabs.create({url:sync.url+'/#pipeline'});
    }else{
      const url=$('conn-url-input').value.trim();
      const res=await call('connect',{url});
      await refreshState();
      toast(`已连接 MemoCat 并同步 ${res.syncState.sent||0} 项`);
    }
  }catch(e){
    toast(e.message);
  }finally{
    btn.disabled=false;
  }
};
$('conn-sync-now-btn').onclick=async()=>{
  $('conn-sync-now-btn').disabled=true;
  try{
    const r=await call('sync');
    await refreshState();
    toast(`已同步 ${r.sent||0} 项变更`);
  }catch(e){
    toast(e.message);
  }finally{
    $('conn-sync-now-btn').disabled=false;
  }
};
$('conn-unlink-btn').onclick=async()=>{
  if(!await confirmDialog('解除桌面端配对','解除配对后，插件与桌面端已有的数据都会保留。确定解除？','解除配对'))return;
  await call('disconnect');
  await refreshState();
  toast('已断开与桌面端的连接');
};

$('auto-save-toggle').onchange=async()=>{
  const checked=$('auto-save-toggle').checked;
  try{
    await call('settings',{patch:{autoSave:checked}});
    await refreshState();
    toast(checked?'已开启自动保存':'已暂停自动保存');
  }catch(e){
    $('auto-save-toggle').checked=!checked;
    toast(e.message);
  }
};
$('capture-active-btn').onclick=async()=>{
  $('capture-active-btn').disabled=true;
  try{
    const r=await call('captureActive');
    if(r.error)throw new Error(r.error);
    toast(r.paused?'当前平台已停用或未开启':r.suppressed?'此对话已删除':r.busy?'正在保存，请稍候':`已保存 ${r.count||0} 条消息`);
    await refresh();
  }catch(e){
    toast(e.message);
  }finally{
    $('capture-active-btn').disabled=false;
  }
};
$('export-btn').onclick=e=>{
  e.stopPropagation();
  $('export-menu').hidden=!$('export-menu').hidden;
};
$('export-json').onclick=async()=>{
  $('export-menu').hidden=true;
  const backup=await call('export');
  download(JSON.stringify(backup,null,2),`memocat-${new Date().toISOString().slice(0,10)}.json`,'application/json');
  toast(`已导出 ${backup.conversations.length} 段对话`);
};
$('export-md').onclick=async()=>{
  $('export-menu').hidden=true;
  const backup=await call('export');
  const md=backup.conversations.map(c=>MemoCore.markdown(c)).join('\n\n====================\n\n');
  download(md||'# MemoCat 空导出\n',`memocat-${new Date().toISOString().slice(0,10)}.md`,'text/markdown');
  toast(`已合并导出 ${backup.conversations.length} 段对话`);
};
$('clear-all-btn').onclick=async()=>{
  if(!await confirmDialog('确认清空所有数据？','此操作将清空插件保存的全部对话记录（已开启桌面同步时也会同步删除）。建议先导出备份。','确认清空'))return;
  await call('clear');
  await refresh();
  toast('已清空全部记录');
};
$('import-backup-btn').onclick=()=>$('import-backup-file').click();
$('import-backup-file').onchange=async()=>{
  const file=$('import-backup-file').files[0];
  if(!file)return;
  try{
    const backup=JSON.parse(await file.text());
    const count=await call('import',{backup});
    await refresh();
    toast(`已合并导入 ${count} 段对话`);
  }catch(e){
    toast(e.message||'备份文件格式无效');
  }finally{
    $('import-backup-file').value='';
  }
};

document.addEventListener('click',()=>{
  $('detail-more-menu').hidden=true;
  $('export-menu').hidden=true;
  $('filter-dropdown').hidden=true;
});

async function refresh(){
  await refreshState();
  if(!$('tab-panel-memories').hidden){
    await loadList();
  }else if(!$('tab-panel-detail').hidden&&currentId){
    await showDetail(currentId);
  }
}

chrome.storage.onChanged.addListener((changes,area)=>{
  if(area==='local'&&(changes.lastChangeAt||changes.syncState||changes.settings)){
    void refresh().catch(()=>{});
  }
});

void refresh().catch(e=>toast(e.message));
