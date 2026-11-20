import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import * as nodeFs from 'node:fs';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import * as nodePath from 'node:path';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {runInNewContext} from 'node:vm';
import '../extension/lib/core.js';
import {start} from '../src/server.js';
import {Store} from '../src/store.js';

test('app server and extension share 3792 as default port',async()=>{
  assert.equal(globalThis.MemoCore.defaults().sync.url,'http://127.0.0.1:3792');
  const root=await mkdtemp(join(tmpdir(),'memo-port-'));
  const app=await start({port:0,dataDir:root});
  try{
    const serverSrc=await readFile(new URL('../src/server.js',import.meta.url),'utf8');
    assert.match(serverSrc,/process\.env\.PORT\|\|3792/);
    const bgSrc=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
    assert.ok(bgSrc.includes('3792'));
  }finally{await app.close();await rm(root,{recursive:true,force:true});}
});

test('desktop background mode defaults enabled, persists updates, and reports 409 when unsupported',async()=>{
  const root=await mkdtemp(join(tmpdir(),'memo-bg-'));
  let bg=true;
  const desktopApp=await start({
    port:0,
    dataDir:join(root,'desktop'),
    desktopActions:{
      startupSupported:false,
      backgroundSupported:true,
      getBackground:()=>bg,
      setBackground:v=>{bg=v;},
      getStartup:()=>false,
      setStartup:()=>{},
      openDataDirectory:()=>{}
    }
  });
  try{
    const prefs=await (await fetch(desktopApp.url+'/api/preferences')).json();
    assert.equal(prefs.backgroundSupported,true);
    assert.equal(prefs.backgroundEnabled,true);
    const off=await fetch(desktopApp.url+'/api/background',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:false})});
    assert.equal(off.status,200);
    assert.deepEqual(await off.json(),{enabled:false});
    assert.equal((await (await fetch(desktopApp.url+'/api/preferences')).json()).backgroundEnabled,false);
    const bad=await fetch(desktopApp.url+'/api/background',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:'no'})});
    assert.equal(bad.status,400);
  }finally{await desktopApp.close();}

  const webApp=await start({port:0,dataDir:join(root,'web')});
  try{
    const prefs=await (await fetch(webApp.url+'/api/preferences')).json();
    assert.equal(prefs.backgroundSupported,false);
    assert.equal(prefs.backgroundEnabled,false);
    const denied=await fetch(webApp.url+'/api/background',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:true})});
    assert.equal(denied.status,409);
  }finally{await webApp.close();await rm(root,{recursive:true,force:true});}
});

test('/api/state exposes activeSources reflecting only sources with saved records',async()=>{
  const root=await mkdtemp(join(tmpdir(),'memo-active-src-'));
  const app=await start({port:0,dataDir:root});
  try{
    let state=await (await fetch(app.url+'/api/state')).json();
    assert.deepEqual(state.activeSources,[]);

    const now='2026-11-19T00:00:00Z';
    app.store.save({meta:{channelId:'codex',threadId:'t1',title:'Codex Session',createdAt:now,lastActiveAt:now,sourcePath:'/tmp/a'},records:[{id:'m1',seq:0,role:'user',text:'hello',ts:now,sourceRef:'/tmp/a:1'}]});
    app.store.save({meta:{channelId:'browser-grok',threadId:'t2',title:'Grok Session',createdAt:now,lastActiveAt:now,sourcePath:'https://x.com/i/grok?conversation=t2'},records:[{id:'m2',seq:0,role:'user',text:'hi',ts:now,sourceRef:'https://x.com/i/grok?conversation=t2'}]});
    state=await (await fetch(app.url+'/api/state')).json();
    assert.deepEqual(state.activeSources,[
      {source:'browser-grok',count:1},
      {source:'codex',count:1}
    ]);

    app.store.db.prepare('DELETE FROM conversations WHERE source=?').run('codex');
    state=await (await fetch(app.url+'/api/state')).json();
    assert.deepEqual(state.activeSources,[{source:'browser-grok',count:1}]);
  }finally{await app.close();await rm(root,{recursive:true,force:true});}
});

