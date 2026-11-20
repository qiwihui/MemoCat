import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {start} from '../src/server.js';

const binary=process.env.MEMO_BROWSER_BINARY||'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
await access(binary);

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
  for(let i=0;i<100;i++){if(await fn())return;await sleep(100);}
  throw new Error(msg);
}

const profile=await mkdtemp(join(tmpdir(),'memo-site-shot-profile-'));
const dataDir=await mkdtemp(join(tmpdir(),'memo-site-shot-data-'));
const sourceRoot=join(dataDir,'mock-sources');
for(const s of ['codex','claude-code','grok-bot','antigravity'])await mkdir(join(sourceRoot,s),{recursive:true});

const app=await start({port:0,dataDir});

const isoDaysAgo=(days,hour=14,min=20)=>{
  const d=new Date();
  d.setDate(d.getDate()-days);
  d.setHours(hour,min,0,0);
  return d.toISOString();
};

const localConversations=[
  {
    meta:{
      channelId:'codex',
      threadId:'codex-sqlite-fts5-recall',
      title:'SQLite WAL 与 FTS5 trigram 混合召回架构设计',
      createdAt:isoDaysAgo(0,9,10),
      lastActiveAt:isoDaysAgo(0,10,42),
      sourcePath:'/Users/demo/.codex/sessions/2026/11/rollout-fts5-recall.jsonl'
    },
    records:[
      {
        id:'c-u-1',seq:0,role:'user',ts:isoDaysAgo(0,9,12),sourceRef:'rollout-fts5-recall.jsonl:12',
        text:'我们需要在纯本机离线条件下索引十万级历史对话，支持中英文混合关键词检索、片段边界合并和 9,600 token 预算裁剪，应该如何设计存储和召回管线？'
      },
      {
        id:'c-a-1',seq:1,role:'assistant',ts:isoDaysAgo(0,9,14),sourceRef:'rollout-fts5-recall.jsonl:28',
        text:[
          '建议采用 **SQLite WAL + FTS5 trigram** 作为底层索引，并配合按对话回合切分的混合召回引擎：',
          '',
          '1. **持久化层**：单库 `memo.sqlite` 开启 `PRAGMA journal_mode=WAL`，用内容哈希 `version` 做幂等 upsert，避免重复写入与索引抖动。',
          '2. **分词与权重**：中文抽取连续 2-gram（CJK Bigram），英文与数字保留完整词元；用户提问字段权重设为 `2.5`，AI 回复权重为 `1.0`。',
          '3. **区域平滑与预算**：对每个会话单元做 5 邻域平滑 `[0.08, 0.22, 0.40, 0.22, 0.08]`，向外扩展合并高相关区域，最终输出不超过 8 个区域、总计 `9,600 token`。',
          '',
          '```sql',
          'CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(',
          "  title, text, content='conversations',",
          "  content_rowid='id', tokenize='trigram'",
          ');',
          '```'
        ].join('\n')
      },
      {
        id:'c-u-2',seq:2,role:'user',ts:isoDaysAgo(0,10,35),sourceRef:'rollout-fts5-recall.jsonl:51',
        text:'如果同一个 AI 客户端在连续几轮里多次调用 MCP `recall`，如何避免把已经看过的片段重复塞进上下文？'
      },
      {
        id:'c-a-2',seq:3,role:'assistant',ts:isoDaysAgo(0,10,42),sourceRef:'rollout-fts5-recall.jsonl:68',
        text:[
          '通过 `process_id` 绑定会话上下文并维护三态交付记录（`prepared` / `committed` / `abandoned`）：',
          '',
          '- 首次调用返回 `process_id`，后续同一 AI 对话原样带回；服务端校验 `caller` 归属。',
          '- 仅当 HTTP 响应完整写回（`res.once("finish")`）后标记为 `committed`，被中断或配置变更则记为 `abandoned`。',
          '- 下一次检索时过滤当前 `process_id` 下已 `committed` 或在途 `prepared` 完整单元的 `unitIds`，被截断的片段不计入已读集合。'
        ].join('\n')
      }
    ]
  },
  {
    meta:{
      channelId:'claude-code',
      threadId:'claude-mas-sandbox-bookmarks',
      title:'macOS Security-Scoped Bookmarks 目录授权持久化',
      createdAt:isoDaysAgo(0,8,20),
      lastActiveAt:isoDaysAgo(0,9,30),
      sourcePath:'/Users/demo/.claude/projects/memocat/session-bookmarks.jsonl'
    },
    records:[
      {
        id:'cc-u-1',seq:0,role:'user',ts:isoDaysAgo(0,8,22),sourceRef:'session-bookmarks.jsonl:4',
        text:'Mac App Store 沙盒下如何让用户授权读取 `~/.codex` 和 `~/.claude/projects` 等隐藏目录，并在下次重启后继续有效？'
      },
      {
        id:'cc-a-1',seq:1,role:'assistant',ts:isoDaysAgo(0,9,30),sourceRef:'session-bookmarks.jsonl:19',
        text:'在 Electron 主进程调用 `dialog.showOpenDialog` 时开启 `showHiddenFiles` 与 `securityScopedBookmarks: true`，将返回的 base64 Bookmark 随来源配置持久化；应用启动时依次执行 `app.startAccessingSecurityScopedResource(bookmark)`，并在 `will-quit` 时统一释放句柄。'
      }
    ]
  },
  {
    meta:{
      channelId:'antigravity',
      threadId:'ag-mcp-interop-policy',
      title:'跨 AI HTTP MCP 端点隔离与白名单校验',
      createdAt:isoDaysAgo(1,16,10),
      lastActiveAt:isoDaysAgo(1,16,45),
      sourcePath:'/Users/demo/.gemini/antigravity/brain/session/transcript.jsonl'
    },
    records:[
      {
        id:'ag-u-1',seq:0,role:'user',ts:isoDaysAgo(1,16,12),sourceRef:'transcript.jsonl:1',
        text:'如何在本机同时接入 Codex 和 Claude Code，又防止某个客户端读到未授权的网页对话来源？'
      },
      {
        id:'ag-a-1',seq:1,role:'assistant',ts:isoDaysAgo(1,16,45),sourceRef:'transcript.jsonl:2',
        text:'为每个客户端分配独立路径 `/mcp/codex`、`/mcp/claude-code`、`/mcp/other-local`，在 `scopedArgs` 阶段校验授权来源白名单；若取用期间配置发生变化，`samePolicy` 检查会立即中止并标记交付为 `abandoned`。'
      }
    ]
  },
  {
    meta:{
      channelId:'grok-bot',
      threadId:'gb-compact-responsive-shell',
      title:'Electron 桌面壳与 1/4 屏紧凑响应式布局适配',
      createdAt:isoDaysAgo(2,11,5),
      lastActiveAt:isoDaysAgo(2,11,40),
      sourcePath:'/Users/demo/Library/Application Support/Grok Bot/replica.blob#1'
    },
    records:[
      {
        id:'gb-u-1',seq:0,role:'user',ts:isoDaysAgo(2,11,8),sourceRef:'replica.blob#1',
        text:'当用户在 macOS 上把工作台缩放到 1/4 屏窄窗口（< 600px）时，左侧双栏和导航如何保持可用？'
      },
      {
        id:'gb-a-1',seq:1,role:'assistant',ts:isoDaysAgo(2,11,40),sourceRef:'replica.blob#2',
        text:'在 `@media (max-width: 600px)` 下将主导航移至底部 54px 标签栏，工作台自动转为上下分栏（38% 会话列表 + 自适应正文），并在窗口顶部预留红黄绿信号灯拖拽区。'
      }
    ]
  }
];

