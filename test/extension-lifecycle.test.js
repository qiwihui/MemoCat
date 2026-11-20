import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
test('invalidated content context stops automatic work and requests refresh',async()=>{
 const script=await readFile(new URL('../extension/content.js',import.meta.url),'utf8');
 for(const message of ['Extension context invalidated.','Extension content invalidated.']){
  const nodes=[];let disconnected=false,cleared=false;
  const create=()=>{const node={append(){},attachShadow(){return {append(){}}},contains(){return false}};nodes.push(node);return node;};
  runInNewContext(script,{chrome:{runtime:{id:'extension-id',getURL:p=>'chrome-extension://extension-id/'+p,sendMessage:async()=>{throw new Error(message)},onMessage:{addListener(){}}},storage:{local:{get:async()=>({}),set:async()=>{}},onChanged:{addListener(){}}}},crypto:{randomUUID:()=> 'id'},location:{href:'https://chatgpt.com/c/test'},document:{createElement:create,documentElement:{append(){}},body:{},addEventListener(){},removeEventListener(){}},window:{addEventListener(){},removeEventListener(){}},MutationObserver:class{observe(){}disconnect(){disconnected=true}},setInterval:()=>1,clearInterval:()=>{cleared=true},setTimeout,clearTimeout});
  await new Promise(resolve=>setImmediate(resolve));
  const actionButton=nodes.find(n=>n.className==='action');
  const statusNode=nodes.find(n=>n.className==='status-text');
  assert.ok(disconnected);assert.ok(cleared);assert.equal(actionButton.disabled,true);assert.match(statusNode.textContent,/请刷新页面/);
 }
});
test('SPA capture follows the live tab and rejects previous routes and foreign origins',async()=>{
 const scope={URL,TextEncoder,crypto:globalThis.crypto};
 runInNewContext(await readFile(new URL('../extension/lib/core.js',import.meta.url),'utf8'),scope);
 const core=scope.MemoCore,current='https://chatgpt.com/c/new';
 const c={platform:'chatgpt',url:current,id:core.conversationKey(current)};
 assert.equal(core.currentCapture(c,'https://chatgpt.com/c/old',current),true);
 assert.equal(core.currentCapture(c,current,'https://chatgpt.com/c/other'),false);
 assert.equal(core.currentCapture(c,'https://claude.ai/chat/old',current),false);
 assert.equal(core.currentCapture({...c,id:'chatgpt:wrong'},current,current),false);
});
