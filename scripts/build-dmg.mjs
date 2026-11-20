import {readFile,symlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {prepareMacApp,run} from './mac-bundle.mjs';

const root=resolve(import.meta.dirname,'..');
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const stage=join(root,'dist','mac-'+process.arch);
const app=await prepareMacApp({
  root,
  stage,
  pkg,
  sourceApp:join(root,'node_modules/electron/dist/Electron.app')
});
run('/usr/bin/codesign',['--force','--deep','--sign','-',app]);
run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
run(process.execPath,[join(root,'scripts/verify-packaged.mjs'),app]);
await symlink('/Applications',join(stage,'Applications'));
const image=join(root,'dist',`MemoCat-${pkg.version}-macOS-${process.arch}.dmg`);
run('/usr/bin/hdiutil',['create','-volname','MemoCat','-srcfolder',stage,'-ov','-format','UDZO',image]);
run('/usr/bin/hdiutil',['verify',image]);
console.log(`Built ${image}`);