for(const conv of localConversations)app.store.save(conv);

// Configure local sources as detected + authorized for Data Pipeline showcase
app.store.setSetting('sources',[
  {id:'codex',path:join(sourceRoot,'codex'),enabled:true,bookmark:'demo-bookmark-codex'},
  {id:'claude-code',path:join(sourceRoot,'claude-code'),enabled:true,bookmark:'demo-bookmark-claude'},
  {id:'grok-bot',path:join(sourceRoot,'grok-bot'),enabled:true},
  {id:'antigravity',path:join(sourceRoot,'antigravity'),enabled:true}
]);
app.store.setSetting('sourceRuns',{
  codex:{lastRun:isoDaysAgo(0,10,45),issues:[]},
  'claude-code':{lastRun:isoDaysAgo(0,10,45),issues:[]},
  'grok-bot':{lastRun:isoDaysAgo(0,10,45),issues:[]},
  antigravity:{lastRun:isoDaysAgo(0,10,45),issues:[]}
});
app.store.setSetting('interopClients',{
  codex:{enabled:true,sources:['codex','claude-code','antigravity','browser-chatgpt','browser-claude','browser-deepseek']},
  'claude-code':{enabled:true,sources:null},
  'other-local':{enabled:false,sources:[]}
});

// Seed 7-day historical ingestion events pointing to existing threads for realistic Statistics chart
const pastEvents=[
  [6,'codex','codex-sqlite-fts5-recall',18],
  [6,'claude-code','claude-mas-sandbox-bookmarks',12],
  [5,'codex','codex-sqlite-fts5-recall',26],
  [5,'antigravity','ag-mcp-interop-policy',14],
  [4,'claude-code','claude-mas-sandbox-bookmarks',22],
  [4,'grok-bot','gb-compact-responsive-shell',9],
  [3,'codex','codex-sqlite-fts5-recall',31],
  [3,'antigravity','ag-mcp-interop-policy',16],
  [2,'grok-bot','gb-compact-responsive-shell',15],
  [2,'claude-code','claude-mas-sandbox-bookmarks',19],
  [1,'antigravity','ag-mcp-interop-policy',24],
  [1,'codex','codex-sqlite-fts5-recall',21]
];
for(const [days,source,thread,count] of pastEvents){
  app.store.db.prepare('INSERT INTO ingestion_events(source,thread,created,messages) VALUES(?,?,?,?)').run(source,thread,isoDaysAgo(days,15,0),count);
}

