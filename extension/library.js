import {call,element as el,download,platform,date,initTheme,themeLabels} from './ui-api.js';
const $=id=>document.getElementById(id);
let state,selected=null,current=null,offset=0,listing=0,reading=0,loadTimer,quickRange='';

const themeApi=initTheme((pref,effective)=>{
  const label=$('library-theme-label');
  if(label)label.textContent=themeLabels[pref];
  const select=$('library-theme-select');
  if(select&&select.value!==pref)select.value=pref;
  const icon=$('library-theme-toggle')?.querySelector('.theme-icon');
  if(icon){
    icon.innerHTML=effective==='dark'
      ?'<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'
      :'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41"/>';
  }
});

$('library-theme-toggle').onclick=async()=>{
  const next=await themeApi.cycle();
  toast(`外观已切换为：${themeLabels[next.pref]}`);
};
$('library-theme-select').onchange=async e=>{
  await themeApi.set(e.target.value);
  toast(`外观已切换为：${themeLabels[e.target.value]}`);
};

const toast=message=>{
  $('toast').textContent=message;
  $('toast').hidden=false;
  clearTimeout(toast.timer);
  toast.timer=setTimeout(()=>{$('toast').hidden=true;},4500);
};

async function action(button,fn){
  if(button)button.disabled=true;
  try{return await fn();}
  catch(e){toast(e.message);}
  finally{if(button)button.disabled=false;}
}

function formatBytes(bytes){
  if(!Number.isFinite(bytes)||bytes<=0)return '0 B';
  if(bytes<1024)return bytes+' B';
  if(bytes<1048576)return (bytes/1024).toFixed(2)+' KB';
  return (bytes/1048576).toFixed(2)+' MB';
}

function formatDay(iso){
  if(!iso)return '';
  const d=new Date(iso);
  if(Number.isNaN(d.getTime()))return '';
  return d.toLocaleDateString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit'});
}