test('floating widget opens sidebar on the right, supports collapse, dragging persistence, and status marquee',async()=>{
  const script=await readFile(new URL('../extension/content.js',import.meta.url),'utf8');
  function makeNode(tag='div'){
    const listeners=new Map(),attrs=new Map(),children=[],cls=new Set();
    const node={
      tagName:tag.toUpperCase(),
      children,
      dataset:{},
      style:{props:{},setProperty(k,v){this.props[k]=v;}},
      hidden:false,
      disabled:false,
      _text:'',
      get className(){return [...cls].join(' ');},
      set className(v){cls.clear();for(const c of String(v||'').split(/\s+/).filter(Boolean))cls.add(c);},
      classList:{
        add:(...items)=>items.forEach(c=>cls.add(c)),
        remove:(...items)=>items.forEach(c=>cls.delete(c)),
        toggle:(c,force)=>{const on=force===undefined?!cls.has(c):Boolean(force);if(on)cls.add(c);else cls.delete(c);return on;},
        contains:c=>cls.has(c)
      },
      get textContent(){return this._text||children.map(c=>c.textContent).join('');},
      set textContent(v){this._text=String(v);children.length=0;},
      append(...items){children.push(...items);},
      remove(){},
      attachShadow(){const s=makeNode('shadow');node._shadow=s;return s;},
      setAttribute(k,v){attrs.set(k,String(v));},
      getAttribute(k){return attrs.get(k);},
      addEventListener(type,fn){const list=listeners.get(type)||[];list.push(fn);listeners.set(type,list);},
      removeEventListener(type,fn){const list=listeners.get(type)||[];listeners.set(type,list.filter(f=>f!==fn));},
      dispatch(type,event={}){for(const fn of listeners.get(type)||[])fn(event);},
      contains(other){return children.includes(other)||children.some(c=>c.contains?.(other));},
      getBoundingClientRect(){return {left:900,top:18,right:1182,width:282,height:36};},
      get clientWidth(){return node._clientWidth??112;},
      get scrollWidth(){return node._scrollWidth??60;}
    };
    return node;
  }
  const docChildren=[],stored={floatingWidget:null},winListeners=new Map();
  const listeners={};
  const sandbox={
    URL,
    TextEncoder,
    Math,
    Date,
    Number,
    Boolean,
    Promise,
    MemoAdapters:{streaming:()=>false,extract:()=>({id:'grok:abc',platform:'grok',url:'https://x.com/i/grok?conversation=abc',title:'Test',messages:[{id:'m1',role:'user',text:'hi'}]})},
    chrome:{
      runtime:{
        id:'ext-id',
        getURL:p=>'chrome-extension://ext-id/'+p,
        sendMessage:async msg=>msg.type==='captureSettings'?{ok:true,data:{autoSave:false,enabled:true}}:{ok:true,data:{}},
        onMessage:{addListener:(fn)=>{listeners.onMessage=fn;}}
      },
      storage:{
        local:{
          get:async()=>({floatingWidget:stored.floatingWidget}),
          set:async v=>{if(v.floatingWidget)stored.floatingWidget=v.floatingWidget;}
        },
        onChanged:{addListener:()=>{}}
      }
    },
    crypto:{randomUUID:()=> 'uuid-1'},
    location:{href:'https://x.com/i/grok?conversation=abc'},
    requestAnimationFrame:fn=>fn(),
    window:{
      innerWidth:1200,
      innerHeight:800,
      addEventListener:(t,fn)=>{const l=winListeners.get(t)||[];l.push(fn);winListeners.set(t,l);},
      removeEventListener:()=>{}
    },
    document:{
      hidden:false,
      createElement:tag=>makeNode(tag),
      documentElement:{append:n=>docChildren.push(n)},
      body:makeNode('body'),
      addEventListener(){},
      removeEventListener(){}
    },
    MutationObserver:class{observe(){}disconnect(){}},
    setInterval:()=>1,
    clearInterval:()=>{},
    setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,20)),
    clearTimeout
  };
  runInNewContext(await readFile(new URL('../extension/lib/core.js',import.meta.url),'utf8'),sandbox);
  runInNewContext(script,sandbox);
  await new Promise(r=>setImmediate(r));

  try{
    const host=docChildren.find(n=>n.id==='memocat-capture');
    assert.ok(host);
    const pill=host._shadow.children.find(n=>n.classList.contains('pill'));
    assert.ok(pill);

    // Toggle sidebar opens on the left edge
    const logoBtn=pill.children[0],expandable=pill.children[1];
    logoBtn.onclick();
    const sidebar=docChildren.find(n=>n.id==='memocat-sidebar');
    assert.ok(sidebar);
    assert.match(sidebar.style.cssText,/right:0!important/);
    assert.doesNotMatch(sidebar.style.cssText,/left:0!important/);

    // Pill auto-shrinks to icon-only, has only the status text next to the icon, no fixed 'Memo' prefix
    assert.equal(expandable.children.length,1);
    await new Promise(r=>setTimeout(r,80));
    assert.equal(pill.classList.contains('collapsed'),true);
    assert.ok(!expandable.children[0].textContent.includes('Memo'));

    // Dragging near left half snaps widget to left edge and persists position
    pill.getBoundingClientRect=()=>({left:30,top:140,right:66,width:36,height:36});
    pill.dispatch('pointerdown',{button:0,clientX:920,clientY:24,pointerId:1});
    pill.dispatch('pointermove',{clientX:30,clientY:140,pointerId:1});
    pill.dispatch('pointerup',{pointerId:1});
    await new Promise(r=>setImmediate(r));
    assert.equal(pill.classList.contains('collapsed'),true);
    assert.equal(stored.floatingWidget.edge,'left');
    assert.equal(stored.floatingWidget.top,140);
    assert.equal(host.style.left,'30px');

    // Marquee engages when status text overflows fixed 112px viewport
    const statusViewport=expandable.children[0].children[0];
    const statusTrack=statusViewport.children[0];
    const statusText=statusTrack.children[0];
    const statusDup=statusTrack.children[1];
    statusViewport._clientWidth=112;
    statusText._scrollWidth=220;
    statusText.textContent='这是一条非常长的状态提示信息用于测试向左滚动';
    pill.dispatch('mouseenter');
    assert.equal(statusTrack.classList.contains('is-scrolling'),true);
    assert.equal(statusDup.textContent,statusText.textContent);
  }finally{
    for(const fn of winListeners.get('pagehide')||[])fn();
  }
});

test('MemoCore.replace overwrites misclassified roles cleanly without role-conflict errors',()=>{
  const prev=globalThis.MemoCore.reconcile(null,{
    id:'grok:4055efd8-cdd8-5d37-bf1b-4d51cb43888b',
    platform:'grok',
    url:'https://x.com/i/grok?conversation=4055efd8-cdd8-5d37-bf1b-4d51cb43888b',
    title:'历史对话',
    messages:[
      {id:'m1',role:'assistant',text:'用户提问\n\n旧版误识别回复'},
      {id:'m2',role:'assistant',text:'旧版第二条回复'}
    ]
  });
  const replaced=globalThis.MemoCore.replace(prev,{
    id:'grok:4055efd8-cdd8-5d37-bf1b-4d51cb43888b',
    platform:'grok',
    url:'https://x.com/i/grok?conversation=4055efd8-cdd8-5d37-bf1b-4d51cb43888b',
    title:'未命名对话',
    messages:[
      {id:'m1',role:'user',text:'用户提问'},
      {id:'m2',role:'assistant',text:'修复后的 AI 回复'}
    ]
  });
  assert.equal(replaced.title,'历史对话');
  assert.equal(replaced.createdAt,prev.createdAt);
  assert.equal(replaced.revision,prev.revision+1);
  assert.deepEqual(replaced.messages.map(m=>[m.id,m.role,m.text,m.index]),[
    ['m1','user','用户提问',0],
    ['m2','assistant','修复后的 AI 回复',1]
  ]);
});

