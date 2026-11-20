/* Independent implementation. Shared by the worker, content scripts and tests. */
(() => {
  'use strict';
  const platforms = [
    {id:'chatgpt',name:'ChatGPT',hosts:['chatgpt.com','chat.openai.com'],url:'https://chatgpt.com/'},
    {id:'claude',name:'Claude',hosts:['claude.ai'],url:'https://claude.ai/'},
    {id:'gemini',name:'Gemini',hosts:['gemini.google.com'],url:'https://gemini.google.com/'},
    {id:'deepseek',name:'DeepSeek',hosts:['chat.deepseek.com'],url:'https://chat.deepseek.com/'},
    {id:'yuanbao',name:'腾讯元宝',hosts:['yuanbao.tencent.com'],url:'https://yuanbao.tencent.com/'},
    {id:'doubao',name:'豆包',hosts:['www.doubao.com'],url:'https://www.doubao.com/'},
    {id:'kimi',name:'Kimi',hosts:['kimi.moonshot.cn','kimi.com'],url:'https://www.kimi.com/'},
    {id:'qianwen',name:'千问',hosts:['qianwen.com','www.qianwen.com'],url:'https://www.qianwen.com/'},
    {id:'grok',name:'Grok',hosts:['grok.com','www.grok.com','x.com'],url:'https://x.com/i/grok'}
  ];
  const MAX_MESSAGES=10000, MAX_TEXT=500000, MAX_BYTES=8*1024*1024;
  const defaults=()=>({autoSave:false,platforms:Object.fromEntries(platforms.map(p=>[p.id,true])),sync:{enabled:false,url:'http://127.0.0.1:3792',token:''}});
  function platformFor(url){try{const u=new URL(url);if(u.protocol!=='https:')return null;return platforms.find(p=>{if(p.id==='grok'&&u.hostname==='x.com')return u.pathname==='/i/grok'||u.pathname.startsWith('/i/grok/');if(p.id==='kimi'&&u.hostname.endsWith('.kimi.com'))return true;return p.hosts.includes(u.hostname);})||null;}catch{return null;}}
  function canonicalURL(url){const u=new URL(url),p=platformFor(u.href);if(!p)throw new Error('不支持的来源网址');u.hash='';const session=u.searchParams.get('sessionId'),conversation=u.searchParams.get('conversation');u.search='';if(p.id==='qianwen'&&session)u.searchParams.set('sessionId',session);if(p.id==='grok'&&conversation)u.searchParams.set('conversation',conversation);return u.href;}
  function conversationKey(url){const u=new URL(canonicalURL(url)),p=platformFor(url);let id;
    if(p.id==='chatgpt')id=u.pathname.match(/\/c\/([^/]+)/)?.[1];
    else if(p.id==='claude')id=u.pathname.match(/\/chat\/([^/]+)/)?.[1];
    else if(p.id==='gemini')id=u.pathname.match(/\/app\/([^/]+)/)?.[1];
    else if(p.id==='deepseek')id=u.pathname.match(/\/(?:a\/chat|chat)\/s\/([^/]+)/)?.[1];
    else if(p.id==='doubao')id=u.pathname.match(/\/chat\/([^/]+)/)?.[1];
    else if(p.id==='yuanbao')id=u.pathname.match(/\/chat\/(.+?)\/?$/)?.[1];
    else if(p.id==='kimi')id=u.pathname.match(/\/(?:chat|c)\/([^/]+)/)?.[1];
    else if(p.id==='qianwen')id=u.pathname.match(/\/(?:chat|c)\/([^/]+)/)?.[1]||new URL(url).searchParams.get('sessionId');
    else if(p.id==='grok')id=u.searchParams.get('conversation')||u.pathname.match(/\/(?:c|chat|share)\/([^/]+)/)?.[1]||u.pathname.match(/\/i\/grok\/([^/]+)/)?.[1];
    return id?`${p.id}:${id}`:null;
  }
  function hash(text){let a=2166136261,b=5381;for(let i=0;i<text.length;i++){a=Math.imul(a^text.charCodeAt(i),16777619);b=Math.imul(b,33)^text.charCodeAt(i);}return (a>>>0).toString(36)+(b>>>0).toString(36);}
  function normalizeMessage(m,index){if(!m||!['user','assistant'].includes(m.role)||typeof m.text!=='string'||m.text.length>MAX_TEXT)throw new Error('消息格式或长度无效');const text=m.text.replace(/\r\n/g,'\n').trim();if(!text)throw new Error('消息不能为空');
    return {id:typeof m.id==='string'&&m.id.length<=300?m.id:'',role:m.role,text,index,at:typeof m.at==='string'&&Number.isFinite(Date.parse(m.at))?new Date(m.at).toISOString():null};}
  function validateConversation(input){if(!input||typeof input!=='object'||Array.isArray(input)||!Array.isArray(input.messages)||!input.messages.length||input.messages.length>MAX_MESSAGES)throw new Error('对话格式无效');
    if(new TextEncoder().encode(JSON.stringify(input)).length>MAX_BYTES)throw new Error('单个对话超过 8 MiB，请分段保存');
    const url=canonicalURL(input.url),p=platformFor(url),native=conversationKey(input.url);
    if(input.platform!==p.id||typeof input.id!=='string'||input.id.length>600||!input.id.startsWith(p.id+':'))throw new Error('对话身份无效');
    if(native&&input.id!==native)throw new Error('对话标识与网址不符');
    if(!native&&!input.id.startsWith(p.id+':draft:'))throw new Error('临时会话标识无效');
    const messages=input.messages.map(normalizeMessage);const ids=new Set();for(const m of messages){if(m.id){if(ids.has(m.id))throw new Error('消息标识重复');ids.add(m.id);}}
    const date=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))?new Date(x).toISOString():new Date().toISOString();
    return {id:input.id,platform:p.id,url,title:typeof input.title==='string'?input.title.trim().slice(0,240)||'未命名对话':'未命名对话',messages,createdAt:date(input.createdAt),updatedAt:date(input.updatedAt)};
  }
  // Observations are partial windows. Match stable DOM IDs first, exact text second.
  // Ambiguous edited/branched content is retained as a separate observation, never truncating old history.
  function reconcile(previous,incoming){const c=validateConversation(incoming),now=new Date().toISOString();
    if(!previous)return {...c,createdAt:c.createdAt,updatedAt:now,messages:c.messages.map((m,i)=>({...m,id:m.id||crypto.randomUUID(),index:i,at:m.at||now})),revision:1};
    const messages=previous.messages.map(m=>({...m})),used=new Set();let cursor=-1,changed=previous.title!==c.title||previous.url!==c.url;
    for(const m of c.messages){let at=m.id?messages.findIndex(x=>x.id===m.id):-1;
      if(at<0)at=messages.findIndex((x,i)=>i>cursor&&!used.has(i)&&x.role===m.role&&x.text===m.text);
      if(at>=0){used.add(at);cursor=at;if(messages[at].role!==m.role)throw new Error('消息角色发生冲突');if(messages[at].text!==m.text){messages[at]={...messages[at],text:m.text};changed=true;}continue;}
      // Preserve the relative order of new messages inside an observed window.
      const nextIncoming=c.messages.slice(c.messages.indexOf(m)+1).find(x=>x.id&&messages.some(y=>y.id===x.id));
      const nextIndex=nextIncoming?messages.findIndex(x=>x.id===nextIncoming.id):-1;
      const insert=cursor<0&&nextIndex>=0?nextIndex:cursor>=0?cursor+1:messages.length;
      messages.splice(insert,0,{...m,id:m.id||crypto.randomUUID(),at:m.at||now});
      const shifted=[...used].map(i=>i>=insert?i+1:i);used.clear();shifted.forEach(i=>used.add(i));used.add(insert);cursor=insert;changed=true;
    }
    if(!changed)return previous;
    const merged={...previous,title:c.title,url:c.url,messages:messages.map((m,index)=>({...m,index})),updatedAt:now,revision:(previous.revision||0)+1};
    validateConversation(merged);return merged;
  }
  function replace(previous,incoming){const c=validateConversation(incoming),now=new Date().toISOString();
    const messages=c.messages.map((m,i)=>({...m,id:m.id||crypto.randomUUID(),index:i,at:m.at||now}));
    const next={...c,title:c.title!=='未命名对话'?c.title:(previous?.title||c.title),createdAt:previous?.createdAt||c.createdAt,updatedAt:now,messages,revision:(previous?.revision||0)+1};
    validateConversation(next);return next;
  }
  function validateSettings(patch){if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(k=>!['autoSave','platforms','sync'].includes(k)))throw new Error('设置无效');
    if(patch.autoSave!==undefined&&typeof patch.autoSave!=='boolean')throw new Error('自动保存开关无效');
    if(patch.platforms!==undefined&&(!patch.platforms||typeof patch.platforms!=='object'||Array.isArray(patch.platforms)||Object.entries(patch.platforms).some(([k,v])=>!platforms.some(p=>p.id===k)||typeof v!=='boolean')))throw new Error('平台设置无效');
    if(patch.sync!==undefined){const s=patch.sync;if(!s||Object.keys(s).some(k=>!['enabled','url','token'].includes(k))||typeof s.enabled!=='boolean'||typeof s.token!=='string'||s.token.length>256)throw new Error('同步设置无效');const u=new URL(s.url);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.pathname!=='/'||u.search||u.hash||u.username||u.password)throw new Error('仅支持 http://127.0.0.1:端口');if(s.token&&!/^[a-f0-9]{64}$/.test(s.token))throw new Error('连接密钥格式无效');}
    return patch;
  }
  const markdown=c=>`# ${c.title}\n\n来源：${c.url}\n\n`+c.messages.map(m=>`## ${m.role==='user'?'你':'AI'}\n\n${m.text}`).join('\n\n---\n\n')+'\n';
  function currentCapture(c,senderURL,currentURL){try{return new URL(senderURL).origin===new URL(currentURL).origin&&c.platform===platformFor(currentURL)?.id&&c.url===canonicalURL(currentURL)&&(!conversationKey(currentURL)||c.id===conversationKey(currentURL));}catch{return false;}}
  globalThis.MemoCore={currentCapture,platforms,defaults,platformFor,canonicalURL,conversationKey,hash,validateConversation,reconcile,replace,validateSettings,markdown,MAX_BYTES};
})();
