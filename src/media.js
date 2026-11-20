import {readFile,stat,mkdir,writeFile} from 'node:fs/promises';
import {join,dirname,resolve,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const MAX_IMAGE_BYTES=32*1024*1024;
export function imageType(bytes){
 if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {ext:'png',mime:'image/png'};
 if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return {ext:'jpg',mime:'image/jpeg'};
 if(/^GIF8[79]a$/.test(bytes.subarray(0,6).toString()))return {ext:'gif',mime:'image/gif'};
 if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return {ext:'webp',mime:'image/webp'};
 return null;
}
export function extractImages(content,text,cwd,sourcePath,extra=[]){
 const items=[],seen=new Set();
 const add=(value,alt='对话图片',marker)=>{
  if(!value||typeof value!=='string')return;
  let source=value;
  if(!/^(data:|https?:)/i.test(source)){
   try{if(source.startsWith('file:'))source=fileURLToPath(source);else source=decodeURIComponent(source);}catch{}
   source=isAbsolute(source)?source:resolve(cwd||dirname(sourcePath),source);
  }
  const key=createHash('sha256').update(source).digest('hex');
  if(seen.has(key)){if(marker)items.find(i=>i.key===key)?.markers.push(marker);return;}seen.add(key);
  items.push({key,source,alt,markers:marker?[marker]:[]});
 };
 for(const block of Array.isArray(content)?content:[]){
  if(block.type==='image'){
   const s=block.source||{};
   if(s.type==='base64'&&typeof s.data==='string')add(`data:${s.media_type||'image/png'};base64,${s.data}`,block.alt);
   else add(s.url||s.path||block.path,block.alt);
  }else if(['input_image','image_url','local_image'].includes(block.type))add(typeof block.image_url==='string'?block.image_url:block.image_url?.url||block.path||block.url,block.alt);
 }
 for(const value of extra)add(typeof value==='string'?value:value?.path||value?.url);
 for(const match of text.matchAll(/<image\b[^>]*\bpath="([^"\r\n]+)"[^>]*>/g))add(match[1],'对话图片',match[0]);
 for(const match of text.matchAll(/!\[([^\]]*)\]\(([^\n]+?)\)/g))add(match[2],match[1]||'对话图片',match[0]);
 return items;
}
export class MediaStore{
 constructor(root){this.root=root;}
 async ingest(conversation,previous){
  const records=[];
  for(const record of conversation.records){
   if(!record.images?.length){records.push(record);continue;}
   const images=[];
   for(const image of record.images){
    try{
     if(/^https?:/i.test(image.source))throw new Error('远程图片未下载，无法离线显示');
     let bytes;
     if(image.source.startsWith('data:')){
      const match=/^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i.exec(image.source);
      if(!match||match[1].length>MAX_IMAGE_BYTES*1.4)throw new Error('图片数据格式无效或超过32MB');
      bytes=Buffer.from(match[1],'base64');
     }else{const info=await stat(image.source);if(!info.isFile()||info.size>MAX_IMAGE_BYTES)throw new Error('图片不可读或超过32MB');bytes=await readFile(image.source);}
     if(bytes.length>MAX_IMAGE_BYTES)throw new Error('图片超过32MB');
     const type=imageType(bytes);if(!type)throw new Error('图片格式暂不支持');
     const id=createHash('sha256').update(bytes).digest('hex')+'.'+type.ext;await mkdir(this.root,{recursive:true,mode:0o700});
     try{await writeFile(join(this.root,id),bytes,{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
     images.push({id,sourceKey:image.key,alt:image.alt,markers:image.markers});
    }catch(error){const cached=previous?.records.flatMap(r=>r.images||[]).find(i=>i.sourceKey===image.key&&i.id);if(cached&&await this.read(cached.id))images.push({...cached,markers:image.markers});else images.push({sourceKey:image.key,unavailable:true,alt:image.alt,markers:image.markers,reason:error.code==='ENOENT'?'原图片文件已不存在':error.message});}
   }
   records.push({...record,images});
  }
  return {...conversation,records};
 }
 async read(id){if(!/^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(id))return null;try{const bytes=await readFile(join(this.root,id)),type=imageType(bytes);return type?{bytes,mime:type.mime}:null;}catch(error){if(error.code==='ENOENT')return null;throw error;}}
}
