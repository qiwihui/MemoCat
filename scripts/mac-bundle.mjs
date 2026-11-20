import {cp,mkdir,writeFile,rm,rename} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';

export const BUNDLE_ID='com.qiwihui.memocat.desktop';

export function run(command,args){
  execFileSync(command,args,{stdio:'inherit',env:{...process.env,COPYFILE_DISABLE:'1'}});
}

export function setPlist(plist,key,type,value){
  const raw=type==='bool'?(value?'true':'false'):`"${String(value).replace(/"/g,'\\"')}"`;
  try{
    execFileSync('/usr/libexec/PlistBuddy',['-c',`Print :${key}`,plist],{stdio:'ignore'});
    run('/usr/libexec/PlistBuddy',['-c',`Set :${key} ${raw}`,plist]);
  }catch{
    run('/usr/libexec/PlistBuddy',['-c',`Add :${key} ${type} ${raw}`,plist]);
  }
}

export function deletePlist(plist,key){
  try{
    execFileSync('/usr/libexec/PlistBuddy',['-c',`Delete :${key}`,plist],{stdio:'ignore'});
  }catch{}
}

export async function prepareMacApp({root,stage,pkg,sourceApp}){
  const app=join(stage,'MemoCat.app');
  await rm(stage,{recursive:true,force:true});
  await mkdir(stage,{recursive:true});
  await cp(sourceApp,app,{recursive:true,verbatimSymlinks:true});
  const resources=join(app,'Contents/Resources'),destination=join(resources,'app');
  await mkdir(destination,{recursive:true});
  for(const name of ['src','public','extension/lib'])await cp(join(root,name),join(destination,name),{recursive:true});
  await writeFile(join(destination,'package.json'),JSON.stringify({name:'memocat',productName:'MemoCat',version:pkg.version,type:'module',main:'src/desktop.cjs'},null,2));
  await cp(join(root,'public/assets/MemoCat.icns'),join(resources,'MemoCat.icns'));
  await rm(join(resources,'electron.icns'),{force:true});
  await cp(join(root,'build/PrivacyInfo.xcprivacy'),join(resources,'PrivacyInfo.xcprivacy'));
  await rename(join(app,'Contents/MacOS/Electron'),join(app,'Contents/MacOS/MemoCat'));

  const plist=join(app,'Contents/Info.plist');
  for(const [key,type,value] of [
    ['CFBundleExecutable','string','MemoCat'],
    ['CFBundleName','string','MemoCat'],
    ['CFBundleDisplayName','string','MemoCat'],
    ['CFBundleIdentifier','string',BUNDLE_ID],
    ['CFBundleIconFile','string','MemoCat.icns'],
    ['CFBundleShortVersionString','string',pkg.version],
    ['CFBundleVersion','string',pkg.version],
    ['LSApplicationCategoryType','string','public.app-category.developer-tools'],
    ['ITSAppUsesNonExemptEncryption','bool',false],
    ['LSMinimumSystemVersion','string','12.0'],
    ['NSHumanReadableCopyright','string','Copyright © 2026 MemoCat. All rights reserved.']
  ]){
    setPlist(plist,key,type,value);
  }
  for(const unused of [
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription',
    'NSBluetoothPeripheralUsageDescription',
    'NSBluetoothAlwaysUsageDescription',
    'NSAudioCaptureUsageDescription',
    'NSAppTransportSecurity'
  ]){
    deletePlist(plist,unused);
  }
  run('/usr/libexec/PlistBuddy',['-c','Add :NSAppTransportSecurity dict',plist]);
  run('/usr/libexec/PlistBuddy',['-c','Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true',plist]);

  const helperIds={
    'Electron Helper.app':`${BUNDLE_ID}.helper`,
    'Electron Helper (GPU).app':`${BUNDLE_ID}.helper.gpu`,
    'Electron Helper (Plugin).app':`${BUNDLE_ID}.helper.plugin`,
    'Electron Helper (Renderer).app':`${BUNDLE_ID}.helper.renderer`
  };
  for(const [helperName,helperId] of Object.entries(helperIds)){
    const helperPlist=join(app,'Contents/Frameworks',helperName,'Contents/Info.plist');
    if(existsSync(helperPlist))setPlist(helperPlist,'CFBundleIdentifier','string',helperId);
  }
  run('/usr/bin/plutil',['-lint',plist,join(resources,'PrivacyInfo.xcprivacy')]);
  return app;
}
