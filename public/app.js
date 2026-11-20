import {marked} from './marked.js';
import DOMPurify from './purify.js';
import {visibleConversationText,pastedDocuments} from './display-text.js';

const $=s=>document.querySelector(s), el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
let outlineObserver;
let scheduleDirty=false,schedulePending=false;
let state, selected, offset=0, query='', processId, busy=false, lastRecallResult=null;
const keywords=[];
const THEME_KEY='memocat-theme';
const themeLabels={system:'系统',light:'浅色',dark:'深色'};
const names={'claude-code':'Claude Code',codex:'Codex','grok-bot':'Grok Bot',antigravity:'Antigravity',demo:'演示数据','other-local':'其他本机 AI',preview:'沙盒测试'};
const browserNames={chatgpt:'ChatGPT',claude:'Claude',gemini:'Gemini',deepseek:'DeepSeek',yuanbao:'腾讯元宝',doubao:'豆包',kimi:'Kimi',qianwen:'千问',grok:'Grok'};
const isBrowserSource=s=>typeof s==='string'&&s.startsWith('browser-');
const sourcePlainName=s=>isBrowserSource(s)?(browserNames[s.slice(8)]||s.slice(8)):(names[s]||s);

/* Theme Management */
const darkMedia=window.matchMedia('(prefers-color-scheme: dark)');
function readThemePref(){
  try{
    const val=localStorage.getItem(THEME_KEY);
    return ['system','light','dark'].includes(val)?val:'system';
  }catch{return 'system';}
}
function applyTheme(pref){
  const valid=['system','light','dark'].includes(pref)?pref:'system';
  const effective=valid==='system'?(darkMedia.matches?'dark':'light'):valid;
  document.documentElement.dataset.theme=effective;
  document.documentElement.style.colorScheme=effective;
  const label=$('#theme-toggle-label');
  if(label)label.textContent=themeLabels[valid];
  const toggleBtn=$('#theme-toggle');
  if(toggleBtn){
    toggleBtn.title=`当前主题：${themeLabels[valid]}（点击切换）`;
    const icon=toggleBtn.querySelector('.theme-icon');
    if(icon){
      icon.innerHTML=effective==='dark'
        ?'<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'
        :'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41"/>';
    }
  }
  const select=$('#theme-select');
  if(select&&select.value!==valid)select.value=valid;
}
function setThemePref(pref){
  try{localStorage.setItem(THEME_KEY,pref);}catch{}
  applyTheme(pref);
}
applyTheme(readThemePref());
darkMedia.addEventListener('change',()=>{if(readThemePref()==='system')applyTheme('system');});
$('#theme-toggle')?.addEventListener('click',()=>{
  const order=['system','light','dark'];
  const next=order[(order.indexOf(readThemePref())+1)%order.length];
  setThemePref(next);
  toast(`外观已切换为：${themeLabels[next]}`);
});
$('#theme-select')?.addEventListener('change',e=>{
  setThemePref(e.target.value);
  toast(`外观已切换为：${themeLabels[e.target.value]}`);
});

function webIcon(){
  const w=el('span','web-source-icon');
  w.setAttribute('aria-hidden','true');w.title='网页收集';
  w.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
  return w;
}
function sourceLabel(source){
  const span=el('span','source-label');
  span.append(document.createTextNode(sourcePlainName(source)));
  if(isBrowserSource(source))span.append(webIcon());
  return span;
}
const optionSourceLabel=source=>isBrowserSource(source)?`${sourcePlainName(source)} 🌐`:sourcePlainName(source);
function badge(source){const cls=isBrowserSource(source)?'browser':source;const b=el('span','badge '+cls);b.append(sourceLabel(source));return b;}

let lastFilterSignature=null;
function renderSourcePills(ordered){
  const pillsHost=$('#source-pills');
  if(!pillsHost)return;
  const activeVal=$('#source-filter')?.value||'';
  const totalCount=ordered.reduce((sum,s)=>sum+(Number(s.count)||0),0);
  pillsHost.replaceChildren();
  const makePill=(val,labelNode,count)=>{
    const btn=el('button','source-pill'+(activeVal===val?' active':''));
    btn.type='button';
    btn.dataset.source=val;
    btn.append(labelNode,el('span','source-pill-count',String(count)));
    btn.onclick=()=>{
      const sel=$('#source-filter');
      if(sel)sel.value=val;
      updateSourcePillActive();
      offset=0;
      void loadList().catch(e=>toast(e.message));
    };
    return btn;
  };
  pillsHost.append(makePill('',document.createTextNode('全部'),totalCount));
  for(const s of ordered){
    pillsHost.append(makePill(s.source,sourceLabel(s.source),s.count));
  }
}
function updateSourcePillActive(){
  const activeVal=$('#source-filter')?.value||'';
  for(const btn of document.querySelectorAll('#source-pills .source-pill')){
    btn.classList.toggle('active',(btn.dataset.source||'')===activeVal);
  }
}
function syncSourceFilters(activeSources=[]){
  const canonicalOrder=['codex','claude-code','grok-bot','antigravity','demo',...Object.keys(browserNames).map(k=>'browser-'+k)];
  const positive=(Array.isArray(activeSources)?activeSources:[]).filter(s=>s&&s.count>0&&s.source);
  const rank=src=>{const i=canonicalOrder.indexOf(src);return i>=0?i:canonicalOrder.length;};
  const ordered=[...positive].sort((a,b)=>rank(a.source)-rank(b.source)||String(a.source).localeCompare(String(b.source)));
  const signature=ordered.map(s=>`${s.source}:${s.count}`).join(',');
  if(signature===lastFilterSignature)return;
  lastFilterSignature=signature;
  let reloadList=false;
  for(const selectId of ['source-filter','recall-source']){
    const select=document.getElementById(selectId);if(!select)continue;
    const prev=select.value;
    select.replaceChildren();
    const allOpt=document.createElement('option');allOpt.value='';allOpt.textContent='全部来源';select.append(allOpt);
    for(const s of ordered){
      const opt=document.createElement('option');opt.value=s.source;opt.textContent=optionSourceLabel(s.source);select.append(opt);
    }
    if(prev&&ordered.some(s=>s.source===prev))select.value=prev;
    else if(prev){select.value='';if(selectId==='source-filter')reloadList=true;}
  }
  renderSourcePills(ordered);
  if(reloadList){offset=0;void loadList().catch(e=>toast(e.message));}
}

const date=t=>t?new Date(t).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'未知时间';
function toast(msg){$('#toast').textContent=msg;$('#toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').hidden=true,5000);}
async function api(path,data){const res=await fetch('/api/'+path,data===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});const r=await res.json();if(!res.ok)throw new Error(r.error||'请求失败');return r;}

let currentPage='workspace';
let historyPeriod=7,historyEnd='',historyDay='',historyOffset=0,historyRequest=0;