test('Grok adapter separates user and assistant messages across x.com/i/grok paired turns, RNW styles, and grok.com bubbles',async()=>{
  function createMockDom(buildFn){
    const doc={defaultView:{getComputedStyle:el=>el._style||{}}};
    function matchSimple(el,part){
      if(!el||el.nodeType!==1)return false;
      let rest=part.trim();
      const tagMatch=/^[a-z0-9-]+/i.exec(rest);
      if(tagMatch){
        if(el.tagName.toLowerCase()!==tagMatch[0].toLowerCase())return false;
        rest=rest.slice(tagMatch[0].length);
      }
      while(rest.length){
        if(rest[0]==='#'){
          const m=/^#([^.#\[]+)/.exec(rest);if(!m)return false;
          if(el.id!==m[1])return false;
          rest=rest.slice(m[0].length);
        }else if(rest[0]==='.'){
          const m=/^\.([^.#\[]+)/.exec(rest);if(!m)return false;
          if(!el.className.split(/\s+/).filter(Boolean).includes(m[1]))return false;
          rest=rest.slice(m[0].length);
        }else if(rest[0]==='['){
          const m=/^\[([^=\]*$^~]+)(?:([*^$~]?=)"([^"]*)"(\s+i)?)?\]/i.exec(rest);if(!m)return false;
          const [,attr,op,expected,ci]=m;
          const actual=el.getAttribute(attr);
          if(actual==null)return false;
          if(op){
            const a=ci?actual.toLowerCase():actual,e=ci?expected.toLowerCase():expected;
            if(op==='='&&a!==e)return false;
            if(op==='*='&&!a.includes(e))return false;
            if(op==='^='&&!a.startsWith(e))return false;
            if(op==='$='&&!a.endsWith(e))return false;
          }
          rest=rest.slice(m[0].length);
        }else{
          return false;
        }
      }
      return true;
    }
    function matchSelector(el,sel){
      for(const branch of sel.split(',')){
        const tokens=branch.trim().match(/(?:[^\s\[]|\[[^\]]*\])+/g)||[];
        if(!tokens.length)continue;
        if(!matchSimple(el,tokens.at(-1)))continue;
        let cur=el.parentElement,ok=true;
        for(let i=tokens.length-2;i>=0;i--){
          while(cur&&!matchSimple(cur,tokens[i]))cur=cur.parentElement;
          if(!cur){ok=false;break;}
          cur=cur.parentElement;
        }
        if(ok)return true;
      }
      return false;
    }
    function makeEl(tag,{attrs={},style={},rect=null,children=[]}={}){
      const el={
        nodeType:1,
        tagName:tag.toUpperCase(),
        ownerDocument:doc,
        parentElement:null,
        children:[],
        _nodes:[],
        _attrs:new Map(Object.entries(attrs)),
        _style:{...style},
        _rect:rect||{left:0,right:600,width:600,height:24},
        get hidden(){return this._attrs.has('hidden');},
        get id(){return this._attrs.get('id')||'';},
        get className(){return this._attrs.get('class')||'';},
        set className(v){this._attrs.set('class',String(v));},
        get dataset(){
          const out={};
          for(const [k,v] of this._attrs)if(k.startsWith('data-')){
            const camel=k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase());
            out[camel]=v;
          }
          return out;
        },
        getAttribute(k){return this._attrs.has(k)?this._attrs.get(k):null;},
        hasAttribute(k){return this._attrs.has(k);},
        setAttribute(k,v){this._attrs.set(k,String(v));},
        getClientRects(){return this.hidden?[]:[this._rect];},
        getBoundingClientRect(){return this._rect;},
        get textContent(){return this._nodes.map(n=>n.textContent).join('');},
        append(...items){
          for(const item of items){
            if(typeof item==='string')this._nodes.push({nodeType:3,parentElement:this,textContent:item});
            else{item.parentElement=this;this._nodes.push(item);this.children.push(item);}
          }
        },
        remove(){
          if(!this.parentElement)return;
          const p=this.parentElement;
          p._nodes=p._nodes.filter(n=>n!==this);
          p.children=p.children.filter(n=>n!==this);
          this.parentElement=null;
        },
        replaceWith(...items){
          if(!this.parentElement)return;
          const p=this.parentElement,idx=p._nodes.indexOf(this);
          const norm=items.map(it=>typeof it==='string'?{nodeType:3,parentElement:p,textContent:it}:(it.parentElement=p,it));
          p._nodes.splice(idx,1,...norm);
          p.children=p._nodes.filter(n=>n.nodeType===1);
          this.parentElement=null;
        },
        cloneNode(deep=false){
          const copy=makeEl(this.tagName,{attrs:Object.fromEntries(this._attrs),style:this._style,rect:this._rect});
          if(deep)for(const n of this._nodes)copy.append(n.nodeType===3?n.textContent:n.cloneNode(true));
          return copy;
        },
        matches(sel){return matchSelector(this,sel);},
        contains(o){let c=o;while(c){if(c===this)return true;c=c.parentElement;}return false;},
        closest(sel){let c=this;while(c){if(matchSelector(c,sel))return c;c=c.parentElement;}return null;},
        querySelectorAll(sel){
          const res=[];
          const walk=node=>{for(const ch of node.children){if(matchSelector(ch,sel))res.push(ch);walk(ch);}};
          walk(this);
          return res;
        },
        querySelector(sel){return this.querySelectorAll(sel)[0]||null;}
      };
      if(children.length)el.append(...children);
      return el;
    }
    const h=(tag,opts,children=[])=>{
      if(Array.isArray(opts)){children=opts;opts={};}
      return makeEl(tag,{...(opts||{}),children});
    };
    const body=buildFn(h);
    doc.body=body;
    doc.title='Grok Test';
    doc.createTextNode=t=>({nodeType:3,textContent:String(t)});
    doc.querySelector=sel=>body.matches(sel)?body:body.querySelector(sel);
    doc.querySelectorAll=sel=>[...(body.matches(sel)?[body]:[]),...body.querySelectorAll(sel)];
    return doc;
  }

  const sandbox={URL,TextEncoder,Map,Set,Array,Object,String,Number,Boolean,RegExp,JSON,crypto:{randomUUID:()=>'uuid-1'}};
  runInNewContext(await readFile(new URL('../extension/lib/core.js',import.meta.url),'utf8'),sandbox);
  runInNewContext(await readFile(new URL('../extension/lib/adapters.js',import.meta.url),'utf8'),sandbox);
  const {extract}=sandbox.MemoAdapters;

  // 1. Paired turns [U+A, U+A, U-only, U+A] without Tailwind items-end, mirroring real x.com/i/grok
  const pairedDoc=createMockDom(h=>h('body',{},[
    h('div',{attrs:{'data-testid':'primaryColumn'},rect:{left:0,right:720,width:720,height:900}},[
      h('div',{rect:{left:0,right:720,width:720,height:900}},[
        h('div',{rect:{left:0,right:720,width:720,height:200}},[
          h('div',{style:{display:'flex',flexDirection:'column',alignItems:'flex-end'},rect:{left:0,right:720,width:720,height:40}},[
            h('div',{attrs:{dir:'ltr'},rect:{left:460,right:708,width:248,height:30}},['第一问'])
          ]),
          h('div',{},[
            h('div',{attrs:{dir:'ltr'}},['第一答']),
            h('div',{},[h('button',{attrs:{'aria-label':'Copy text'}}),h('button',{attrs:{'aria-label':'Like'}})])
          ])
        ]),
        h('div',{rect:{left:0,right:720,width:720,height:200}},[
          h('div',{style:{display:'flex',flexDirection:'column',alignItems:'flex-end'},rect:{left:0,right:720,width:720,height:40}},[
            h('div',{attrs:{dir:'ltr'},rect:{left:500,right:708,width:208,height:30}},['再继续生成一组'])
          ]),
          h('div',{},[
            h('div',{attrs:{dir:'ltr'}},['第二答']),
            h('div',{},[h('button',{attrs:{'aria-label':'Regenerate'}})])
          ])
        ]),
        h('div',{rect:{left:0,right:720,width:720,height:40}},[
          h('div',{attrs:{dir:'ltr'},rect:{left:540,right:708,width:168,height:30},style:{marginLeft:'400px'}},['列举日语区的'])
        ]),
        h('div',{rect:{left:0,right:720,width:720,height:200}},[
          h('div',{style:{display:'flex',flexDirection:'column',alignItems:'flex-end'}},[
            h('div',{attrs:{dir:'ltr'}},['日语区推文推荐'])
          ]),
          h('div',{},[
            h('div',{attrs:{dir:'ltr'}},['第三答']),
            h('div',{},[h('button',{attrs:{'aria-label':'Dislike'}})])
          ])
        ])
      ])
    ])
  ]));
  const res1=extract(pairedDoc,'https://x.com/i/grok?conversation=t1','d1');
  assert.deepEqual(JSON.parse(JSON.stringify(res1.messages.map(m=>[m.role,m.text]))),[
    ['user','第一问'],
    ['assistant','第一答'],
    ['user','再继续生成一组'],
    ['assistant','第二答'],
    ['user','列举日语区的'],
    ['user','日语区推文推荐'],
    ['assistant','第三答']
  ]);

  // 2. Paired turn with 3 children [user, asst body, separate toolbar] + no-markdown RNW
  const threeSiblingDoc=createMockDom(h=>h('body',{},[
    h('main',{},[
      h('div',{},[
        h('div',{},[
          h('div',{style:{display:'flex',flexDirection:'column',alignItems:'flex-end'}},[h('div',{attrs:{dir:'ltr'}},['Q1'])]),
          h('div',{},[h('div',{attrs:{dir:'ltr'}},['A1'])]),
          h('div',{},[h('button',{attrs:{'aria-label':'Like'}}),h('button',{attrs:{'aria-label':'Regenerate'}})])
        ]),
        h('div',{},[
          h('div',{style:{display:'flex',flexDirection:'column',alignItems:'flex-end'}},[h('div',{attrs:{dir:'ltr'}},['Q2'])]),
          h('div',{},[h('div',{attrs:{dir:'ltr'}},['A2'])]),
          h('div',{},[h('button',{attrs:{'aria-label':'Dislike'}})])
        ])
      ])
    ])
  ]));
  const res2=extract(threeSiblingDoc,'https://x.com/i/grok?conversation=t2','d2');
  assert.deepEqual(JSON.parse(JSON.stringify(res2.messages.map(m=>[m.role,m.text]))),[
    ['user','Q1'],['assistant','A1'],['user','Q2'],['assistant','A2']
  ]);

  // 3. Structural paired turn (0 alignment CSS) where user bubbles also have Copy text button
  const structuralDoc=createMockDom(h=>h('body',{},[
    h('main',{},[
      h('div',{},[
        h('div',{},[
          h('div',{},[h('span',{},['Q1']),h('button',{attrs:{'aria-label':'Copy text'}})]),
          h('div',{attrs:{class:'response-content-markdown'}},['A1']),
          h('div',{},[h('button',{attrs:{'aria-label':'Regenerate'}})])
        ]),
        h('div',{},[
          h('div',{},[h('span',{},['Q2']),h('button',{attrs:{'aria-label':'Copy text'}})]),
          h('div',{attrs:{class:'response-content-markdown'}},['A2']),
          h('div',{},[h('button',{attrs:{'aria-label':'Regenerate'}})])
        ])
      ])
    ])
  ]));
  const res3=extract(structuralDoc,'https://x.com/i/grok?conversation=t3','d3');
  assert.deepEqual(JSON.parse(JSON.stringify(res3.messages.map(m=>[m.role,m.text]))),[
    ['user','Q1'],['assistant','A1'],['user','Q2'],['assistant','A2']
  ]);

  // 4. Flat sibling layout must not split multi-block assistant turn with Grok label into a fake user message
  const flatMultiParaDoc=createMockDom(h=>h('body',{},[
    h('main',{},[
      h('div',{},[
        h('div',{},['用户问题']),
        h('div',{},[
          h('div',{},['Grok']),
          h('p',{},['第一段解释']),
          h('p',{},['第二段总结']),
          h('div',{},[h('button',{attrs:{'aria-label':'Like'}})])
        ])
      ])
    ])
  ]));
  const res4=extract(flatMultiParaDoc,'https://x.com/i/grok?conversation=t4','d4');
  assert.deepEqual(JSON.parse(JSON.stringify(res4.messages.map(m=>[m.role,m.text]))),[
    ['user','用户问题'],
    ['assistant','Grok\n第一段解释\n第二段总结']
  ]);

  // 5. grok.com .message-bubble without Tailwind classes, aligned via flex-column alignItems
  const grokComDoc=createMockDom(h=>h('body',{},[
    h('main',{},[
      h('div',{style:{display:'flex',flexDirection:'column',alignItems:'flex-end'}},[
        h('div',{attrs:{class:'message-bubble'}},['Grok.com prompt'])
      ]),
      h('div',{style:{display:'flex',flexDirection:'column',alignItems:'flex-start'}},[
        h('div',{attrs:{class:'message-bubble'}},[h('div',{attrs:{class:'response-content-markdown'}},['Grok.com reply'])])
      ])
    ])
  ]));
  const res5=extract(grokComDoc,'https://grok.com/c/g1','d5');
  assert.deepEqual(JSON.parse(JSON.stringify(res5.messages.map(m=>[m.role,m.text]))),[
    ['user','Grok.com prompt'],
    ['assistant','Grok.com reply']
  ]);
});

