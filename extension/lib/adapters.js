(() => {
  'use strict';
  function parts(node,selector){return [...node.querySelectorAll(selector)].filter(n=>!n.closest('.thinking-container,.think-stage,[class*="deepThinkContent-"],[data-testid="thought-container"],[data-testid="grok-thought"]')&&!n.parentElement?.closest(selector));}
  function isVisible(n){
    if(!n||n.hidden||n.closest('[hidden],[aria-hidden="true"]'))return false;
    return n.getClientRects().length>0||[...n.querySelectorAll('*')].some(child=>!child.closest('[hidden],[aria-hidden="true"]')&&child.getClientRects().length>0);
  }
  const GROK_USER_SEL='[data-message-author-role="user"],[data-testid="user-message"],[data-role="user"]';
  const GROK_ASST_SEL='[data-message-author-role="assistant"],[data-testid="assistant-message"],[data-role="assistant"]';
  const GROK_ASST_HINT_SEL=GROK_ASST_SEL+',.response-content-markdown,button[aria-label*="Regenerate" i],button[aria-label*="重新生成"],button[aria-label*="Retry" i],button[aria-label*="重试"],button[aria-label*="Like" i],button[aria-label*="Dislike" i],button[aria-label*="Good response" i],button[aria-label*="Bad response" i],button[aria-label*="Upvote" i],button[aria-label*="Downvote" i]';
  const GROK_USER_EDIT_SEL='button[aria-label*="Edit" i],button[aria-label*="编辑"]';
  const GROK_INLINE_TAGS=new Set(['P','H1','H2','H3','H4','H5','H6','UL','OL','LI','PRE','BLOCKQUOTE','TABLE','HR','SPAN','A','CODE']);
  function grokExplicitUser(n){return n.matches(GROK_USER_SEL)||!!n.querySelector(GROK_USER_SEL);}
  function grokAssistantNode(n){return n.matches(GROK_ASST_HINT_SEL)||!!n.querySelector(GROK_ASST_HINT_SEL);}
  function grokUserEditOnly(n){return !grokAssistantNode(n)&&!!n.querySelector(GROK_USER_EDIT_SEL);}
  function grokExtractText(n){
    let b=parts(n,'.response-content-markdown,.markdown,[data-testid="tweetText"]');
    if(!b.length)b=parts(n,'[dir="auto"],[dir="ltr"]');
    const t=b.length?b.map(textOf).filter(Boolean).join('\n\n'):'';
    return t||textOf(n);
  }
  function grokStyleEnd(el,win){
    const cls=typeof el.className==='string'?el.className:'';
    if(/(?:^|\s)(?:items-end|justify-end|self-end|ml-auto|flex-row-reverse)(?:\s|$)|items-end|justify-end|self-end/.test(cls))return true;
    if(win?.getComputedStyle){
      const st=win.getComputedStyle(el);
      if(st.alignSelf==='flex-end'||st.alignSelf==='end'||st.justifyContent==='flex-end'||st.justifyContent==='end'||st.justifySelf==='flex-end'||st.justifySelf==='end'||st.flexDirection==='row-reverse')return true;
      const disp=String(st.display||'');
      if((disp==='flex'||disp==='inline-flex')&&String(st.flexDirection||'').startsWith('column')&&(st.alignItems==='flex-end'||st.alignItems==='end'))return true;
      const ml=parseFloat(st.marginLeft),mr=parseFloat(st.marginRight)||0;
      if(Number.isFinite(ml)&&ml>32&&ml>mr+32)return true;
    }
    return false;
  }
  function grokRectRightAligned(el,refRect){
    if(!el?.getBoundingClientRect)return false;
    const er=el.getBoundingClientRect();
    if(!(er.width>0))return false;
    const refs=[];
    if(refRect)refs.push(refRect);
    const pr=el.parentElement?.getBoundingClientRect?.();
    if(pr)refs.push(pr);
    for(const r of refs){
      if(!(r.width>er.width+40))continue;
      const leftGap=er.left-r.left,rightGap=r.right-er.right;
      if(leftGap>32&&rightGap>=-4&&leftGap>rightGap+32&&leftGap>Math.max(rightGap,1)*1.8)return true;
    }
    return false;
  }
  function grokAlignedEnd(node,container){
    const win=node.ownerDocument?.defaultView;
    const refContainer=container||node.closest?.('[data-testid="primaryColumn"],main')||node.ownerDocument?.body;
    const refRect=refContainer?.getBoundingClientRect?.()||null;
    let cur=node;
    for(let depth=0;cur&&depth<5;depth++){
      if(grokStyleEnd(cur,win)||grokRectRightAligned(cur,refRect))return true;
      const vis=[...(cur.children||[])].filter(k=>isVisible(k));
      if(vis.length===1){cur=vis[0];continue;}
      const textVis=vis.filter(k=>textOf(k).length>0);
      if(textVis.length===1){
        const tr=textVis[0].getBoundingClientRect?.();
        const hasLeftSibling=tr&&vis.some(s=>{
          if(s===textVis[0])return false;
          const sr=s.getBoundingClientRect?.();
          return sr&&sr.width>0&&sr.left<tr.left-4;
        });
        if(!hasLeftSibling){cur=textVis[0];continue;}
      }
      break;
    }
    let anc=node.parentElement;
    for(let depth=0;anc&&depth<4;depth++){
      if(anc===container||anc===node.ownerDocument?.body||anc.matches?.('[data-testid="primaryColumn"],main'))break;
      const textKids=[...(anc.children||[])].filter(k=>isVisible(k)&&textOf(k).length>0);
      if(textKids.length>1)break;
      if(grokAssistantNode(anc)&&!grokAssistantNode(node))break;
      if(grokStyleEnd(anc,win)||grokRectRightAligned(anc,refRect))return true;
      anc=anc.parentElement;
    }
    return false;
  }
  function grokExpandTurn(turnNode,container,ignored,allowStructuralSplit,depth=0){
    if(depth>3)return null;
    let box=turnNode;
    for(let u=0;u<8;u++){
      if(box.matches(GROK_USER_SEL+','+GROK_ASST_SEL+',.message-bubble'))break;
      const kids=[...box.children].filter(k=>!ignored(k));
      const textKids=kids.filter(k=>textOf(k).length>0);
      const markerKids=kids.filter(k=>grokAssistantNode(k));
      if(kids.length===1){box=kids[0];continue;}
      if(textKids.length===1&&markerKids.every(m=>m===textKids[0]||textOf(m).length===0)){box=textKids[0];continue;}
      break;
    }
    const textKids=[...box.children].filter(k=>!ignored(k)&&textOf(k).length>0);
    if(textKids.length<2)return null;
    const isThinkingOrMeta=t=>t.length<80&&/^(?:Grok(?:\s*\d+(?:\.\d+)?)?(?:\s*(?:Beta|Mini|Fast|Heavy|Think|Expert))?|(?:DeepSearch|DeeperSearch|Think|Thinking)(?:[.…·:]*|\s*\d+\s*[smh秒分]+)?|Thought for\s+[\d\s\w:.,]+|Searched(?:\s+\d+)?\s*(?:web pages?|posts?|sources?|results?|个网页|条帖子|个来源)|(?:已深度思考|思考中|正在思考|搜索了|检索了).*|\d+\s*(?:web pages?|posts?|sources?|results?|个网页|条帖子|个来源))$/i.test(t.trim());
    const infos=textKids.map(k=>{
      const text=grokExtractText(k);
      if(!text)return null;
      const expUser=grokExplicitUser(k);
      const asst=!expUser&&grokAssistantNode(k);
      const userEdit=!expUser&&!asst&&grokUserEditOnly(k);
      const alignedEnd=!expUser&&!asst&&!userEdit&&grokAlignedEnd(k,container);
      const sub=asst&&!expUser?grokExpandTurn(k,container,ignored,allowStructuralSplit,depth+1):null;
      const native=k.getAttribute('data-message-id')||k.querySelector('[data-message-id]')?.getAttribute('data-message-id')||k.id||'';
      return {node:k,text,native,expUser,asst,userEdit,alignedEnd,sub};
    }).filter(Boolean);
    if(infos.length<2)return null;
    const hasSubPair=infos.some(x=>Array.isArray(x.sub)&&x.sub.length>=2);
    const hasMarkedUser=infos.some(x=>x.expUser||x.userEdit||x.alignedEnd);
    const hasMarkedAsst=infos.some(x=>x.asst);
    const firstAsstIdx=infos.findIndex(x=>x.asst);
    const hasStructuralPairedUser=!hasMarkedUser&&!hasSubPair&&allowStructuralSplit&&firstAsstIdx>0&&infos.slice(0,firstAsstIdx).some(x=>!GROK_INLINE_TAGS.has(x.node.tagName)&&!isThinkingOrMeta(x.text));
    if(!hasMarkedUser&&!hasStructuralPairedUser&&!hasSubPair)return null;
    const hasAssistantSide=hasMarkedAsst||hasSubPair||(grokAssistantNode(turnNode)&&infos.some(x=>!x.expUser&&!x.userEdit&&!x.alignedEnd));
    if(!hasAssistantSide)return null;
    const out=[];
    const pushOut=(native,role,text)=>{
      if(role==='assistant'&&out.length&&out[out.length-1].role==='assistant'&&!native&&!out[out.length-1].native){
        out[out.length-1].text+='\n\n'+text;
      }else{
        out.push({native,role,text});
      }
    };
    for(let i=0;i<infos.length;i++){
      const x=infos[i];
      if(x.sub&&x.sub.length>=2){
        for(const s of x.sub)pushOut(s.native,s.role,s.text);
      }else if(x.expUser||x.userEdit||x.alignedEnd){
        pushOut(x.native,'user',x.text);
      }else if(x.asst){
        pushOut(x.native,'assistant',x.text);
      }else if(hasStructuralPairedUser&&i<firstAsstIdx){
        if(isThinkingOrMeta(x.text))continue;
        pushOut(x.native,'user',x.text);
      }else{
        if(isThinkingOrMeta(x.text)&&infos.slice(i+1).some(y=>!y.expUser&&!y.userEdit&&!y.alignedEnd))continue;
        pushOut(x.native,'assistant',x.text);
      }
    }
    return out.some(m=>m.role==='user')&&out.some(m=>m.role==='assistant')?out:null;
  }
  function grokFallback(doc){
    const scope=doc.querySelector('[data-testid="primaryColumn"]')||doc.querySelector('main')||doc.body;
    if(!scope)return [];
    const ignored=n=>!isVisible(n)||n.matches('header,nav,form,textarea,input,[role="banner"],[role="navigation"],[data-testid="grokInput"],[data-testid*="Header"]')||!!n.querySelector('textarea,input[type="text"],[contenteditable="true"],[data-testid="grokInput"]');
    const filterAnchors=sel=>[...scope.querySelectorAll(sel)].filter(b=>isVisible(b)&&!b.closest('form,nav,header,[role="banner"],[role="navigation"],[data-testid="grokInput"]'));
    let anchors=filterAnchors(GROK_ASST_HINT_SEL);
    if(!anchors.length)anchors=filterAnchors('button[aria-label*="Copy text" i],button[aria-label*="复制文本"]');
    if(!anchors.length)return [];
    let listEl=null,bestCount=1;
    const candidateLists=new Set();
    for(const a of anchors){let p=a.parentElement;while(p&&p!==scope){candidateLists.add(p);p=p.parentElement;}candidateLists.add(scope);}
    for(const p of candidateLists){
      const children=[...p.children].filter(c=>!ignored(c)&&textOf(c).length>0);
      if(children.length<2)continue;
      const hitChildren=children.filter(c=>anchors.some(a=>c.contains(a)));
      if(hitChildren.length>=2&&(hitChildren.length>bestCount||!listEl)){bestCount=hitChildren.length;listEl=p;}
    }
    if(!listEl){
      const buttonAnchor=anchors.find(a=>a.tagName==='BUTTON')||anchors[0];
      let cur=buttonAnchor;
      while(cur.parentElement&&cur.parentElement!==scope&&!textOf(cur))cur=cur.parentElement;
      while(cur.parentElement&&cur.parentElement!==scope){
        const p=cur.parentElement,siblings=[...p.children].filter(c=>!ignored(c)&&textOf(c).length>0),idx=siblings.indexOf(cur);
        if(idx>0&&siblings.slice(0,idx).length>0){listEl=p;break;}
        cur=p;
      }
      if(!listEl)listEl=cur.parentElement||scope;
    }
    const items=[];
    const rawChildren=[...listEl.children].filter(c=>!ignored(c));
    const lastAssistantIdx=rawChildren.reduce((acc,c,i)=>grokAssistantNode(c)?i:acc,-1);
    let pairedLayout=false;
    for(let i=0;i<rawChildren.length;i++){
      const c=rawChildren[i];
      if(grokAssistantNode(c)&&!grokExplicitUser(c)){
        const prevStandaloneUser=i>0&&!grokAssistantNode(rawChildren[i-1])&&textOf(rawChildren[i-1]).length>0;
        const expanded=grokExpandTurn(c,listEl,ignored,pairedLayout||!prevStandaloneUser);
        if(expanded){pairedLayout=true;items.push(...expanded);continue;}
      }
      const text=grokExtractText(c);
      if(!text)continue;
      const explicitUser=grokExplicitUser(c);
      let role;
      if(explicitUser)role='user';
      else if(grokAssistantNode(c))role='assistant';
      else if(grokAlignedEnd(c,listEl)||grokUserEditOnly(c))role='user';
      else if(i>lastAssistantIdx&&lastAssistantIdx>=0&&/^(Grok can make mistakes|Grok 可能会犯错|Verify|请注意核实)/i.test(text))continue;
      else role='user';
      const native=c.getAttribute('data-message-id')||c.querySelector('[data-message-id]')?.getAttribute('data-message-id')||c.id||'';
      items.push({native,role,text});
    }
    return items;
  }
  const rules={
    chatgpt:{containers:'[data-content-search-unit-key], [data-message-author-role="user"], [data-message-author-role="assistant"]',role:n=>n.dataset.messageAuthorRole||(n.getAttribute('data-content-search-unit-key')?.endsWith(':user')?'user':n.getAttribute('data-content-search-unit-key')?.endsWith(':assistant')?'assistant':null),body:n=>n.querySelector('[data-user-message-bubble], [data-markdown-text-style="assistant-message"], .markdown, .whitespace-pre-wrap, [class*="whitespace-pre-wrap"]')||n},
    claude:{containers:'[data-testid="user-message"], [data-testid="assistant-message"], .font-claude-response',role:n=>n.matches('[data-testid="user-message"]')?'user':'assistant',body:n=>n},
    gemini:{containers:'user-query, model-response, .user-query-container, .query-content, .response-container, .model-response-text',role:n=>n.matches('user-query, .user-query-container, .query-content')?'user':'assistant',body:n=>{const queries=parts(n,'.query-text, .query-text-line');return n.matches('user-query, .user-query-container, .query-content')?(queries.length?queries:n):n.querySelector('message-content, .markdown-main-panel, .model-response-text, .markdown')||n}},
    deepseek:{containers:'._9663006, ._4f9bf79._43c05b5, .ds-message, [data-role="user"], [data-role="assistant"]',role:n=>n.getAttribute('data-role')||(n.matches('._9663006')?'user':n.matches('._4f9bf79')||n.querySelector('.ds-markdown')?'assistant':null),body:n=>n.querySelector('.fbb737a4, .ds-markdown')||n},
    yuanbao:{containers:'[data-conv-speaker="human"], [data-conv-speaker="ai"], .agent-chat__list__item--human, .agent-chat__list__item--ai, [data-role="user"], [data-role="assistant"]',role:n=>n.getAttribute('data-role')||(n.getAttribute('data-conv-speaker')==='human'||n.className.includes('--human')?'user':'assistant'),body:n=>parts(n,'.hyc-content-text, .hyc-common-markdown, .agent-chat__conv--ai__speech_show')},
    doubao:{containers:'[data-message-id], [data-testid="send_message"], [data-testid="receive_message"], [data-role="user"], [data-role="assistant"]',role:n=>{const declared=n.getAttribute('data-role');if(declared)return declared;const bar=n.parentElement?.querySelector('[data-foundation-type$="message-action-bar"]')?.getAttribute('data-foundation-type');return n.dataset.testid==='send_message'||bar==='send-message-action-bar'||n.querySelector('.text-g-send-msg-bubble-text')?'user':n.dataset.testid==='receive_message'||bar==='receive-message-action-bar'?'assistant':null;},body:n=>n.querySelector('[data-testid="message_text_content"], .md-box-root, .flow-markdown-body, .whitespace-pre-wrap')||n},
    kimi:{containers:'.chat-content-item-user, .chat-content-item-assistant, .chat-content-item.chat-content-item-user, [data-role="user"], [data-role="assistant"]',role:n=>n.getAttribute('data-role')||(n.className.includes('-user')?'user':'assistant'),body:n=>parts(n,'.markdown-container, .editor-content, .markdown, .segment-content, .user-content')},
    qianwen:{containers:'[data-chat-question-wrap], [data-chat-answers-wrap], [data-msgid$="-question"], [data-msgid$="-answer"], .questionItem, .answerItem, [data-role="user"], [data-role="assistant"], [data-message-role="user"], [data-message-role="assistant"]',role:n=>n.getAttribute('data-role')||n.getAttribute('data-message-role')||(n.hasAttribute('data-chat-question-wrap')||n.getAttribute('data-msgid')?.endsWith('-question')||n.className.includes('question')?'user':'assistant'),body:n=>parts(n,'.question-text-card, .markdown-pc-special-class, .markdown-body, .bubble')},
    grok:{
      containers:'[data-message-author-role="user"], [data-message-author-role="assistant"], [data-testid="user-message"], [data-testid="assistant-message"], [data-role="user"], [data-role="assistant"], .message-bubble',
      role:n=>{
        const explicit=n.getAttribute('data-message-author-role')||n.getAttribute('data-role');if(explicit)return explicit;
        if(n.matches('[data-testid="user-message"]'))return 'user';
        if(n.matches('[data-testid="assistant-message"]'))return 'assistant';
        if(grokAssistantNode(n))return 'assistant';
        if(grokUserEditOnly(n)||grokAlignedEnd(n))return 'user';
        let anc=n.parentElement;
        for(let d=0;anc&&d<4;d++){
          if(anc.matches?.('[data-testid="primaryColumn"],main')||anc===n.ownerDocument?.body)break;
          const textKids=[...(anc.children||[])].filter(k=>isVisible(k)&&textOf(k).length>0);
          if(textKids.length>1||grokAssistantNode(anc))break;
          const cls=typeof anc.className==='string'?anc.className:'';
          if(/(?:^|\s)(?:items-end|justify-end|self-end|ml-auto|flex-row-reverse)(?:\s|$)/.test(cls))return 'user';
          if(/(?:^|\s)(?:items-start|justify-start|self-start)(?:\s|$)/.test(cls))return 'assistant';
          anc=anc.parentElement;
        }
        return 'assistant';
      },
      body:n=>{const b=parts(n,'.response-content-markdown, .markdown, [data-testid="tweetText"]');return b.length?b:parts(n,'[dir="auto"], [dir="ltr"]');},
      fallback:grokFallback
    }
  };
  function textOf(node){const clone=node.cloneNode(true);clone.querySelectorAll('script,style,button,svg,nav,textarea,input,[aria-hidden="true"],.memocat-status, [data-find-omitted], [data-testid="message-actions"], [data-markdown-copy="exclude"], .thinking-container, .think-stage, .hyc-component-reasoner__think-content, .agent-chat__conv--ai__toolbar, [class*="deepThinkContent-"], [data-testid="thought-container"], [data-testid="grok-thought"]').forEach(n=>n.remove());
    clone.querySelectorAll('pre').forEach(n=>n.replaceWith(node.ownerDocument.createTextNode('\n\n```\n'+n.textContent.trim()+'\n```\n\n')));
    clone.querySelectorAll('br').forEach(n=>n.replaceWith(node.ownerDocument.createTextNode('\n')));
    clone.querySelectorAll('p,div,li,h1,h2,h3,blockquote,tr').forEach(n=>n.append(node.ownerDocument.createTextNode('\n')));
    return clone.textContent.replace(/\u00a0/g,' ').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  }
  function pushMessage(messages,counts,platformId,native,role,text){
    const base=native?`${platformId}:dom:${native}:${role}`:`${platformId}:text:${MemoCore.hash(role+'\n'+text)}`;
    const count=counts.get(base)||0;counts.set(base,count+1);messages.push({id:base+':'+count,role,text});
  }
  function extract(doc,url,draftId){const p=MemoCore.platformFor(url);if(!p)throw new Error('当前不是支持的 AI 聊天页面');const r=rules[p.id];
    const candidates=[...doc.querySelectorAll(r.containers)].filter(n=>!n.parentElement?.closest(r.containers));
    const messages=[],counts=new Map();for(const n of candidates){if(!isVisible(n))continue;
      const role=r.role(n);if(!['user','assistant'].includes(role))continue;const body=r.body(n),text=Array.isArray(body)?(body.length?body.map(textOf).filter(Boolean).join('\n\n'):textOf(n)):textOf(body);if(!text)continue;
      const native=n.getAttribute('data-message-id')||n.closest('[data-message-id]')?.getAttribute('data-message-id')||n.getAttribute('data-content-search-unit-key')||n.getAttribute('data-msgid')||n.getAttribute('data-chat-question-wrap')||n.getAttribute('data-chat-answers-wrap')||n.id;
      pushMessage(messages,counts,p.id,native,role,text);
    }
    if((!messages.length||!messages.some(m=>m.role==='user')||!messages.some(m=>m.role==='assistant'))&&typeof r.fallback==='function'){
      const fb=r.fallback(doc);
      const fbHasUser=fb.some(m=>m.role==='user'),fbHasAsst=fb.some(m=>m.role==='assistant');
      const curHasUser=messages.some(m=>m.role==='user'),curHasAsst=messages.some(m=>m.role==='assistant');
      if(fb.length&&(!messages.length||(fbHasUser&&fbHasAsst)||(!curHasUser&&fbHasUser)||(!curHasAsst&&fbHasAsst))){
        messages.length=0;counts.clear();
        for(const m of fb)pushMessage(messages,counts,p.id,m.native,m.role,m.text);
      }
    }
    if(!messages.length)throw new Error('尚未找到对话消息；请打开具体对话，或等待页面加载。若页面已更新，请反馈适配问题。');
    const firstQuestion=messages.find(m=>m.role==='user')?.text;
    const rawTitle=doc.querySelector('[data-testid="conversation-title"], [data-testid="chat-title"]')?.textContent||doc.title||messages.find(m=>m.role==='user')?.text;
    let title=(rawTitle||'未命名对话').replace(/\s*[-–|·\/]\s*(ChatGPT|Claude|Gemini|DeepSeek|Kimi|豆包|腾讯元宝|千问|Grok|X).*$/i,'').trim();if(!title||title.toLowerCase()==='x'||MemoCore.platforms.some(p=>p.name.toLowerCase()===title.toLowerCase()))title=firstQuestion?.slice(0,80)||title||'未命名对话';
    return MemoCore.validateConversation({id:MemoCore.conversationKey(url)||`${p.id}:draft:${draftId}`,platform:p.id,url,title,messages});
  }
  function streaming(doc){return !!doc.querySelector('[data-is-streaming="true"], [data-testid="stop-button"], [data-testid="stop-response"], button[aria-label="Stop generating"], button[aria-label="停止生成"], button[aria-label="Stop" i], button[aria-label="Stop response" i], button[aria-label="停止回答"], [data-testid="grokStop"], .result-streaming, .ds-stop-button');}
  globalThis.MemoAdapters={extract,textOf,streaming,rules};
})();