function normalizePage(page){
  if(['workspace','library','home',''].includes(page))return 'workspace';
  if(['recall','activity','history-interop'].includes(page))return 'recall';
  if(['pipeline','connections'].includes(page))return 'pipeline';
  if(['stats','history','history-backup','history-storage','system'].includes(page))return 'stats';
  if(['settings','preferences'].includes(page))return 'settings';
  return 'workspace';
}
function pageFromHash(){
  const raw=(location.hash||'').replace(/^#/,'');
  return normalizePage(raw);
}
function go(page,fromHistory=false){
  const target=normalizePage(page);
  currentPage=target;
  document.body.dataset.page=target;
  $('#workspace-title').textContent=({workspace:'会话工作台',recall:'记忆召回与审计',pipeline:'数据管道',stats:'统计',settings:'设置'})[target];
  document.body.classList.toggle('show-outline',target==='workspace');
  window.scrollTo(0,0);
  for(const p of document.querySelectorAll('.page'))p.hidden=p.id!==target;
  for(const n of document.querySelectorAll('.app-header [data-page]')){
    const active=n.dataset.page===target;
    n.classList.toggle('active',active);
    n.setAttribute('aria-current',active?'page':'false');
  }
  const hash='#'+target;
  if(!fromHistory&&location.hash!==hash)history.pushState({page:target},'',hash);
  if(target==='recall')void loadActivity().catch(e=>toast(e.message));
  if(target==='stats')void loadHistory().catch(e=>toast(e.message));
  if(target==='settings')void openSettings();
  if(target==='pipeline'){
    void sourceCards();
    void loadInterop();
  }
}
window.addEventListener('popstate',()=>go(pageFromHash(),true));
for(const n of document.querySelectorAll('[data-page],[data-go]'))n.onclick=()=>go(n.dataset.page||n.dataset.go);

const jumpToSearch=()=>{go('workspace');$('#search').focus();};
if($('#topbar-search'))$('#topbar-search').onclick=jumpToSearch;
document.addEventListener('keydown',e=>{
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){
    e.preventDefault();
    jumpToSearch();
    return;
  }
  if(currentPage==='workspace'&&(e.key==='ArrowDown'||e.key==='ArrowUp')&&!e.metaKey&&!e.ctrlKey&&!e.altKey){
    const tag=document.activeElement?.tagName;
    if(tag==='TEXTAREA'||tag==='SELECT'||document.querySelector('dialog[open]'))return;
    const cards=[...document.querySelectorAll('#conversation-list .conversation')];
    if(!cards.length)return;
    e.preventDefault();
    const idx=cards.findIndex(c=>c.dataset.id===selected);
    const nextIdx=e.key==='ArrowDown'
      ?(idx<cards.length-1?idx+1:0)
      :(idx>0?idx-1:cards.length-1);
    const nextCard=cards[nextIdx];
    if(nextCard){
      nextCard.scrollIntoView({block:'nearest'});
      void showConversation(nextCard.dataset.id,nextCard);
    }
  }
});

const colors={
  codex:'#6c83ec',
  'claude-code':'#aa80e2',
  'grok-bot':'#111827',
  antigravity:'#2563eb',
  demo:'#48b2a3',
  'browser-chatgpt':'#10a37f',
  'browser-claude':'#d97757',
  'browser-gemini':'#4285f4',
  'browser-deepseek':'#4d6bfe',
  'browser-yuanbao':'#00a4ff',
  'browser-doubao':'#3b82f6',
  'browser-kimi':'#1f2937',
  'browser-qianwen':'#6366f1',
  'browser-grok':'#111827'
};
function aiLogo(source){
  const logo=el('span','ai-logo '+(source==='claude-code'?'claude':source));
  logo.setAttribute('aria-hidden','true');
  if(['codex','claude-code','grok-bot','antigravity'].includes(source)){
    logo.classList.add('product-logo');
    const img=el('img');img.src='/assets/'+source+'.png';img.alt='';logo.append(img);
  }else if(typeof source==='string'&&source.startsWith('browser-')&&browserNames[source.slice(8)]){
    logo.classList.add('platform-logo');
    const img=el('img');img.src='/assets/platforms/'+source.slice(8)+'.png';img.alt='';logo.append(img);
  }else{
    logo.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3v-3a2 2 0 0 1-2-2V6a2 2 0 0 1 3-2Z"/><path d="M7 9h10M7 13h6"/></svg>';
  }
  return logo;
}

/* Pipeline: Ingestion Sources */
const sourceViews=new Map();let sourcePolling=false;
async function patchSource(id,patch){const view=sourceViews.get(id);view.pending=true;view.toggle.disabled=true;view.save.disabled=true;try{return await api('sources/'+id,patch);}finally{view.pending=false;view.toggle.disabled=false;view.save.disabled=false;}}
function buildSourceView(def){
  const article=el('div','backup-source'),row=el('div','backup-row'),expand=el('button','backup-expand'),copy=el('span','backup-copy'),name=el('strong','',names[def.id]),subtitle=el('small');
  const panel=el('div','backup-source-panel');panel.id='source-panel-'+def.id;panel.hidden=true;
  expand.type='button';
  expand.setAttribute('aria-expanded','false');expand.setAttribute('aria-controls',panel.id);copy.append(name,subtitle);expand.append(aiLogo(def.id),copy);
  const toggle=el('input','backup-switch');toggle.type='checkbox';toggle.setAttribute('role','switch');toggle.setAttribute('aria-label',names[def.id]+' 本地备份');
  row.append(expand,toggle);

  const footer=el('div','backup-card-footer'),summary=el('span','source-config-stats'),footerActions=el('div','backup-card-actions');
  const sync=el('button','secondary','立即同步');sync.type='button';
  const configBtn=el('button','secondary','目录配置 ⌄');configBtn.type='button';
  footerActions.append(sync,configBtn);
  footer.append(summary,footerActions);

  article.append(row,footer,panel);
  const form=el('form','source-config-form'),label=el('label','',names[def.id]+' 来源目录'),path=el('input','source-input');path.id='path-'+def.id;path.required=true;label.htmlFor=path.id;path.setAttribute('autocomplete','off');path.placeholder=def.path;
  const actions=el('div','source-actions'),pick=el('button','secondary','选择文件夹…'),save=el('button','primary','保存配置'),reset=el('button','secondary','恢复默认');pick.type='button';pick.hidden=true;save.type='submit';reset.type='button';actions.append(pick,save,reset);
  const note=el('p','source-config-note','目录修改保存后生效，仅影响此 AI；已备份记录不会删除。'),status=el('p','source-config-status'),errors=el('details','source-errors');errors.append(el('summary','','查看同步问题'));const issues=el('div');errors.append(issues);errors.hidden=true;
  form.append(label,path,actions,note);panel.append(form,status,errors);

  const view={article,expand,configBtn,panel,toggle,path,pick,save,sync,subtitle,summary,status,errors,issues,def,pending:false,dirty:false};sourceViews.set(def.id,view);
  const togglePanel=()=>{panel.hidden=!panel.hidden;expand.setAttribute('aria-expanded',String(!panel.hidden));configBtn.textContent=panel.hidden?'目录配置 ⌄':'收起配置 ⌃';};
  expand.onclick=togglePanel;
  configBtn.onclick=togglePanel;
  path.oninput=()=>{view.dirty=true;};
  pick.onclick=async()=>{
    if(view.pending)return;
    view.pending=true;pick.disabled=true;save.disabled=true;toggle.disabled=true;
    try{
      const res=await api('sources/'+def.id+'/pick',{});
      if(res.canceled)return;
      view.dirty=false;
      if(res.source?.path)path.value=res.source.path;
      toast(names[def.id]+(res.source?.authorized?' 目录已授权并保存':' 目录已选择'));
      await sourceCards();
    }catch(e){toast(e.message);}
    finally{view.pending=false;pick.disabled=false;save.disabled=false;toggle.disabled=false;}
  };
  reset.onclick=()=>{path.value=def.path;view.dirty=true;toast('已填入默认目录，保存后生效');};
  form.onsubmit=async event=>{event.preventDefault();if(view.pending)return;try{const directory=path.value.trim();if(!directory.startsWith('/')){toast('请输入绝对目录路径');path.focus();return;}await patchSource(def.id,{path:directory});view.dirty=false;toast(names[def.id]+' 配置已保存');await sourceCards();}catch(e){toast(e.message);}};
  toggle.onchange=async()=>{const enabled=toggle.checked;try{await patchSource(def.id,{enabled});toast(names[def.id]+(enabled?' 本地备份已开启':' 本地备份已关闭，历史记录已保留'));await refreshState();if(enabled&&!state.sync.running){await api('sources/'+def.id+'/sync',{});await refreshState();}}catch(e){toggle.checked=!enabled;toast(e.message);}};
  sync.onclick=async()=>{try{await api('sources/'+def.id+'/sync',{});toast('正在同步 '+names[def.id]);await refreshState();}catch(e){toast(e.message);}};
  return view;
}
async function sourceCards(){if(sourcePolling)return;sourcePolling=true;try{
  const result=await api('source-status'),root=$('#connection-list');
  if(!root.querySelector('.detected-sources')){const found=el('div','detected-sources'),missing=el('details','undetected-sources'),summary=el('summary');summary.textContent='未检测到';missing.append(summary,el('div','undetected-items'));root.append(found,missing);}
  let missingCount=0;
  for(const def of [...state.defaults].sort((a,b)=>a.id==='codex'?-1:b.id==='codex'?1:0)){const info=result.items.find(s=>s.id===def.id);if(!info)continue;const view=sourceViews.get(def.id)||buildSourceView(def),group=root.querySelector(info.detected||info.enabled?'.detected-sources':'.undetected-items');if(view.article.parentElement!==group){group.append(view.article);if(!view.panel.hidden){const parent=group.closest('details');if(parent)parent.open=true;}}
  if(!info.detected&&!info.enabled)missingCount++;
  view.info=info;view.pick.hidden=!result.canPickDirectory;if(!view.pending){view.toggle.checked=info.enabled;view.toggle.disabled=false;view.save.disabled=false;view.pick.disabled=false;}
  if(!view.dirty&&document.activeElement!==view.path)view.path.value=info.path;
  view.subtitle.textContent=!info.detected?'未找到目录 · 点击配置':!info.enabled?'已关闭采集':info.todayMessages?`今日 +${info.todayMessages} 条（${info.todayConversations} 会话）`:'已开启 · 今日暂无新增';
  view.summary.textContent=`${info.conversations} 会话 · ${info.messages} 消息`;
  view.status.textContent=(info.enabled?'备份已开启':'备份已关闭')+(info.authorized?' · 目录已授权':'')+(info.lastRun?' · 上次检查 '+date(info.lastRun):' · 尚未同步');
  view.sync.disabled=!info.enabled||result.running||view.pending;view.errors.hidden=!info.issues.length;
  const signature=JSON.stringify(info.issues);if(view.issueSignature!==signature){view.issueSignature=signature;view.issues.replaceChildren();for(const issue of info.issues)view.issues.append(el('p','',`${issue.path||''} ${issue.error}`));}
  }
  root.querySelector('.undetected-sources').hidden=!missingCount;root.querySelector('.undetected-sources>summary').textContent=`未检测到（${missingCount}）`;
  }catch(e){if(!sourceViews.size)$('#connection-list').textContent='无法读取来源状态：'+e.message;}finally{sourcePolling=false;}}

