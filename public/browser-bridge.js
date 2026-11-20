const host=document.getElementById('backup-panel');
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n;};
async function api(data){const res=await fetch('/api/browser/config',data===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}),value=await res.json();if(!res.ok)throw new Error(value.error);return value;}
if(host){
 const card=el('section','','card browser-bridge-card');
 const head=el('div','','bridge-head');
 const titleWrap=el('div','','bridge-title-wrap');
 const heading=el('h2','浏览器对话归档');
 const badge=el('span','等待连接','bridge-badge');
 titleWrap.append(heading,badge);
 head.append(titleWrap);

 const desc=el('p','在 Chrome / Edge 中加载 MemoCat 扩展后，在扩展中点击「一键连接 MemoCat 并同步」即可自动完成本机配对，无需手动复制扩展 ID 或连接密钥。');
 const form=el('form');
 const enableLabel=el('label','','bridge-toggle-row');
 const enableText=el('span','允许浏览器扩展自动连接');
 const enabled=el('input','','switch');
 enabled.type='checkbox';
 enabled.setAttribute('aria-label','允许浏览器扩展自动连接');
 enableLabel.append(enableText,enabled);

 const idLabel=el('label','已绑定扩展 ID');
 const id=el('input','','source-input');
 id.placeholder='等待浏览器扩展发起连接…';
 id.readOnly=true;
 id.autocomplete='off';
 idLabel.append(id);

 const actions=el('div','','source-actions');
 const rotate=el('button','重置密钥','secondary');
 const disconnect=el('button','解除绑定','secondary');
 rotate.type='button';
 disconnect.type='button';
 actions.append(rotate,disconnect);

 const secret=el('input');
 secret.type='hidden';
 secret.readOnly=true;
 secret.setAttribute('aria-label','浏览器连接密钥');

 const stats=el('p','','source-config-stats');
 const status=el('p','','bridge-status');
 status.setAttribute('role','status');
 const note=el('p','本机监听地址：'+location.origin+'。同步后可在对话记录与记忆召回中选择网页来源。','source-config-note');

 form.append(enableLabel,idLabel,actions);
 card.append(head,desc,form,secret,stats,status,note);
 host.append(card);

 let updating=false;
 const render=c=>{
  if(!updating){
   id.value=c.extensionId||'';
   enabled.checked=c.enabled;
   secret.value=c.token||'';
   rotate.disabled=disconnect.disabled=!c.extensionId&&!c.token;
  }
  const connected=Boolean(c.enabled&&c.extensionId);
  badge.textContent=!c.enabled?'已关闭':connected?'● 已连接':'等待连接';
  badge.classList.toggle('off',!connected);
  stats.textContent=`已保存 ${c.conversations||0} 个网页会话 · ${c.messages||0} 条消息`;
  const pairTime=c.lastPaired?'（配对于 '+new Date(c.lastPaired).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'})+'）':'';
  status.textContent=(!c.enabled?'已关闭浏览器扩展连接':c.extensionId?`● 已连接扩展 ${c.extensionId}${pairTime}`:'等待扩展连接（请在扩展中点击连接并同步）')+(c.lastSync?' · 最近同步 '+new Date(c.lastSync).toLocaleString('zh-CN'):' · 尚无同步记录');
 };
 async function update(patch){
  updating=true;
  enabled.disabled=rotate.disabled=disconnect.disabled=true;
  try{render(await api(patch));}
  catch(e){status.textContent=e.message;}
  finally{updating=false;enabled.disabled=false;}
 }
 async function poll(){if(updating)return;try{render(await api());}catch{}}
 enabled.onchange=()=>void update({enabled:enabled.checked});
 rotate.onclick=()=>{void update({rotate:true});};
 disconnect.onclick=()=>{void update({disconnect:true});};
 void poll();
 setInterval(poll,2000);
 window.addEventListener('focus',poll);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)void poll();});
}
