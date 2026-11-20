export async function call(type,args={}){let response;try{if(!chrome.runtime?.id)throw new Error('Extension context invalidated');response=await chrome.runtime.sendMessage({type,...args});}catch(error){if(/extension (?:context|content) invalidated/i.test(error.message))throw new Error('扩展已更新，请关闭并重新打开此扩展页面；AI 对话页面请刷新后再保存');throw error;}if(!response?.ok)throw new Error(response?.error||'后台未响应，请在扩展管理页重新加载');return response.data;}
export const element=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
export function download(text,name,type='application/json'){const url=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
export const platform=id=>MemoCore.platforms.find(p=>p.id===id)?.name||id;
export const date=value=>new Date(value).toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});

const EXT_THEME_KEY='memocat-ext-theme';
export const themeLabels={system:'系统',light:'浅色',dark:'深色'};
const validTheme=v=>['system','light','dark'].includes(v)?v:'system';
const darkQuery=typeof window!=='undefined'&&window.matchMedia?window.matchMedia('(prefers-color-scheme: dark)'):null;

export function readThemePref(){
  try{return validTheme(localStorage.getItem(EXT_THEME_KEY));}
  catch{return 'system';}
}
export function applyThemePref(pref,onChange){
  const valid=validTheme(pref);
  const effective=valid==='system'?(darkQuery?.matches?'dark':'light'):valid;
  document.documentElement.dataset.theme=effective;
  document.documentElement.style.colorScheme=effective;
  onChange?.(valid,effective);
  return {pref:valid,effective};
}
export async function setThemePref(pref,onChange){
  const valid=validTheme(pref);
  try{localStorage.setItem(EXT_THEME_KEY,valid);}catch{}
  try{await chrome.storage?.local?.set({extTheme:valid});}catch{}
  return applyThemePref(valid,onChange);
}
export function initTheme(onChange){
  let current=readThemePref();
  applyThemePref(current,onChange);
  chrome.storage?.local?.get('extTheme').then(row=>{
    if(row?.extTheme){
      current=validTheme(row.extTheme);
      try{localStorage.setItem(EXT_THEME_KEY,current);}catch{}
      applyThemePref(current,onChange);
    }
  }).catch(()=>{});
  darkQuery?.addEventListener('change',()=>{
    if(readThemePref()==='system')applyThemePref('system',onChange);
  });
  chrome.storage?.onChanged?.addListener((changes,area)=>{
    if(area==='local'&&changes.extTheme?.newValue){
      const next=validTheme(changes.extTheme.newValue);
      try{localStorage.setItem(EXT_THEME_KEY,next);}catch{}
      applyThemePref(next,onChange);
    }
  });
  return {
    cycle:async()=>{
      const order=['system','light','dark'];
      const next=order[(order.indexOf(readThemePref())+1)%order.length];
      return setThemePref(next,onChange);
    },
    set:pref=>setThemePref(pref,onChange)
  };
}