/* Pipeline: Interop MCP Clients */
const interopViews=new Map();let interopLoading=false;
async function copyInterop(text,label){try{await navigator.clipboard.writeText(text);toast(label+'已复制');}catch{toast('无法访问剪贴板，请手动复制展开的配置');}}
function makeInteropView(client){
  const article=el('div','interop-client'),row=el('div','interop-client-row'),expand=el('button','interop-client-expand'),copy=el('span','interop-client-copy'),subtitle=el('small'),arrow=el('span','interop-chevron','⌄');copy.append(el('strong','',client.name),subtitle);expand.append(aiLogo(client.id),copy,arrow);expand.setAttribute('aria-expanded','false');
  const toggle=el('input','backup-switch');toggle.type='checkbox';toggle.setAttribute('role','switch');toggle.setAttribute('aria-label',client.name+' 跨 AI 互通');
  const panel=el('div','interop-client-panel');panel.id='interop-'+client.id;panel.hidden=true;expand.setAttribute('aria-controls',panel.id);row.append(expand,toggle);article.append(row,panel);
  const addressLabel=el('label','',client.name+' MCP 地址'),address=el('input','source-input');address.readOnly=true;address.id='interop-url-'+client.id;addressLabel.htmlFor=address.id;const location=el('p','interop-location'),code=el('pre','interop-code'),actions=el('div','source-actions'),copyConfig=el('button','primary','复制'+(client.kind==='command'?'接入命令':'配置')),copyUrl=el('button','secondary','复制地址'),test=el('button','secondary','测试握手'),testStatus=el('p','interop-test-status');testStatus.setAttribute('role','status');actions.append(copyConfig,copyUrl,test);
  const scope=el('form','interop-scope'),heading=el('h3','','允许召回的资料来源'),allLabel=el('label','scope-all'),all=el('input');all.type='checkbox';all.setAttribute('aria-label',client.name+' 读取全部资料');allLabel.append(all,document.createTextNode('全部已保存来源（包括以后新增的来源）'));const choices=el('fieldset','interop-scope-choices'),legend=el('legend','','指定来源');choices.append(legend);const inputs=[];
  for(const id of ['codex','claude-code','grok-bot','antigravity',...Object.keys(browserNames).map(k=>'browser-'+k)]){const label=el('label'),input=el('input');input.type='checkbox';input.value=id;input.setAttribute('aria-label',client.name+' 可读取 '+sourcePlainName(id));label.append(input,sourceLabel(id));choices.append(label);inputs.push(input);}
  const save=el('button','secondary','保存资料范围');save.type='submit';const help=el('p','interop-scope-help','未选择任何来源时，此 AI 无法读取资料。'),usage=el('p','interop-usage');scope.append(heading,allLabel,choices,save,help);panel.append(addressLabel,address,location,code,actions,testStatus,scope,usage);
  const view={article,expand,panel,toggle,address,location,code,copyConfig,copyUrl,test,testStatus,all,inputs,save,subtitle,usage,dirty:false,pending:false,client};interopViews.set(client.id,view);
  expand.onclick=()=>{panel.hidden=!panel.hidden;expand.setAttribute('aria-expanded',String(!panel.hidden));};
  copyConfig.onclick=()=>copyInterop(view.client.config,view.client.name+' 配置');copyUrl.onclick=()=>copyInterop(view.client.url,view.client.name+' 地址');
  all.onchange=()=>{view.dirty=true;for(const input of inputs){input.disabled=all.checked;if(all.checked)input.checked=true;}};for(const input of inputs)input.onchange=()=>{view.dirty=true;};
  async function patch(data){view.pending=true;toggle.disabled=true;save.disabled=true;try{return await api('interop/'+client.id,data);}finally{view.pending=false;toggle.disabled=false;save.disabled=false;}}
  toggle.onchange=async()=>{const enabled=toggle.checked;try{await patch({enabled});testStatus.textContent='';toast(client.name+(enabled?' 跨 AI 互通已开启':' 跨 AI 互通已关闭'));await loadInterop();}catch(e){toggle.checked=!enabled;toast(e.message);}};
  scope.onsubmit=async event=>{event.preventDefault();if(view.pending)return;try{await patch({sources:all.checked?null:inputs.filter(i=>i.checked).map(i=>i.value)});view.dirty=false;toast(client.name+' 的资料范围已保存');await loadInterop();}catch(e){toast(e.message);}};
  test.onclick=async()=>{test.disabled=true;testStatus.textContent='正在测试 MCP 握手…';try{const response=await fetch(view.client.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'test-'+Date.now(),method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'memocat-check',version:'0.5.0'}}})});const rpc=await response.json();if(!response.ok||rpc.error||!rpc.result?.serverInfo)throw new Error(rpc.error?.message||'MCP 握手失败');testStatus.textContent='握手正常 · '+rpc.result.serverInfo.name+' '+rpc.result.serverInfo.version+'（尚不代表客户端已接入）';}catch(e){testStatus.textContent=e.message;}finally{test.disabled=!view.client.enabled;}};
  return view;
}
async function loadInterop(){if(interopLoading)return;interopLoading=true;try{const result=await api('interop');const root=$('#interop-clients');for(const client of result.clients){const view=interopViews.get(client.id)||makeInteropView(client);if(!view.article.parentElement)root.append(view.article);view.client=client;view.subtitle.textContent=client.enabled?'已开启 · '+(client.sources===null?'全部来源':client.sources.length?client.sources.map(id=>sourcePlainName(id)).join('、'):'未授权资料来源'):'已关闭端点';view.address.value=client.url;view.location.textContent=client.location;view.code.textContent=client.config;if(!view.pending){view.toggle.checked=client.enabled;view.toggle.disabled=false;view.test.disabled=!client.enabled;view.save.disabled=false;}if(!view.dirty){view.all.checked=client.sources===null;for(const input of view.inputs){input.checked=client.sources===null||client.sources.includes(input.value);input.disabled=view.all.checked;}}view.usage.textContent=`已完成 ${client.recalls} 次取用 · `+(client.lastRequest?'最近请求 '+date(client.lastRequest):'尚无请求记录');}}catch(e){if(!interopViews.size)$('#interop-clients').textContent='无法读取互通配置：'+e.message;}finally{interopLoading=false;}}