function formatPromptText(c){
  let qNum=0;
  const turns=c.messages.map(m=>`${m.role==='user'?`[提问 #${++qNum}]`:'[AI 回复]'}\n${m.text}`).join('\n\n');
  return `以下是来自 MemoCat 扩展的对话上下文（平台：${platform(c.platform)}）：\n\n<conversation_context title="${c.title||'未命名对话'}" url="${c.url||''}">\n${turns}\n</conversation_context>\n\n请基于以上上下文继续协助我：`;
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
    container.append(el('mark','search-hit',m[0]));
    last=m.index+m[0].length;
  }
  if(last<clean.length)container.append(document.createTextNode(clean.slice(last)));
}

let currentPage='library';
function route(){
  const raw=location.hash.slice(1);
  const page=['connections','settings'].includes(raw)?raw:'library';
  currentPage=page;
  $('archive').hidden=page!=='library';
  $('connections').hidden=page!=='connections';
  $('settings').hidden=page!=='settings';
  const titles={library:'对话工作台',connections:'采集与桌面同步',settings:'存储与设置'};
  $('page-title').textContent=titles[page];
  for(const a of document.querySelectorAll('[data-nav]')){
    const active=a.dataset.nav===page;
    a.classList.toggle('active',active);
    if(active)a.setAttribute('aria-current','page');
    else a.removeAttribute('aria-current');
  }
}
window.addEventListener('hashchange',route);
route();

async function refreshState(){
  state=await call('state');
  const {conversations=0,todayNew=0,messages=0,platforms=0,bytes=0}=state.stats||{};
  $('summary').textContent=`${conversations} 段对话 · ${messages} 条消息 · ${platforms} 个平台`;
  $('nav-count').textContent=String(conversations);
  $('stat-conversations').textContent=String(conversations);
  $('stat-today').textContent=String(todayNew);
  $('stat-messages').textContent=String(messages);
  $('stat-storage').textContent=formatBytes(bytes);

  const autoSave=Boolean(state.settings.autoSave);
  $('capture-status').textContent=autoSave?'● 自动保存已开启':'手动保存';
  $('capture-status').classList.toggle('active',autoSave);
  $('auto-save').checked=autoSave;
  $('platform-global-paused').hidden=autoSave;
  $('extension-id').value=state.extensionId||'';
  $('about-version').textContent=state.version||'0.5.0';
  $('sidebar-version').textContent=`MemoCat · ${state.version||'0.5.0'}`;
  syncPlatformFilter(state.platformCounts||{});

  for(const input of document.querySelectorAll('[data-platform]')){
    const pid=input.dataset.platform;
    const enabled=state.settings.platforms[pid]!==false;
    input.checked=enabled;
    input.closest('.platform-card')?.classList.toggle('is-off',!enabled);
  }

  const s=state.settings.sync||{};
  const v=state.syncState||{};
  const connected=Boolean(s.enabled&&s.token);
  if(document.activeElement!==$('sync-url'))$('sync-url').value=s.url||'http://127.0.0.1:3792';
  $('sync-token').value=s.token||'';
  $('sync-enabled').checked=Boolean(s.enabled);
  $('conn-saved-count').textContent=`已保存 ${conversations} 段对话`;
  $('connect-app').textContent=connected?'重新连接并同步':'一键连接 MemoCat 并同步';
  $('open-desktop-web').hidden=!connected;
  $('disconnect-app').hidden=!connected&&!s.enabled;
  $('sync-badge').textContent=connected?'● 已连接':'待连接';
  $('nav-sync-dot').classList.toggle('connected',connected);
  $('sidebar-sync-tag').textContent=connected?'● 已连接桌面端':'● 本地存储';
  $('sidebar-sync-desc').textContent=connected
    ? `正在与 ${s.url} 自动同步对话。`
    : '所有 AI 对话均保存在这台电脑中，支持随时导出与桌面端同步。';
  $('sync-state').textContent=!s.enabled
    ? '同步未开启（点击「一键连接 MemoCat 并同步」即可自动配对）'
    : v.error
      ? `同步失败：${v.error} · ${v.pending||0} 项待交接`
      : v.lastSync
        ? `已连接 ${s.url} · 上次同步 ${date(v.lastSync)} · ${v.pending||0} 项待交接`
        : `已连接 ${s.url} · ${v.pending||0} 项等待交接`;

  const maxBytes=1024*1024*1024;
  $('settings-storage-usage').textContent=`${formatBytes(bytes)} / 1 GB`;
  $('settings-storage-fill').style.width=`${Math.min(100,Math.max(bytes>0?1:0,(bytes/maxBytes)*100))}%`;
}

async function list(append=false){
  const request=++listing;
  if(!append)offset=0;
  const from=$('from').value,to=$('to').value,q=$('search').value.trim();
  if(from&&to&&from>to){toast('开始日期不能晚于结束日期');return;}
  $('date-filter-badge').hidden=!from&&!to;

  const data=await call('list',{q,platform:$('platform-filter').value,from,to,offset});
  if(request!==listing)return;
  if(!append)$('conversation-list').replaceChildren();
  $('result-count').textContent=`${data.total} 段对话`;

  if(!data.items.length&&!append){
    const empty=el('div','list-empty');
    empty.append(
      el('strong','',q||from||to||$('platform-filter').value?'没有找到匹配的对话':'资料库还是空的'),
      el('p','','在支持的 AI 对话页点击右上角胶囊保存，或导入已有备份。')
    );
    $('conversation-list').append(empty);
  }

  for(const c of data.items){
    const isSelected=c.id===selected;
    const isCurrent=Boolean(state?.activeId&&state.activeId===c.id);
    const button=el('button','conversation'+(isSelected?' selected':''));
    button.dataset.id=c.id;
    button.setAttribute('aria-pressed',String(isSelected));

    const titleNode=el('strong','');
    appendHighlighted(titleNode,c.title||'未命名对话',q);

    const previewNode=el('p','');
    appendHighlighted(previewNode,c.preview||'无内容',q);

    const metaRow=el('div','conv-card-meta');
    const metaLeft=el('div','conv-meta-left');
    const pBadge=el('span','platform-label');
    const pIcon=el('img');
    pIcon.src=`icons/platforms/${c.platform}.png`;
    pIcon.alt='';
    pBadge.append(pIcon,document.createTextNode(platform(c.platform)));

    const msgBadge=el('span','conv-msg-badge',`💬 ${c.count}`);
    metaLeft.append(pBadge,msgBadge);
    if(isCurrent){
      metaLeft.append(el('span','conv-current-tag','Current'));
    }
    metaRow.append(metaLeft,el('span','',formatDay(c.updatedAt)));

    button.append(titleNode,previewNode,metaRow);
    button.onclick=()=>{void show(c.id).catch(e=>toast(e.message));};
    $('conversation-list').append(button);
  }

  offset+=data.items.length;
  $('more').hidden=offset>=data.total;
}

async function show(id){
  const request=++reading,c=await call('read',{id});
  if(request!==reading)return;
  if(!c){toast('该会话已不存在');await refresh();return;}
  selected=id;
  current=c;
  for(const b of document.querySelectorAll('.conversation')){
    b.classList.toggle('selected',b.dataset.id===id);
    b.setAttribute('aria-pressed',String(b.dataset.id===id));
  }

  const header=el('header','detail-header');
  const pTag=el('span','platform-label');
  const pImg=el('img');
  pImg.src=`icons/platforms/${c.platform}.png`;
  pImg.alt='';
  pTag.append(pImg,document.createTextNode(platform(c.platform)));

  const titleBar=el('div','detail-title-bar');
  const h2=el('h2','',c.title||'未命名对话');
  h2.title='双击修改对话标题';
  const titleInput=el('input','detail-title-input');
  titleInput.type='text';
  titleInput.value=c.title||'';
  titleInput.hidden=true;
  const editBtn=el('button','secondary','修改标题');
  editBtn.type='button';

  const saveTitle=async()=>{
    if(titleInput.hidden)return;
    const next=titleInput.value.trim();
    titleInput.hidden=true;
    h2.hidden=false;
    editBtn.textContent='修改标题';
    if(!next||next===c.title)return;
    const updated=await call('rename',{id:c.id,title:next});
    current=updated;
    h2.textContent=updated.title;
    await list();
    toast('已更新对话标题');
  };
  const startEdit=()=>{
    titleInput.value=current.title||'';
    h2.hidden=true;
    titleInput.hidden=false;
    editBtn.textContent='保存标题';
    titleInput.focus();
    titleInput.select();
  };
  h2.ondblclick=startEdit;
  editBtn.onclick=()=>{if(titleInput.hidden)startEdit();else void action(editBtn,saveTitle);};
  titleInput.onkeydown=e=>{
    if(e.key==='Enter'){e.preventDefault();void saveTitle();}
    if(e.key==='Escape'){e.preventDefault();titleInput.hidden=true;h2.hidden=false;editBtn.textContent='修改标题';}
  };
  titleBar.append(h2,titleInput);

  const metaBar=el('div','detail-meta-bar');
  const metaInfo=el('div','detail-meta-info');
  metaInfo.append(pTag,el('span','',`${c.messages.length} 条消息 · 保存于 ${date(c.updatedAt)}`));

  const actions=el('div','actions');
  const copyPrompt=el('button','primary','复制为 Prompt');
  copyPrompt.type='button';
  copyPrompt.id='detail-copy-prompt';
  const recapture=el('button','secondary','重新采集');
  recapture.type='button';
  recapture.id='detail-recapture';
  const source=el('a','secondary','原对话 ↗');
  source.href=c.url;
  source.target='_blank';
  source.rel='noopener noreferrer';
  const copy=el('button','secondary','复制');
  const md=el('button','secondary','Markdown');
  const json=el('button','secondary','JSON');
  const remove=el('button','danger-text','删除');
  copyPrompt.onclick=()=>action(copyPrompt,async()=>{await navigator.clipboard.writeText(formatPromptText(current));toast('已复制为上下文 Prompt');});
  recapture.onclick=()=>action(recapture,async()=>{
    recapture.textContent='采集中…';
    try{
      const r=await call('recapture',{id:current.id});
      if(r?.captured){
        await refresh();
        toast(`已重新采集 ${r.count||0} 条消息`);
      }else if(r?.opened){
        toast('已打开原对话页面，待页面加载完成后可再次点击重新采集');
      }
    }finally{
      recapture.textContent='重新采集';
    }
  });
  copy.onclick=()=>action(copy,async()=>{await navigator.clipboard.writeText(MemoCore.markdown(current));toast('已复制对话');});
  md.onclick=()=>download(MemoCore.markdown(current),filename(current.title)+'.md','text/markdown');
  json.onclick=()=>action(json,()=>exportBackup([current.id]));
  remove.onclick=()=>action(remove,async()=>{
    if(!await confirm('删除这段对话？','将删除扩展中的记录，并停止自动重新采集此对话。已开启同步时，也会删除本地应用中对应的副本。原 AI 网站不受影响。'))return;
    await call('delete',{id:current.id});
    selected=null;
    current=null;
    ++reading;
    $('detail').replaceChildren(el('div','empty','对话已删除。选择左侧另一条记录继续阅读。'));
    await refresh();
    toast('对话已删除');
  });
  actions.append(copyPrompt,editBtn,recapture,source,copy,md,json,remove);
  metaBar.append(metaInfo,actions);
  header.append(titleBar,metaBar);
  $('detail').replaceChildren(header);

  const q=$('search').value.trim();
  const messages=el('div','messages');
  let qNum=0;
  for(const m of c.messages){
    const isUser=m.role==='user';
    const row=el('section','message '+m.role);
    const avatar=el('span','message-avatar',isUser?'你':'AI');
    avatar.setAttribute('aria-hidden','true');
    const bubbleWrap=el('div','message-bubble');
    const head=el('div','message-head'),headLeft=el('div','message-head-left');
    headLeft.append(
      el('div','message-label',isUser?`提问 #${++qNum}`:`${platform(c.platform)} 回复`),
      el('span','message-time',date(m.at||c.updatedAt))
    );
    const msgCopy=el('button','msg-copy-btn','复制');
    msgCopy.type='button';
    msgCopy.onclick=()=>action(msgCopy,async()=>{await navigator.clipboard.writeText(m.text||'');toast('已复制该条内容');});
    head.append(headLeft,msgCopy);

    const bubble=el('div','message-body');
    const needsCollapse=!q&&m.text.length>600;
    const textNode=el('div','message-text'+(needsCollapse?' collapsed':''));
    appendHighlighted(textNode,m.text,q);
    bubble.append(textNode);

    if(needsCollapse){
      const expandBtn=el('button','msg-expand-btn','展开全文 ⌄');
      expandBtn.type='button';
      expandBtn.onclick=()=>{
        const collapsed=textNode.classList.toggle('collapsed');
        expandBtn.textContent=collapsed?'展开全文 ⌄':'收起 ⌃';
      };
      bubble.append(expandBtn);
    }
    bubbleWrap.append(head,bubble);
    row.append(avatar,bubbleWrap);
    messages.append(row);
  }
  $('detail').append(messages);
  $('detail').scrollTop=0;
}

function filename(value){
  return value.replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,100)||'conversation';
}