test('content captureNow with replace refreshes paused state and forces replace observe',async()=>{
  const script=await readFile(new URL('../extension/content.js',import.meta.url),'utf8');
  function makeNode(tag='div'){
    const listeners=new Map(),children=[],cls=new Set();
    return {
      tagName:tag.toUpperCase(),children,dataset:{},style:{setProperty(){}},hidden:false,disabled:false,_text:'',
      get className(){return [...cls].join(' ');},
      set className(v){cls.clear();for(const c of String(v||'').split(/\s+/).filter(Boolean))cls.add(c);},
      classList:{add:(...a)=>a.forEach(c=>cls.add(c)),remove:(...a)=>a.forEach(c=>cls.delete(c)),toggle:(c,f)=>{const on=f===undefined?!cls.has(c):Boolean(f);on?cls.add(c):cls.delete(c);return on;},contains:c=>cls.has(c)},
      get textContent(){return this._text||children.map(c=>c.textContent).join('');},
      set textContent(v){this._text=String(v);children.length=0;},
      append(...items){children.push(...items);},remove(){},attachShadow(){const s=makeNode('shadow');this._shadow=s;return s;},
      setAttribute(){},getAttribute(){},addEventListener(t,fn){const l=listeners.get(t)||[];l.push(fn);listeners.set(t,l);},
      removeEventListener(){},contains:()=>false,getBoundingClientRect:()=>({left:0,top:0,right:100,width:100,height:36})
    };
  }
  const sent=[],docChildren=[],winListeners=new Map();
  let onMsg;
  const sandbox={
    URL,TextEncoder,Math,Date,Number,Boolean,Promise,JSON,
    MemoAdapters:{streaming:()=>false,extract:()=>({id:'grok:abc',platform:'grok',url:'https://x.com/i/grok?conversation=abc',title:'Test',messages:[{id:'m1',role:'user',text:'hi'},{id:'m2',role:'assistant',text:'hello'}]})},
    chrome:{
      runtime:{
        id:'ext-id',
        getURL:p=>'chrome-extension://ext-id/'+p,
        sendMessage:async msg=>{sent.push(msg);if(msg.type==='captureSettings')return {ok:true,data:{autoSave:false,enabled:true}};return {ok:true,data:{changed:true,count:2}};},
        onMessage:{addListener:fn=>{onMsg=fn;}}
      },
      storage:{local:{get:async()=>({}),set:async()=>{}},onChanged:{addListener:()=>{}}}
    },
    crypto:{randomUUID:()=>'uuid-draft'},
    location:{href:'https://x.com/i/grok?conversation=abc'},
    requestAnimationFrame:fn=>fn(),
    window:{innerWidth:1280,innerHeight:800,addEventListener:(t,fn)=>{const l=winListeners.get(t)||[];l.push(fn);winListeners.set(t,l);},removeEventListener:()=>{}},
    document:{hidden:false,createElement:tag=>makeNode(tag),documentElement:{append:n=>docChildren.push(n)},body:makeNode('body'),addEventListener(){},removeEventListener(){}},
    MutationObserver:class{observe(){}disconnect(){}},
    setInterval:()=>1,clearInterval:()=>{},setTimeout,clearTimeout
  };
  runInNewContext(await readFile(new URL('../extension/lib/core.js',import.meta.url),'utf8'),sandbox);
  runInNewContext(script,sandbox);
  try{
    // Invoke captureNow immediately before initial refresh resolves while config.enabled is still false
    const res=await new Promise(resolve=>onMsg({type:'captureNow',replace:true},{id:'ext-id'},resolve));
    assert.equal(res.count,2);
    const obs=sent.find(m=>m.type==='observe');
    assert.equal(obs.manual,true);
    assert.equal(obs.replace,true);
    const host=docChildren.find(n=>n.id==='memocat-capture');
    const statusText=host._shadow.children[1].children[1].children[0].children[0].children[0].children[0];
    assert.equal(statusText.textContent,'已重新采集 2 条');
  }finally{
    for(const fn of winListeners.get('pagehide')||[])fn();
  }
});