/* Global State & Metrics */
async function updateTopbarMetrics(){
  try{
    const d=await api('dashboard');
    $('#today-messages').textContent=d.today.toLocaleString();
  }catch{}
}
async function refreshState(){
  state=await api('state');
  showSchedule(state.schedule);
  syncSourceFilters(state.activeSources||[]);
  for(const [key,value] of Object.entries(state.stats)){
    const node=$('#stat-'+key);
    if(node)node.textContent=value.toLocaleString();
  }
  const navCount=$('#nav-conversations-count');
  if(navCount){const count=Number(state.stats?.conversations)||0;navCount.textContent=String(count);navCount.hidden=!count;}
  const navRecalls=$('#nav-recalls-count');
  if(navRecalls){const count=Number(state.stats?.recalls)||0;navRecalls.textContent=String(count);navRecalls.hidden=!count;}
  $('#sync-label').textContent=state.sync.running?'同步中…':state.sync.lastRun?`${date(state.sync.lastRun)} 更新`:'尚未更新';
  $('#sync').disabled=state.sync.running;
  const portMatch=/^https?:\/\/([^/]+)/.exec(state.mcp||'');
  if(portMatch&&$('#workspace-port-label'))$('#workspace-port-label').textContent=portMatch[1];
  await updateTopbarMetrics();
  await sourceCards();
  await loadInterop();
}

/* Workspace: List & Structured Turn Reader */
async function loadList(append=false){
  const data=await api(`conversations?q=${encodeURIComponent(query)}&source=${$('#source-filter').value}&offset=${offset}`);
  const list=$('#conversation-list');if(!append)list.replaceChildren();
  $('#result-count').textContent=`${data.total} 条`;
  $('#more').hidden=offset+data.items.length>=data.total;
  if(!data.items.length&&!append)list.append(el('p','history-empty','没有匹配的会话。可在数据管道中开启来源目录。'));
  let previousDay='';
  for(const c of data.items){
    const day=c.updated?recordDay(c.updated):'未知日期';
    if(day!==previousDay){list.append(el('div','date-group',day));previousDay=day;}
    const b=el('button','conversation'+(selected===c.id?' selected':''));b.dataset.id=c.id;
    const copy=el('div','conv-copy'),top=el('div','conv-top');
    top.append(el('h3','',visibleConversationText(c.title)||'未命名会话'),el('time','',c.updated?new Date(c.updated).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):''));
    const previewText=visibleConversationText(c.preview||'').replace(/\s+/g,' ').trim();
    const preview=el('p','conv-preview',previewText||'暂无正文摘要');
    const meta=el('div','conv-meta');
    const sourceTag=el('span','conv-source-tag'+(isBrowserSource(c.source)?'':' local'));sourceTag.append(sourceLabel(c.source));
    meta.append(sourceTag);
    copy.append(top,preview,meta);
    b.append(aiLogo(c.source),copy);
    b.onclick=()=>showConversation(c.id,b);
    list.append(b);
  }
  highlightMatches(list);
  if(query.trim()&&data.items.length){await showConversation(data.items[0].id,list.querySelector('.conversation'));}
  else if(!selected&&data.items.length){const first=list.querySelector('.conversation');await showConversation(data.items[0].id,first);}
}

function prepareDisplayTurns(c){
  const isLocal=!isBrowserSource(c.meta?.channelId);
  const turns=[];
  for(const [recordIndex,r] of (c.records||[]).entries()){
    const documents=pastedDocuments(r.text);
    let visibleText=visibleConversationText(documents.text);
    for(const image of r.images||[])for(const marker of image.markers||[])visibleText=visibleText.replaceAll(marker,'');
    if(r.images?.length)visibleText=visibleText.replace(/<\/image\s*>/g,'').trim();
    const files=documents.files.map((file,fileIndex)=>({file,recordIndex,fileIndex}));
    const images=r.images||[];
    if(!visibleText&&!images.length&&!files.length)continue;

    const last=turns.at(-1);
    if(isLocal&&r.role==='assistant'&&last?.role==='assistant'){
      if(visibleText)last.texts.push(visibleText);
      last.files.push(...files);
      last.images.push(...images);
      if(r.ts)last.ts=r.ts;
      last.parts++;
    }else{
      turns.push({role:r.role,texts:visibleText?[visibleText]:[],files,images,ts:r.ts,parts:1});
    }
  }
  return turns.map(t=>({...t,visibleText:t.texts.join('\n\n')}));
}
function formatConversationMarkdown(c){
  const title=visibleConversationText(c.meta.title)||'未命名会话';
  const body=prepareDisplayTurns(c).map(t=>`## ${t.role==='user'?'提问':'AI 回复'}\n\n${t.visibleText||'[图片或附件]'}`).join('\n\n---\n\n');
  return `# ${title}\n\n来源：${sourcePlainName(c.meta.channelId)}${isBrowserSource(c.meta.channelId)?' (Web)':''}\n路径：${c.meta.sourcePath}\n\n${body}\n`;
}
function formatPromptContext(c){
  const title=visibleConversationText(c.meta.title)||'未命名会话';
  let qIndex=0;
  const turns=prepareDisplayTurns(c).map(t=>{
    if(!t.visibleText)return '';
    const label=t.role==='user'?`[提问 #${++qIndex}]`:'[AI 回复]';
    return `${label}\n${t.visibleText}`;
  }).filter(Boolean).join('\n\n');
  return `以下是来自 MemoCat 本机资料库的历史对话上下文（来源：${sourcePlainName(c.meta.channelId)}，时间：${date(c.meta.lastActiveAt)}）：\n\n<conversation_context title="${title}" source="${c.meta.channelId}" path="${c.meta.sourcePath}">\n${turns}\n</conversation_context>\n\n请基于以上上下文继续协助我：`;
}
function downloadFile(content,name,type='text/markdown'){
  const url=URL.createObjectURL(new Blob([content],{type})),a=document.createElement('a');
  a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
}