async function exportBackup(ids){
  const backup=await call('export',{ids});
  download(JSON.stringify(backup,null,2),'memocat-'+new Date().toISOString().slice(0,10)+'.json');
  toast(`已导出 ${backup.conversations.length} 段对话`);
}

async function exportMarkdownAll(){
  const backup=await call('export');
  const md=backup.conversations.map(c=>MemoCore.markdown(c)).join('\n\n====================\n\n');
  download(md||'# MemoCat 空导出\n','memocat-'+new Date().toISOString().slice(0,10)+'.md','text/markdown');
  toast(`已合并导出 ${backup.conversations.length} 段对话`);
}

function confirm(title,description){
  $('confirm-title').textContent=title;
  $('confirm-description').textContent=description;
  const dialog=$('confirm-dialog');
  dialog.querySelector('[value=confirm]').textContent=title.includes('导入')?'确认导入':'确认删除';
  dialog.returnValue='';
  dialog.showModal();
  return new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'),{once:true}));
}

async function refresh(){
  await refreshState();
  await list();
  if(current)await show(current.id);
}

// 平台快速筛选胶囊与下拉同步
let lastPlatformFilterSig=null;
function renderLibraryPlatformPills(active,counts){
  const host=$('library-platform-pills');
  if(!host)return;
  const val=$('platform-filter').value||'';
  host.replaceChildren();
  if(!active.length)return;
  const totalCount=active.reduce((s,p)=>s+(counts[p.id]||0),0);
  const makePill=(pid,text)=>{
    const btn=el('button','platform-pill'+(val===pid?' active':''),text);
    btn.type='button';
    btn.dataset.platform=pid;
    btn.onclick=()=>{
      $('platform-filter').value=pid;
      updateLibraryPillActive();
      void list().catch(e=>toast(e.message));
    };
    return btn;
  };
  host.append(makePill('',`全部 (${totalCount})`));
  for(const p of active)host.append(makePill(p.id,`${p.name} (${counts[p.id]||0})`));
}
function updateLibraryPillActive(){
  const val=$('platform-filter').value||'';
  for(const btn of document.querySelectorAll('#library-platform-pills .platform-pill')){
    btn.classList.toggle('active',(btn.dataset.platform||'')===val);
  }
}
function syncPlatformFilter(counts={}){
  const active=MemoCore.platforms.filter(p=>(counts[p.id]||0)>0);
  const sig=active.map(p=>`${p.id}:${counts[p.id]}`).join(',');
  if(sig===lastPlatformFilterSig)return;
  lastPlatformFilterSig=sig;
  const select=$('platform-filter'),prev=select.value;
  const allOpt=el('option','','全部平台');allOpt.value='';
  select.replaceChildren(allOpt);
  for(const p of active){
    const option=el('option','',p.name);
    option.value=p.id;
    select.append(option);
  }
  if(prev&&active.some(p=>p.id===prev))select.value=prev;
  else if(prev){select.value='';void list().catch(e=>toast(e.message));}
  renderLibraryPlatformPills(active,counts);
}

