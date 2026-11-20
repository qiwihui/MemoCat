import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pastedDocuments} from '../public/display-text.js';
import {start} from '../src/server.js';
test('pasted documents preserve user request and download only declared attachments',async()=>{
 const root=await mkdtemp(join(tmpdir(),'memocat-doc-'));let app;
 try{
  const file=join(root,'Pasted text.txt');await writeFile(file,'document body');
  const text=`# Files pasted by the user:\n\n## "Example": ${file}\n\n## My request:\nRead this document`;
  const parsed=pastedDocuments(text);assert.equal(parsed.files[0].path,file);assert.match(parsed.text,/Read this document/);assert.doesNotMatch(parsed.text,/Files pasted/);
  assert.equal(pastedDocuments('Please read /etc/passwd').files.length,0);
  app=await start({port:0,dataDir:join(root,'data')});
  app.store.save({meta:{channelId:'codex',threadId:'document-test',title:'Document',lastActiveAt:new Date().toISOString()},records:[{role:'user',text}]});
  const id=app.store.db.prepare('SELECT id FROM conversations').get().id;
  const response=await fetch(`${app.url}/api/documents/${id}/0/0`);assert.equal(response.status,200);assert.equal(await response.text(),'document body');assert.match(response.headers.get('content-disposition'),/attachment/);
  assert.equal((await fetch(`${app.url}/api/documents/${id}/0/1`)).status,404);
  await rm(file);assert.equal((await fetch(`${app.url}/api/documents/${id}/0/0`)).status,404);
 }finally{await app?.close();await rm(root,{recursive:true,force:true});}
});
