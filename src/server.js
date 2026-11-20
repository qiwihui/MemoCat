import {pastedDocuments} from '../public/display-text.js';
import {createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {userDataDirectory} from './data-directory.js';
import {browserConfig,saveBrowserConfig,pairBrowserExtension,authorizeBrowser,applyBrowserChange,BROWSER_SOURCES} from './browser-bridge.js';
import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Store} from './store.js';
import {historyData} from './history.js';
import {clientConfig,saveClient,clientViews,scopedArgs,samePolicy} from './interop.js';
import {LOCAL_SOURCES} from './adapters.js';
import {Service,localDay} from './service.js';
import {SyncScheduler} from './sync-schedule.js';
const base=dirname(fileURLToPath(import.meta.url));
const schema={type:'object',additionalProperties:false,properties:{query:{type:'string',minLength:1,maxLength:20000},alternatives:{type:'array',maxItems:8,items:{type:'string'}},from:{type:'string'},to:{type:'string'},sources:{type:'array',items:{type:'string',enum:[...LOCAL_SOURCES,'demo',...BROWSER_SOURCES]}},process_id:{type:'string'}},required:['query']};
export async function start({port=Number(process.env.PORT||3792),dataDir=process.env.MEMO_DATA_DIR,desktopActions=null}={}){
  dataDir ||= userDataDirectory({legacy:[join(base,'../data')]});
  const store=new Store(resolve(dataDir)),service=new Service(store);let scheduler;
  const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(body));};
  async function body(req,limit=1024*1024){let size=0,chunks=[];for await(const c of req){size+=c.length;if(size>limit)throw new Error('请求超过大小限制');chunks.push(c);}return JSON.parse(Buffer.concat(chunks).toString()||'{}');}
  const sourceDefaults=[
    {id:'codex',path:join(homedir(),'.codex')},
    {id:'claude-code',path:join(homedir(),'.claude/projects')},
    {id:'grok-bot',path:join(homedir(),'Library/Application Support/Grok Bot')},
    {id:'antigravity',path:join(homedir(),'.gemini/antigravity')}
  ];
  async function sourceStatus(){
    const configured=store.getSetting('sources',[]),all=store.all();
    const events=store.db.prepare('SELECT source,thread,created,messages FROM ingestion_events').all();
    const today=localDay(new Date().toISOString());
    return Promise.all(sourceDefaults.map(async def=>{const config=configured.find(s=>s.id===def.id)||{...def,enabled:false};const {bookmark,...publicConfig}=config;let detected=false;try{detected=(await stat(config.path)).isDirectory();}catch{}
      const run=store.getSetting('sourceRuns',{})[def.id];const entries=all.filter(c=>c.meta.channelId===def.id),daily=events.filter(e=>e.source===def.id&&localDay(e.created)===today);
      return {...publicConfig,detected,authorized:Boolean(bookmark),todayConversations:new Set(daily.map(e=>e.thread)).size,todayMessages:daily.reduce((n,e)=>n+e.messages,0),conversations:entries.length,messages:entries.reduce((n,c)=>n+c.records.length,0),lastRun:run?.lastRun||null,issues:run?.issues||[]};
    }));
  }
  const server=createServer(async(req,res)=>{
    let delivery;
    res.on('close',()=>{if(delivery&&!res.writableFinished)store.finish(delivery,'abandoned');});
    try{
      const host=req.headers.host;
      if(host!==`127.0.0.1:${server.address().port}` && host!==`localhost:${server.address().port}`)return json(res,403,{error:'Host 无效'});
      // Browser pairing and sync endpoints accept local Chrome extensions.
      // All ordinary web/API/MCP routes retain their existing same-origin rules.
      if(req.url==='/api/browser-pair'){
        const extOrigin=/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin||'')?req.headers.origin:null;
        if(req.method==='OPTIONS'){
          if(!extOrigin)return json(res,403,{error:'仅支持 Chrome 扩展连接'});
          res.writeHead(204,{'access-control-allow-origin':extOrigin,'access-control-allow-methods':'POST','access-control-allow-headers':'content-type,x-memo-extension','access-control-allow-private-network':'true','vary':'Origin'});return res.end();
        }
        if(req.method!=='POST')return json(res,405,{error:'仅支持 POST'});
        if(req.headers.origin&&!extOrigin)return json(res,403,{error:'仅支持 Chrome 扩展连接'});
        if(extOrigin)res.setHeader('access-control-allow-origin',extOrigin);
        const payload=await body(req,4096);
        try{return json(res,200,pairBrowserExtension(req,store,payload));}catch(e){return json(res,403,{error:e.message});}
      }
      if(req.url==='/api/browser-sync'){
        const config=browserConfig(store),expected='chrome-extension://'+config.extensionId;
        if(req.method==='OPTIONS'){
          if(!config.enabled||!config.extensionId||req.headers.origin!==expected)return json(res,403,{error:'浏览器扩展未获授权'});
          res.writeHead(204,{'access-control-allow-origin':expected,'access-control-allow-methods':'POST','access-control-allow-headers':'content-type,authorization,x-memo-extension','access-control-allow-private-network':'true','vary':'Origin'});return res.end();
        }
        if(req.method!=='POST')return json(res,405,{error:'仅支持 POST'});
        if(!authorizeBrowser(req,store))return json(res,403,{error:'浏览器连接未开启、扩展 ID 不匹配或密钥已失效'});
        if(req.headers.origin)res.setHeader('access-control-allow-origin',expected);
        const payload=await body(req,9*1024*1024);
        // Recheck after awaiting the body: disabling a connection cancels queued writes.
        if(!authorizeBrowser(req,store))return json(res,403,{error:'浏览器连接已关闭'});
        return json(res,200,applyBrowserChange(store,payload));
      }
      const origin=req.headers.origin;
      if(origin && ![`http://127.0.0.1:${server.address().port}`,`http://localhost:${server.address().port}`].includes(origin))return json(res,403,{error:'Origin 无效'});
      if(req.headers['sec-fetch-site']==='cross-site')return json(res,403,{error:'拒绝跨站请求'});
      const url=new URL(req.url,`http://${host}`),path=url.pathname;
      if(path.startsWith('/mcp/')){
        if(req.method!=='POST')return json(res,405,{error:'仅支持 POST'});
        if(!/^\/mcp\/[a-z0-9-]{1,80}$/.test(path))return json(res,400,{error:'调用方无效'});
        const rpc=await body(req),caller=path.slice(5),client=clientConfig(store,caller);
        if(!client)return json(res,404,{jsonrpc:'2.0',id:rpc.id??null,error:{code:-32600,message:'请先为此客户端配置互通地址'}});
        if(!client.enabled)return json(res,403,{jsonrpc:'2.0',id:rpc.id??null,error:{code:-32000,message:'此 AI 的跨 AI 互通已关闭'}});
        if(rpc.jsonrpc!=='2.0'||typeof rpc.method!=='string')return json(res,400,{error:'JSON-RPC 无效'});
        if(rpc.id===undefined){res.writeHead(202);return res.end();}
        const requests=store.getSetting('interopRequests',{});store.setSetting('interopRequests',{...requests,[caller]:new Date().toISOString()});
        let result;
        try {
          if(rpc.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'memocat',version:'0.5.0'}};
          else if(rpc.method==='ping')result={};
          else if(rpc.method==='tools/list')result={tools:[{name:'recall',description:'从本机已导入 AI 会话召回历史片段。同一对话后续传回 process_id。',inputSchema:schema},{name:'list_conversations',description:'按主机时区列出指定日期范围的会话（最多31天）。',inputSchema:{...schema,properties:{from:{type:'string'},to:{type:'string'},sources:schema.properties.sources},required:['from','to']}}]};
          else if(rpc.method==='tools/call'){
            if(rpc.params?.name==='recall'){
              const r=await service.invoke(scopedArgs(rpc.params.arguments,client),caller,String(rpc.id));delivery=r.deliveryId;if(!samePolicy(client,clientConfig(store,caller))){store.finish(delivery,'abandoned');delivery=undefined;throw new Error('互通配置已改变，本次取用已取消');}
              const text=`主机时区：${r.timeZone}\nprocess_id: ${r.process_id}\n${r.partial?'部分来源读取失败，结果不完整。\n':''}`+(r.evidence.length?r.evidence.map((e,i)=>`[${i+1}] ${e.meta.title} | ${e.meta.channelId} | ${e.meta.lastActiveAt}\n来源：${e.meta.sourcePath}\n${e.text}`).join('\n\n'):'当前已保存范围没有新的匹配片段。');
              result={content:[{type:'text',text}]};
            }else if(rpc.params?.name==='list_conversations'){await service.sync();if(!samePolicy(client,clientConfig(store,caller)))throw new Error('互通配置已改变，请重试');result={content:[{type:'text',text:JSON.stringify(service.listConversations(scopedArgs(rpc.params.arguments,client)))}]};}
            else throw new Error('未知工具');
          }else return json(res,200,{jsonrpc:'2.0',id:rpc.id,error:{code:-32601,message:'未知方法'}});
        }catch(e){return json(res,200,{jsonrpc:'2.0',id:rpc.id,result:{isError:true,content:[{type:'text',text:e.message}]}});}
        if(delivery)res.once('finish',()=>store.finish(delivery,'committed'));
        return json(res,200,{jsonrpc:'2.0',id:rpc.id,result});
      }
      if(path.startsWith('/api/')){
        if(req.method==='GET'){
          if(path==='/api/browser/config')return json(res,200,browserConfig(store));
          if(path==='/api/interop')return json(res,200,{clients:clientViews(store,`http://${host}`)});
          if(path.startsWith('/api/documents/')){
            const match=/^\/api\/documents\/(\d+)\/(\d+)\/(\d+)$/.exec(path);
            const record=match&&store.read(Number(match[1]))?.records[Number(match[2])];
            const file=record&&pastedDocuments(record.text).files[Number(match[3])];
            if(!file)return json(res,404,{error:'文档不存在'});
            let info;try{info=await stat(file.path);}catch{return json(res,404,{error:'原文档已移动或删除'});}
            if(!info.isFile())return json(res,404,{error:'文档不可用'});
            res.writeHead(200,{'content-type':'application/octet-stream','content-length':info.size,'content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(file.name),'x-content-type-options':'nosniff','cache-control':'no-store'});
            await pipeline(createReadStream(file.path),res);return;
          }
          if(path==='/api/history')return json(res,200,await historyData(store,url.searchParams));
          if(path.startsWith('/api/images/')){const image=await service.media.read(path.slice('/api/images/'.length));if(!image)return json(res,404,{error:'图片不可用'});res.writeHead(200,{'content-type':image.mime,'x-content-type-options':'nosniff','cache-control':'private, max-age=31536000, immutable'});return res.end(image.bytes);}
          if(path==='/api/dashboard'){
            const all=store.db.prepare('SELECT id,source,title,updated,body FROM conversations ORDER BY updated DESC,id DESC').all();
            const counts=new Map();let today=0,yesterday=0,total=0;const now=localDay(new Date().toISOString()),past=localDay(new Date(Date.now()-86400000).toISOString());
            for(const row of all){const c=JSON.parse(row.body);counts.set(row.source,(counts.get(row.source)||0)+c.records.length);total+=c.records.length;}
            const events=store.db.prepare('SELECT e.id AS eventId,c.id,c.title,e.source,e.created AS updated,e.messages FROM ingestion_events e LEFT JOIN conversations c ON c.source=e.source AND c.thread=e.thread ORDER BY e.created DESC,e.id DESC').all();
            for(const event of events){const day=localDay(event.updated);if(day===now)today+=event.messages;if(day===past)yesterday+=event.messages;}
            return json(res,200,{today,yesterday,total,distribution:[...counts].map(([source,messages])=>({source,messages})),recent:events.filter(e=>e.id).slice(0,15)});
          }
          if(path==='/api/sync-schedule')return json(res,200,scheduler.status());
          if(path==='/api/source-status')return json(res,200,{items:await sourceStatus(),running:service.syncState.running,canPickDirectory:!!desktopActions?.pickSourceDirectory});
          if(path==='/api/preferences')return json(res,200,{version:'0.5.0',dataDir:resolve(dataDir),canOpenDataDir:!!desktopActions?.openDataDirectory,startupSupported:!!desktopActions?.startupSupported,startupEnabled:desktopActions?.startupSupported?desktopActions.getStartup():false,backgroundSupported:!!desktopActions?.backgroundSupported,backgroundEnabled:desktopActions?.backgroundSupported?!!desktopActions.getBackground():false});
          if(path==='/api/state')return json(res,200,{stats:store.stats(),activeSources:store.sources(),sources:store.getSetting('sources',[]).map(({bookmark,...s})=>({...s,authorized:Boolean(bookmark)})),sync:service.syncState,schedule:scheduler.status(),defaults:sourceDefaults,mcp:`http://${host}/mcp/codex`});
          if(path==='/api/conversations')return json(res,200,store.list({q:url.searchParams.get('q')||'',source:url.searchParams.get('source')||'',offset:Number(url.searchParams.get('offset'))||0}));
          if(/^\/api\/conversations\/\d+$/.test(path)){const c=store.read(Number(path.split('/').at(-1)));return json(res,c?200:404,c||{error:'会话不存在'});}
          if(path==='/api/activity')return json(res,200,store.activity());
        }
        if(req.method==='POST'){
          const input=await body(req);
          if(path==='/api/sync-schedule')return json(res,200,scheduler.configure(input));
          if(path==='/api/browser/config')return json(res,200,saveBrowserConfig(store,input));
          if(/^\/api\/interop\/(codex|claude-code|other-local)$/.test(path))return json(res,200,{client:saveClient(store,path.split('/')[3],input)});
          if(path==='/api/open-data'){if(!desktopActions?.openDataDirectory)return json(res,409,{error:'网页版请使用复制路径，在文件管理器中打开'});await desktopActions.openDataDirectory(resolve(dataDir));return json(res,200,{ok:true});}
          if(path==='/api/startup'){if(!desktopActions?.startupSupported)return json(res,409,{error:'请安装桌面版以启用开机自启'});if(typeof input.enabled!=='boolean')throw new Error('启动设置无效');await desktopActions.setStartup(input.enabled);return json(res,200,{enabled:desktopActions.getStartup()});}
          if(path==='/api/background'){if(!desktopActions?.backgroundSupported)return json(res,409,{error:'请使用桌面版以启用后台驻留'});if(typeof input.enabled!=='boolean')throw new Error('后台运行设置无效');await desktopActions.setBackground(input.enabled);return json(res,200,{enabled:!!desktopActions.getBackground()});}
          if(/^\/api\/sources\/(codex|claude-code|grok-bot|antigravity)(?:\/(?:sync|pick))?$/.test(path)){
            const id=path.split('/')[3],def=sourceDefaults.find(s=>s.id===id);
            if(path.endsWith('/sync')){const config=store.getSetting('sources',[]).find(s=>s.id===id);if(!config?.enabled)return json(res,409,{error:'请先开启此 AI 的本地备份'});if(service.syncState.running)return json(res,409,{error:'正在同步，请稍后重试'});void service.sync(id);return json(res,202,{ok:true});}
            if(path.endsWith('/pick')){
              if(!desktopActions?.pickSourceDirectory)return json(res,409,{error:'请使用桌面端选择来源目录'});
              const latest=store.getSetting('sources',[]),current=latest.find(s=>s.id===id)||{...def,enabled:false};
              const picked=await desktopActions.pickSourceDirectory({defaultPath:current.path||def.path,title:`选择 ${id} 来源目录`});
              if(!picked||picked.canceled)return json(res,200,{canceled:true});
              const pickedPath=typeof picked.path==='string'?picked.path.trim():'';
              if(!pickedPath.startsWith('/')||pickedPath.includes('\0'))throw new Error('选择的目录路径无效');
              const bookmark=typeof picked.bookmark==='string'&&picked.bookmark?picked.bookmark:undefined;
              if(bookmark)await desktopActions.activateSourceBookmark?.(bookmark,id);
              const next={...current,id,path:pickedPath};
              if(bookmark)next.bookmark=bookmark;else delete next.bookmark;
              const after=store.getSetting('sources',[]),nowCurrent=after.find(s=>s.id===id)||{...def,enabled:false};
              if(JSON.stringify(nowCurrent)!==JSON.stringify(current))return json(res,409,{error:'此 AI 的配置已在另一窗口更改，请重试'});
              store.setSetting('sources',[...after.filter(s=>s.id!==id),next]);
              const {bookmark:_hidden,...publicNext}=next;
              return json(res,200,{canceled:false,source:{...publicNext,authorized:Boolean(next.bookmark)}});
            }
            if(!input||typeof input!=='object'||Array.isArray(input)||!Object.keys(input).length||Object.keys(input).some(k=>!['path','enabled','bookmark'].includes(k)))throw new Error('来源配置无效');
            if(input.path!==undefined&&(typeof input.path!=='string'||!input.path.startsWith('/')||input.path.includes('\0')))throw new Error('请输入绝对目录路径');
            if(input.enabled!==undefined&&typeof input.enabled!=='boolean')throw new Error('开关值无效');
            if(input.bookmark!==undefined&&input.bookmark!==null&&typeof input.bookmark!=='string')throw new Error('目录授权凭据无效');
            const configs=store.getSetting('sources',[]),previous=configs.find(s=>s.id===id)||{...def,enabled:false};
            const next={...previous,...input,id};next.path=next.path.trim();
            if(input.bookmark===null)delete next.bookmark;
            else if(input.path!==undefined&&next.path!==previous.path&&input.bookmark===undefined)delete next.bookmark;
            if(next.bookmark)await desktopActions?.activateSourceBookmark?.(next.bookmark,id);
            if(next.enabled){try{if(!(await stat(next.path)).isDirectory())throw new Error();}catch{return json(res,400,{error:'未找到来源目录，请展开配置并填写有效目录'});}}
            // Re-read after async validation so changing one AI never overwrites another.
            const latest=store.getSetting('sources',[]);const current=latest.find(s=>s.id===id)||{...def,enabled:false};if(JSON.stringify(current)!==JSON.stringify(previous))return json(res,409,{error:'此 AI 的配置已在另一窗口更改，请重试'});store.setSetting('sources',[...latest.filter(s=>s.id!==id),next]);
            const {bookmark:_hidden,...publicNext}=next;
            return json(res,200,{ok:true,source:{...publicNext,authorized:Boolean(next.bookmark)}});
          }
          if(path==='/api/sources'){
            if(!Array.isArray(input)||input.length>LOCAL_SOURCES.length||input.some(s=>!LOCAL_SOURCES.includes(s.id)||typeof s.path!=='string'||!s.path.startsWith('/')||typeof s.enabled!=='boolean')||new Set(input.map(s=>s.id)).size!==input.length)throw new Error('来源设置无效');
            if(service.syncState.running)throw new Error('同步进行中，请完成后再修改来源');
            store.setSetting('sources',input);return json(res,200,{ok:true});
          }
          if(path==='/api/sync'){void service.sync();return json(res,202,{ok:true});}
          if(path==='/api/recall'){const r=await service.invoke(input);delivery=r.deliveryId;res.once('finish',()=>store.finish(delivery,'committed'));return json(res,200,r);}

        }return json(res,404,{error:'接口不存在'});
      }
      if(req.method!=='GET')return json(res,405,{error:'方法无效'});
      const files={
        '/':'index.html','/app.js':'app.js','/display-text.js':'display-text.js','/browser-bridge.js':'browser-bridge.js',
        '/style.css':'style.css','/desktop-theme.css':'desktop-theme.css','/marked.js':'marked.js','/purify.js':'purify.js',
        '/assets/app-icon-64.png':'assets/app-icon-64.png','/assets/app-icon-256.png':'assets/app-icon-256.png',
        '/assets/codex.png':'assets/codex.png','/assets/claude-code.png':'assets/claude-code.png',
        '/assets/grok-bot.png':'assets/grok-bot.png','/assets/antigravity.png':'assets/antigravity.png',
        '/assets/platforms/chatgpt.png':'assets/platforms/chatgpt.png','/assets/platforms/claude.png':'assets/platforms/claude.png',
        '/assets/platforms/gemini.png':'assets/platforms/gemini.png','/assets/platforms/deepseek.png':'assets/platforms/deepseek.png',
        '/assets/platforms/yuanbao.png':'assets/platforms/yuanbao.png','/assets/platforms/doubao.png':'assets/platforms/doubao.png',
        '/assets/platforms/kimi.png':'assets/platforms/kimi.png','/assets/platforms/qianwen.png':'assets/platforms/qianwen.png',
        '/assets/platforms/grok.png':'assets/platforms/grok.png'
      };
      if(!files[path])return json(res,404,{error:'未找到'});
      res.writeHead(200,{'content-type':path.endsWith('.png')?'image/png':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html; charset=utf-8','content-security-policy':"default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'",'x-content-type-options':'nosniff'});res.end(await readFile(join(base,'../public',files[path])));
    }catch(e){if(delivery)store.finish(delivery,'abandoned');if(!res.headersSent)json(res,400,{error:e.message});else res.destroy();}
  });
  await new Promise((ok,bad)=>{server.once('error',bad);server.listen(port,'127.0.0.1',ok);});
  scheduler=new SyncScheduler(store,service);
  return {server,store,service,url:`http://127.0.0.1:${server.address().port}`,close:async()=>{scheduler.close();await new Promise(r=>server.close(r));await service.syncTask;store.close();}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=await start();console.log(`MemoCat → ${app.url}\nMCP → ${app.url}/mcp/codex`);
  for(const sig of ['SIGINT','SIGTERM'])process.once(sig,()=>{void app.close().then(()=>process.exit(0));});
}
