import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readSourceStable} from '../src/adapters.js';
test('JSONL keeps Unicode separators inside valid JSON strings',async()=>{
 const root=await mkdtemp(join(tmpdir(),'memocat-unicode-'));
 try{const path=join(root,'session.jsonl');const text='中文\u2028段落\u2029'+ '猫'.repeat(100000);
 const row={type:'user',sessionId:'unicode',message:{role:'user',content:text}};
 await writeFile(path,JSON.stringify(row)+'\r\n'+JSON.stringify({...row,uuid:'second',message:{role:'user',content:'next'}}));
 const {conversation}=await readSourceStable(path,'claude-code');assert.equal(conversation.records.length,2);assert.equal(conversation.records[0].text,text);
 }finally{await rm(root,{recursive:true,force:true});}
});
