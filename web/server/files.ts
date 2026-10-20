import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import type { CloudDatabase } from './cloud.js';
import type { CloudUser } from '../src/shared/sync.js';
import type { BookFormat } from '../src/shared/types.js';
import { ServiceError } from './network.js';

export interface StoredFile { hash:string; bytes:number; format:BookFormat; updatedAt:string }
export class CloudFiles {
  readonly maxFileBytes:number;
  readonly userLimit:number;
  private readonly globalLimit:number;
  private readonly reserveDisk:number;
  private uploading=false;
  private downloads=0;
  private ready:Promise<void>;
  constructor(private cloud:CloudDatabase,private root:string,limits:{maxFileBytes?:number;userLimit?:number;globalLimit?:number;reserveDisk?:number}={}){
    this.maxFileBytes=limits.maxFileBytes??250*1024**2;this.userLimit=limits.userLimit??2*1024**3;
    this.globalLimit=limits.globalLimit??10*1024**3;this.reserveDisk=limits.reserveDisk??5*1024**3;
    this.ready=this.prepare();
  }
  initialize(){return this.ready;}
  private path(user:CloudUser,hash:string){
    if(!/^[a-f0-9-]{36}$/.test(user.id)||!/^[a-f0-9]{64}$/.test(hash))throw new ServiceError('文件不存在。',404);
    return join(this.root,user.id,hash);
  }
  private async prepare(){
    await mkdir(this.root,{recursive:true,mode:0o700});
    // Recover interrupted writes; never remove unrelated names or follow links.
    for(const user of await readdir(this.root,{withFileTypes:true})){
      if(!user.isDirectory()||!/^[a-f0-9-]{36}$/.test(user.name))continue;
      const owned=new Set(this.cloud.fileRows({id:user.name,username:''}).map(f=>f.hash));
      for(const file of await readdir(join(this.root,user.name),{withFileTypes:true})){
        if(file.isFile()&&(file.name.startsWith('.upload-')||/^[a-f0-9]{64}$/.test(file.name)&&!owned.has(file.name)))await rm(join(this.root,user.name,file.name));
      }
    }
  }
  async list(user:CloudUser){
    await this.ready;await this.prune(user);
    const entries=this.cloud.fileBooks(user),files=[];
    for(const row of this.cloud.fileRows(user)){
      const info=await stat(this.path(user,row.hash)).catch(()=>null);
      if(!info||info.size!==row.bytes){this.cloud.forgetFile(user,row.hash);continue;}
      for(const book of entries.filter(book=>book.fileHash===row.hash))files.push({bookID:book.id,...row});
    }
    return {files,usedBytes:this.cloud.fileUsage(user),limitBytes:this.userLimit,maxFileBytes:this.maxFileBytes};
  }
  async prune(user:CloudUser){
    const live=new Set(this.cloud.fileBooks(user).map(book=>book.fileHash));
    for(const file of this.cloud.fileRows(user))if(!live.has(file.hash)){this.cloud.forgetFile(user,file.hash);await rm(this.path(user,file.hash),{force:true});}
  }
  async upload(user:CloudUser,hash:string,bookID:string,bytes:number,input:Readable,checkSession:()=>void){
    await this.ready;
    const book=this.cloud.fileBooks(user).find(b=>b.id===bookID&&b.fileHash===hash);
    if(!book?.publicationFormat)throw new ServiceError('请先同步这本书的书架资料。',409);
    if(!Number.isSafeInteger(bytes)||bytes<1||bytes>this.maxFileBytes)throw new ServiceError('单本文件超过上传上限。',413);
    this.path(user,hash);
    const existing=this.cloud.fileRows(user).find(f=>f.hash===hash);
    if(this.uploading)throw new ServiceError('文件同步正忙，请稍后重试。',429);
    this.uploading=true;
    const temporary=join(this.root,user.id,'.upload-'+randomUUID());
    try{
      await this.prune(user);
      if(this.cloud.fileUsage(user)+(existing?0:bytes)>this.userLimit)throw new ServiceError('账号云文件空间已满。',413);
      if(this.cloud.fileUsage()+(existing?0:bytes)>this.globalLimit)throw new ServiceError('服务器云文件空间已满。',507);
      const disk=await statfs(this.root);
      if(disk.bavail*disk.bsize-bytes<this.reserveDisk)throw new ServiceError('服务器可用磁盘空间不足，文件仍保留在本机。',507);
      await mkdir(join(this.root,user.id),{recursive:true,mode:0o700});
      let received=0;let prefix=Buffer.alloc(0);const digest=createHash('sha256');
      const bounded=new Transform({transform(chunk:Buffer,_encoding,done){
        received+=chunk.length;if(received>bytes){done(new ServiceError('文件长度与声明不一致。',400));return;}
        if(prefix.length<8)prefix=Buffer.concat([prefix,chunk.subarray(0,8-prefix.length)]);
        digest.update(chunk);done(null,chunk);
      }});
      await pipeline(input,bounded,createWriteStream(temporary,{flags:'wx',mode:0o600}),{signal:AbortSignal.timeout(600_000)});
      if(received!==bytes||digest.digest('hex')!==hash)throw new ServiceError('文件校验失败，请重新同步。',400);
      const format=book.publicationFormat;
      if(format==='pdf'&&prefix.subarray(0,5).toString()!=='%PDF-'||format==='epub'&&!prefix.subarray(0,4).equals(Buffer.from([80,75,3,4])))throw new ServiceError('文件格式与书架资料不一致。',400);
      checkSession();
      if(!this.cloud.fileBooks(user).some(b=>b.id===bookID&&b.fileHash===hash))throw new ServiceError('书籍已移除，文件同步已取消。',409);
      await rename(temporary,this.path(user,hash));
      const row={hash,bytes,format,updatedAt:new Date().toISOString()};this.cloud.saveFile(user,row);return row;
    }finally{this.uploading=false;await rm(temporary,{force:true});}
  }
  async download(user:CloudUser,hash:string){
    await this.ready;
    if(!this.cloud.fileBooks(user).some(book=>book.fileHash===hash))throw new ServiceError('云端文件不存在。',404);
    const file=this.cloud.fileRows(user).find(file=>file.hash===hash),path=this.path(user,hash);
    if(!file||(await stat(path).catch(()=>null))?.size!==file.bytes)throw new ServiceError('云端文件不存在。',404);
    if(this.downloads>=2)throw new ServiceError('文件下载正忙，请稍后重试。',429);
    this.downloads++;const stream=createReadStream(path);
    stream.once('close',()=>{this.downloads--;});return {file,stream};
  }
}
export function registerFileRoutes(app:FastifyInstance,cloud:CloudDatabase,files:CloudFiles){
  app.addHook('onReady',()=>files.initialize());
  app.addContentTypeParser('application/octet-stream',(_request,payload,done)=>done(null,payload));
  const auth=(header:unknown)=>cloud.authorize(header);
  app.get('/api/files',async request=>files.list(auth(request.headers.authorization)));
  const params={type:'object',required:['hash'],properties:{hash:{type:'string',pattern:'^[a-f0-9]{64}$'}},additionalProperties:false} as const;
  app.post<{Params:{hash:string};Querystring:{bookID:string;bytes:number}}>('/api/files/:hash',{
    bodyLimit:files.maxFileBytes,
    schema:{params,querystring:{type:'object',required:['bookID','bytes'],properties:{bookID:{type:'string',minLength:1,maxLength:8192},bytes:{type:'integer',minimum:1,maximum:files.maxFileBytes}},additionalProperties:false}},
    config:{rateLimit:{max:12,timeWindow:'1 minute'}},
    onRequest:async request=>{auth(request.headers.authorization);if([...new URL(request.url,'http://localhost').searchParams.keys()].some(key=>!['bookID','bytes'].includes(key)))throw new ServiceError('文件请求参数无效。',400);},
  },async request=>{
    if(!request.headers['content-type']?.startsWith('application/octet-stream'))throw new ServiceError('请使用文件上传格式。',415);
    const user=auth(request.headers.authorization);
    return files.upload(user,request.params.hash,request.query.bookID,request.query.bytes,request.body as Readable,()=>auth(request.headers.authorization));
  });
  app.get<{Params:{hash:string}}>('/api/files/:hash',{schema:{params}},async(request,reply)=>{
    const {file,stream}=await files.download(auth(request.headers.authorization),request.params.hash);
    reply.raw.once('close',()=>stream.destroy());
    return reply.type('application/octet-stream').header('Content-Length',file.bytes).header('Content-Disposition',`attachment; filename="book.${file.format}"`).header('Cache-Control','private, no-store').send(stream);
  });
}
