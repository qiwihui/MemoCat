import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {start} from '../src/server.js';

const root=resolve(import.meta.dirname,'..');
const binary=process.env.MEMO_BROWSER_BINARY||'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
await access(binary);

// 1. Rebuild unpacked extension & zip so CWS archive is always fresh.
execFileSync(process.execPath,[join(root,'scripts/build-extension.mjs')],{stdio:'inherit'});

const manifest=JSON.parse(await readFile(join(root,'extension/manifest.json'),'utf8'));
const zipSource=join(root,'dist/memocat-extension.zip');
const zipEntries=execFileSync('/usr/bin/unzip',['-Z1',zipSource],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
if(zipEntries.some(e=>e.includes('.DS_Store')||e.includes('__MACOSX'))){
  throw new Error('Extension ZIP contains macOS metadata files (.DS_Store or __MACOSX)');
}

const outRoot=join(root,'dist/chrome-web-store');
const shotDir=join(outRoot,'screenshots');
const promoDir=join(outRoot,'promo');
await rm(outRoot,{recursive:true,force:true});
await mkdir(shotDir,{recursive:true});
await mkdir(promoDir,{recursive:true});

const outZip=join(outRoot,`memocat-extension-${manifest.version}.zip`);
const outIcon=join(outRoot,'store-icon-128x128.png');
await copyFile(zipSource,outZip);
await copyFile(join(root,'extension/icons/icon128.png'),outIcon);

class CDP{
  constructor(ws){
    this.ws=ws;this.n=0;this.calls=new Map();this.events=new Map();
    ws.addEventListener('message',e=>{
      const m=JSON.parse(e.data);
      if(m.id){
        const c=this.calls.get(m.id);
        if(c){this.calls.delete(m.id);clearTimeout(c.timer);m.error?c.reject(new Error(m.error.message)):c.resolve(m.result);}
      }else{
        for(const handler of this.events.get(m.method)||[])handler(m.params);
      }
    });
  }
  static async connect(url){
    const ws=new WebSocket(url);
    await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
    return new CDP(ws);
  }
  send(method,params={}){
    return new Promise((resolve,reject)=>{
      const id=++this.n;
      const timer=setTimeout(()=>{this.calls.delete(id);reject(new Error('CDP timeout: '+method));},20000);
      this.calls.set(id,{resolve,reject,timer});
      this.ws.send(JSON.stringify({id,method,params}));
    });
  }
  on(event,fn){const rows=this.events.get(event)||[];rows.push(fn);this.events.set(event,rows);}
  async evaluate(expression){
    const r=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  close(){this.ws.close();}
}

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,msg='Timed out'){
  for(let i=0;i<120;i++){if(await fn())return;await sleep(100);}
  throw new Error(msg);
}

const sampleConversations=[
  {
    id:'chatgpt:local-first-outbox',
    platform:'chatgpt',
    url:'https://chatgpt.com/c/local-first-outbox',
    title:'Local-First Sync Cursor & Outbox CAS Design',
    messages:[
      {
        id:'cg-u-1',role:'user',
        text:'如何确保浏览器扩展在多标签并发更新或断网重试时，不会用旧同步回执误删 IndexedDB 里更新排队中的对话？'
      },
      {
        id:'cg-a-1',role:'assistant',
        text:[
          '建议在 `IndexedDB` 的 `outbox` 中结合单调序列号 `sequence` 与每次写入唯一 UUID `changeId` 做 CAS 校验：',
          '',
          '1. 每次会话变动入队时递增 `sequence`，覆盖同一对话键并写入新 `changeId`。',
          '2. 后台仅在服务端返回并校验与当前队列 `changeId` 严格相等时执行 `ack` 出队。',
          '3. 桌面端按照 `(sourceInstanceId, conversationId)` 比较 `prior.sequence >= item.sequence`，拒绝乱序旧请求覆盖。',
          '',
          '```js',
          'if (prior?.changeId === receipt.changeId) {',
          '  await outbox.delete(receipt.id);',
          '}',
          '```'
        ].join('\n')
      },
      {
        id:'cg-u-2',role:'user',
        text:'网页端开启虚拟滚动后，历史消息临时从 DOM 卸载怎么办？'
      },
      {
        id:'cg-a-2',role:'assistant',
        text:'`MemoCore.reconcile` 将页面观测视为局部滚动窗口，按稳定消息 ID 与精确文本游标对齐补齐增量，不会因为顶部节点暂时隐藏而截断本机已归档历史。'
      }
    ]
  },
  {
    id:'claude:mv3-csp-isolation',
    platform:'claude',
    url:'https://claude.ai/chat/mv3-csp-isolation',
    title:'Manifest V3 最小权限边界与严格 CSP 审计',
    messages:[
      {
        id:'cl-u-1',role:'user',
        text:'Chrome Web Store 审核对 MV3 内容脚本权限和 CSP 有哪些硬性要求？'
      },
      {
        id:'cl-a-1',role:'assistant',
        text:[
          '建议遵循以下隔离准则：',
          '',
          '- 不申请 `<all_urls>`，只在明确的 AI 站点及子路径（如 `x.com/i/grok*`）注入只读采集脚本。',
          '- 扩展页面严格启用 `script-src \'self\'; object-src \'none\'`，杜绝远程动态执行脚本。',
          '- Service Worker 通过 `sender.url` 校验调用方是否来自扩展正式页面，防止网页直接触发全库导出、删除或备份导入。'
        ].join('\n')
      }
    ]
  },
  {
    id:'deepseek:node24-sqlite-wal',
    platform:'deepseek',
    url:'https://chat.deepseek.com/a/chat/s/node24-sqlite-wal',
    title:'Node 24 内置 node:sqlite WAL 与 FTS5 全文检索',
    messages:[
      {
        id:'ds-u-1',role:'user',
        text:'如果不想引入原生 C++ 编译依赖，怎样在本地桌面对上万条中文 AI 对话实现毫秒级搜索？'
      },
      {
        id:'ds-a-1',role:'assistant',
        text:'直接使用 Node 24 内置 `node:sqlite`，对 `conversations` 开启 WAL 模式，配合 `FTS5` `trigram` 虚表与 CJK 2-gram 切词加权即可完全脱离第三方二进制依赖实现高速本机检索。'
      }
    ]
  },
  {
    id:'gemini:cjk-bigram-weights',
    platform:'gemini',
    url:'https://gemini.google.com/app/cjk-bigram-weights',
    title:'中英文混合提示词整理与上下文复用技巧',
    messages:[
      {
        id:'gm-u-1',role:'user',
        text:'从旧对话中恢复架构上下文喂给新对话时，怎样组织 Prompt 最清晰？'
      },
      {
        id:'gm-a-1',role:'assistant',
        text:'在 MemoCat 工作台点击「复制为 Prompt」，会自动按轮次编号整理提问与 AI 回答并包裹 `<conversation_context>` 标签，保留来源平台与原链接，直接粘贴即可继续提问。'
      }
    ]
  },
  {
    id:'kimi:virtual-list-merge',
    platform:'kimi',
    url:'https://www.kimi.com/chat/virtual-list-merge',
    title:'长上下文技术文档归档与 Markdown 合并导出',
    messages:[
      {
        id:'km-u-1',role:'user',
        text:'多段独立会话能不能批量合并导出成一份文档保存？'
      },
      {
        id:'km-a-1',role:'assistant',
        text:'可以在「存储与设置」页点击「合并导出 Markdown」生成完整阅读文档，或者使用「导出 JSON 备份」保留全部来源网址、时间戳与消息 ID 以便迁移恢复。'
      }
    ]
  },
  {
    id:'grok:route-scoping',
    platform:'grok',
    url:'https://x.com/i/grok?conversation=route-scoping',
    title:'X 平台下 /i/grok 路由专属注入配置方案',
    messages:[
      {
        id:'gr-u-1',role:'user',
        text:'怎样只捕获 x.com 里的 Grok 对话，而不干扰 X 主页信息流？'
      },
      {
        id:'gr-a-1',role:'assistant',
        text:'将 `content_scripts` 与 `host_permissions` 收窄到 `https://x.com/i/grok*`，并在路由监听中校验 `MemoCore.platformFor(location.href)`，SPA 切回 `/home` 时自动隐藏悬浮控件。'
      }
    ]
  },
  {
    id:'qianwen:prompt-library',
    platform:'qianwen',
    url:'https://www.qianwen.com/chat/prompt-library',
    title:'个人 AI 知识库按日期与平台组合筛选',
    messages:[
      {
        id:'qw-u-1',role:'user',
        text:'支持按保存时间和具体 AI 平台快速检索记录吗？'
      },
      {
        id:'qw-a-1',role:'assistant',
        text:'支持顶部平台胶囊一键过滤、按保存日期区间（最近一周 / 最近一月 / 自定义起止）筛选，并支持关键词高亮预览与键盘 `↑` `↓` 快速翻阅。'
      }
    ]
  },
  {
    id:'doubao:local-storage-quota',
    platform:'doubao',
    url:'https://www.doubao.com/chat/local-storage-quota',
    title:'浏览器扩展 IndexedDB 容量监控与增量恢复',
    messages:[
      {
        id:'db-u-1',role:'user',
        text:'重装系统前导出的 JSON 备份，再导入时会覆盖现在新保存的对话吗？'
      },
      {
        id:'db-a-1',role:'assistant',
        text:'不会覆盖。导入采用校验后增量合并逻辑，相同 ID 的会话会按时间戳与消息记录安全合并，未冲突的新增对话保留不变。'
      }
    ]
  },
  {
    id:'yuanbao:loopback-sync',
    platform:'yuanbao',
    url:'https://yuanbao.tencent.com/chat/loopback-sync',
    title:'扩展与本机 127.0.0.1 桌面端 256 位密钥配对',
    messages:[
      {
        id:'yb-u-1',role:'user',
        text:'扩展与本地桌面端怎么建立免手动复制密钥的安全连接？'
      },
      {
        id:'yb-a-1',role:'assistant',
        text:'点击「一键连接 MemoCat 并同步」后，扩展自动与本机 `127.0.0.1:3792` 完成扩展 ID 校验和 256 位随机密钥配对，后续变更仅在本地回环通道传递。'
      }
    ]
  }
];

const chatgptFixtureHTML=`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Local-First Sync Cursor &amp; Outbox CAS Design</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif;
      background: #ffffff;
      color: #111827;
      padding: 28px 460px 60px 64px;
    }
    .mock-site-bar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding-bottom: 18px;
      border-bottom: 1px solid #e5e7eb;
      margin-bottom: 28px;
      font-size: 14px;
      font-weight: 600;
      color: #374151;
    }
    .mock-site-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #10a37f;
    }
    .turn-user {
      margin-left: auto;
      max-width: 76%;
      background: #f3f4f6;
      border-radius: 18px;
      padding: 14px 18px;
      font-size: 15px;
      line-height: 1.6;
      margin-bottom: 22px;
    }
    .turn-ai {
      max-width: 92%;
      font-size: 15px;
      line-height: 1.75;
      color: #1f2937;
      margin-bottom: 28px;
    }
    .turn-ai pre {
      background: #0f172a;
      color: #e2e8f0;
      border-radius: 12px;
      padding: 14px 16px;
      font-family: ui-monospace, Menlo, monospace;
      font-size: 13px;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <div class="mock-site-bar">
    <span class="mock-site-dot"></span>
    <span>chatgpt.com · AI Chat Conversation</span>
  </div>
  <div data-message-author-role="user" data-message-id="cg-u-1" class="turn-user">
    如何确保浏览器扩展在多标签并发更新或断网重试时，不会用旧同步回执误删 IndexedDB 里更新排队中的对话？
  </div>
  <div data-message-author-role="assistant" data-message-id="cg-a-1" class="turn-ai">
    <p>建议在 <code>IndexedDB</code> 的 <code>outbox</code> 中结合单调序列号与唯一 UUID <code>changeId</code> 做 CAS 校验：</p>
    <p>1. 每次会话变动入队时递增序列号，覆盖同一对话键并写入新回执标识。<br>
       2. 后台仅在本地服务返回且严格匹配当前 <code>changeId</code> 时执行出队清理。<br>
       3. 桌面端按实例与会话 ID 检查单调序号，拒绝旧写请求覆盖最新状态。</p>
    <pre>if (prior?.changeId === receipt.changeId) {\n  await outbox.delete(receipt.id);\n}</pre>
  </div>
  <div data-message-author-role="user" data-message-id="cg-u-2" class="turn-user">
    网页端开启虚拟滚动后，历史消息临时从 DOM 卸载怎么办？
  </div>
  <div data-message-author-role="assistant" data-message-id="cg-a-2" class="turn-ai">
    <p><code>MemoCore.reconcile</code> 将每次页面观察视为局部窗口，按稳定消息 ID 与精确文本游标对齐补充新增记录，不会因早期 DOM 暂不可见而丢失本地已保存历史。</p>
  </div>
</body>
</html>`;

const profile=await mkdtemp(join(tmpdir(),'memo-cws-profile-'));
const dataDir=await mkdtemp(join(tmpdir(),'memo-cws-data-'));
const app=await start({port:0,dataDir});

const browser=spawn(binary,[
  '--headless=new',
  '--disable-crash-reporter',
  '--no-first-run',
  '--no-default-browser-check',
  '--user-data-dir='+profile,
  '--remote-debugging-port=0',
  '--disable-extensions-except='+join(root,'dist/memocat-extension'),
  '--load-extension='+join(root,'dist/memocat-extension'),
  'about:blank'
],{stdio:'ignore'});

let exited=false;
browser.on('exit',()=>{exited=true;});

const connections=[];
try{
  let debugPort;
  for(let i=0;i<100;i++){
    try{debugPort=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);if(debugPort)break;}catch{}
    if(exited)throw new Error('Test browser failed to launch');
    await sleep(100);
  }
  if(!debugPort)throw new Error('Missing DevToolsActivePort');
  const endpoint=`http://127.0.0.1:${debugPort}`;
  const targets=()=>fetch(endpoint+'/json/list').then(r=>r.json());

  for(let i=0;i<100;i++){
    const list=await targets();
    if(list.some(t=>t.url.includes('/library.html')))break;
    await sleep(100);
  }

  const extTarget=(await targets()).find(t=>t.url.includes('/library.html'));
  if(!extTarget)throw new Error('Extension library.html target not found');

  const ext=await CDP.connect(extTarget.webSocketDebuggerUrl);
  connections.push(ext);
  await ext.send('Runtime.enable');
  await ext.send('Page.enable');
  await ext.send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});

  // Seed IndexedDB conversations, enable auto-save, and pair with local desktop app.
  await ext.evaluate(`(async()=>{
    await import('./lib/db.js');
    for(const item of ${JSON.stringify(sampleConversations)}){
      await MemoDB.save(item,{manual:true});
    }
    await chrome.runtime.sendMessage({type:'settings',patch:{autoSave:true}});
    return true;
  })()`);
  const connectRes=await ext.evaluate(`chrome.runtime.sendMessage({type:'connect',url:${JSON.stringify(app.url)}})`);
  if(!connectRes?.ok)throw new Error('Extension connect failed: '+JSON.stringify(connectRes));

  // Screenshot 1: Archive Workbench (Light) 1280x800
  await ext.evaluate(`(()=>{
    const sel=document.getElementById('library-theme-select');
    if(sel){sel.value='light';sel.dispatchEvent(new Event('change'));}
    location.hash='#library';
    document.getElementById('refresh')?.click();
  })()`);
  await until(()=>ext.evaluate(`!document.getElementById('archive')?.hidden && document.querySelectorAll('#conversation-list .conversation').length>=9 && !!document.querySelector('.conversation[data-id="chatgpt:local-first-outbox"]')`),'Archive workbench did not populate');
  await ext.evaluate(`document.querySelector('.conversation[data-id="chatgpt:local-first-outbox"]').click()`);
  await until(()=>ext.evaluate(`document.querySelectorAll('#detail .message').length===4`),'Conversation detail messages missing');
  await ext.evaluate(`{const t=document.getElementById('toast');if(t)t.hidden=true;}`);
  await sleep(350);
  await ext.send('Page.bringToFront');
  const s1=await ext.send('Page.captureScreenshot',{format:'jpeg',quality:92,captureBeyondViewport:false});
  await writeFile(join(shotDir,'01-archive-workbench-light-1280x800.jpg'),Buffer.from(s1.data,'base64'));
  console.log('Captured 01-archive-workbench-light-1280x800.jpg');

  // Screenshot 2: Archive Workbench (Dark) 1280x800
  await ext.evaluate(`(()=>{
    const sel=document.getElementById('library-theme-select');
    if(sel){sel.value='dark';sel.dispatchEvent(new Event('change'));}
  })()`);
  await until(()=>ext.evaluate(`document.documentElement.dataset.theme==='dark'`),'Dark theme did not activate');
  await ext.evaluate(`document.querySelector('.conversation[data-id="claude:mv3-csp-isolation"]')?.click()`);
  await until(()=>ext.evaluate(`document.querySelectorAll('#detail .message').length===2 && document.querySelector('#detail h2')?.textContent.includes('Manifest V3')`),'Claude thread did not render in dark mode');
  await ext.evaluate(`{const t=document.getElementById('toast');if(t)t.hidden=true;}`);
  await sleep(350);
  const s2=await ext.send('Page.captureScreenshot',{format:'jpeg',quality:92,captureBeyondViewport:false});
  await writeFile(join(shotDir,'02-archive-workbench-dark-1280x800.jpg'),Buffer.from(s2.data,'base64'));
  console.log('Captured 02-archive-workbench-dark-1280x800.jpg');

  // Switch back to light mode for remaining clean screenshots.
  await ext.evaluate(`(()=>{
    const sel=document.getElementById('library-theme-select');
    if(sel){sel.value='light';sel.dispatchEvent(new Event('change'));}
  })()`);
  await until(()=>ext.evaluate(`document.documentElement.dataset.theme==='light'`),'Light theme did not restore');

  // Screenshot 3: In-page AI sidebar overlay + floating capture pill (1280x800)
  const browserInfo=await (await fetch(endpoint+'/json/version')).json();
  const rootCdp=await CDP.connect(browserInfo.webSocketDebuggerUrl);
  connections.push(rootCdp);
  const {targetId:webTabId}=await rootCdp.send('Target.createTarget',{url:'about:blank'});
  let webTarget;
  for(let i=0;i<30;i++){webTarget=(await targets()).find(t=>t.id===webTabId);if(webTarget)break;await sleep(100);}
  const page=await CDP.connect(webTarget.webSocketDebuggerUrl);
  connections.push(page);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
  await page.send('Fetch.enable',{patterns:[{urlPattern:'https://chatgpt.com/*',requestStage:'Request'}]});
  page.on('Fetch.requestPaused',({requestId})=>{
    void page.send('Fetch.fulfillRequest',{
      requestId,
      responseCode:200,
      responseHeaders:[{name:'Content-Type',value:'text/html; charset=utf-8'}],
      body:Buffer.from(chatgptFixtureHTML).toString('base64')
    });
  });

  await page.send('Page.navigate',{url:'https://chatgpt.com/c/local-first-outbox'});
  await until(()=>page.evaluate(`Boolean(document.getElementById('memocat-capture')) && document.getElementById('memocat-capture').hidden===false`),'Floating capture pill not injected on mock ChatGPT page');
  await sleep(500);
  await ext.evaluate(`(async()=>{
    const tabs=await chrome.tabs.query({url:'https://chatgpt.com/*'});
    if(tabs[0])await chrome.tabs.sendMessage(tabs[0].id,{type:'toggleSidebar'});
  })()`);
  await until(()=>page.evaluate(`document.getElementById('memocat-sidebar')?.style.right==='0px'`),'In-page MemoCat sidebar did not open');
  await sleep(900);
  await page.send('Page.bringToFront');
  const s3=await page.send('Page.captureScreenshot',{format:'jpeg',quality:92,captureBeyondViewport:false});
  await writeFile(join(shotDir,'03-inpage-sidebar-capture-1280x800.jpg'),Buffer.from(s3.data,'base64'));
  console.log('Captured 03-inpage-sidebar-capture-1280x800.jpg');
  await page.send('Fetch.disable');

  // Screenshot 4: Platform Capture & Desktop Sync (#connections) 1280x800
  await ext.send('Page.bringToFront');
  await ext.evaluate(`(()=>{
    location.hash='#connections';
    window.scrollTo(0,0);
  })()`);
  await until(()=>ext.evaluate(`!document.getElementById('connections')?.hidden && document.querySelectorAll('#platform-settings .platform-card').length===9 && document.getElementById('sync-badge')?.textContent.includes('已连接')`),'Connections page not ready');
  await ext.evaluate(`{const t=document.getElementById('toast');if(t)t.hidden=true;}`);
  await sleep(350);
  const s4=await ext.send('Page.captureScreenshot',{format:'jpeg',quality:92,captureBeyondViewport:false});
  await writeFile(join(shotDir,'04-platform-capture-sync-1280x800.jpg'),Buffer.from(s4.data,'base64'));
  console.log('Captured 04-platform-capture-sync-1280x800.jpg');

  // Screenshot 5: Storage, Backup & Theme Settings (#settings) 1280x800
  await ext.evaluate(`(()=>{
    location.hash='#settings';
    window.scrollTo(0,0);
  })()`);
  await until(()=>ext.evaluate(`!document.getElementById('settings')?.hidden && document.getElementById('settings-storage-usage')?.textContent.includes('/')`),'Settings page not ready');
  await ext.evaluate(`{const t=document.getElementById('toast');if(t)t.hidden=true;}`);
  await sleep(350);
  const s5=await ext.send('Page.captureScreenshot',{format:'jpeg',quality:92,captureBeyondViewport:false});
  await writeFile(join(shotDir,'05-backup-theme-settings-1280x800.jpg'),Buffer.from(s5.data,'base64'));
  console.log('Captured 05-backup-theme-settings-1280x800.jpg');

  // Generate exact-size Chrome Web Store promo tiles (440x280 & 1400x560, opaque JPEG).
  const icon128B64=(await readFile(outIcon)).toString('base64');
  const platformIds=['chatgpt','claude','gemini','deepseek','grok','kimi','qianwen','doubao','yuanbao'];
  const platformIcons=await Promise.all(platformIds.map(async id=>({
    id,
    b64:(await readFile(join(root,`extension/icons/platforms/${id}.png`))).toString('base64')
  })));
  const iconStripHTML=platformIcons.map(p=>`<span class="plat"><img src="data:image/png;base64,${p.b64}" alt=""></span>`).join('');

  const smallPromoHTML=`<!doctype html>
<html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{
    width:440px;height:280px;overflow:hidden;
    font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
    background:radial-gradient(circle at 85% 18%,#dbeafe 0%,#eef2ff 45%,#f8fafc 100%);
    color:#0f172a;padding:26px 28px;display:flex;flex-direction:column;justify-content:space-between;
  }
  .top{display:flex;align-items:center;gap:14px}
  .logo{width:54px;height:54px;border-radius:14px;box-shadow:0 8px 20px rgba(76,100,203,.24)}
  h1{font-size:24px;font-weight:750;letter-spacing:-.02em;color:#111827}
  .sub{font-size:12.5px;color:#4c64cb;font-weight:600;margin-top:3px}
  .desc{font-size:14.5px;line-height:1.5;color:#334155;font-weight:500}
  .strip{display:flex;align-items:center;gap:8px;flex-wrap:nowrap}
  .plat{width:30px;height:30px;border-radius:9px;background:#fff;border:1px solid rgba(15,23,42,.08);display:inline-flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(15,23,42,.05)}
  .plat img{width:18px;height:18px;border-radius:4px}
  .foot{display:flex;justify-content:space-between;align-items:center;font-size:11.5px;color:#64748b;font-weight:600}
  .badge{background:#4c64cb;color:#fff;padding:4px 10px;border-radius:999px;font-size:11px}
</style></head><body>
  <div class="top">
    <img class="logo" src="data:image/png;base64,${icon128B64}" alt="">
    <div>
      <h1>MemoCat</h1>
      <div class="sub">本地 AI 对话归档 · Chrome 扩展</div>
    </div>
  </div>
  <p class="desc">一键保存与全文搜索 9 大网页 AI 对话<br>纯本机 IndexedDB 存储 · 可选 127.0.0.1 同步</p>
  <div>
    <div class="strip">${iconStripHTML}</div>
  </div>
  <div class="foot">
    <span>多站点网页对话采集</span>
    <span class="badge">离线无遥测</span>
  </div>
</body></html>`;

  const marqueePromoHTML=`<!doctype html>
<html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{
    width:1400px;height:560px;overflow:hidden;
    font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
    background:radial-gradient(circle at 82% 20%,#dbeafe 0%,#e0e7ff 38%,#f8fafc 100%);
    color:#0f172a;padding:64px 80px;display:flex;align-items:center;justify-content:space-between;gap:56px;
  }
  .left{flex:1;max-width:660px}
  .brand{display:flex;align-items:center;gap:18px;margin-bottom:26px}
  .brand img{width:68px;height:68px;border-radius:18px;box-shadow:0 12px 28px rgba(76,100,203,.25)}
  .tag{display:inline-block;background:#eef2ff;color:#4c64cb;border:1px solid #c7d2fe;font-size:14px;font-weight:650;padding:5px 14px;border-radius:999px;margin-bottom:10px}
  h1{font-size:48px;line-height:1.15;font-weight:800;letter-spacing:-.025em;margin-bottom:18px;color:#0f172a}
  p{font-size:20px;line-height:1.6;color:#334155;margin-bottom:30px}
  .strip{display:flex;align-items:center;gap:12px}
  .plat{width:44px;height:44px;border-radius:12px;background:#fff;border:1px solid rgba(15,23,42,.08);display:inline-flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(15,23,42,.06)}
  .plat img{width:26px;height:26px;border-radius:5px}
  .right{width:520px;background:#fff;border-radius:20px;border:1px solid #e2e8f0;box-shadow:0 24px 60px rgba(15,23,42,.12);padding:24px;display:flex;flex-direction:column;gap:14px}
  .card-head{display:flex;justify-content:space-between;align-items:center;padding-bottom:12px;border-bottom:1px solid #f1f5f9;font-size:14px;font-weight:700;color:#1e293b}
  .pill{font-size:12px;color:#15803d;background:#dcfce7;padding:4px 10px;border-radius:999px}
  .bubble{padding:12px 16px;border-radius:14px;font-size:14.5px;line-height:1.55}
  .bubble.user{align-self:flex-end;background:#4c64cb;color:#fff;max-width:82%;border-bottom-right-radius:4px}
  .bubble.ai{align-self:flex-start;background:#f8fafc;border:1px solid #e2e8f0;color:#1e293b;max-width:88%;border-bottom-left-radius:4px}
  .meta-row{display:flex;gap:10px;padding-top:6px;font-size:12.5px;color:#64748b;font-weight:600}
  .chip{background:#f1f5f9;padding:5px 10px;border-radius:8px}
</style></head><body>
  <div class="left">
    <div class="brand">
      <img src="data:image/png;base64,${icon128B64}" alt="">
      <div>
        <span class="tag">Manifest V3 · 本地优先归档</span>
        <div style="font-size:20px;font-weight:700;color:#1e293b">MemoCat · AI 对话归档扩展</div>
      </div>
    </div>
    <h1>把分散在各 AI 网站的<br>重要对话留在本机</h1>
    <p>适配多个主流网页 AI 对话平台，支持聊天气泡阅读、深色模式、Prompt 复用与本机 127.0.0.1 桌面库同步。</p>
    <div class="strip">${iconStripHTML}</div>
  </div>
  <div class="right">
    <div class="card-head">
      <span>Local-First Conversation Archive</span>
      <span class="pill">● 纯本机存储</span>
    </div>
    <div class="bubble user">帮我归档这段架构讨论，并导出成可复用的上下文 Prompt</div>
    <div class="bubble ai">已保存至浏览器本地 IndexedDB：支持全文搜索、暗色主题阅读、Markdown/JSON 导出，以及与 MemoCat 桌面端同步。</div>
    <div class="meta-row">
      <span class="chip">⌘K 全文检索</span>
      <span class="chip">复制为 Prompt</span>
      <span class="chip">JSON 增量恢复</span>
    </div>
  </div>
</body></html>`;

  const promoPage=await rootCdp.send('Target.createTarget',{url:'about:blank'});
  let promoTarget;
  for(let i=0;i<30;i++){promoTarget=(await targets()).find(t=>t.id===promoPage.targetId);if(promoTarget)break;await sleep(100);}
  const promoCdp=await CDP.connect(promoTarget.webSocketDebuggerUrl);
  connections.push(promoCdp);
  await promoCdp.send('Page.enable');

  await promoCdp.send('Emulation.setDeviceMetricsOverride',{width:440,height:280,deviceScaleFactor:1,mobile:false});
  await promoCdp.send('Page.navigate',{url:'data:text/html;charset=utf-8,'+encodeURIComponent(smallPromoHTML)});
  await sleep(250);
  await promoCdp.send('Page.bringToFront');
  const pSmall=await promoCdp.send('Page.captureScreenshot',{format:'jpeg',quality:95,captureBeyondViewport:false});
  await writeFile(join(promoDir,'small-promo-440x280.jpg'),Buffer.from(pSmall.data,'base64'));
  console.log('Captured small-promo-440x280.jpg');

  await promoCdp.send('Emulation.setDeviceMetricsOverride',{width:1400,height:560,deviceScaleFactor:1,mobile:false});
  await promoCdp.send('Page.navigate',{url:'data:text/html;charset=utf-8,'+encodeURIComponent(marqueePromoHTML)});
  await sleep(250);
  const pMarquee=await promoCdp.send('Page.captureScreenshot',{format:'jpeg',quality:95,captureBeyondViewport:false});
  await writeFile(join(promoDir,'marquee-promo-1400x560.jpg'),Buffer.from(pMarquee.data,'base64'));
  console.log('Captured marquee-promo-1400x560.jpg');
}finally{
  for(const c of connections){try{c.close();}catch{}}
  if(!exited){
    browser.kill('SIGTERM');
    await new Promise(r=>{const t=setTimeout(()=>{browser.kill('SIGKILL');r();},4000);browser.once('exit',()=>{clearTimeout(t);r();});});
  }
  await app.close();
  await rm(profile,{recursive:true,force:true});
  await rm(dataDir,{recursive:true,force:true});
}