async function showConversation(id,button){
  try{
    const c=await api('conversations/'+id);
    selected=id;
    for(const b of document.querySelectorAll('.conversation'))b.classList.remove('selected');
    (button||document.querySelector(`.conversation[data-id="${id}"]`))?.classList.add('selected');
    const pane=$('#conversation-detail');
    const header=el('header','detail-header');
    const title=visibleConversationText(c.meta.title)||c.records.map(r=>visibleConversationText(r.text)).find(Boolean)?.slice(0,80)||'未命名会话';
    const metaRow=el('div','detail-meta-row');
    const sourceInfo=el('div','source-path');
    sourceInfo.append(sourceLabel(c.meta.channelId),document.createTextNode(` · ${c.records.length} 条记录 · 上次活动 ${date(c.meta.lastActiveAt)}\n${c.meta.sourcePath}`));

    const actions=el('div','detail-actions');
    const promptBtn=el('button','primary','复制为 Prompt');promptBtn.id='copy-prompt-btn';promptBtn.type='button';
    promptBtn.onclick=async()=>{try{await navigator.clipboard.writeText(formatPromptContext(c));toast('已复制为结构化上下文 Prompt');}catch{toast('无法访问剪贴板');}};
    const copyBtn=el('button','secondary','复制对话');copyBtn.type='button';
    copyBtn.onclick=async()=>{try{await navigator.clipboard.writeText(formatConversationMarkdown(c));toast('已复制 Markdown 对话');}catch{toast('无法访问剪贴板');}};
    const exportBtn=el('button','secondary','导出 .md');exportBtn.type='button';
    exportBtn.onclick=()=>{const safe=title.replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,80)||'conversation';downloadFile(formatConversationMarkdown(c),safe+'.md');toast('已导出 Markdown');};
    const recallBtn=el('button','secondary','以此测试召回');recallBtn.type='button';
    recallBtn.onclick=()=>{
      const seed=title==='未命名会话'?(c.records.find(r=>r.role==='user')?.text||'').slice(0,120):title;
      $('#query').value=seed;
      go('recall');
      $('#query').focus();
      toast('已带入当前会话主题，点击「执行召回」即可测试');
    };
    actions.append(promptBtn,copyBtn,exportBtn,recallBtn);
    if(typeof c.meta.sourcePath==='string'&&c.meta.sourcePath.startsWith('https://')){
      const openBtn=el('a','secondary','原对话 ↗');
      openBtn.href=c.meta.sourcePath;openBtn.target='_blank';openBtn.rel='noopener noreferrer';
      actions.append(openBtn);
    }
    metaRow.append(sourceInfo,actions);
    header.append(badge(c.meta.channelId),el('h2','',title),metaRow);

    const turns=el('div','detail-turns');
    let questionNum=0;
    for(const t of prepareDisplayTurns(c)){
      const msg=el('section','message '+t.role);
      msg.setAttribute('aria-label',t.role==='user'?'用户提问':'AI 回复');
      const avatar=el('span','message-avatar',t.role==='user'?'你':'AI');
      avatar.setAttribute('aria-hidden','true');
      const bubble=el('div','message-bubble');
      const head=el('div','message-head'),headLeft=el('div','message-head-left');
      const roleLabel=t.role==='user'?`提问 #${++questionNum}`:(t.parts>1?`AI 回复 · 已合并 ${t.parts} 段`:'AI 回复');
      headLeft.append(el('span','message-role-badge',roleLabel),el('time','message-time',date(t.ts)));
      const msgCopy=el('button','msg-copy-btn','复制');msgCopy.type='button';
      msgCopy.onclick=async()=>{try{await navigator.clipboard.writeText(t.visibleText||'[附件]');toast('已复制该条内容');}catch{toast('无法访问剪贴板');}};
      head.append(headLeft,msgCopy);

      const body=el('div','message-body');
      if(t.visibleText)body.append(renderText(t.visibleText));
      for(const {file,recordIndex,fileIndex} of t.files){
        const link=el('a','document-attachment','📄 '+file.name);
        link.href=`/api/documents/${id}/${recordIndex}/${fileIndex}`;
        link.download=file.name;link.title=file.path;
        link.append(el('small','',file.label));
        body.append(link);
      }
      for(const image of t.images)body.append(renderMessageImage(image));
      bubble.append(head,body);
      msg.append(avatar,bubble);
      turns.append(msg);
    }

    pane.replaceChildren(badge(c.meta.channelId),header,turns);
    pane.scrollTop=0;
    highlightMatches(pane);
    buildOutline(pane);
  }catch(e){toast(e.message);}
}

let searchTimer;
const syncSearchClear=()=>{if($('#search-clear'))$('#search-clear').hidden=!$('#search').value;};
$('#search').oninput=()=>{
  syncSearchClear();
  clearTimeout(searchTimer);
  searchTimer=setTimeout(()=>{query=$('#search').value;offset=0;highlightMatches($('#conversation-detail'));loadList().catch(e=>toast(e.message));},180);
};
$('#search-clear')?.addEventListener('click',()=>{
  $('#search').value='';
  syncSearchClear();
  query='';offset=0;
  highlightMatches($('#conversation-detail'));
  void loadList().catch(e=>toast(e.message));
  $('#search').focus();
});
$('#source-filter').onchange=()=>{
  updateSourcePillActive();
  offset=0;
  void loadList().catch(e=>toast(e.message));
};
$('#more').onclick=()=>{offset+=200;void loadList(true).catch(e=>toast(e.message));};
$('#sync').onclick=async()=>{try{await api('sync',{});await refreshState();toast('正在同步已启用的来源');}catch(e){toast(e.message);}};

/* Recall & Audit */
function syncKeywordChips(){
  const host=$('#keyword-chips');
  if(!host)return;
  host.replaceChildren();
  keywords.forEach((kw,idx)=>{
    const chip=el('span','keyword-chip');
    chip.append(document.createTextNode(kw));
    const del=el('button','','×');
    del.type='button';
    del.setAttribute('aria-label',`移除关键词 ${kw}`);
    del.onclick=()=>{keywords.splice(idx,1);syncKeywordChips();};
    chip.append(del);
    host.append(chip);
  });
  $('#alternatives').value=keywords.join('\n');
}
function addKeywordFromInput(){
  const input=$('#keyword-input');
  if(!input)return;
  const parts=input.value.split(/[\n,，]+/).map(s=>s.trim()).filter(Boolean);
  for(const p of parts){
    if(keywords.includes(p))continue;
    if(keywords.length>=8){toast('最多支持 8 条补充关键词');break;}
    keywords.push(p);
  }
  input.value='';
  syncKeywordChips();
}
$('#keyword-add')?.addEventListener('click',addKeywordFromInput);
$('#keyword-input')?.addEventListener('keydown',e=>{
  if(e.key==='Enter'){e.preventDefault();addKeywordFromInput();}
});
for(const btn of document.querySelectorAll('[data-recall-range]')){
  btn.onclick=()=>{
    const range=btn.dataset.recallRange;
    for(const b of document.querySelectorAll('[data-recall-range]'))b.classList.toggle('active',b===btn);
    if(range==='all'){
      $('#from').value='';$('#to').value='';
    }else{
      const days=Number(range),end=new Date(),start=new Date();
      start.setDate(end.getDate()-days);
      const fmt=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      $('#from').value=fmt(start);
      $('#to').value=fmt(end);
    }
  };
}
for(const id of ['from','to']){
  $('#'+id)?.addEventListener('change',()=>{
    for(const b of document.querySelectorAll('[data-recall-range]'))b.classList.remove('active');
  });
}

