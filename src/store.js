import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {hash} from './adapters.js';
import {messageKey} from './sync-snapshots.js';
export class Store {
  constructor(root) {
    this.root=root;this.closed=false;mkdirSync(root,{recursive:true,mode:0o700}); this.db=new DatabaseSync(join(root,'memo.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS conversations(id INTEGER PRIMARY KEY, source TEXT NOT NULL, thread TEXT NOT NULL, title TEXT NOT NULL, updated TEXT NOT NULL, body TEXT NOT NULL, text TEXT NOT NULL, version TEXT NOT NULL, UNIQUE(source,thread));
    CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(title,text,content='conversations',content_rowid='id',tokenize='trigram');
    CREATE TRIGGER IF NOT EXISTS ci AFTER INSERT ON conversations BEGIN INSERT INTO search(rowid,title,text) VALUES(new.id,new.title,new.text); END;
    CREATE TRIGGER IF NOT EXISTS cd AFTER DELETE ON conversations BEGIN INSERT INTO search(search,rowid,title,text) VALUES('delete',old.id,old.title,old.text); END;
    CREATE TRIGGER IF NOT EXISTS cu AFTER UPDATE ON conversations BEGIN INSERT INTO search(search,rowid,title,text) VALUES('delete',old.id,old.title,old.text); INSERT INTO search(rowid,title,text) VALUES(new.id,new.title,new.text); END;
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ingestion_events(id INTEGER PRIMARY KEY,source TEXT NOT NULL,thread TEXT NOT NULL,created TEXT NOT NULL,messages INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS contexts(id TEXT PRIMARY KEY,caller TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,process TEXT NOT NULL REFERENCES contexts(id),request TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('prepared','committed','abandoned')),created TEXT NOT NULL,query TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(process,request));`);
    // A process restart cannot establish delivery of an in-flight response.
    this.db.exec("UPDATE deliveries SET status='abandoned' WHERE status='prepared'");
  }
  getSetting(key,fallback){if(this.closed)return fallback;const row=this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);return row?JSON.parse(row.value):fallback;}
  setSetting(key,value){if(this.closed)return;this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key,JSON.stringify(value));}
  save(c){const body=JSON.stringify(c),version=hash(body);const prior=this.db.prepare('SELECT version,body FROM conversations WHERE source=? AND thread=?').get(c.meta.channelId,c.meta.threadId);if(prior?.version===version)return false;
    const old=new Map();for(const r of prior?JSON.parse(prior.body).records:[]){const key=messageKey(r);old.set(key,(old.get(key)||0)+1);}
    let messages=0;for(const r of c.records){const key=messageKey(r),count=old.get(key)||0;if(count)old.set(key,count-1);else messages++;}
    this.db.exec('BEGIN IMMEDIATE');try{
      this.db.prepare('INSERT INTO conversations(source,thread,title,updated,body,text,version) VALUES(?,?,?,?,?,?,?) ON CONFLICT(source,thread) DO UPDATE SET title=excluded.title,updated=excluded.updated,body=excluded.body,text=excluded.text,version=excluded.version').run(c.meta.channelId,c.meta.threadId,c.meta.title,c.meta.lastActiveAt,body,c.records.map(x=>x.text).join('\n'),version);
      if(messages)this.db.prepare('INSERT INTO ingestion_events(source,thread,created,messages) VALUES(?,?,?,?)').run(c.meta.channelId,c.meta.threadId,new Date().toISOString(),messages);
      this.db.exec('COMMIT');return true;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  list({q='',source='',limit=200,offset=0}={}){
    const clauses=[],args=[];
    if(source){clauses.push('source=?');args.push(source);}
    if(q && [...q].length>=3 && !/[\s%_]/.test(q)){clauses.push('id IN (SELECT rowid FROM search WHERE search MATCH ?)');args.push('"'+q.replaceAll('"','""')+'"');}
    if(q){clauses.push("(title LIKE ? ESCAPE '\\' OR text LIKE ? ESCAPE '\\')");const pattern='%'+q.replace(/[\\%_]/g,'\\$&')+'%';args.push(pattern,pattern);}
    // Trigram narrows long literals; LIKE preserves exact substring/short-query behavior.
    const where=clauses.length?' WHERE '+clauses.join(' AND '):'';
    const total=this.db.prepare('SELECT count(*) AS n FROM conversations'+where).get(...args).n;
    const items=this.db.prepare('SELECT id,source,thread,title,updated,substr(text,1,160) AS preview FROM conversations'+where+' ORDER BY updated DESC,id DESC LIMIT ? OFFSET ?').all(...args,Math.min(200,Math.max(1,limit)),Math.max(0,offset));return {items,total};
  }
  read(id){const r=this.db.prepare('SELECT body FROM conversations WHERE id=?').get(id);return r?JSON.parse(r.body):null;}
  all(sources){return this.db.prepare('SELECT body FROM conversations').all().map(r=>JSON.parse(r.body)).filter(c=>!sources?.length||sources.includes(c.meta.channelId));}
  context(id,caller){if(!id){id=randomUUID();this.db.prepare('INSERT INTO contexts VALUES(?,?)').run(id,caller);}else{const row=this.db.prepare('SELECT caller FROM contexts WHERE id=?').get(id);if(!row||row.caller!==caller)throw new Error('process_id 不存在或不属于当前调用方');}return id;}
  seen(process){return this.db.prepare("SELECT payload FROM deliveries WHERE process=? AND status IN ('committed','prepared')").all(process).flatMap(r=>JSON.parse(r.payload).evidence.flatMap(e=>e.unitIds));}
  prepare(process,request,query,payload){const prior=this.db.prepare('SELECT * FROM deliveries WHERE process=? AND request=?').get(process,request);if(prior)return prior;
    const row={id:randomUUID(),process,request,status:'prepared',created:new Date().toISOString(),query,payload:JSON.stringify(payload)};
    this.db.prepare('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?)').run(row.id,row.process,row.request,row.status,row.created,row.query,row.payload);return row;}
  finish(id,status){if(this.closed)return;this.db.prepare("UPDATE deliveries SET status=? WHERE id=? AND status='prepared'").run(status,id);}
  activity(){return this.db.prepare('SELECT d.*,c.caller FROM deliveries d JOIN contexts c ON c.id=d.process ORDER BY d.created DESC LIMIT 100').all().map(r=>({...r,payload:JSON.parse(r.payload)}));}
  stats(){return {conversations:this.db.prepare('SELECT count(*) n FROM conversations').get().n,messages:this.all().reduce((n,c)=>n+c.records.length,0),recalls:this.db.prepare("SELECT count(*) n FROM deliveries WHERE status='committed'").get().n};}
  sources(){return this.db.prepare('SELECT source, count(*) AS count FROM conversations GROUP BY source ORDER BY count DESC, source ASC').all();}
  close(){if(this.closed)return;this.closed=true;this.db.close();}
}