const browserConversations=[
  {
    id:'chatgpt:local-first-outbox',platform:'chatgpt',url:'https://chatgpt.com/c/local-first-outbox',
    title:'Local-First Sync Cursor & Outbox CAS Design',
    messages:[
      {id:'m1',role:'user',text:'如何防止浏览器扩展在断网重试或并发修改时，用旧的同步回执误删新排队的对话变更？'},
      {id:'m2',role:'assistant',text:'在 IndexedDB `outbox` 中为每次写入生成递增 `sequence` 与 UUID `changeId`。只有当桌面端返回的 `changeId` 与当前 `outbox` 队头记录严格一致时才执行 `ack` 删除；桌面端同时按 `(sourceInstanceId, conversationId)` 检查单调序列号 `prior.sequence >= c.sequence`。'}
    ]
  },
  {
    id:'claude:mv3-csp-isolation',platform:'claude',url:'https://claude.ai/chat/mv3-csp-isolation',
    title:'Chrome MV3 CSP 策略与网页增量 DOM 解析',
    messages:[
      {id:'m1',role:'user',text:'Manifest V3 下内容脚本与扩展后台页面的权限边界怎么划分才符合商店安全规范？'},
      {id:'m2',role:'assistant',text:'Content Script 仅拥有 `captureSettings` 读取和当前页 `observe` 提交权限，后台 `trusted(sender)` 校验 `sender.url` 必须来自扩展自身页面后才开放导出、导入与删除操作，并启用严格 `script-src \'self\'` CSP。'}
    ]
  },
  {
    id:'gemini:cjk-bigram-weights',platform:'gemini',url:'https://gemini.google.com/app/cjk-bigram-weights',
    title:'中英文 Bigram 分词与字段权重调优',
    messages:[
      {id:'m1',role:'user',text:'技术对话里经常中英混杂（比如「SQLite 触发器」），无分词器怎么保证召回率？'},
      {id:'m2',role:'assistant',text:'英文与数字按连续 `[a-z0-9]+` 切词，CJK 字符切分为重叠 2-gram，并与 SQLite FTS5 `trigram` 结合；同时支持主查询权重 `1.0` 配合最多 8 条同义补充词（权重 `0.72`）双轨打分。'}
    ]
  },
  {
    id:'deepseek:node24-sqlite-wal',platform:'deepseek',url:'https://chat.deepseek.com/a/chat/s/node24-sqlite-wal',
    title:'Node.js 24 内置 node:sqlite 并发与 WAL 实践',
    messages:[
      {id:'m1',role:'user',text:'使用 Node 24 原生 `node:sqlite` 的 `DatabaseSync` 需要注意哪些事务并发问题？'},
      {id:'m2',role:'assistant',text:'建议初始化时启用 `PRAGMA journal_mode=WAL` 与外键约束，写操作使用 `BEGIN IMMEDIATE` 包裹并在异常时显式 `ROLLBACK`，读路径与 MCP 调用队列通过异步互斥门控串行协调，避免快照不一致。'}
    ]
  },
  {
    id:'kimi:virtual-list-merge',platform:'kimi',url:'https://www.kimi.com/chat/virtual-list-merge',
    title:'长对话虚拟列表下的局部窗口合并策略',
    messages:[
      {id:'m1',role:'user',text:'AI 网页端对长对话使用虚拟滚动卸载顶部 DOM 时，自动采集会不会把老消息覆盖掉？'},
      {id:'m2',role:'assistant',text:'不会。`MemoCore.reconcile` 将每次页面观察视为局部窗口，按稳定 DOM ID 与精确文本游标对齐插入新增消息，绝不因早期节点暂不可见而截断本地已保存历史。'}
    ]
  },
  {
    id:'qianwen:markdown-sanitization',platform:'qianwen',url:'https://www.qianwen.com/chat/markdown-sanitization',
    title:'Markdown 安全渲染与 DOMPurify 规则清单',
    messages:[
      {id:'m1',role:'user',text:'渲染历史对话里的 Markdown 代码块时怎样防止恶意标签或样式注入？'},
      {id:'m2',role:'assistant',text:'使用 `marked.parse` 解析后立即经过 `DOMPurify.sanitize`，禁用 `img`、`iframe`、`style`、`form`、`input` 标签与内联 `style` 属性，外部链接强制加上 `rel="noopener noreferrer"`。'}
    ]
  },
  {
    id:'doubao:idb-backup-restore',platform:'doubao',url:'https://www.doubao.com/chat/idb-backup-restore',
    title:'浏览器扩展 IndexedDB 配额与 JSON 增量恢复',
    messages:[
      {id:'m1',role:'user',text:'浏览器扩展里的本地对话库最多能存多少？清空或换电脑后怎么恢复？'},
      {id:'m2',role:'assistant',text:'扩展声明了 `unlimitedStorage` 权限，避免浏览器配额自动回收；支持一键导出含完整消息与来源 URL 的 JSON 备份或合并 Markdown，导入时自动校验格式并与现有记录增量合并。'}
    ]
  },
  {
    id:'yuanbao:loopback-origin-guard',platform:'yuanbao',url:'https://yuanbao.tencent.com/chat/loopback-origin-guard',
    title:'本机 127.0.0.1 回环接口 Origin 与跨站校验',
    messages:[
      {id:'m1',role:'user',text:'本地桌面服务监听 3792 端口时，怎样防止外部网页通过跨站请求窃取本地对话？'},
      {id:'m2',role:'assistant',text:'所有接口严格校验 `Host` 必须为 `127.0.0.1:端口` 或 `localhost:端口`，非扩展路由拒绝任意外部 `Origin` 与 `Sec-Fetch-Site: cross-site`；扩展同步接口则校验 32 位扩展 ID 与 256 位随机 Bearer 密钥。'}
    ]
  },
  {
    id:'grok:mcp-streamable-http',platform:'grok',url:'https://grok.com/c/mcp-streamable-http',
    title:'MCP Streamable HTTP 无状态协议握手与工具声明',
    messages:[
      {id:'m1',role:'user',text:'MemoCat 对外暴露的 MCP 服务实现了哪些工具与协议方法？'},
      {id:'m2',role:'assistant',text:'实现了 JSON-RPC 2.0 无状态 Streamable HTTP POST，支持 `initialize`、`ping`、`tools/list` 与 `tools/call`，提供 `recall`（历史语义片段召回）与 `list_conversations`（按主机时区列出最多 31 天内的会话清单）。'}
    ]
  }
];

