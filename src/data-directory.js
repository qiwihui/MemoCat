import {mkdirSync,readFileSync,writeFileSync,existsSync,cpSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';

// One stable local identity until a real account service is connected.
export function userDataDirectory({home=homedir(),legacy=[]}={}) {
  const root=join(home,'.memocat');mkdirSync(root,{recursive:true,mode:0o700});
  const identity=join(root,'user-id');
  try {writeFileSync(identity,randomUUID(),{flag:'wx',mode:0o600});} catch(error) {if(error.code!=='EEXIST')throw error;}
  const id=readFileSync(identity,'utf8').trim();
  if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('MemoCat 用户 ID 无效');
  const target=join(root,id);
  if(!existsSync(target)) {
    const source=legacy.find(path=>existsSync(join(path,'memo.sqlite')));
    if(source){const stage=join(root,id+'.migrating-'+randomUUID());cpSync(source,stage,{recursive:true});renameSync(stage,target);}
    else mkdirSync(target,{mode:0o700});
  }
  return target;
}