async function openConversationByMeta(meta){
  try{
    const title=visibleConversationText(meta.title||'');
    let match=null;
    if(title){
      const searched=await api(`conversations?source=${encodeURIComponent(meta.channelId||'')}&q=${encodeURIComponent(title)}&offset=0`);
      match=searched.items.find(i=>i.thread===meta.threadId)||searched.items[0];
    }
    if(!match){
      const listed=await api(`conversations?source=${encodeURIComponent(meta.channelId||'')}&offset=0`);
      match=listed.items.find(i=>i.thread===meta.threadId);
    }
    if(match){
      go('workspace');
      await showConversation(match.id);
      return;
    }
    toast('未能定位到对应会话，已在工作台搜索');
    go('workspace');
    $('#search').value=title||'';
    syncSearchClear();
    query=$('#search').value;offset=0;
    await loadList();
  }catch(e){toast(e.message);}
}

function evidenceCard(e){
  const card=el('div','card');
  const head=el('div','evidence-card-head'),badges=el('div','evidence-head-badges');
  badges.append(badge(e.meta.channelId));
  if(typeof e.score==='number')badges.append(el('span','score-pill',`相关度 ${Math.round(e.score*100)}%`));
  if(e.truncated)badges.append(el('span','score-pill','已截断'));
  const openBtn=el('button','secondary','在工作台打开 ↗');
  openBtn.type='button';
  openBtn.onclick=()=>void openConversationByMeta(e.meta);
  head.append(badges,openBtn);
  card.append(
    head,
    el('h2','',visibleConversationText(e.meta.title)||'未命名会话'),
    el('div','evidence-meta',`${e.meta.sourcePath} · ${date(e.meta.lastActiveAt)}`),
    el('div','evidence-text',visibleConversationText(e.text)||'此片段仅包含环境信息，已隐藏。')
  );
  return card;
}

function updateTokenMeter(tokens=0){
  const used=Math.ceil(Number(tokens)||0);
  const pct=Math.min(100,Math.round((used/9600)*100));
  $('#token-meter-text').textContent=`${used.toLocaleString()} / 9,600 token (${pct}%)`;
  $('#token-meter-fill').style.width=pct+'%';
}
$('#new-context').onclick=()=>{
  processId=undefined;
  lastRecallResult=null;
  $('#copy-recall-results').hidden=true;
  updateTokenMeter(0);
  $('#context-label').textContent='已重置上下文，下次召回可重新取用历史片段。';
};
$('#copy-recall-results')?.addEventListener('click',async()=>{
  if(!lastRecallResult?.evidence?.length)return;
  const text=lastRecallResult.evidence.map((e,i)=>`[${i+1}] ${e.meta.title} (${sourcePlainName(e.meta.channelId)})\n${e.text}`).join('\n\n---\n\n');
  try{await navigator.clipboard.writeText(text);toast('已复制全部命中片段');}catch{toast('无法访问剪贴板');}
});
$('#recall-form').onsubmit=async event=>{
  event.preventDefault();
  if(busy)return;
  if($('#keyword-input')?.value.trim())addKeywordFromInput();
  busy=true;
  const button=$('#recall-submit');button.disabled=true;button.textContent='正在同步与召回…';
  try{
    const input={query:$('#query').value,alternatives:$('#alternatives').value.split('\n').map(s=>s.trim()).filter(Boolean)};
    if(processId)input.process_id=processId;
    for(const k of ['from','to'])if($('#'+k).value)input[k]=$('#'+k).value;
    if($('#recall-source').value)input.sources=[$('#recall-source').value];
    const r=await api('recall',input);
    processId=r.process_id;
    lastRecallResult=r;
    $('#context-label').textContent='当前上下文：'+processId;
    updateTokenMeter(r.estimatedTokens);
    $('#copy-recall-results').hidden=!r.evidence.length;
    const output=$('#recall-results');
    output.replaceChildren(el('p','',`${r.evidence.length} 个命中区域 · 约 ${Math.ceil(r.estimatedTokens)} token · ${r.timeZone}${r.partial?' · 部分来源读取失败，结果不完整':''}`));
    for(const e of r.evidence)output.append(evidenceCard(e));
    if(!r.evidence.length)output.append(el('div','card','没有新的匹配片段。可调整关键词或点击「重置上下文」。'));
    await Promise.all([refreshState(),loadActivity()]);
  }catch(e){toast(e.message);}
  finally{busy=false;button.disabled=false;button.textContent='⌕ 执行召回';}
};

async function loadActivity(target=$('#activity-list')){
  const rows=await api('activity'),root=target;
  root.replaceChildren();
  if(!rows.length){root.append(el('div','card','暂无取用记录。在左侧召回沙盒执行一次查询，或接入外部 MCP 客户端。'));return;}
  for(const r of rows){
    const card=el('div','card'),head=el('div','activity-head');
    head.append(badge(r.caller),el('small','',date(r.created)+' · '+({committed:'已返回',prepared:'待返回',abandoned:'未完成'}[r.status]||r.status)));
    card.append(head,el('div','activity-query',r.query),el('p','',`${r.payload.evidence.length} 个区域 · 上下文 ${r.process.slice(0,8)}…`));
    const details=el('details');details.append(el('summary','','查看当时交付的原文快照'));
    for(const e of r.payload.evidence)details.append(evidenceCard(e));
    card.append(details);
    root.append(card);
  }
}
$('#refresh-activity')?.addEventListener('click',()=>{void loadActivity().catch(e=>toast(e.message));});