test('background recapture supports existing open tabs and opening closed conversation tabs',async()=>{
  const bgScript=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
  const savedConv={
    id:'grok:t1',
    platform:'grok',
    url:'https://x.com/i/grok?conversation=t1',
    title:'Grok 问答',
    messages:[{id:'m1',role:'assistant',text:'Old merged'}],
    createdAt:'2026-11-19T00:00:00.000Z',
    updatedAt:'2026-11-19T00:00:00.000Z'
  };
  let onMessage,tabsState=[],sentToTab=[],createdUrls=[];
  const storageData={settings:{autoSave:false,platforms:{grok:true},sync:{enabled:false,url:'http://127.0.0.1:3792',token:''}}};
  const sandbox={
    URL,TextEncoder,Math,Date,Number,Boolean,Promise,JSON,Set,Map,Error,
    importScripts:()=>{},
    MemoDB:{
      identity:async()=>'11111111-1111-1111-1111-111111111111',
      get:async(store,id)=>store==='conversations'&&id===savedConv.id?savedConv:null,
      all:async()=>[]
    },
    chrome:{
      runtime:{
        id:'ext-id',
        getURL:p=>'chrome-extension://ext-id/'+p,
        getManifest:()=>({version:'0.5.0'}),
        onMessage:{addListener:fn=>{onMessage=fn;}},
        onInstalled:{addListener:()=>{}},
        onStartup:{addListener:()=>{}}
      },
      storage:{local:{get:async k=>typeof k==='string'?{[k]:storageData[k]}:storageData,set:async obj=>Object.assign(storageData,obj)}},
      alarms:{onAlarm:{addListener:()=>{}},create:async()=>{}},
      action:{onClicked:{addListener:()=>{}}},
      tabs:{
        query:async q=>q?.active?tabsState.filter(t=>t.active):tabsState,
        get:async id=>tabsState.find(t=>t.id===id)||null,
        create:async ({url})=>{
          createdUrls.push(url);
          const tab={id:99,url,active:true,status:'loading'};
          tabsState.push(tab);
          setTimeout(()=>{tab.status='complete';},50);
          return tab;
        },
        sendMessage:async (tabId,payload)=>{sentToTab.push({tabId,payload});return {changed:true,count:4};}
      }
    },
    setTimeout,clearTimeout
  };
  runInNewContext(await readFile(new URL('../extension/lib/core.js',import.meta.url),'utf8'),sandbox);
  runInNewContext(bgScript,sandbox);

  const uiSender={id:'ext-id',url:'chrome-extension://ext-id/library.html'};
  const invoke=msg=>new Promise(resolve=>onMessage(msg,uiSender,resolve));

  // Case 1: matching open tab exists
  tabsState=[{id:12,url:'https://x.com/i/grok?conversation=t1&tab=top',active:true,status:'complete'}];
  const r1=await invoke({type:'recapture',id:'grok:t1'});
  assert.equal(r1.ok,true);
  assert.deepEqual(JSON.parse(JSON.stringify(r1.data)),{captured:true,opened:false,count:4,id:'grok:t1'});
  assert.deepEqual(JSON.parse(JSON.stringify(sentToTab)),[{tabId:12,payload:{type:'captureNow',replace:true}}]);

  // Case 2: no open tab -> creates tab, waits until complete, and captures
  tabsState=[];sentToTab=[];createdUrls=[];
  const r2=await invoke({type:'recapture',id:'grok:t1'});
  assert.equal(r2.ok,true);
  assert.deepEqual(JSON.parse(JSON.stringify(r2.data)),{captured:true,opened:true,count:4,id:'grok:t1'});
  assert.deepEqual(JSON.parse(JSON.stringify(createdUrls)),['https://x.com/i/grok?conversation=t1']);
  assert.deepEqual(JSON.parse(JSON.stringify(sentToTab)),[{tabId:99,payload:{type:'captureNow',replace:true}}]);
});