for(const p of MemoCore.platforms){
  const row=el('label','platform-card');
  const info=el('span','platform-card-info');
  const logo=el('img','platform-card-logo');
  logo.src=`icons/platforms/${p.id}.png`;
  logo.alt='';
  const text=el('span','platform-card-text');
  text.append(el('strong','',p.name),el('small','',new URL(p.url).hostname));
  info.append(logo,text);

  const input=el('input');
  input.type='checkbox';
  input.dataset.platform=p.id;
  input.setAttribute('role','switch');
  input.setAttribute('aria-label',p.name+' 采集');
  input.onchange=()=>action(input,async()=>{
    const old=state.settings.platforms[p.id];
    try{
      await call('settings',{patch:{platforms:{[p.id]:input.checked}}});
      await refreshState();
    }catch(e){
      input.checked=old;
      throw e;
    }
  });
  row.append(info,input);
  $('platform-settings').append(row);
}

function applyQuickDays(days,tag){
  if(!days){
    $('from').value='';
    $('to').value='';
    quickRange='';
  }else{
    const end=new Date(),start=new Date();
    start.setDate(end.getDate()-days);
    const fmt=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    $('from').value=fmt(start);
    $('to').value=fmt(end);
    quickRange=tag;
  }
  $('quick-week').classList.toggle('active',quickRange==='week');
  $('quick-month').classList.toggle('active',quickRange==='month');
  void list().catch(e=>toast(e.message));
}
$('quick-week').onclick=()=>applyQuickDays(7,'week');
$('quick-month').onclick=()=>applyQuickDays(30,'month');
$('quick-clear').onclick=()=>applyQuickDays(0,'');

