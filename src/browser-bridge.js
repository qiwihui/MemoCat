import {randomBytes,timingSafeEqual} from 'node:crypto';
import '../extension/lib/core.js';
const core=globalThis.MemoCore;
export const BROWSER_SOURCES=core.platforms.map(p=>'browser-'+p.id);
export function browserConfig(store){
  const c=store.getSetting('browserBridge',{enabled:true,extensionId:'',token:''});
  let conversations=0,messages=0;
  const rows=store.db.prepare("SELECT body FROM conversations WHERE source LIKE 'browser-%'").all();
  for(const row of rows){conversations++;messages+=JSON.parse(row.body).records.length;}
  return {...c,platforms:core.platforms.map(p=>({id:'browser-'+p.id,name:p.name})),lastSync:store.getSetting('browserLastSync',null),lastPaired:store.getSetting('browserLastPaired',null),conversations,messages};
}
export function saveBrowserConfig(store,input){if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['enabled','extensionId','rotate','disconnect'].includes(k)))throw new Error('浏览器连接设置无效');const c=browserConfig(store);
  if(input.enabled!==undefined&&typeof input.enabled!=='boolean'||input.rotate!==undefined&&typeof input.rotate!=='boolean'||input.disconnect!==undefined&&typeof input.disconnect!=='boolean'||input.extensionId!==undefined&&(typeof input.extensionId!=='string'||!/^([a-p]{32})?$/.test(input.extensionId)))throw new Error('请输入 Chrome 扩展管理页中的 32 位扩展 ID');
  const next={enabled:input.enabled??c.enabled,extensionId:input.disconnect?'':(input.extensionId??c.extensionId),token:input.disconnect?'':c.token};
  if(next.extensionId&&(!next.token||input.rotate||next.extensionId!==c.extensionId))next.token=randomBytes(32).toString('hex');
  else if(input.rotate)next.token=randomBytes(32).toString('hex');
  if(input.disconnect)store.setSetting('browserLastPaired',null);
  store.setSetting('browserBridge',next);return browserConfig(store);
}
export function pairBrowserExtension(req,store,input){
  const origin=req.headers.origin||'',headerId=req.headers['x-memo-extension'],match=/^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
  const extensionId=match?match[1]:typeof headerId==='string'&&/^[a-p]{32}$/.test(headerId)&&!origin?headerId:'';
  if(!extensionId||headerId!==extensionId)throw new Error('仅支持从本机 Chrome 扩展发起自动连接');
  if(!input||input.protocol!==1||typeof input.sourceInstanceId!=='string'||!/^[0-9a-f-]{36}$/.test(input.sourceInstanceId))throw new Error('浏览器配对协议无效');
  const c=browserConfig(store);
  const token=c.extensionId===extensionId&&c.token?c.token:randomBytes(32).toString('hex');
  const now=new Date().toISOString();
  store.setSetting('browserBridge',{enabled:true,extensionId,token});
  store.setSetting('browserLastPaired',now);
  return {ok:true,extensionId,token,pairedAt:now};
}
function bearerMatches(header,token){if(typeof header!=='string'||!token)return false;const actual=Buffer.from(header),expected=Buffer.from('Bearer '+token);return actual.length===expected.length&&timingSafeEqual(actual,expected);}
export function authorizeBrowser(req,store){const c=browserConfig(store);const origin=req.headers.origin,extension='chrome-extension://'+c.extensionId;
  if(!c.enabled||!c.extensionId||origin&&origin!==extension||req.headers['x-memo-extension']!==c.extensionId||!bearerMatches(req.headers.authorization,c.token))return false;return true;
}
export function applyBrowserChange(store,input){if(!input||input.protocol!==1||typeof input.sourceInstanceId!=='string'||!/^[0-9a-f-]{36}$/.test(input.sourceInstanceId))throw new Error('浏览器同步协议或来源实例无效');
  const c=input.change;if(!c||typeof c.id!=='string'||c.id.length>600||typeof c.changeId!=='string'||!/^[0-9a-f-]{36}$/.test(c.changeId)||!Number.isSafeInteger(c.sequence)||c.sequence<1||!['upsert','delete'].includes(c.action)||!core.platforms.some(p=>p.id===c.platform)||!c.id.startsWith(c.platform+':'))throw new Error('浏览器变更格式无效');
  const conversation=c.action==='upsert'?core.validateConversation(c.conversation):null;if(conversation&&(conversation.id!==c.id||conversation.platform!==c.platform))throw new Error('浏览器对话身份不符');
  store.db.exec('CREATE TABLE IF NOT EXISTS browser_sync_cursors(instance TEXT NOT NULL,conversation TEXT NOT NULL,sequence INTEGER NOT NULL,change TEXT NOT NULL,PRIMARY KEY(instance,conversation))');
  const prior=store.db.prepare('SELECT sequence,change FROM browser_sync_cursors WHERE instance=? AND conversation=?').get(input.sourceInstanceId,c.id);
  if(prior&&prior.sequence>=c.sequence)return {changeId:c.changeId,duplicate:true};
  const source='browser-'+c.platform,thread=input.sourceInstanceId+':'+c.id;
  if(conversation){const meta={channelId:source,threadId:thread,title:conversation.title,createdAt:conversation.createdAt,lastActiveAt:conversation.updatedAt,sourcePath:conversation.url};
    store.save({meta,records:conversation.messages.map((m,seq)=>({id:m.id||'message-'+seq,seq,role:m.role,text:m.text,ts:m.at||conversation.updatedAt,sourceRef:conversation.url}))});
  }else store.db.prepare('DELETE FROM conversations WHERE source=? AND thread=?').run(source,thread);
  // Store.save and deletion are idempotent. A crash before cursor commit replays the same change.
  store.db.prepare('INSERT INTO browser_sync_cursors VALUES(?,?,?,?) ON CONFLICT(instance,conversation) DO UPDATE SET sequence=excluded.sequence,change=excluded.change').run(input.sourceInstanceId,c.id,c.sequence,c.changeId);
  store.setSetting('browserLastSync',new Date().toISOString());return {changeId:c.changeId,duplicate:false};
}