test('Store close guards prevent database-not-open errors after shutdown',async()=>{
  const root=await mkdtemp(join(tmpdir(),'memo-store-close-'));
  try{
    const store=new Store(root);
    store.setSetting('backgroundMode',false);
    assert.equal(store.getSetting('backgroundMode',true),false);
    store.close();
    store.close();
    assert.equal(store.closed,true);
    assert.equal(store.getSetting('backgroundMode',true),true);
    assert.doesNotThrow(()=>store.setSetting('backgroundMode',true));
    assert.doesNotThrow(()=>store.finish('missing-delivery','abandoned'));
  }finally{
    await rm(root,{recursive:true,force:true});
  }
});

test('desktop close/quit sequences do not query closed database on window-all-closed',async()=>{
  const desktopSrc=await readFile(new URL('../src/desktop.cjs',import.meta.url),'utf8');
  const srcDir=nodePath.dirname(new URL('../src/desktop.cjs',import.meta.url).pathname);
  const patchedSrc=desktopSrc
    .replace("'./data-directory.js'",JSON.stringify(pathToFileURL(join(srcDir,'data-directory.js')).href))
    .replace("'./server.js'",JSON.stringify(pathToFileURL(join(srcDir,'server.js')).href));

  async function runDesktopQuitScenario(backgroundMode){
    const root=await mkdtemp(join(tmpdir(),'memo-desktop-quit-'));
    const storeSeed=new Store(root);
    storeSeed.setSetting('backgroundMode',backgroundMode);
    storeSeed.setSetting('sources',[{id:'codex',path:root,enabled:false,bookmark:'startup-bm'}]);
    storeSeed.close();

    const windows=[],quitOutcomes=[],installedMenus=[];
    let readyResolve,quitResolve,destroyedTray=false,startedBookmarks=0,stoppedBookmarks=0;
    const readyPromise=new Promise(r=>{readyResolve=r;});
    const quitPromise=new Promise(r=>{quitResolve=r;});

    class MockBrowserWindow extends EventEmitter{
      constructor(){
        super();
        this._destroyed=false;
        this.webContents=new EventEmitter();
        this.webContents.setWindowOpenHandler=()=>{};
        windows.push(this);
      }
      isDestroyed(){return this._destroyed;}
      isMinimized(){return false;}
      restore(){}
      show(){}
      focus(){}
      hide(){}
      async loadURL(){}
      close(){
        if(this._destroyed)return true;
        let prevented=false;
        this.emit('close',{preventDefault(){prevented=true;}});
        if(prevented)return false;
        this._destroyed=true;
        this.emit('closed');
        return true;
      }
    }

    class MockTray extends EventEmitter{
      setToolTip(){}
      setContextMenu(){}
      isDestroyed(){return destroyedTray;}
      destroy(){destroyedTray=true;}
    }

    const app=new EventEmitter();
    app.isPackaged=false;
    app.getPath=()=>root;
    app.setName=()=>{};
    app.setPath=()=>{};
    app.requestSingleInstanceLock=()=>true;
    app.exit=()=>{};
    app.whenReady=()=>readyPromise;
    app.getLoginItemSettings=()=>({openAtLogin:false});
    app.setLoginItemSettings=()=>{};
    app.dock={setIcon(){}};
    app.getVersion=()=>'0.5.0';
    app.setAboutPanelOptions=()=>{};
    app.startAccessingSecurityScopedResource=()=>{startedBookmarks++;return()=>{stoppedBookmarks++;};};
    app.quit=()=>{
      let prevented=false;
      app.emit('before-quit',{preventDefault(){prevented=true;}});
      if(prevented)return;
      for(const win of windows.slice())win.close();
      if(windows.every(w=>w.isDestroyed()))app.emit('window-all-closed');
      quitOutcomes.push('exited');
      quitResolve();
    };

    const electronMock={
      app,
      BrowserWindow:MockBrowserWindow,
      Tray:MockTray,
      Menu:{buildFromTemplate:t=>t,setApplicationMenu:m=>{installedMenus.push(m);}},
      nativeImage:{createFromPath:()=>({resize:()=>({})})},
      dialog:{showErrorBox:(_t,m)=>{throw new Error(m);},showOpenDialog:async()=>({canceled:true})},
      shell:{openPath:async()=>''},
      screen:{getPrimaryDisplay:()=>({workAreaSize:{width:1440}})}
    };

    const fakeRequire=id=>id==='electron'?electronMock:id==='node:path'?nodePath:id==='node:fs'?nodeFs:null;
    const fakeProcess={...process,env:{...process.env,MEMO_DATA_DIR:root,PORT:'0'}};
    const fn=new Function('require','process','__dirname','__filename',patchedSrc);
    fn(fakeRequire,fakeProcess,srcDir,join(srcDir,'desktop.cjs'));

    readyResolve();
    // Wait for async app.whenReady() startup and initial showWindow()
    for(let i=0;i<100&&windows.length===0;i++)await new Promise(r=>setTimeout(r,20));
    assert.equal(windows.length,1);
    assert.equal(installedMenus.length,1);
    assert.equal(startedBookmarks,1);
    assert.equal(stoppedBookmarks,0);

    if(backgroundMode){
      // Simulates Cmd+Q or tray Exit while backgroundMode=true
      app.quit();
    }else{
      // Simulates clicking window close button when backgroundMode=false
      const closed=windows[0].close();
      assert.equal(closed,true);
      app.emit('window-all-closed');
    }

    await quitPromise;
    assert.deepEqual(quitOutcomes,['exited']);
    assert.equal(destroyedTray,true);
    assert.equal(stoppedBookmarks,1);
    await rm(root,{recursive:true,force:true});
  }

  await runDesktopQuitScenario(false);
  await runDesktopQuitScenario(true);
});