const browser=spawn(binary,[
  '--headless=new',
  '--disable-crash-reporter',
  '--no-first-run',
  '--no-default-browser-check',
  '--user-data-dir='+profile,
  '--remote-debugging-port=0',
  '--disable-extensions-except='+resolve('extension'),
  '--load-extension='+resolve('extension'),
  'about:blank'
],{stdio:'ignore'});

let exited=false;
browser.on('exit',()=>{exited=true;});

const connections=[];
try{
  let debugPort;
  for(let i=0;i<100;i++){
    try{debugPort=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);if(debugPort)break;}catch{}
    if(exited)throw new Error('Edge failed to start');
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

  const list=await targets();
  const extTarget=list.find(t=>t.url.includes('/library.html'));
  if(!extTarget)throw new Error('Extension library.html target not found');

  const ext=await CDP.connect(extTarget.webSocketDebuggerUrl);
  connections.push(ext);
  await ext.send('Runtime.enable');
  await ext.send('Page.enable');
  await ext.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:2,mobile:false});

  // Seed browser extension IndexedDB & sync with desktop app
  await ext.evaluate(`(async()=>{
    await import('./lib/db.js');
    const items=${JSON.stringify(browserConversations)};
    for(const item of items){
      await MemoDB.save(item,{manual:true});
    }
    await chrome.runtime.sendMessage({type:'settings',patch:{autoSave:true}});
    return true;
  })()`);
  const connectRes=await ext.evaluate(`chrome.runtime.sendMessage({type:'connect',url:${JSON.stringify(app.url)}})`);
  if(!connectRes?.ok)throw new Error('Extension connect failed: '+JSON.stringify(connectRes));

  // Add a couple more historical ingestion events for browser sources so stats look balanced
  for(const [days,source,thread,count] of [
    [4,'browser-chatgpt',app.store.all(['browser-chatgpt'])[0].meta.threadId,6],
    [2,'browser-claude',app.store.all(['browser-claude'])[0].meta.threadId,4],
    [1,'browser-deepseek',app.store.all(['browser-deepseek'])[0].meta.threadId,5]
  ]){
    app.store.db.prepare('INSERT INTO ingestion_events(source,thread,created,messages) VALUES(?,?,?,?)').run(source,thread,isoDaysAgo(days,18,30),count);
  }

  // Trigger real MCP recall calls for audit trail
  await fetch(app.url+'/mcp/codex',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:101,method:'tools/call',params:{name:'recall',arguments:{query:'SQLite FTS5 trigram 召回',alternatives:['9600 token','process_id']}}})
  });
  await fetch(app.url+'/mcp/claude-code',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:102,method:'tools/call',params:{name:'recall',arguments:{query:'Security-Scoped Bookmarks 沙盒授权'}}})
  });

  // Switch extension library page to #library, refresh, select ChatGPT thread
  await ext.evaluate(`(()=>{
    location.hash='#library';
    document.getElementById('refresh')?.click();
  })()`);
  await until(()=>ext.evaluate(`!document.getElementById('archive')?.hidden && document.querySelectorAll('.conversation').length>=9 && !!document.querySelector('.conversation[data-id="chatgpt:local-first-outbox"]')`),'Extension conversations not rendered');
  await ext.evaluate(`document.querySelector('.conversation[data-id="chatgpt:local-first-outbox"]').click()`);
  await until(()=>ext.evaluate(`document.querySelectorAll('.message').length===2`),'Extension detail not rendered');
  await sleep(300);
  await ext.send('Page.bringToFront');
  const extShot=await ext.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  await writeFile('docs/site/assets/extension-library.png',Buffer.from(extShot.data,'base64'));
  await writeFile('extension/preview.png',Buffer.from(extShot.data,'base64'));
  console.log('Captured extension-library.png & extension/preview.png');

  // Open desktop/web app page
  const browserInfo=await (await fetch(endpoint+'/json/version')).json();
  const rootCdp=await CDP.connect(browserInfo.webSocketDebuggerUrl);
  connections.push(rootCdp);
  const {targetId}=await rootCdp.send('Target.createTarget',{url:app.url});
  let pageTarget;
  for(let i=0;i<30;i++){pageTarget=(await targets()).find(t=>t.id===targetId);if(pageTarget)break;await sleep(100);}
  const page=await CDP.connect(pageTarget.webSocketDebuggerUrl);
  connections.push(page);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:2,mobile:false});

  // 1. Workbench Light
  await page.evaluate(`localStorage.setItem('memocat-theme','light')`);
  await page.send('Page.navigate',{url:app.url+'/?desktop=1#workspace'});
  await until(()=>page.evaluate(`document.querySelectorAll('#conversation-list .conversation').length>=10 && document.querySelectorAll('#conversation-detail .message').length>=2`),'Workspace light not ready');
  await page.evaluate(`(()=>{
    const items=[...document.querySelectorAll('#conversation-list .conversation')];
    const target=items.find(b=>b.textContent.includes('SQLite WAL'));
    if(target)target.click();
  })()`);
  await until(()=>page.evaluate(`document.querySelector('#conversation-detail h2')?.textContent.includes('SQLite WAL') && document.querySelectorAll('#conversation-detail .message').length===4`),'Codex thread not selected');
  await sleep(350);
  await page.send('Page.bringToFront');
  const shotLight=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  await writeFile('docs/site/assets/workbench-light.png',Buffer.from(shotLight.data,'base64'));
  console.log('Captured workbench-light.png');

  // 2. Workbench Dark
  await page.evaluate(`(()=>{
    localStorage.setItem('memocat-theme','dark');
    document.documentElement.dataset.theme='dark';
    document.documentElement.style.colorScheme='dark';
    const lbl=document.getElementById('theme-toggle-label');
    if(lbl)lbl.textContent='深色';
    const icon=document.querySelector('#theme-toggle .theme-icon');
    if(icon)icon.innerHTML='<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
  })()`);
  await sleep(300);
  const shotDark=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  await writeFile('docs/site/assets/workbench-dark.png',Buffer.from(shotDark.data,'base64'));
  console.log('Captured workbench-dark.png');

  // Switch back to light for remaining shots
  await page.evaluate(`(()=>{
    localStorage.setItem('memocat-theme','light');
    document.documentElement.dataset.theme='light';
    document.documentElement.style.colorScheme='light';
    const lbl=document.getElementById('theme-toggle-label');
    if(lbl)lbl.textContent='浅色';
    const icon=document.querySelector('#theme-toggle .theme-icon');
    if(icon)icon.innerHTML='<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41"/>';
  })()`);

  // 3. Recall Sandbox
  await page.evaluate(`document.querySelector('button[data-page="recall"]').click()`);
  await until(()=>page.evaluate(`!document.getElementById('recall').hidden && document.querySelectorAll('#activity-list .card').length>=2`),'Recall page not ready');
  await page.evaluate(`(()=>{
    document.getElementById('query').value='SQLite WAL 与 FTS5 trigram 召回';
    document.getElementById('keyword-input').value='BM25, 9600 token';
    document.getElementById('keyword-add').click();
    document.getElementById('recall-submit').click();
  })()`);
  await until(()=>page.evaluate(`document.querySelectorAll('#recall-results .card').length>=1 && document.getElementById('token-meter-text')?.textContent!=='0 / 9,600 token'`),'Recall results not ready');
  await sleep(350);
  const shotRecall=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  await writeFile('docs/site/assets/recall-sandbox.png',Buffer.from(shotRecall.data,'base64'));
  console.log('Captured recall-sandbox.png');

  // 4. Data Pipeline (expand Codex MCP client and frame browser bridge + MCP config cleanly)
  await page.evaluate(`document.querySelector('button[data-page="pipeline"]').click()`);
  await until(()=>page.evaluate(`!document.getElementById('pipeline').hidden && document.querySelectorAll('#connection-list .backup-source').length>=4 && document.querySelectorAll('#interop-clients .interop-client').length>=3 && !!document.querySelector('.browser-bridge-card')`),'Pipeline page not ready');
  await page.evaluate(`(()=>{
    const expandBtn=document.querySelector('#interop-clients .interop-client .interop-client-expand');
    if(expandBtn && expandBtn.getAttribute('aria-expanded')!=='true')expandBtn.click();
    const bridge=document.querySelector('.browser-bridge-card');
    const top=bridge?Math.max(0,bridge.getBoundingClientRect().top+window.scrollY-78):0;
    window.scrollTo(0,top);
  })()`);
  await sleep(350);
  const shotPipeline=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  await writeFile('docs/site/assets/data-pipeline.png',Buffer.from(shotPipeline.data,'base64'));
  console.log('Captured data-pipeline.png');

  // 5. Statistics
  await page.evaluate(`window.scrollTo(0,0); document.querySelector('button[data-page="stats"]').click()`);
  await until(()=>page.evaluate(`!document.getElementById('stats').hidden && document.querySelectorAll('#history-chart .chart-column').length===7 && document.querySelectorAll('#history-distribution .distribution-row').length>=4`),'Stats page not ready');
  await sleep(350);
  const shotStats=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  await writeFile('docs/site/assets/storage-stats.png',Buffer.from(shotStats.data,'base64'));
  console.log('Captured storage-stats.png');
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