const zhShort='在本机保存、搜索和导出网页 AI 对话，支持多平台归档与 Markdown/JSON 备份，可选通过 127.0.0.1 同步至桌面端工作台。';
const enShort='Save, search, and export AI web conversations locally with Markdown/JSON backup and optional localhost desktop sync.';
if(enShort.length>132||zhShort.length>132){
  throw new Error('Short description exceeds Chrome Web Store 132-character limit');
}

const submissionGuide=`# Chrome Web Store 提交材料清单 · MemoCat (${manifest.version})

> 目录内所有交付件均通过 \`npm run build:cws\` 自动生成与校验，上传前请确认已将 \`docs/site/\` 推送并启用 GitHub Pages（\`https://memocat.qiwihui.com/privacy.html\` 可公开访问）。

---

## 一、待上传文件清单

| 类型 | 规格要求 | 本地文件路径 |
|---|---|---|
| 扩展程序 ZIP 包 | MV3，${zipEntries.length} 个文件，无 \`.DS_Store\` | \`dist/chrome-web-store/memocat-extension-${manifest.version}.zip\` |
| 商店图标 | 128×128 PNG | \`dist/chrome-web-store/store-icon-128x128.png\` |
| 商店截图 #1 | 1280×800 JPEG（无透明通道） | \`dist/chrome-web-store/screenshots/01-archive-workbench-light-1280x800.jpg\` |
| 商店截图 #2 | 1280×800 JPEG（无透明通道） | \`dist/chrome-web-store/screenshots/02-archive-workbench-dark-1280x800.jpg\` |
| 商店截图 #3 | 1280×800 JPEG（无透明通道） | \`dist/chrome-web-store/screenshots/03-inpage-sidebar-capture-1280x800.jpg\` |
| 商店截图 #4 | 1280×800 JPEG（无透明通道） | \`dist/chrome-web-store/screenshots/04-platform-capture-sync-1280x800.jpg\` |
| 商店截图 #5 | 1280×800 JPEG（无透明通道） | \`dist/chrome-web-store/screenshots/05-backup-theme-settings-1280x800.jpg\` |
| 小型宣传图块（可选） | 440×280 JPEG（无透明通道） | \`dist/chrome-web-store/promo/small-promo-440x280.jpg\` |
| 顶部精选宣传图（可选） | 1400×560 JPEG（无透明通道） | \`dist/chrome-web-store/promo/marquee-promo-1400x560.jpg\` |

---

## 二、Store Listing（商品详情）填写内容

- **Extension name**：\`MemoCat · AI 对话归档\`（或英文清单名 \`MemoCat — Local AI Chat Archive\`）
- **Category**：\`Productivity\`（效率工具）
- **Language**：\`Chinese (Simplified)\`（可附加 \`English\` 本地化详情）

### 1. Short description（不超过 132 字符）
- **中文**（${zhShort.length} 字符）：
  \`\`\`
  ${zhShort}
  \`\`\`
- **English**（${enShort.length} chars）：
  \`\`\`
  ${enShort}
  \`\`\`

### 2. Detailed description（中文 / English）
\`\`\`text
MemoCat 是一款采用纯本机离线架构的 AI 对话归档扩展，帮助你把分散在网页端的 AI 聊天记录稳定保存、整理和检索。

核心功能：
• 多站点对话采集：在已适配的 AI 对话网页提取当前加载的问答内容，提供页面保存胶囊与分站点独立开关。
• 纯本机保存：默认手动保存，支持按站点开启自动保存；全部正文保存在浏览器本地 IndexedDB 中，无账号、无云端上传、无遥测。
• 对话工作台与侧边抽屉：双栏工作台提供浅色 / 深色 / 跟随系统三种外观，支持来源胶囊筛选、日期筛选、关键词高亮、左右聊天气泡展示、单条复制与「复制为 Prompt」。
• 长对话安全合并：针对网页虚拟列表仅增量补齐新增消息，不会因顶部旧消息从 DOM 卸载而覆盖或丢失历史。
• 备份与桌面协同：支持单会话导出、全库 JSON 备份增量恢复与 Markdown 合并导出；也可选择与本机 127.0.0.1 运行的 MemoCat 桌面端配对同步。
\`\`\`

\`\`\`text
MemoCat is a local-first Chrome extension that archives, organizes, and searches your AI web conversations—100% stored on your device.

Key Features:
• Multi-Site Conversation Capture: Extracts loaded Q&A messages on supported AI chat web pages with an in-page save control and per-site toggles.
• Local-First Storage: Manual capture by default with optional per-site auto-save. Conversations stay in your browser's local IndexedDB—no account, no cloud server, no telemetry.
• Clean Workbench & In-Page Sidebar: Browse saved threads in left-right chat bubbles with code copy, "Copy as Prompt", platform filter pills, date ranges, keyword highlighting, and Light / Dark / System themes.
• Virtual-Scroll Safe Merging: Incremental DOM window reconciliation keeps earlier archived messages intact even when long chat pages virtualize old nodes.
• Backup & Optional Desktop Sync: Export/import incremental JSON backups, export merged Markdown, or optionally sync via localhost (127.0.0.1) to MemoCat Desktop.
\`\`\`

### 3. Graphic Assets & Store Links
- **Official URL / Homepage URL**：\`https://memocat.qiwihui.com/\`
- **Support URL**：\`https://memocat.qiwihui.com/support.html\`
- **Privacy Policy URL**：\`https://memocat.qiwihui.com/privacy.html\`（英文版：\`https://memocat.qiwihui.com/en/privacy.html\`）

---

## 三、Privacy Practices（隐私权实务）逐项填写

### Single Purpose Description（单一用途说明）
\`\`\`text
Capture, search, organize, and locally archive conversations from supported AI web chat interfaces in browser IndexedDB, with optional user-initiated localhost (127.0.0.1) sync to the MemoCat Desktop app.
\`\`\`

### Permission Justifications（权限申请理由）
- **\`storage\`**
  > Stores local user preferences (manual vs. auto-save mode, per-platform enablement switches, UI theme preference, floating widget coordinates, and optional localhost desktop pairing key).
- **\`unlimitedStorage\`**
  > Stores full local text archives of user-saved AI conversations in IndexedDB so browsers do not prematurely evict long chat archives under default quota limits.
- **\`alarms\`**
  > Schedules periodic background retry checks for the persistent local outbox queue when the user explicitly opts in to synchronizing conversations to MemoCat Desktop over localhost (\`127.0.0.1\`).
- **\`host_permissions\`（共 ${manifest.host_permissions.length} 条）**
  - Supported AI platforms（\`https://chatgpt.com/*\`、\`https://chat.openai.com/*\`、\`https://claude.ai/*\`、\`https://gemini.google.com/*\`、\`https://chat.deepseek.com/*\`、\`https://yuanbao.tencent.com/*\`、\`https://www.doubao.com/*\`、\`https://kimi.moonshot.cn/*\`、\`https://kimi.com/*\`、\`https://*.kimi.com/*\`、\`https://qianwen.com/*\`、\`https://www.qianwen.com/*\`、\`https://x.com/i/grok*\`、\`https://grok.com/*\`、\`https://www.grok.com/*\`）：
    > Required to inject the read-only conversation extractor and floating capture pill solely on explicitly listed AI chat pages (\`x.com\` is restricted strictly to \`/i/grok*\`). No host script runs outside these AI chat URLs.
  - \`http://127.0.0.1/*\`：
    > Used exclusively when the user clicks "一键连接 MemoCat 并同步" to pair with and incrementally sync local conversations to the MemoCat Desktop application running on localhost \`127.0.0.1:3792\`. No external network traffic is generated.

### Remote Code & Data Disclosure
- **Are you using remote code?** -> 选择 **\`No, I am not using Remote code\`**
  - Justification if prompted: \`All scripts, stylesheets, and icons are packaged locally inside the extension ZIP under strict MV3 CSP ("script-src 'self'").\`
- **Data Usage Collection**：全部勾选 **不收集任何用户数据**（Zero data collection），并勾选确认遵循 Chrome Web Store Limited Use 政策。

---

## 四、Reviewer Instructions（Distribution -> Testing Instructions）

\`\`\`text
1. No login or external account is required. Installing the extension automatically opens the local Workbench page (library.html).
2. You can import a sample JSON backup under "存储与设置 -> 导入 JSON 备份" or visit any supported AI site (e.g., https://chatgpt.com/ or https://x.com/i/grok) to see the floating save control in the top-right corner and click the MemoCat icon to open the in-page sidebar drawer.
3. Non-Grok routes on x.com (such as https://x.com/home) do not inject content scripts due to the scoped pattern https://x.com/i/grok*.
4. Desktop sync (http://127.0.0.1:3792) is strictly optional and disabled by default; all archiving, search, chat-bubble reading, theme switching, Markdown export, and JSON backup/restore work standalone inside the browser.
\`\`\`
`;

await writeFile(join(outRoot,'CHROME_WEB_STORE_SUBMISSION.md'),submissionGuide);
console.log('Generated Chrome Web Store package, 5 screenshots, 2 promo tiles, and CHROME_WEB_STORE_SUBMISSION.md');