test('source directory picker persists, activates, and clears security-scoped bookmarks safely',async()=>{
  const root=await mkdtemp(join(tmpdir(),'memo-pick-'));
  const pickedDir=join(root,'codex-home'),manualDir=join(root,'manual-codex');
  await mkdir(pickedDir,{recursive:true});await mkdir(manualDir,{recursive:true});

  const activated=[];
  let nextPick={canceled:false,path:pickedDir,bookmark:'bm-secret-base64'};
  const desktopApp=await start({
    port:0,
    dataDir:join(root,'desktop'),
    desktopActions:{
      pickSourceDirectory:async()=>nextPick,
      activateSourceBookmark:async(bookmark,sourceId)=>{activated.push({bookmark,sourceId});return true;}
    }
  });
  try{
    let status=await (await fetch(desktopApp.url+'/api/source-status')).json();
    assert.equal(status.canPickDirectory,true);
    assert.equal(status.items.find(s=>s.id==='codex').authorized,false);

    // Pick directory -> stores path + bookmark internally, activates bookmark, strips raw bookmark from HTTP JSON
    const pickedRes=await (await fetch(desktopApp.url+'/api/sources/codex/pick',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).json();
    assert.equal(pickedRes.canceled,false);
    assert.equal(pickedRes.source.path,pickedDir);
    assert.equal(pickedRes.source.authorized,true);
    assert.equal('bookmark' in pickedRes.source,false);
    assert.deepEqual(activated,[{bookmark:'bm-secret-base64',sourceId:'codex'}]);

    status=await (await fetch(desktopApp.url+'/api/source-status')).json();
    const codexStatus=status.items.find(s=>s.id==='codex');
    assert.equal(codexStatus.path,pickedDir);
    assert.equal(codexStatus.authorized,true);
    assert.equal('bookmark' in codexStatus,false);

    // Enable same path without changing path -> preserves bookmark and re-activates it
    const enabledRes=await (await fetch(desktopApp.url+'/api/sources/codex',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:true})})).json();
    assert.equal(enabledRes.ok,true);
    assert.equal(enabledRes.source.authorized,true);
    assert.equal(activated.length,2);

    // Canceled picker preserves existing bookmark
    nextPick={canceled:true};
    const canceledRes=await (await fetch(desktopApp.url+'/api/sources/codex/pick',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).json();
    assert.equal(canceledRes.canceled,true);
    assert.equal(desktopApp.store.getSetting('sources',[]).find(s=>s.id==='codex').bookmark,'bm-secret-base64');

    // Manually changing path without supplying a new bookmark clears stale bookmark
    const manualRes=await (await fetch(desktopApp.url+'/api/sources/codex',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:manualDir})})).json();
    assert.equal(manualRes.ok,true);
    assert.equal(manualRes.source.authorized,false);
    assert.equal(desktopApp.store.getSetting('sources',[]).find(s=>s.id==='codex').bookmark,undefined);
  }finally{
    await desktopApp.close();
  }

  // Web mode rejects /pick with 409 and sets canPickDirectory=false
  const webApp=await start({port:0,dataDir:join(root,'web')});
  try{
    const status=await (await fetch(webApp.url+'/api/source-status')).json();
    assert.equal(status.canPickDirectory,false);
    const denied=await fetch(webApp.url+'/api/sources/codex/pick',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    assert.equal(denied.status,409);
  }finally{
    await webApp.close();
    await rm(root,{recursive:true,force:true});
  }
});