$('auto-save').onchange=()=>action($('auto-save'),async()=>{
  try{await call('settings',{patch:{autoSave:$('auto-save').checked}});}
  finally{await refreshState();}
});
$('sync-form').onsubmit=e=>{
  e.preventDefault();
  void action(e.submitter||$('connect-app'),async()=>{
    const result=await call('connect',{url:$('sync-url').value.trim()});
    await refreshState();
    toast(`已连接 MemoCat 并交接 ${result.syncState.sent} 项变更`);
  });
};
$('open-desktop-web').onclick=()=>{
  const url=state?.settings?.sync?.url||'http://127.0.0.1:3792';
  chrome.tabs.create({url:url+'/#pipeline'});
};
$('sync-enabled').onchange=()=>action($('sync-enabled'),async()=>{
  const enabled=$('sync-enabled').checked;
  try{
    if(enabled){
      const result=await call('connect',{url:$('sync-url').value.trim()});
      toast(`已开启同步并交接 ${result.syncState.sent} 项变更`);
    }else{
      await call('settings',{patch:{sync:{enabled:false,url:$('sync-url').value.trim(),token:state.settings.sync.token}}});
      toast('已暂停后台同步');
    }
  }finally{
    await refreshState();
  }
});
$('disconnect-app').onclick=()=>action($('disconnect-app'),async()=>{
  await call('disconnect');
  await refreshState();
  toast('已断开与本地应用的连接');
});
$('sync-now').onclick=()=>action($('sync-now'),async()=>{
  const s=state.settings.sync;
  const result=!s.enabled||!s.token?(await call('connect',{url:$('sync-url').value.trim()})).syncState:await call('sync');
  await refreshState();
  toast(`已交接 ${result.sent} 项变更`);
});
$('clear').onclick=()=>action($('clear'),async()=>{
  if(!await confirm('清空整个资料库？','全部对话会从扩展资料库删除。已开启同步时，删除操作也会同步到当前本地应用。请先下载备份；原 AI 网站不受影响。'))return;
  await call('clear');
  selected=null;
  current=null;
  ++reading;
  $('detail').replaceChildren(el('div','empty','资料库已清空。'));
  await refresh();
  toast('已清空资料库');
});
$('search').oninput=()=>{
  clearTimeout(loadTimer);
  loadTimer=setTimeout(()=>{void list().catch(e=>toast(e.message));},180);
};
for(const id of ['platform-filter','from','to']){
  $(id).onchange=()=>{
    if(id==='from'||id==='to'){
      quickRange='';
      $('quick-week').classList.remove('active');
      $('quick-month').classList.remove('active');
    }else{
      updateLibraryPillActive();
    }
    void list().catch(e=>toast(e.message));
  };
}
$('more').onclick=()=>action($('more'),()=>list(true));
$('refresh').onclick=()=>action($('refresh'),refresh);
for(const id of ['export-all','settings-export'])$(id).onclick=()=>action($(id),()=>exportBackup());
$('settings-export-md').onclick=()=>action($('settings-export-md'),exportMarkdownAll);
for(const id of ['import','settings-import'])$(id).onclick=()=>$('import-file').click();
$('import-file').onchange=async()=>{
  const file=$('import-file').files[0];
  if(!file)return;
  await action($('import'),async()=>{
    if(file.size>64*1024*1024)throw new Error('备份超过 64 MiB，请拆分后导入');
    const backup=JSON.parse(await file.text());
    if(!await confirm('合并导入备份？','将校验备份，并保留资料库已有记录。相同消息 ID 的正文可能更新；新消息会追加。'))return;
    const count=await call('import',{backup});
    await refresh();
    toast(`已合并 ${count} 段对话`);
  });
  $('import-file').value='';
};

