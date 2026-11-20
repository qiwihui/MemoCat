const {app,BrowserWindow,Tray,Menu,nativeImage,dialog,shell,screen}=require('electron');
const {existsSync}=require('node:fs');
const path=require('node:path');
// Keep the existing Electron library and preferences when changing the display name.
const userData=app.getPath('userData');
app.setName('MemoCat');
app.setPath('userData',userData);
let backend=null,mainWin=null,tray=null,quitting=false;
const activeBookmarks=new Map();
const getBackground=()=>{
  if(!backend||backend.store?.closed)return true;
  try{return backend.store.getSetting('backgroundMode',true);}catch{return true;}
};
function releaseBookmark(id){
  const stop=activeBookmarks.get(id);
  if(typeof stop==='function'){try{stop();}catch{}}
  activeBookmarks.delete(id);
}
function releaseAllBookmarks(){
  for(const id of [...activeBookmarks.keys()])releaseBookmark(id);
}
function activateSourceBookmark(bookmark,sourceId='default'){
  if(!bookmark||typeof app.startAccessingSecurityScopedResource!=='function')return false;
  try{
    const stop=app.startAccessingSecurityScopedResource(bookmark);
    releaseBookmark(sourceId);
    if(typeof stop==='function')activeBookmarks.set(sourceId,stop);
    return true;
  }catch{
    return false;
  }
}
function resolveDefaultPickPath(targetPath){
  if(targetPath&&existsSync(targetPath))return targetPath;
  const parent=targetPath?path.dirname(targetPath):'';
  if(parent&&existsSync(parent))return parent;
  return app.getPath('home');
}
async function pickSourceDirectory({defaultPath,title}={}){
  const options={
    title:title||'选择 AI 对话来源目录',
    defaultPath:resolveDefaultPickPath(defaultPath),
    properties:['openDirectory','showHiddenFiles','dontAddToRecent'],
    securityScopedBookmarks:true
  };
  const result=mainWin&&!mainWin.isDestroyed()
    ?await dialog.showOpenDialog(mainWin,options)
    :await dialog.showOpenDialog(options);
  if(result.canceled||!result.filePaths?.length)return {canceled:true};
  const pickedPath=result.filePaths[0];
  const bookmark=Array.isArray(result.bookmarks)&&result.bookmarks[0]?result.bookmarks[0]:null;
  return {canceled:false,path:pickedPath,bookmark};
}
function installApplicationMenu(){
  const openRoute=hash=>{
    void showWindow().then(()=>{
      if(mainWin&&!mainWin.isDestroyed()&&backend?.url){
        void mainWin.webContents.executeJavaScript(`location.hash=${JSON.stringify(hash)}`);
      }
    });
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label:'MemoCat',
      submenu:[
        {role:'about',label:'关于 MemoCat'},
        {type:'separator'},
        {label:'设置…',accelerator:'Command+,',click:()=>{openRoute('#settings');}},
        {type:'separator'},
        {role:'services',label:'服务'},
        {type:'separator'},
        {role:'hide',label:'隐藏 MemoCat'},
        {role:'hideOthers',label:'隐藏其他'},
        {role:'unhide',label:'全部显示'},
        {type:'separator'},
        {role:'quit',label:'退出 MemoCat'}
      ]
    },
    {
      label:'编辑',
      submenu:[
        {role:'undo',label:'撤销'},
        {role:'redo',label:'重做'},
        {type:'separator'},
        {role:'cut',label:'剪切'},
        {role:'copy',label:'复制'},
        {role:'paste',label:'粘贴'},
        {role:'selectAll',label:'全选'}
      ]
    },
    {
      label:'视图',
      submenu:[
        {label:'工作台',accelerator:'Command+1',click:()=>{openRoute('#workspace');}},
        {label:'记忆召回',accelerator:'Command+2',click:()=>{openRoute('#recall');}},
        {label:'数据管道',accelerator:'Command+3',click:()=>{openRoute('#pipeline');}},
        {label:'统计',accelerator:'Command+4',click:()=>{openRoute('#stats');}},
        {label:'设置',accelerator:'Command+5',click:()=>{openRoute('#settings');}},
        {type:'separator'},
        {role:'resetZoom',label:'实际大小'},
        {role:'zoomIn',label:'放大'},
        {role:'zoomOut',label:'缩小'},
        {type:'separator'},
        {role:'togglefullscreen',label:'进入全屏幕'}
      ]
    },
    {
      label:'窗口',
      submenu:[
        {role:'minimize',label:'最小化'},
        {role:'zoom',label:'缩放'},
        {type:'separator'},
        {role:'front',label:'前置全部窗口'},
        {role:'close',label:'关闭窗口'}
      ]
    }
  ]));
}
function updateTray(){
  if(!tray||tray.isDestroyed?.())return;
  const hostText=backend?backend.url.replace(/^http:\/\//,''):'127.0.0.1:3792';
  tray.setToolTip(`MemoCat · 本地服务运行中 (${hostText})`);
  tray.setContextMenu(Menu.buildFromTemplate([
    {label:'打开 MemoCat',click:()=>{void showWindow();}},
    {label:`服务地址：${hostText}`,enabled:false},
    {type:'separator'},
    {label:'后台运行（关闭窗口保持服务）',type:'checkbox',checked:getBackground(),click:item=>{setBackground(item.checked);}},
    {type:'separator'},
    {label:'退出 MemoCat',click:()=>{app.quit();}}
  ]));
}
function setBackground(enabled){
  if(backend&&!backend.store?.closed)backend.store.setSetting('backgroundMode',Boolean(enabled));
  updateTray();
}
function createTray(){
  try{
    if(tray&&!tray.isDestroyed?.()){updateTray();return;}
    const icon=nativeImage.createFromPath(path.join(__dirname,'../public/assets/app-icon-64.png')).resize({width:18,height:18});
    tray=new Tray(icon);
    tray.on('double-click',()=>{void showWindow();});
    updateTray();
  }catch{}
}
async function showWindow(){
  if(mainWin&&!mainWin.isDestroyed()){
    if(mainWin.isMinimized())mainWin.restore();
    mainWin.show();
    mainWin.focus();
    return;
  }
  const appIcon=path.join(__dirname,'../public/assets/app-icon.png');
  const workAreaWidth=screen?.getPrimaryDisplay?.()?.workAreaSize?.width||1440;
  const minWidth=Math.max(320,Math.min(360,Math.floor(workAreaWidth/4)));
  const win=new BrowserWindow({icon:appIcon,width:1320,height:900,minWidth,minHeight:420,title:'MemoCat',titleBarStyle:'hiddenInset',trafficLightPosition:{x:14,y:18},backgroundColor:'#ffffff',webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
  mainWin=win;
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,url)=>{if(!backend||!url.startsWith(backend.url+'/'))event.preventDefault();});
  win.on('close',event=>{if(!quitting&&getBackground()){event.preventDefault();win.hide();}});
  win.on('closed',()=>{if(mainWin===win)mainWin=null;});
  await win.loadURL(backend.url+'/?desktop=1');
}
if(process.env.MEMOCAT_VERIFY_PACKAGE!=='1'&&!app.requestSingleInstanceLock())app.exit(0);
app.on('second-instance',()=>{if(backend&&!quitting)void showWindow();});
app.on('activate',()=>{if(backend&&!quitting)void showWindow();});
app.whenReady().then(async()=>{
 if(process.env.MEMOCAT_VERIFY_PACKAGE==='1'){console.log('MEMOCAT_PACKAGE '+JSON.stringify({packaged:app.isPackaged,loginApi:typeof app.setLoginItemSettings==='function'}));app.quit();return;}

 const {userDataDirectory}=await import('./data-directory.js');
 const dataDir=process.env.MEMO_DATA_DIR||userDataDirectory({legacy:[path.join(app.getPath('userData'),'library'),path.join(__dirname,'../data')]});
 const port=Number(process.env.PORT||3792);
 const {start}=await import('./server.js');
 const startupSupported=app.isPackaged&&!process.mas;
 backend=await start({
   port,
   dataDir,
   desktopActions:{
     startupSupported,
     getStartup:()=>startupSupported?app.getLoginItemSettings({path:process.execPath}).openAtLogin:false,
     setStartup:enabled=>{if(startupSupported)app.setLoginItemSettings({openAtLogin:enabled,path:process.execPath});},
     backgroundSupported:true,
     getBackground,
     setBackground,
     pickSourceDirectory,
     activateSourceBookmark,
     openDataDirectory:async directory=>{const error=await shell.openPath(directory);if(error)throw new Error(error);}
   }
 });
 for(const source of backend.store.getSetting('sources',[])){
   if(source?.bookmark)activateSourceBookmark(source.bookmark,source.id);
 }
 app.setAboutPanelOptions?.({
   applicationName:'MemoCat',
   applicationVersion:app.getVersion?.()||'0.5.0',
   copyright:'Copyright © 2026 MemoCat. Local-first offline archive.'
 });
 installApplicationMenu();
 const appIcon=path.join(__dirname,'../public/assets/app-icon.png');
 if(app.dock)app.dock.setIcon(appIcon);
 createTray();
 await showWindow();
}).catch(error=>{dialog.showErrorBox('MemoCat 启动失败',error.message+(error.code==='EADDRINUSE'?'\n默认端口为 3792，请确认未被其他进程占用。':''));app.quit();});
app.on('before-quit',event=>{
 if(!quitting&&backend){
   event.preventDefault();
   quitting=true;
   const closing=backend;
   backend=null;
   closing.close().finally(()=>{
     releaseAllBookmarks();
     if(tray){try{tray.destroy();}catch{}tray=null;}
     app.quit();
   });
 }else{
   quitting=true;
 }
});
app.on('window-all-closed',()=>{if(!quitting&&!getBackground())app.quit();});