/* Media Preview */
function renderMessageImage(image){
  const figure=el('figure','message-image');
  if(!image.id){figure.classList.add('image-unavailable');figure.append(el('span','',image.alt||'图片'),el('small','',image.reason||'原图片不可用'));return figure;}
  const button=el('button','image-thumbnail'),img=el('img');img.src='/api/images/'+encodeURIComponent(image.id);img.alt=image.alt||'对话图片';img.loading='lazy';button.setAttribute('aria-label','放大查看 '+img.alt);button.append(img);figure.append(button);
  img.onerror=()=>{figure.classList.add('image-unavailable');figure.replaceChildren(el('span','','图片暂不可用'),el('small','','本地缓存无法读取'));};
  button.onclick=()=>{const preview=$('#image-preview');$('#image-preview-error').hidden=true;preview.hidden=false;preview.alt=img.alt;preview.onerror=()=>{preview.hidden=true;$('#image-preview-error').hidden=false;};preview.src=img.src;$('#image-dialog').showModal();};
  return figure;
}
$('#close-image').onclick=()=>$('#image-dialog').close();
$('#image-dialog').onclick=e=>{if(e.target===$('#image-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}};

/* System: History & Storage Insights */
const shiftHistoryDay=(day,n)=>{const d=new Date(day+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const todayDay=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
$('#history-days').onchange=()=>{historyPeriod=Number($('#history-days').value);historyOffset=0;void loadHistory().catch(e=>toast(e.message));};
$('#history-prev').onclick=()=>{historyEnd=shiftHistoryDay(historyEnd||todayDay(),-historyPeriod);historyDay=historyEnd;historyOffset=0;void loadHistory().catch(e=>toast(e.message));};
$('#history-next').onclick=()=>{historyEnd=[shiftHistoryDay(historyEnd||todayDay(),historyPeriod),todayDay()].sort()[0];historyDay=historyEnd;historyOffset=0;void loadHistory().catch(e=>toast(e.message));};
$('#history-more').onclick=()=>{historyOffset+=50;void loadHistory(true).catch(e=>toast(e.message));};
const formatBytes=bytes=>bytes>=1048576?(bytes/1048576).toFixed(1)+' MB':bytes>=1024?(bytes/1024).toFixed(1)+' KB':bytes+' B';

async function loadHistory(append=false){
  const ticket=++historyRequest;
  $('#history-error').hidden=true;
  const params=new URLSearchParams({days:String(historyPeriod),offset:String(historyOffset)});
  if(historyEnd)params.set('end',historyEnd);
  if(historyDay&&(!historyEnd||historyDay<=historyEnd)&&historyDay>=shiftHistoryDay(historyEnd||todayDay(),1-historyPeriod))params.set('day',historyDay);
  let data;
  try{data=await api('history?'+params);}
  catch(e){$('#history-error').textContent=e.message;$('#history-error').hidden=false;return;}
  if(ticket!==historyRequest)return;
  historyEnd=data.end;historyDay=data.day;$('#history-next').disabled=data.end>=data.today;

  const summary=$('#history-storage-summary');summary.replaceChildren();
  for(const [name,value] of [['会话总数',data.storage.conversations.toLocaleString()],['消息总数',data.storage.messages.toLocaleString()],['活跃平台',data.storage.platforms],['磁盘占用',formatBytes(data.storage.bytes)]]){
    const box=el('div');box.append(el('span','',name),el('strong','',String(value)));summary.append(box);
  }
  const distRoot=$('#history-distribution');distRoot.replaceChildren();
  for(const part of data.storage.distribution){
    const row=el('div','distribution-row'),body=el('div','distribution-body'),head=el('div','distribution-head'),progress=el('div','distribution-track'),fill=el('span'),ratio=data.storage.messages?Math.round(part.messages/data.storage.messages*100):0;
    const strong=el('strong');strong.append(sourceLabel(part.source));
    head.append(strong,el('span','',`${part.conversations} 会话 · ${part.messages.toLocaleString()} 消息`));
    fill.style.width=ratio+'%';fill.style.background=colors[part.source]||'#6480ea';
    progress.append(fill);body.append(head,progress);
    row.append(aiLogo(part.source),body,el('span','distribution-percent',ratio+'%'));
    distRoot.append(row);
  }
  if(!data.storage.distribution.length)distRoot.append(el('p','history-empty','暂无保存记录，接入来源后即可查看。'));

  const [,month,day]=data.day.split('-');
  $('#history-day-title').textContent=`${Number(month)}月${Number(day)}日`;
  $('#history-day-relative').textContent=data.day===data.today?'今天':data.day;
  const chart=$('#history-chart');chart.replaceChildren();
  const max=Math.max(1,...data.daily.map(d=>Object.values(d.counts).reduce((a,b)=>a+b,0)));
  const scale=max<=5?5:Math.ceil(max/Math.pow(10,Math.floor(Math.log10(max))))*Math.pow(10,Math.floor(Math.log10(max)));
  const axis=el('div','chart-axis');axis.append(el('span','',scale.toLocaleString()),el('span','',Math.round(scale/2).toLocaleString()),el('span','','0'));chart.append(axis);
  const scroller=el('div','chart-scroller'),columns=el('div','chart-columns');if(data.days===30)columns.classList.add('thirty-days');
  for(const d of data.daily){
    const column=el('button','chart-column'+(d.day===data.day?' selected':'')),stack=el('div','bar-stack'),total=Object.values(d.counts).reduce((a,b)=>a+b,0);
    column.type='button';column.title=`${d.day}：${total} 条消息`;column.setAttribute('aria-label',column.title);column.setAttribute('aria-pressed',String(d.day===data.day));
    for(const source of data.sources){const value=d.counts[source]||0;if(!value)continue;const segment=el('span','bar-segment');segment.style.height=(value/scale*100)+'%';segment.style.background=colors[source]||'#6480ea';stack.append(segment);}
    column.append(stack,el('span','chart-date',`${Number(d.day.slice(5,7))}/${Number(d.day.slice(8))}`));
    column.onclick=()=>{historyDay=d.day;historyOffset=0;void loadHistory().catch(e=>toast(e.message));};
    columns.append(column);
  }
  scroller.append(columns);chart.append(scroller);
  const legend=$('#history-legend');legend.replaceChildren();
  for(const t of data.totals){const label=el('span'),dot=el('i');dot.style.background=colors[t.source]||'#6480ea';label.append(dot,sourceLabel(t.source),document.createTextNode(' '+t.messages.toLocaleString()+' 条'));legend.append(label);}
  const records=$('#history-records');if(!append)records.replaceChildren();
  for(const r of data.records){
    const row=el('button','timeline-row'),copy=el('span','row-copy'),sub=el('small');
    sub.append(sourceLabel(r.source),document.createTextNode(' 存入 '+r.messages+' 条新消息'));
    copy.append(el('strong','',visibleConversationText(r.title)||'未命名会话'),sub);
    row.append(aiLogo(r.source),copy,el('time','',date(r.created)));
    row.disabled=!r.conversationId;
    row.onclick=()=>{go('workspace');void showConversation(r.conversationId);};
    records.append(row);
  }
  if(!data.totalRecords)records.append(el('p','history-empty','当天没有记录到新的同步入库事件。'));
  $('#history-more').hidden=historyOffset+data.records.length>=data.totalRecords;
}

/* System: Preferences & Schedule */
let settingsInfo=null;
async function openSettings(){
  void loadSchedule();
  try{
    settingsInfo=await api('preferences');
    $('#data-location').textContent=settingsInfo.dataDir;
    $('#settings-version').textContent=settingsInfo.version;
    $('#open-data').textContent=settingsInfo.canOpenDataDir?'打开文件夹 ↗':'复制路径';
    $('#startup-setting').disabled=!settingsInfo.startupSupported;
    $('#startup-setting').checked=settingsInfo.startupEnabled;
    $('#startup-help').textContent=settingsInfo.startupSupported?'登录系统时启动 MemoCat':'请安装桌面版以启用';
    $('#background-setting').disabled=!settingsInfo.backgroundSupported;
    $('#background-setting').checked=Boolean(settingsInfo.backgroundEnabled);
    $('#background-help').textContent=settingsInfo.backgroundSupported?'关闭主窗口后在后台持续运行 3792 端口服务，避免扩展同步与 MCP 中断。':'请使用桌面版以启用后台驻留';
  }catch(e){$('#data-location').textContent='无法读取资料位置';toast(e.message);}
}
$('#manage-sources').onclick=()=>go('pipeline');
$('#open-data').onclick=async()=>{
  if(!settingsInfo)return;
  try{
    if(settingsInfo.canOpenDataDir){await api('open-data',{});toast('已打开本地资料文件夹');}
    else{await navigator.clipboard.writeText(settingsInfo.dataDir);toast('资料路径已复制，可在文件管理器中打开');}
  }catch(e){toast(e.message||'复制失败，请手动复制下方路径');}
};
$('#startup-setting').onchange=async()=>{
  const input=$('#startup-setting'),wanted=input.checked;input.disabled=true;
  try{const result=await api('startup',{enabled:wanted});input.checked=result.enabled;toast(result.enabled?'已启用开机自启':'已关闭开机自启');}
  catch(e){input.checked=!wanted;toast(e.message);}
  finally{input.disabled=!settingsInfo?.startupSupported;}
};
$('#background-setting').onchange=async()=>{
  const input=$('#background-setting'),wanted=input.checked;input.disabled=true;
  try{const result=await api('background',{enabled:wanted});input.checked=result.enabled;toast(result.enabled?'已开启后台驻留运行':'已关闭后台驻留，关闭主窗口时将退出服务');}
  catch(e){input.checked=!wanted;toast(e.message);}
  finally{input.disabled=!settingsInfo?.backgroundSupported;}
};
$('#about-app').onclick=()=>$('#about-dialog').showModal();
for(const id of ['close-about','about-done'])$('#'+id).onclick=()=>$('#about-dialog').close();
const aboutDialog=$('#about-dialog');
aboutDialog.addEventListener('close',()=>{if(!$('#settings').hidden)$('#about-app').focus();});
aboutDialog.addEventListener('click',e=>{if(e.target===aboutDialog){const r=aboutDialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)aboutDialog.close();}});

if(new URLSearchParams(location.search).get('desktop')==='1')document.body.classList.add('desktop');
await refreshState();
await loadList();
go(pageFromHash(),true);
setInterval(async()=>{
  try{
    const was=state?.sync.running;
    await refreshState();
    if(was&&!state.sync.running){
      offset=0;
      await loadList();
      toast(`同步完成，更新 ${state.sync.changed} 条；问题 ${state.sync.issues.length} 项`);
    }
  }catch{/* server unavailable: retain current UI */}
},2500);

function recordDay(ts){
  const day=new Date(ts).toLocaleDateString('zh-CN'),today=new Date(),yesterday=new Date();
  yesterday.setDate(today.getDate()-1);
  return day===today.toLocaleDateString('zh-CN')?'今天':day===yesterday.toLocaleDateString('zh-CN')?'昨天':day;
}
function renderText(text){
  const node=el('div','message-text markdown');
  node.innerHTML=DOMPurify.sanitize(marked.parse(text),{FORBID_TAGS:['img','iframe','style','form','input'],FORBID_ATTR:['style']});
  for(const a of node.querySelectorAll('a')){a.target='_blank';a.rel='noopener noreferrer';}
  for(const pre of node.querySelectorAll('pre')){
    const wrap=el('div','code-block-wrap');
    const copy=el('button','code-copy-btn','复制代码');
    copy.type='button';
    copy.onclick=async()=>{
      try{
        await navigator.clipboard.writeText(pre.textContent||'');
        copy.textContent='已复制';
        setTimeout(()=>{copy.textContent='复制代码';},1600);
      }catch{toast('无法访问剪贴板');}
    };
    pre.replaceWith(wrap);
    wrap.append(pre,copy);
  }
  return node;
}

function buildOutline(pane){
  outlineObserver?.disconnect();
  document.querySelector('.conversation-outline')?.remove();
  const questions=[...pane.querySelectorAll('.message.user')];
  if(!questions.length)return;
  const rail=el('div','conversation-outline'),bars=el('div','outline-bars'),menu=el('div','outline-menu');
  menu.append(el('div','outline-title','提问目录 · '+questions.length));
  const buttons=[];
  questions.forEach((q,i)=>{
    const text=q.querySelector('.message-text')?.textContent||'图片消息',bar=el('button','outline-bar'),item=el('button','outline-item',`${i+1}　${text.replace(/\s+/g,' ').slice(0,90)}`);
    bar.type='button';item.type='button';
    bar.setAttribute('aria-label','跳转到提问 '+(i+1));item.title=text.slice(0,180);
    const jump=()=>q.scrollIntoView({behavior:'smooth',block:'start'});
    bar.onclick=jump;item.onclick=jump;bars.append(bar);menu.append(item);buttons.push([bar,item]);
  });
  rail.append(bars,menu);document.body.append(rail);
  const activate=i=>buttons.forEach((pair,j)=>pair.forEach(b=>b.classList.toggle('active',i===j)));
  activate(0);
  outlineObserver=new IntersectionObserver(entries=>{
    for(const entry of entries)if(entry.isIntersecting)activate(questions.indexOf(entry.target));
  },{root:pane,rootMargin:'0px 0px -65% 0px'});
  questions.forEach(q=>outlineObserver.observe(q));
}

function showSchedule(config){
  if(!config)return;
  if(!scheduleDirty&&!schedulePending){$('#schedule-enabled').checked=config.enabled;$('#schedule-interval').value=config.intervalMinutes;}
  $('#schedule-status').textContent=!config.enabled?'定时同步已关闭，仍可手动更新。':state?.sync.running?'正在同步，完成后安排下一次检查。':config.nextRun?'下次检查：'+date(config.nextRun)+'（应用运行期间）':'等待当前同步完成。';
}
async function loadSchedule(){try{showSchedule(await api('sync-schedule'));}catch(e){$('#schedule-status').textContent='无法读取定时配置：'+e.message;}}
for(const id of ['schedule-enabled','schedule-interval'])$('#'+id).oninput=()=>{scheduleDirty=true;};
$('#sync-schedule-form').onsubmit=async event=>{
  event.preventDefault();if(schedulePending)return;
  const minutes=Number($('#schedule-interval').value);
  if(!Number.isInteger(minutes)||minutes<1||minutes>1440){toast('请输入 1–1440 的整数分钟');return;}
  schedulePending=true;$('#schedule-save').disabled=true;
  try{
    const result=await api('sync-schedule',{enabled:$('#schedule-enabled').checked,intervalMinutes:minutes});
    scheduleDirty=false;toast('定时同步配置已保存');showSchedule(result);
  }catch(e){toast(e.message);}
  finally{schedulePending=false;$('#schedule-save').disabled=false;}
};

function highlightMatches(root){
  for(const mark of root.querySelectorAll('mark.search-hit'))mark.replaceWith(document.createTextNode(mark.textContent));
  root.normalize();
  const terms=[...new Set(query.trim().split(/\s+/).filter(Boolean))].sort((a,b)=>b.length-a.length);
  if(!terms.length)return;
  const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const pattern=new RegExp(terms.map(escape).join('|'),'giu');
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);const nodes=[];
  while(walker.nextNode())if(!walker.currentNode.parentElement.closest('button,.source-path,.message-head,.conv-source-tag,script,style'))nodes.push(walker.currentNode);
  for(const node of nodes){
    const text=node.data;const matches=[...text.matchAll(pattern)];if(!matches.length)continue;
    const fragment=document.createDocumentFragment();let start=0;
    for(const match of matches){fragment.append(document.createTextNode(text.slice(start,match.index)),el('mark','search-hit',match[0]));start=match.index+match[0].length;}
    fragment.append(document.createTextNode(text.slice(start)));node.replaceWith(fragment);
  }
}
