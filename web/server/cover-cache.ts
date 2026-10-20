import { createHash, randomUUID } from 'node:crypto';
import { mkdir,readFile,writeFile,rename,readdir,stat,rm } from 'node:fs/promises';
import { join } from 'node:path';
export interface CoverImage {bytes:Buffer;type:string}
export class CoverCache {
 private memory=new Map<string,{image:CoverImage;expires:number}>();private bytes=0;
 private pending=new Map<string,Promise<{image:CoverImage;cache:string}>>();
 private missing=new Map<string,{expires:number;error:unknown}>();private writes=0;
 constructor(private root?:string){}
 async get(key:string,loader:()=>Promise<CoverImage>){
  const old=this.memory.get(key);if(old&&old.expires>Date.now())return{image:old.image,cache:'memory'};
  const missing=this.missing.get(key);if(missing&&missing.expires>Date.now())throw missing.error;
  const pending=this.pending.get(key);if(pending)return pending;
  const task=this.load(key,loader);this.pending.set(key,task);
  try{return await task;}catch(error){this.missing.set(key,{expires:Date.now()+30_000,error});if(this.missing.size>300)this.missing.delete(this.missing.keys().next().value!);throw error;}finally{this.pending.delete(key);}
 }
 private remember(key:string,image:CoverImage){
  const previous=this.memory.get(key);if(previous)this.bytes-=previous.image.bytes.length;this.memory.delete(key);
  while(this.bytes+image.bytes.length>40*1024**2||this.memory.size>=150){const first=this.memory.keys().next().value;if(!first)break;this.bytes-=this.memory.get(first)!.image.bytes.length;this.memory.delete(first);}
  this.memory.set(key,{image,expires:Date.now()+6*3600_000});this.bytes+=image.bytes.length;
 }
 private async load(key:string,loader:()=>Promise<CoverImage>){
  const path=this.root?join(this.root,createHash('sha256').update(key).digest('hex')+'.json'):undefined;
  if(path)try{
   const file=await stat(path);
   if(Date.now()-file.mtimeMs<7*86400_000&&file.size<7*1024**2){
    const saved=JSON.parse(await readFile(path,'utf8')) as {type:string;data:string};
    if(['image/jpeg','image/png','image/webp','image/gif'].includes(saved.type)){
     const image={type:saved.type,bytes:Buffer.from(saved.data,'base64')};this.remember(key,image);return{image,cache:'disk'};
    }
   }
  }catch{ /* Cache failures never hide the original image. */ }
  const image=await loader();this.remember(key,image);
  if(path)try{
   await mkdir(this.root!,{recursive:true,mode:0o700});const temporary=path+'.'+randomUUID()+'.tmp';
   try{await writeFile(temporary,JSON.stringify({type:image.type,data:image.bytes.toString('base64')}),{mode:0o600});await rename(temporary,path);}finally{await rm(temporary,{force:true});}
   if(++this.writes===1||this.writes%12===0)await this.prune();
  }catch{ /* Read-only or full cache is not a reading failure. */ }
  return{image,cache:'miss'};
 }
 private async prune(){
  if(!this.root)return;
  const rows=[];
  for(const name of await readdir(this.root))if(/^[a-f0-9]{64}\.json$/.test(name)){const path=join(this.root,name),info=await stat(path);rows.push({path,bytes:info.size,time:info.mtimeMs});}
  rows.sort((a,b)=>a.time-b.time);let total=rows.reduce((n,row)=>n+row.bytes,0),count=rows.length;
  for(const row of rows)if(total>128*1024**2||count>500||Date.now()-row.time>7*86400_000){await rm(row.path,{force:true});total-=row.bytes;count--;}
 }
}