chrome.storage.onChanged.addListener((changes,area)=>{
  if(area==='local'&&(changes.lastChangeAt||changes.syncState||changes.settings)){
    void refresh().catch(()=>{});
  }
});

document.addEventListener('keydown',event=>{
  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){
    event.preventDefault();
    location.hash='#library';
    $('search').focus();
    return;
  }
  if(currentPage==='library'&&(event.key==='ArrowDown'||event.key==='ArrowUp')&&!event.metaKey&&!event.ctrlKey&&!event.altKey){
    const tag=document.activeElement?.tagName;
    if(tag==='TEXTAREA'||tag==='SELECT'||document.querySelector('dialog[open]'))return;
    const cards=[...document.querySelectorAll('#conversation-list .conversation')];
    if(!cards.length)return;
    event.preventDefault();
    const idx=cards.findIndex(c=>c.dataset.id===selected);
    const nextIdx=event.key==='ArrowDown'?(idx<cards.length-1?idx+1:0):(idx>0?idx-1:cards.length-1);
    const nextCard=cards[nextIdx];
    if(nextCard){
      nextCard.scrollIntoView({block:'nearest'});
      void show(nextCard.dataset.id);
    }
  }
});

void refresh().catch(e=>{$('summary').textContent='无法打开资料库：'+e.message;toast(e.message);});
