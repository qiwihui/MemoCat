(() => {
  'use strict';
  if(globalThis.__memoCatCapture)return;globalThis.__memoCatCapture=true;
  let invalidated=false,sidebar;
  function toggleSidebar(close=false){if(sidebar){sidebar.remove();sidebar=null;return;}if(close||invalidated)return;sidebar=document.createElement('div');sidebar.id='memocat-sidebar';const root=sidebar.attachShadow({mode:'closed'});const frame=document.createElement('iframe');frame.src=chrome.runtime.getURL('sidebar.html');frame.title='MemoCat 对话资料库';frame.style.cssText='display:block;width:100%;height:100%;border:0;background:#f7f8fc';sidebar.style.cssText='position:fixed!important;right:0!important;top:0!important;width:min(420px,100vw)!important;height:100dvh!important;z-index:2147483647!important;background:#f7f8fc!important;box-shadow:0 0 0 1px rgba(0,0,0,.05),-4px 0 24px rgba(0,0,0,.08),-2px 0 8px rgba(0,0,0,.04)!important;border-left:1px solid rgba(0,0,0,.08)!important';root.append(frame);document.documentElement.append(sidebar);}
  let config={autoSave:false,enabled:false},timer,maxTimer,inflight=false,again=false,lastSignature='',lastURL=location.href,draftId=crypto.randomUUID(),lastCount=0,retryAt=0,routeVersion=0;
  const supported=()=>typeof MemoCore==='undefined'||Boolean(MemoCore.platformFor(location.href));
  let wasSupported=supported();
  const stale=error=>/extension (?:context|content) invalidated/i.test(error?.message||'');
  const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
  const DEFAULT_WIDGET={edge:'right',offsetX:18,top:18,collapsed:false};
  let widgetState={...DEFAULT_WIDGET},dragging=false,dragMoved=false,suppressClickUntil=0,dragStart=null;
  function normalizeWidget(raw){
    const w=raw&&typeof raw==='object'?raw:{};
    const edge=w.edge==='left'?'left':'right';
    const offsetX=Number.isFinite(w.offsetX)?w.offsetX:DEFAULT_WIDGET.offsetX;
    const top=Number.isFinite(w.top)?w.top:DEFAULT_WIDGET.top;
    return {edge,offsetX,top,collapsed:Boolean(w.collapsed)};
  }
  function stop(){if(invalidated)return;invalidated=true;toggleSidebar(true);config.enabled=false;again=false;clearTimeout(timer);clearTimeout(maxTimer);clearInterval(poll);observer.disconnect();document.removeEventListener('visibilitychange',visible);window.removeEventListener('popstate',route);window.removeEventListener?.('resize',clampAndApply);status('扩展已更新，请刷新页面','paused');button.disabled=true;}
  const call=async message=>{try{if(invalidated||!chrome.runtime?.id){stop();throw new Error('扩展已更新，请刷新页面');}const r=await chrome.runtime.sendMessage(message);if(!r?.ok)throw new Error(r?.error||'扩展暂不可用，请刷新页面');return r.data;}catch(error){if(stale(error)){stop();throw new Error('扩展已更新，请刷新页面');}throw error;}};
  const host=document.createElement('div');host.id='memocat-capture';host.hidden=!wasSupported;const shadow=host.attachShadow({mode:'closed'}),style=document.createElement('style');
  style.textContent=':host{all:initial;position:fixed;right:18px;top:18px;z-index:2147483646;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}.pill{display:inline-flex;align-items:center;height:36px;padding:0 10px 0 8px;border-radius:18px;background:rgba(255,255,255,.94);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);box-shadow:0 4px 20px rgba(2,4,26,.14),0 0 0 .5px rgba(0,0,0,.08);color:#1f2937;font:500 12.5px/1 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;transition:box-shadow .2s,padding .18s;touch-action:none;user-select:none;cursor:grab}.pill[data-edge="right"]{flex-direction:row-reverse;padding:0 8px 0 10px}.pill.is-dragging{cursor:grabbing;box-shadow:0 10px 28px rgba(2,4,26,.22),0 0 0 .5px rgba(0,0,0,.12)}.pill:hover{box-shadow:0 6px 24px rgba(2,4,26,.18),0 0 0 .5px rgba(0,0,0,.1)}.logo-wrap{position:relative;width:20px;height:20px;flex-shrink:0;display:flex;align-items:center;justify-content:center;cursor:pointer;border:0;background:none;padding:0}.logo-wrap img{width:20px;height:20px;display:block;border-radius:5px;pointer-events:none}.dot{position:absolute;right:-1px;bottom:-1px;width:7px;height:7px;border-radius:50%;background:#28cd41;border:1.5px solid #fff}.dot.paused{background:#ff9500}.expandable{display:inline-flex;align-items:center;gap:6px;max-width:260px;opacity:1;overflow:hidden;margin-left:6px;transition:max-width .2s ease,opacity .16s ease,margin .18s ease}.pill[data-edge="right"] .expandable{margin-left:0;margin-right:6px}.pill.collapsed{padding:0 8px}.pill.collapsed .expandable{max-width:0;opacity:0;margin:0;pointer-events:none}.pill.collapsed:hover,.pill.collapsed:focus-within{padding:0 10px 0 8px}.pill.collapsed[data-edge="right"]:hover,.pill.collapsed[data-edge="right"]:focus-within{padding:0 8px 0 10px}.pill.collapsed:hover .expandable,.pill.collapsed:focus-within .expandable{max-width:260px;opacity:1;margin-left:6px;pointer-events:auto}.pill.collapsed[data-edge="right"]:hover .expandable,.pill.collapsed[data-edge="right"]:focus-within .expandable{margin-left:0;margin-right:6px}.action{border:0;background:transparent;color:inherit;font:inherit;padding:4px 2px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center}.action:hover{color:#4c64cb}.action:disabled{opacity:.6;cursor:wait}.status-viewport{width:112px;overflow:hidden;white-space:nowrap;display:inline-flex;align-items:center}.status-track{display:inline-flex;align-items:center;white-space:nowrap;will-change:transform}.status-track.is-scrolling{animation:memocat-marquee var(--marquee-dur,6s) linear infinite}.status-text,.status-dup{display:inline-block;white-space:nowrap}.status-dup{display:none}.status-track.is-scrolling .status-text{padding-right:28px}.status-track.is-scrolling .status-dup{display:inline-block;padding-right:28px}@keyframes memocat-marquee{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}.open-side{border:0;background:#eef2ff;color:#4c64cb;border-radius:10px;padding:4px 8px;font:500 11px/1 inherit;cursor:pointer;white-space:nowrap;flex-shrink:0}.open-side:hover{background:#e0e7ff}.collapse-btn{border:0;background:transparent;color:#94a3b8;width:20px;height:20px;border-radius:10px;padding:0;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;font-size:13px;line-height:1}.collapse-btn:hover{background:#f1f5f9;color:#475569}';
  const wrap=document.createElement('div');wrap.className='pill';wrap.dataset&&(wrap.dataset.edge='right');
  const logoBtn=document.createElement('button');logoBtn.type='button';logoBtn.className='logo-wrap';logoBtn.title='打开 MemoCat 侧边栏（按住可拖拽）';
  const logoImg=document.createElement('img');logoImg.src=chrome.runtime.getURL('icons/icon64.png');logoImg.alt='';
  const dot=document.createElement('span');dot.className='dot';logoBtn.append(logoImg,dot);
  const expandable=document.createElement('div');expandable.className='expandable';
  const button=document.createElement('span');button.setAttribute?.('role','button');button.tabIndex=0;button.className='action';button.title='点击立即保存当前页面对话';
  const statusViewport=document.createElement('span');statusViewport.className='status-viewport';
  const statusTrack=document.createElement('span');statusTrack.className='status-track';
  const statusText=document.createElement('span');statusText.className='status-text';statusText.textContent='保存此对话';
  const statusDup=document.createElement('span');statusDup.className='status-dup';statusDup.setAttribute?.('aria-hidden','true');
  statusTrack.append(statusText,statusDup);statusViewport.append(statusTrack);button.append(statusViewport);
  expandable.append(button);
  logoBtn.onclick=()=>{if(Date.now()<suppressClickUntil)return;toggleSidebar();};
  wrap.append(logoBtn,expandable);shadow.append(style,wrap);document.documentElement.append(host);
  function syncMarquee(){
    if(typeof requestAnimationFrame!=='function')return;
    requestAnimationFrame(()=>{
      if(invalidated)return;
      statusTrack.classList?.remove('is-scrolling');
      statusDup.textContent='';
      const viewW=statusViewport.clientWidth||112;
      const textW=statusText.scrollWidth||0;
      if(textW>viewW+1){
        statusDup.textContent=statusText.textContent;
        statusTrack.style?.setProperty('--marquee-dur',Math.max(4,(textW+28)/34).toFixed(2)+'s');
        statusTrack.classList?.add('is-scrolling');
      }
    });
  }
  let peeking=false,peekTimer;
  function updateCollapsed(){wrap.classList?.toggle('collapsed',!(peeking||dragging));}
  function peek(){peeking=true;updateCollapsed();clearTimeout(peekTimer);peekTimer=setTimeout(()=>{peeking=false;updateCollapsed();},3500);}
  function applyWidget(){
    const vw=typeof window!=='undefined'&&Number.isFinite(window.innerWidth)?window.innerWidth:1280;
    const vh=typeof window!=='undefined'&&Number.isFinite(window.innerHeight)?window.innerHeight:800;
    const h=wrap.getBoundingClientRect?.().height||36;
    const w=wrap.getBoundingClientRect?.().width||36;
    widgetState.top=clamp(Math.round(widgetState.top),8,Math.max(8,vh-h-8));
    widgetState.offsetX=clamp(Math.round(widgetState.offsetX),8,Math.max(8,vw-w-8));
    if(host.style){
      host.style.top=widgetState.top+'px';
      if(widgetState.edge==='left'){host.style.left=widgetState.offsetX+'px';host.style.right='auto';}
      else{host.style.right=widgetState.offsetX+'px';host.style.left='auto';}
    }
    if(wrap.dataset)wrap.dataset.edge=widgetState.edge;
    updateCollapsed();
    syncMarquee();
  }
  function clampAndApply(){if(!dragging)applyWidget();}
  async function saveWidget(){try{await chrome.storage?.local?.set({floatingWidget:widgetState});}catch{}}
  async function loadWidget(){try{const row=await chrome.storage?.local?.get('floatingWidget');if(row?.floatingWidget)widgetState=normalizeWidget(row.floatingWidget);applyWidget();}catch{applyWidget();}}
  wrap.addEventListener?.('click',e=>{if(Date.now()<suppressClickUntil){e.preventDefault();e.stopPropagation();}},true);
  wrap.addEventListener?.('mouseenter',()=>syncMarquee());
  wrap.addEventListener?.('focusin',()=>syncMarquee());
  wrap.addEventListener?.('pointerdown',e=>{
    if(e.button!==0||!host.style||!wrap.getBoundingClientRect)return;
    const rect=wrap.getBoundingClientRect();
    dragging=true;dragMoved=false;updateCollapsed();
    dragStart={x:e.clientX,y:e.clientY,left:rect.left,top:rect.top,w:rect.width,h:rect.height,pid:e.pointerId};
  });
  wrap.addEventListener?.('pointermove',e=>{
    if(!dragging||!dragStart)return;
    const dx=e.clientX-dragStart.x,dy=e.clientY-dragStart.y;
    if(!dragMoved&&Math.hypot(dx,dy)<5)return;
    if(!dragMoved){dragMoved=true;wrap.classList?.add('is-dragging');try{wrap.setPointerCapture?.(dragStart.pid);}catch{}}
    const vw=window.innerWidth||1280,vh=window.innerHeight||800;
    const left=clamp(Math.round(dragStart.left+dx),8,Math.max(8,vw-dragStart.w-8));
    const top=clamp(Math.round(dragStart.top+dy),8,Math.max(8,vh-dragStart.h-8));
    host.style.left=left+'px';host.style.right='auto';host.style.top=top+'px';
  });
  const endDrag=e=>{
    if(!dragging)return;
    const moved=dragMoved;
    dragging=false;dragMoved=false;wrap.classList?.remove('is-dragging');updateCollapsed();
    try{wrap.releasePointerCapture?.(e.pointerId);}catch{}
    if(moved&&wrap.getBoundingClientRect){
      suppressClickUntil=Date.now()+250;
      const rect=wrap.getBoundingClientRect();
      const vw=window.innerWidth||1280,vh=window.innerHeight||800;
      const centerX=rect.left+rect.width/2;
      const edge=centerX<vw/2?'left':'right';
      const offsetX=edge==='left'?rect.left:Math.max(8,vw-rect.right);
      widgetState={...widgetState,edge,offsetX:clamp(Math.round(offsetX),8,Math.max(8,vw-rect.width-8)),top:clamp(Math.round(rect.top),8,Math.max(8,vh-rect.height-8))};
      applyWidget();
      void saveWidget();
    }
    dragStart=null;
  };
  wrap.addEventListener?.('pointerup',endDrag);
  wrap.addEventListener?.('pointercancel',endDrag);
  window.addEventListener?.('resize',clampAndApply);
  function status(text,mode){
    const full=text;
    statusText.textContent=full;
    button.title=full+'（点击立即保存）';
    dot.classList?.toggle('paused',mode==='paused'||(!config.autoSave&&mode!=='ok'));
    syncMarquee();peek();
  }
  async function capture(manual=false,{replace=false,targetDraftId=''}={}){route();if(!supported())return {paused:true};if(inflight){again=true;return {busy:true};}if(manual&&!config.enabled){await refresh();if(invalidated)return {error:'扩展已更新，请刷新页面'};if(inflight){again=true;return {busy:true};}}if(!config.enabled||!manual&&!config.autoSave)return {paused:true};if(!manual&&(document.hidden||Date.now()<retryAt))return {paused:true};
    if(!manual&&MemoAdapters.streaming(document)){schedule();return {streaming:true};}
    inflight=true;button.disabled=true;try{
      if(!manual&&!MemoCore.conversationKey(location.href)){status('新对话等待网址');return {draft:true};}
      const version=routeVersion;const useDraftId=targetDraftId||draftId;const conversation=MemoAdapters.extract(document,location.href,useDraftId),signature=MemoCore.hash(JSON.stringify([conversation.id,conversation.title,conversation.messages]));
      if(!manual&&!replace&&signature===lastSignature)return {unchanged:true,count:lastCount};
      const result=await call({type:'observe',conversation,manual,replace});if(version!==routeVersion||conversation.url!==MemoCore.canonicalURL(location.href)||result.stale){route();schedule();return {stale:true};}if(!result.paused){lastSignature=signature;lastCount=result.count||0;status(result.suppressed?'此对话已删除':replace?`已重新采集 ${lastCount} 条`:`已保存 ${lastCount} 条`,result.suppressed?'paused':'ok');}else status('采集已暂停','paused');return result;
    }catch(e){if(invalidated)return {error:'扩展已更新，请刷新页面'};if(manual)status(e.message);else status('等待对话 / 点击重试');retryAt=Date.now()+10000;if(manual)throw e;return {error:e.message};}
    finally{inflight=false;button.disabled=invalidated;if(again&&!invalidated){again=false;schedule();}}
  }
  function schedule(){if(invalidated||!supported()||!config.autoSave||!config.enabled)return;clearTimeout(timer);timer=setTimeout(run,1600);if(!maxTimer)maxTimer=setTimeout(run,12000);}
  function run(){clearTimeout(timer);clearTimeout(maxTimer);maxTimer=null;void capture();}
  button.onclick=()=>{if(Date.now()<suppressClickUntil)return;void capture(true).catch(()=>{});};
  const observer=new MutationObserver(mutations=>{route();if(!supported())return;if(mutations.every(m=>m.target===host||host.contains(m.target)))return;schedule();});observer.observe(document.body||document.documentElement,{subtree:true,childList:true,characterData:true});
  function route(){if(location.href===lastURL)return;lastURL=location.href;routeVersion++;retryAt=0;lastCount=0;clearTimeout(timer);clearTimeout(maxTimer);maxTimer=null;draftId=crypto.randomUUID();lastSignature='';const nowSupported=supported(),prevSupported=wasSupported;wasSupported=nowSupported;if(!nowSupported){host.hidden=true;toggleSidebar(true);config.enabled=false;return;}status('保存此对话');if(!prevSupported){void refresh();return;}schedule();}
  const poll=setInterval(()=>{try{if(!chrome.runtime?.id){stop();return;}}catch(error){if(stale(error)){stop();return;}throw error;}route();},500);
  const refresh=async()=>{if(!supported()){host.hidden=true;config={autoSave:false,enabled:false};return;}try{config=await call({type:'captureSettings'});host.hidden=!config.enabled;if(!config.autoSave)status('手动保存','paused');else{status('自动保存','ok');schedule();}applyWidget();}catch{if(!invalidated)status('请刷新页面','paused');}};
  try{chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.settings)void refresh();if(area==='local'&&changes.floatingWidget?.newValue&&!dragging){widgetState=normalizeWidget(changes.floatingWidget.newValue);applyWidget();}});
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{if(sender.id!==chrome.runtime.id)return false;if(message.type==='toggleSidebar'||message.type==='closeSidebar'){if(!supported()&&message.type==='toggleSidebar'){respond({ok:false});return false;}toggleSidebar(message.type==='closeSidebar');respond({ok:true});return false;}if(message.type!=='captureNow')return false;void capture(true,{replace:message.replace===true,targetDraftId:typeof message.draftId==='string'?message.draftId:''}).then(data=>respond(data),error=>respond({error:error.message}));return true;});}catch(error){if(stale(error))stop();else throw error;}
  function visible(){if(!document.hidden&&supported()){route();schedule();}}
  document.addEventListener('visibilitychange',visible);window.addEventListener('popstate',route);
  window.addEventListener('pagehide',()=>{clearInterval(poll);clearTimeout(timer);clearTimeout(maxTimer);observer.disconnect();window.removeEventListener?.('resize',clampAndApply);},{once:true});
  void loadWidget();
  void refresh();
})();
