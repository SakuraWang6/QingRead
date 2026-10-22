import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OfflineJobs, type OfflineAccountAccess } from '../server/offline-jobs';
import { CloudDatabase } from '../server/cloud';
import { createApp } from '../server/app';
import type { Book, Chapter, ChapterContent } from '../src/shared/types';
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.restoreAllMocks();});
const token='A'.repeat(43),header='Bearer '+token,hash=createHash('sha256').update(token).digest('hex');
const book:Book={id:'old-logical-id',sourceID:'biequgei',sourceName:'笔趣阁',title:'测试小说',author:'作者',summary:'',url:'https://www.biequgei.com/book/123/'};
const chapters:Chapter[]=Array.from({length:3},(_,index)=>({id:'chapter-'+index,title:'第'+(index+1)+'章',index,url:book.url+(index+1)+'.html'}));
const value=(chapter:Chapter,text='已经准备的正文'):ChapterContent=>({chapter,paragraphs:[text]});
async function setup(options:ConstructorParameters<typeof OfflineJobs>[2]={}){
 const root=await mkdtemp(join(tmpdir(),'qingread-server-jobs-')),a={id:randomUUID(),username:'a'},b={id:randomUUID(),username:'b'},books=new Map<string,Book[]>([[a.id,[book]],[b.id,[book]]]),sessions=new Set([a.id+'|'+hash,b.id+'|'+hash]);
 const accounts:OfflineAccountAccess={fileBooks:user=>books.get(user.id)??[],hasSession:(id,key)=>sessions.has(id+'|'+key)};
 const jobs=new OfflineJobs(accounts,root,{autoStart:false,intervalMs:0,reserveDisk:0,diskAvailable:async()=>1024**3,load:async(_book,chapter)=>value(chapter),...options});await jobs.initialize();
 cleanup.push(async()=>{await jobs.close();await rm(root,{recursive:true,force:true});});return{root,jobs,a,b,books,sessions,accounts};
}
describe('durable account-isolated server preparation',()=>{
 it('coalesces identical submissions and enforces active account/global bounds after asynchronous space checks',async()=>{
  const x=await setup({maxGlobalActive:2});const [first,retry]=await Promise.all([x.jobs.create(x.a,header,{bookID:book.id,chapters}),x.jobs.create(x.a,header,{bookID:book.id,chapters})]);expect(first.id).toBe(retry.id);
  await x.jobs.create(x.a,header,{bookID:book.id,chapters:[chapters[0]]});await expect(x.jobs.create(x.a,header,{bookID:book.id,chapters:[chapters[1]]})).rejects.toMatchObject({statusCode:429});await expect(x.jobs.create(x.b,header,{bookID:book.id,chapters})).rejects.toMatchObject({statusCode:429});expect((await x.jobs.list(x.b)).jobs).toEqual([]);
 });
 it('takes book identity from the owned shelf and rejects cross-owner IDs, file books, private URLs and duplicate chapter IDs',async()=>{
  const x=await setup();x.books.set(x.b.id,[]);await expect(x.jobs.create(x.b,header,{bookID:book.id,chapters})).rejects.toMatchObject({statusCode:409});
  for(const invalid of [[{...chapters[0],url:'https://127.0.0.1/private'}],[chapters[0],chapters[0]]])await expect(x.jobs.create(x.a,header,{bookID:book.id,chapters:invalid})).rejects.toMatchObject({statusCode:400});
  await expect(x.jobs.create(x.a,header,{bookID:book.id,chapters,userID:x.b.id})).rejects.toMatchObject({statusCode:400});x.books.set(x.a.id,[{...book,publicationFormat:'epub'}]);await expect(x.jobs.create(x.a,header,{bookID:book.id,chapters})).rejects.toMatchObject({statusCode:400});
 });
 it('prepares serially, streams only to the owner, and binds work to a digest rather than the raw bearer',async()=>{
  let active=0,maximum=0;const x=await setup({load:async(_book,chapter)=>{active++;maximum=Math.max(maximum,active);await new Promise(resolve=>setTimeout(resolve,1));active--;return value(chapter);}}),job=await x.jobs.create(x.a,header,{bookID:book.id,chapters});await x.jobs.runPending();expect(maximum).toBe(1);expect((await x.jobs.list(x.a)).jobs[0]).toMatchObject({status:'completed',completed:3,book:{id:book.id},engine:'server'});
  await expect(x.jobs.download(x.b,job.id,()=>{})).rejects.toMatchObject({statusCode:404});const got=await x.jobs.download(x.a,job.id,()=>{});const data=[];for await(const chunk of got.stream)data.push(String(chunk));const records=data.join('').trim().split('\n').map(line=>JSON.parse(line));expect(records.filter(row=>row.type==='chapter').map(row=>row.content.chapter.id)).toEqual(chapters.map(chapter=>chapter.id));expect(records.at(-1)).toMatchObject({type:'complete',chapters:3});
  for(const name of await readdir(x.root)){if(name.startsWith('offline-jobs.sqlite'))expect((await readFile(join(x.root,name))).includes(Buffer.from(token))).toBe(false);}
 });
 it('drops late chapter responses after pause and resumes the same job without resurrecting stale data',async()=>{
  let finish!:(value:ChapterContent)=>void;const load=vi.fn<(book:Book,chapter:Chapter)=>Promise<ChapterContent>>().mockImplementationOnce(()=>new Promise(resolve=>finish=resolve)).mockImplementation(async(_book,chapter)=>value(chapter,'继续后取得的正文'));
  const x=await setup({load}),job=await x.jobs.create(x.a,header,{bookID:book.id,chapters:[chapters[0]]}),running=x.jobs.runPending();await vi.waitFor(()=>expect(load).toHaveBeenCalled());await x.jobs.action(x.a,header,job.id,'pause');finish(value(chapters[0],'不应保存的旧响应'));await running;expect((await x.jobs.list(x.a)).jobs[0]).toMatchObject({status:'paused',completed:0,bytes:0});
  await x.jobs.action(x.a,header,job.id,'resume');await x.jobs.runPending();const download=await x.jobs.download(x.a,job.id,()=>{});let body='';for await(const chunk of download.stream)body+=chunk;expect(body).toContain('继续后取得的正文');expect(body).not.toContain('不应保存的旧响应');
 });
 it('cancels and discards responses when the owned book changes source while a request is in flight',async()=>{
  let finish!:(value:ChapterContent)=>void;const load=vi.fn().mockImplementation(()=>new Promise<ChapterContent>(resolve=>finish=resolve)),x=await setup({load}),job=await x.jobs.create(x.a,header,{bookID:book.id,chapters}),running=x.jobs.runPending();await vi.waitFor(()=>expect(load).toHaveBeenCalled());x.books.set(x.a.id,[{...book,url:'https://www.biequgei.com/book/456/'}]);finish(value(chapters[0]));await running;expect((await x.jobs.list(x.a)).jobs[0]).toMatchObject({status:'cancelled',bytes:0,completed:0});await expect(x.jobs.download(x.a,job.id,()=>{})).rejects.toMatchObject({statusCode:409});
 });
 it('pauses revoked sessions before storing an in-flight result and allows an authenticated new session to resume',async()=>{
  let finish!:(value:ChapterContent)=>void;const load=vi.fn().mockImplementationOnce(()=>new Promise<ChapterContent>(resolve=>finish=resolve)).mockImplementation(async(_book,chapter)=>value(chapter)),x=await setup({load}),job=await x.jobs.create(x.a,header,{bookID:book.id,chapters:[chapters[0]]}),running=x.jobs.runPending();await vi.waitFor(()=>expect(load).toHaveBeenCalled());x.sessions.delete(x.a.id+'|'+hash);finish(value(chapters[0]));await running;expect((await x.jobs.list(x.a)).jobs[0]).toMatchObject({status:'paused',completed:0});
  const next='B'.repeat(43);x.sessions.add(x.a.id+'|'+createHash('sha256').update(next).digest('hex'));await x.jobs.action(x.a,'Bearer '+next,job.id,'resume');await x.jobs.runPending();expect((await x.jobs.list(x.a)).jobs[0].status).toBe('completed');
 });
 it('recovers interrupted running jobs and reuses durable completed chapter files after restart',async()=>{
  let finish!:(value:ChapterContent)=>void;const load=vi.fn().mockImplementationOnce(async(_book,chapter)=>value(chapter)).mockImplementation(()=>new Promise<ChapterContent>(resolve=>finish=resolve));const x=await setup({load}),job=await x.jobs.create(x.a,header,{bookID:book.id,chapters}),running=x.jobs.runPending();await vi.waitFor(()=>expect(load).toHaveBeenCalledTimes(2));const closing=x.jobs.close();finish(value(chapters[1]));await running;await closing;
  const resumedLoad=vi.fn(async(_book:Book,chapter:Chapter)=>value(chapter)),reopened=new OfflineJobs(x.accounts,x.root,{autoStart:false,intervalMs:0,reserveDisk:0,load:resumedLoad});cleanup.push(()=>reopened.close());await reopened.initialize();expect((await reopened.list(x.a)).jobs[0]).toMatchObject({status:'queued',completed:1});await reopened.runPending();expect(resumedLoad).toHaveBeenCalledTimes(2);expect((await reopened.list(x.a)).jobs[0]).toMatchObject({id:job.id,status:'completed',completed:3});
 });
 it('bounds prepared bytes and keeps a disk reserve without deleting existing prepared chapters',async()=>{
  const size=Buffer.byteLength(JSON.stringify(value(chapters[0]))),x=await setup({userLimit:size+1,globalLimit:size*10}),job=await x.jobs.create(x.a,header,{bookID:book.id,chapters});await x.jobs.runPending();const snapshot=(await x.jobs.list(x.a)).jobs[0];expect(snapshot).toMatchObject({status:'paused',completed:1});expect(snapshot.bytes).toBeLessThanOrEqual(size+1);
  await x.jobs.action(x.a,header,job.id,'cancel');expect((await x.jobs.list(x.a)).usedBytes).toBe(0);
  const low=await setup({reserveDisk:100,diskAvailable:async()=>99});await expect(low.jobs.create(low.a,header,{bookID:book.id,chapters})).rejects.toMatchObject({statusCode:507});
 });
 it('enforces the shared byte limit across accounts and detects equal-size corruption before importing it',async()=>{
  const size=Buffer.byteLength(JSON.stringify(value(chapters[0]))),x=await setup({globalLimit:size+1,userLimit:size*10}),first=await x.jobs.create(x.a,header,{bookID:book.id,chapters:[chapters[0]]});await x.jobs.runPending();await x.jobs.create(x.b,header,{bookID:book.id,chapters:[chapters[0]]});await x.jobs.runPending();expect((await x.jobs.list(x.b)).jobs[0]).toMatchObject({status:'paused',completed:0});
  const path=join(x.root,'jobs',x.a.id,first.id,'0.json'),bytes=await readFile(path);await writeFile(path,Buffer.from(bytes.toString().replace('已经准备的正文','应该拒绝的正文')));const download=await x.jobs.download(x.a,first.id,()=>{});const consume=async()=>{for await(const _line of download.stream){/* only verified lines may reach the client */}};await expect(consume()).rejects.toThrow('校验失败');expect((await x.jobs.list(x.a)).jobs[0]).toMatchObject({status:'paused',completed:0});
 });
 it('restores missing completed chapter files as queued work on restart',async()=>{
  const x=await setup(),job=await x.jobs.create(x.a,header,{bookID:book.id,chapters:[chapters[0]]});await x.jobs.runPending();await x.jobs.close();await rm(join(x.root,'jobs',x.a.id,job.id,'0.json'));const load=vi.fn(async(_book:Book,chapter:Chapter)=>value(chapter)),reopened=new OfflineJobs(x.accounts,x.root,{autoStart:false,intervalMs:0,reserveDisk:0,load});cleanup.push(()=>reopened.close());await reopened.initialize();expect((await reopened.list(x.a)).jobs[0]).toMatchObject({status:'queued',completed:0,bytes:0});await reopened.runPending();expect(load).toHaveBeenCalledTimes(1);expect((await reopened.list(x.a)).jobs[0].status).toBe('completed');
 });
 it('bounds each chapter retry and expires stale jobs with their private files',async()=>{
  let now=Date.now();const load=vi.fn().mockRejectedValue(new Error('source offline')),x=await setup({load,now:()=>now,ttlMs:100});await x.jobs.create(x.a,header,{bookID:book.id,chapters:[chapters[0]]});await x.jobs.runPending();expect(load).toHaveBeenCalledTimes(3);expect((await x.jobs.list(x.a)).jobs[0]).toMatchObject({status:'failed',failedChapterIDs:[chapters[0].id]});now+=101;expect((await x.jobs.list(x.a)).jobs).toEqual([]);
 });
});
describe('authenticated server preparation routes',()=>{
 it('keeps account auth independent of the legacy source token and hides other owners jobs',async()=>{
  const root=await mkdtemp(join(tmpdir(),'qingread-offline-route-')),cloud=new CloudDatabase(join(root,'accounts.sqlite')),jobs=new OfflineJobs(cloud,root,{autoStart:false,intervalMs:0,reserveDisk:0,load:async(_book,chapter)=>value(chapter)}),app=await createApp({cloud,offlineJobs:jobs,token:'legacy-token',serveWeb:false});cleanup.push(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  const a=await cloud.authenticate({username:'offline_reader',password:'long-test-password'},true),b=await cloud.authenticate({username:'other_reader',password:'long-test-password'},true);cloud.sync(a.user,{anchorFormat:'body-utf16-v1',cursor:0,mutations:[{id:randomUUID(),action:'add',bookID:book.id,baseRevision:0,changedAt:new Date().toISOString(),entry:{book,addedAt:new Date().toISOString()}}]});
  expect((await app.inject({method:'POST',url:'/api/offline/jobs',payload:{bookID:book.id,chapters}})).statusCode).toBe(401);const created=await app.inject({method:'POST',url:'/api/offline/jobs',headers:{authorization:'Bearer '+a.token},payload:{bookID:book.id,chapters}});expect(created.statusCode).toBe(200);await jobs.runPending();const id=created.json().id;expect((await app.inject({url:'/api/offline/jobs/'+id+'/content',headers:{authorization:'Bearer '+b.token}})).statusCode).toBe(404);const own=await app.inject({url:'/api/offline/jobs/'+id+'/content',headers:{authorization:'Bearer '+a.token}});expect(own.statusCode).toBe(200);expect(own.headers['cache-control']).toContain('no-store');expect(own.body).toContain('"type":"complete"');
 });
});
