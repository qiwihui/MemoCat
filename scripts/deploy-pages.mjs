import {access,cp,mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';

const root=resolve(import.meta.dirname,'..');
const siteDir=join(root,'docs/site');
const remote=process.env.MEMOCAT_PAGES_REMOTE||'https://github.com/qiwihui/MemoCat.git';
const branch=process.env.MEMOCAT_PAGES_BRANCH||'gh-pages';
const dryRun=process.argv.includes('--dry-run');

const requiredFiles=[
  '.nojekyll',
  'CNAME',
  'index.html',
  'privacy.html',
  'support.html',
  'en/index.html',
  'en/privacy.html',
  'en/support.html',
  'assets/site.css',
  'assets/site.js',
  'assets/icon.png',
  'assets/favicon.png',
  'assets/workbench-light.png',
  'assets/workbench-dark.png',
  'assets/recall-sandbox.png',
  'assets/data-pipeline.png',
  'assets/storage-stats.png',
  'assets/extension-library.png'
];

for(const rel of requiredFiles){
  const full=join(siteDir,rel);
  await access(full);
}

// Verify all relative HTML links/images/scripts/data-src assets exist inside docs/site
const htmlFiles=['index.html','privacy.html','support.html','en/index.html','en/privacy.html','en/support.html'];
for(const rel of htmlFiles){
  const full=join(siteDir,rel);
  const html=await readFile(full,'utf8');
  const dir=dirname(full);
  const refs=[...html.matchAll(/\b(?:href|src|data-src)="([^"]+)"/g)].map(m=>m[1]);
  for(const ref of refs){
    if(!ref||/^(https?:|mailto:|data:|#)/.test(ref))continue;
    const clean=ref.split('#')[0].split('?')[0];
    if(!clean)continue;
    const target=resolve(dir,clean);
    if(!target.startsWith(siteDir))throw new Error(`${rel}: reference escapes site dir -> ${ref}`);
    let resolved=target;
    if(existsSync(resolved)&&(await stat(resolved)).isDirectory()){
      resolved=join(resolved,'index.html');
    }
    if(!existsSync(resolved))throw new Error(`${rel}: missing referenced file ${ref} (${resolved})`);
  }
}

console.log(`Validated ${htmlFiles.length} HTML pages and all local assets in ${siteDir}`);
if(dryRun){
  console.log('Dry run complete.');
  process.exit(0);
}

const stage=await mkdtemp(join(tmpdir(),'memocat-pages-deploy-'));
try{
  await cp(siteDir,stage,{recursive:true});
  const git=(args)=>execFileSync('git',args,{cwd:stage,stdio:'inherit'});
  git(['init','-b',branch]);
  git(['add','-A']);
  git(['-c','commit.gpgsign=false','commit','-m','chore: deploy MemoCat product site']);
  git(['remote','add','origin',remote]);
  git(['push','--force','origin',branch]);
  console.log(`Deployed ${siteDir} -> ${remote} (branch ${branch})`);
}finally{
  await rm(stage,{recursive:true,force:true});
}
