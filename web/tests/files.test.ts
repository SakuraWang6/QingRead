import { afterEach,describe,it,expect } from 'vitest';
import { createHash,randomUUID } from 'node:crypto';
import { mkdtemp,rm,readdir,stat,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app';
import { CloudDatabase } from '../server/cloud';
import { CloudFiles } from '../server/files';
import { sampleBook } from '../src/lib/sample';
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const clean of cleanups.splice(0))await clean();});
async function setup(limits:{maxFileBytes?:number;userLimit?:number;globalLimit?:number}={}){
 const directory=await mkdtemp(join(tmpdir(),'qingread-files-')),db=new CloudDatabase(join(directory,'accounts.sqlite'));
 const files=new CloudFiles(db,join(directory,'files'),{reserveDisk:0,...limits}),app=await createApp({serveWeb:false,cloud:db,files,token:'legacy-source-code'});
 cleanups.push(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
 const a=await db.authenticate({username:'file_reader_a',password:'long-test-passphrase'},true),b=await db.authenticate({username:'file_reader_b',password:'long-test-passphrase'},true);
 const headers=(token:string)=>({Authorization:'Bearer '+token});
 const save=(user:typeof a,body:Buffer,format:'txt'|'pdf'|'epub'='txt',id='file|'+createHash('sha256').update(body).digest('hex'))=>{
  const hash=createHash('sha256').update(body).digest('hex');
  db.sync(user.user,{anchorFormat:'body-utf16-v1',cursor:0,mutations:[{id:randomUUID(),action:'add',bookID:id,baseRevision:0,changedAt:new Date().toISOString(),entry:{book:{...sampleBook,id,fileHash:hash,publicationFormat:format},addedAt:new Date().toISOString()}}]});return{hash,id};
 };
 const upload=(user:typeof a,body:Buffer,book:{hash:string;id:string},bytes=body.length)=>app.inject({method:'POST',url:'/api/files/'+book.hash+'?'+new URLSearchParams({bookID:book.id,bytes:String(bytes)}),headers:{...headers(user.token),'Content-Type':'application/octet-stream'},payload:body});
 return{directory,db,files,app,a,b,headers,save,upload};
}
describe('private cloud publications',()=>{
 it('streams the original bytes across sessions and isolates identical hashes by account',async()=>{
  const x=await setup(),body=Buffer.from('第一章\n云文件正文。'),book=x.save(x.a,body);
  expect((await x.upload(x.a,body,book)).statusCode).toBe(200);
  const second=await x.db.authenticate({username:x.a.user.username,password:'long-test-passphrase'},false);
  const got=await x.app.inject({url:'/api/files/'+book.hash,headers:x.headers(second.token)});
  expect(got.rawPayload).toEqual(body);expect(got.headers['cache-control']).toContain('no-store');
  expect((await x.app.inject({url:'/api/files/'+book.hash})).statusCode).toBe(401);
  x.save(x.b,body); // Guessing both the exact book and file hash still grants no access.
  expect((await x.app.inject({url:'/api/files/'+book.hash,headers:x.headers(x.b.token)})).statusCode).toBe(404);
  expect((await x.app.inject({url:'/api/files',headers:x.headers(x.b.token)})).json().files).toEqual([]);
  expect((await x.upload(x.b,body,book)).statusCode).toBe(200);
  expect((await stat(join(x.directory,'files',x.a.user.id,book.hash))).mode&0o777).toBe(0o600);
  expect((await stat(join(x.directory,'files',x.b.user.id,book.hash))).mode&0o777).toBe(0o600);
 });
 it('verifies hash and size and cleans incomplete uploads without registering files',async()=>{
  const x=await setup(),body=Buffer.from('原来的书'),book=x.save(x.a,body);
  expect((await x.upload(x.a,Buffer.from('不同的书'),book)).statusCode).toBe(400);
  expect((await x.upload(x.a,body,book,body.length+1)).statusCode).toBe(400);
  expect(x.db.fileRows(x.a.user)).toEqual([]);
  expect((await readdir(join(x.directory,'files',x.a.user.id))).filter(n=>n.startsWith('.upload-'))).toEqual([]);
 });
 it('bounds per-file, per-account and shared storage and does not trust owner IDs',async()=>{
  const x=await setup({maxFileBytes:30,userLimit:12,globalLimit:15}),one=Buffer.from('12345678'),two=Buffer.from('abcdefgh');
  const first=x.save(x.a,one),second=x.save(x.a,two);
  expect((await x.upload(x.a,one,first)).statusCode).toBe(200);
  expect((await x.upload(x.a,one,first)).statusCode).toBe(200); // Lost-response retry is idempotent.
  expect(x.db.fileUsage(x.a.user)).toBe(8);
  expect((await x.upload(x.a,two,second)).statusCode).toBe(413);
  expect((await x.app.inject({url:'/api/files?userID='+x.a.user.id,headers:x.headers(x.b.token)})).json().files).toEqual([]);
  expect((await x.app.inject({method:'POST',url:'/api/files/'+first.hash+'?bookID='+encodeURIComponent(first.id)+'&bytes=8&userID='+x.a.user.id,headers:{...x.headers(x.b.token),'Content-Type':'application/octet-stream'},payload:one})).statusCode).toBe(400);
  const other=x.save(x.b,two);expect((await x.upload(x.b,two,other)).statusCode).toBe(507);
  const big=Buffer.alloc(31);expect((await x.upload(x.a,big,x.save(x.a,big))).statusCode).toBe(400);
 });
 it('supports EPUB and PDF without unpacking private content on the server',async()=>{
  const x=await setup(),epub=await readFile(new URL('../../Tests/ReadingCoreTests/Fixtures/import.epub',import.meta.url)),pdf=Buffer.from('%PDF-1.4\nprivate document');
  for(const [body,format] of [[epub,'epub'],[pdf,'pdf']] as const){const book=x.save(x.a,body,format);expect((await x.upload(x.a,body,book)).statusCode).toBe(200);expect((await x.app.inject({url:'/api/files/'+book.hash,headers:x.headers(x.a.token)})).rawPayload).toEqual(body);}
  const wrong=Buffer.from('not a PDF');expect((await x.upload(x.a,wrong,x.save(x.a,wrong,'pdf'))).statusCode).toBe(400);
 });
 it('retains shared owned files until the last book reference is removed',async()=>{
  const x=await setup(),body=Buffer.from('same original file'),book=x.save(x.a,body),other=x.save(x.a,body,'txt','second-library-id');await x.upload(x.a,body,book);
  const remove=(bookID:string)=>x.db.sync(x.a.user,{anchorFormat:'body-utf16-v1',cursor:0,mutations:[{id:randomUUID(),action:'remove',bookID,baseRevision:100,changedAt:new Date().toISOString()}]});
  remove(book.id);await x.files.list(x.a.user);expect(x.db.fileUsage(x.a.user)).toBe(body.length);
  remove(other.id);expect((await x.files.list(x.a.user)).usedBytes).toBe(0);
  expect((await x.app.inject({url:'/api/files/'+book.hash,headers:x.headers(x.a.token)})).statusCode).toBe(404);
 });
});