test('App Store and Chrome Web Store build configs, manifests, and plists are valid',async()=>{
  const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(pkg.scripts['build:mas'],'node scripts/build-mas.mjs');

  const manifest=JSON.parse(await readFile(new URL('../extension/manifest.json',import.meta.url),'utf8'));
  assert.deepEqual(manifest.icons,{
    16:'icons/icon16.png',
    32:'icons/icon32.png',
    48:'icons/icon48.png',
    128:'icons/icon128.png'
  });
  assert.deepEqual(manifest.action.default_icon,manifest.icons);
  assert.equal(manifest.host_permissions.includes('https://x.com/*'),false);
  assert.equal(manifest.host_permissions.includes('https://x.com/i/grok*'),true);
  assert.equal(manifest.content_scripts[0].matches.includes('https://x.com/*'),false);
  assert.equal(manifest.content_scripts[0].matches.includes('https://x.com/i/grok*'),true);
  assert.equal(manifest.web_accessible_resources[0].matches.includes('https://x.com/*'),true);

  const privacy=await readFile(new URL('../build/PrivacyInfo.xcprivacy',import.meta.url),'utf8');
  assert.match(privacy,/<key>NSPrivacyTracking<\/key>\s*<false\/>/);
  assert.match(privacy,/<key>NSPrivacyCollectedDataTypes<\/key>\s*<array\/>/);
  assert.match(privacy,/NSPrivacyAccessedAPICategoryFileTimestamp/);
  assert.match(privacy,/C617\.1/);
  assert.match(privacy,/DDA9\.1/);
  assert.match(privacy,/35F9\.1/);
  assert.match(privacy,/E174\.1/);

  const masEntitlements=await readFile(new URL('../build/entitlements.mas.plist',import.meta.url),'utf8');
  assert.match(masEntitlements,/com\.apple\.security\.app-sandbox/);
  assert.match(masEntitlements,/com\.apple\.security\.files\.user-selected\.read-only/);
  assert.match(masEntitlements,/com\.apple\.security\.files\.bookmarks\.app-scope/);
  assert.match(masEntitlements,/com\.apple\.security\.network\.server/);

  const inheritEntitlements=await readFile(new URL('../build/entitlements.mas.inherit.plist',import.meta.url),'utf8');
  assert.match(inheritEntitlements,/com\.apple\.security\.app-sandbox/);
  assert.match(inheritEntitlements,/com\.apple\.security\.inherit/);

  const macBundle=await readFile(new URL('../scripts/mac-bundle.mjs',import.meta.url),'utf8');
  assert.match(macBundle,/com\.qiwihui\.memocat\.desktop/);
  assert.match(macBundle,/ITSAppUsesNonExemptEncryption/);

  const {execFileSync}=await import('node:child_process');
  const rootDir=nodePath.resolve(nodePath.dirname(new URL('../package.json',import.meta.url).pathname));
  execFileSync('/usr/bin/plutil',[
    '-lint',
    join(rootDir,'build/PrivacyInfo.xcprivacy'),
    join(rootDir,'build/entitlements.mas.plist'),
    join(rootDir,'build/entitlements.mas.inherit.plist')
  ]);
});
