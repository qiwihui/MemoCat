import {LOCAL_SOURCES} from './adapters.js';
import {BROWSER_SOURCES} from './browser-bridge.js';
export const CLIENTS=[
 {id:'codex',name:'Codex',enabled:true,kind:'toml',location:'~/.codex/config.toml'},
 {id:'claude-code',name:'Claude Code',enabled:true,kind:'command',location:'终端执行后，在 Claude Code 中重新加载 MCP'},
 {id:'other-local',name:'其他本机 AI',enabled:false,kind:'json',location:'支持 HTTP MCP 的本机客户端配置'}
];
const SOURCES=[...LOCAL_SOURCES,'demo',...BROWSER_SOURCES];
export function clientConfig(store,id){const base=CLIENTS.find(c=>c.id===id);if(!base)return null;return {...base,sources:null,...store.getSetting('interopClients',{})[id]};}
export function saveClient(store,id,input){
 if(!CLIENTS.some(c=>c.id===id))throw new Error('客户端不存在');
 if(!input||typeof input!=='object'||Array.isArray(input)||!Object.keys(input).length||Object.keys(input).some(k=>!['enabled','sources'].includes(k)))throw new Error('客户端配置无效');
 if(input.enabled!==undefined&&typeof input.enabled!=='boolean')throw new Error('开关值无效');
 if(input.sources!==undefined&&input.sources!==null&&(!Array.isArray(input.sources)||input.sources.some(s=>!SOURCES.includes(s))))throw new Error('资料来源无效');
 const all=store.getSetting('interopClients',{}),next={...(all[id]||{}),...input};if(Array.isArray(next.sources))next.sources=[...new Set(next.sources)];
 store.setSetting('interopClients',{...all,[id]:next});return clientConfig(store,id);
}
export function scopedArgs(input,client){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('参数必须为对象');
 if(client.sources===null)return input;
 if(!client.sources.length)throw new Error('此 AI 尚未获准读取任何资料来源');
 if(input.sources!==undefined&&!Array.isArray(input.sources))throw new Error('资料来源无效');
 if(input.sources?.some(s=>!client.sources.includes(s)))throw new Error('此 AI 不允许读取请求中的资料来源');
 return {...input,sources:input.sources?.length?input.sources:client.sources};
}
export const samePolicy=(a,b)=>!!b?.enabled&&JSON.stringify(a.sources)===JSON.stringify(b.sources);
export function clientViews(store,origin){return CLIENTS.map(base=>{
 const c=clientConfig(store,base.id),url=origin+'/mcp/'+base.id;
 const config=c.kind==='toml'?`[mcp_servers.memocat]\nurl = "${url}"`:
 c.kind==='command'?`claude mcp add --transport http --scope user memocat ${url}`:JSON.stringify({mcpServers:{'memocat':{type:'http',url}}},null,2);
 const stats=store.db.prepare("SELECT max(d.created) lastRecall,count(*) recalls FROM deliveries d JOIN contexts c ON c.id=d.process WHERE c.caller=? AND d.status='committed'").get(c.id);
 return {...c,url,config,lastRequest:store.getSetting('interopRequests',{})[c.id]||null,...stats};
});}
