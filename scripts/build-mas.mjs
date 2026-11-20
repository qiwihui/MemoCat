import {cp,readFile,readdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {BUNDLE_ID,prepareMacApp,run} from './mac-bundle.mjs';

const root=resolve(import.meta.dirname,'..');
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const stage=join(root,'dist','mas-'+process.arch);
const sourceApp=process.env.ELECTRON_MAS_APP||join(root,'node_modules/electron/dist/Electron.app');
if(!existsSync(sourceApp))throw new Error(`Electron app not found: ${sourceApp}`);

const entitlementsMain=join(root,'build/entitlements.mas.plist');
const entitlementsInherit=join(root,'build/entitlements.mas.inherit.plist');
const privacyPlist=join(root,'build/PrivacyInfo.xcprivacy');
run('/usr/bin/plutil',['-lint',entitlementsMain,entitlementsInherit,privacyPlist]);

const app=await prepareMacApp({root,stage,pkg,sourceApp});
if(process.env.MAS_PROVISIONING_PROFILE){
  await cp(resolve(process.env.MAS_PROVISIONING_PROFILE),join(app,'Contents/embedded.provisionprofile'));
}

const identity=process.env.MAS_APP_CERT||'-';
const installerCert=process.env.MAS_INSTALLER_CERT||'';
const teamId=process.env.APPLE_TEAM_ID||'';
let effectiveMainEntitlements=entitlementsMain;
if(identity!=='-'&&teamId){
  const rawMain=await readFile(entitlementsMain,'utf8');
  effectiveMainEntitlements=join(stage,'entitlements.mas.signed.plist');
  await writeFile(effectiveMainEntitlements,rawMain.replace('</dict>',`  <key>com.apple.application-identifier</key>\n  <string>${teamId}.${BUNDLE_ID}</string>\n  <key>com.apple.developer.team-identifier</key>\n  <string>${teamId}</string>\n</dict>`));
  run('/usr/bin/plutil',['-lint',effectiveMainEntitlements]);
}
const sign=(target,{entitlements}={})=>{
  const args=['--force','--sign',identity];
  if(identity!=='-')args.push('--timestamp');
  if(entitlements)args.push('--entitlements',entitlements);
  args.push(target);
  run('/usr/bin/codesign',args);
};

// Sign nested libraries, frameworks and helper apps inside-out before main app.
const frameworksDir=join(app,'Contents/Frameworks');
const electronFwHelpers=join(frameworksDir,'Electron Framework.framework/Versions/A/Helpers');
if(existsSync(electronFwHelpers)){
  for(const entry of await readdir(electronFwHelpers)){
    sign(join(electronFwHelpers,entry),{entitlements:entitlementsInherit});
  }
}
const electronFwLibs=join(frameworksDir,'Electron Framework.framework/Versions/A/Libraries');
if(existsSync(electronFwLibs)){
  for(const entry of await readdir(electronFwLibs)){
    if(entry.endsWith('.dylib'))sign(join(electronFwLibs,entry));
  }
}
for(const entry of await readdir(frameworksDir)){
  const full=join(frameworksDir,entry);
  if(entry.endsWith('.framework'))sign(full);
}
for(const entry of await readdir(frameworksDir)){
  if(entry.endsWith('.app'))sign(join(frameworksDir,entry),{entitlements:entitlementsInherit});
}
sign(app,{entitlements:effectiveMainEntitlements});
run('/usr/bin/codesign',['--verify','--deep','--strict',app]);

const pkgOut=installerCert&&identity!=='-'
  ?join(root,'dist',`MemoCat-${pkg.version}-mas-${process.arch}.pkg`)
  :join(root,'dist',`MemoCat-${pkg.version}-mas-${process.arch}-unsigned.pkg`);
const productArgs=['--component',app,'/Applications'];
if(installerCert&&identity!=='-')productArgs.push('--sign',installerCert);
productArgs.push(pkgOut);
run('/usr/bin/productbuild',productArgs);
run('/usr/sbin/pkgutil',['--payload-files',pkgOut]);
console.log(`Built ${pkgOut} (${identity==='-'?'unsigned / ad-hoc':'signed'})`);
