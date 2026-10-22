import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, stat, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app';
import { CloudDatabase } from '../server/cloud';
import { anchorFormat } from '../src/shared/sync';
import { sampleBook } from '../src/lib/sample';
import type { ShelfEntry } from '../src/shared/types';
import { fileURLToPath } from 'node:url';

const apps:Awaited<ReturnType<typeof createApp>>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));});
const entry=()=>({book:sampleBook,addedAt:new Date().toISOString()});
const mutation=(id:string,action='add',extra:Record<string,unknown>={})=>({id,action,bookID:sampleBook.id,baseRevision:0,changedAt:new Date().toISOString(),...(action==='remove'?{}:{entry:entry()}),...extra});
async function setup(){const app=await createApp({serveWeb:false,cloud:new CloudDatabase(':memory:')});apps.push(app);return app;}
async function register(app:Awaited<ReturnType<typeof setup>>,username:string){const r=await app.inject({method:'POST',url:'/api/auth/register',payload:{username,password:'test-password-long-enough'}});expect(r.statusCode).toBe(200);return r.json();}
async function sync(app:Awaited<ReturnType<typeof setup>>,token:string,mutations:unknown[]=[],cursor=0){return app.inject({method:'POST',url:'/api/sync',headers:{Authorization:'Bearer '+token},payload:{anchorFormat,cursor,mutations}});}

describe('account cloud synchronization',()=>{
  it('accepts the same contract fixture as the native iOS reader',async()=>{
    const fixture=JSON.parse(await readFile(fileURLToPath(new URL('../../Tests/ReadingCoreTests/Fixtures/cloud-snapshot.json',import.meta.url)),'utf8'));
    const app=await setup(),a=await register(app,'contract_reader'),value=fixture.records[0].entry;
    const response=(await sync(app,a.token,[{id:'fixture-op-0001',action:'add',bookID:value.book.id,entry:value,baseRevision:0,changedAt:fixture.serverTime}])).json();
    expect(response.records[0].entry.position.characterOffset).toBe('𠀀🙂中é'.length);
    expect(response.records[0].entry.book.fileHash).toBe(value.book.fileHash);
  });
  it('isolates users, rejects impersonation and requires real account sessions',async()=>{
    const app=await setup(),a=await register(app,'reader_a'),b=await register(app,'reader_b');
    expect((await sync(app,a.token,[mutation('first-add-0001')])).statusCode).toBe(200);
    expect((await sync(app,b.token)).json().records).toEqual([]);
    expect((await app.inject({method:'POST',url:'/api/sync',payload:{anchorFormat,cursor:0,mutations:[]}})).statusCode).toBe(401);
    expect((await sync(app,b.token,[{...mutation('bad-user-0001'),userID:a.user.id}])).statusCode).toBe(400);
    expect((await sync(app,'x'.repeat(43))).statusCode).toBe(401);
  });
  it('keeps latest intent including rewinds and ignores duplicate operations',async()=>{
    const app=await setup(),a=await register(app,'latest_reader');
    const base=Date.now()-30000;
    const withPosition=(fraction:number,time:number)=>({...entry(),position:{chapterID:'chapter',chapterIndex:0,chapterFraction:fraction,characterOffset:Math.round(fraction*100),updatedAt:new Date(time).toISOString()}});
    const first=(await sync(app,a.token,[mutation('progress-add-001','add',{entry:withPosition(.8,base)})])).json();
    const second=(await sync(app,a.token,[mutation('progress-new-002','progress',{baseRevision:1,entry:withPosition(.2,base+10000)})],first.cursor)).json();
    expect(second.records[0].entry.position.chapterFraction).toBe(.2);
    const older=(await sync(app,a.token,[mutation('progress-old-003','progress',{entry:withPosition(.9,base+5000)})],second.cursor)).json();
    expect(older.records[0].entry.position.chapterFraction).toBe(.2);
    const replay=(await sync(app,a.token,[mutation('progress-add-001','add',{entry:withPosition(1,base+20000)})])).json();
    expect(replay.records[0].entry.position.chapterFraction).toBe(.2);
    expect(replay.cursor).toBe(second.cursor);
  });
  it('accepts same-source progress without replacing cloud book metadata or file identity',async()=>{
    const app=await setup(),a=await register(app,'progress_metadata_reader'),base=Date.now()-60000;
    const original:ShelfEntry={...entry(),book:{...sampleBook,title:'云端书名',publicationFormat:'txt',fileHash:'a'.repeat(64)},position:{chapterID:'same-chapter',chapterIndex:2,characterOffset:20,chapterFraction:.2,updatedAt:new Date(base).toISOString()}};
    const first=(await sync(app,a.token,[mutation('metadata-add-001','add',{entry:original})])).json();
    const incoming={...original,book:{...sampleBook,title:'旧设备书名',fileHash:'b'.repeat(64)},position:{...original.position!,characterOffset:70,chapterFraction:.7,updatedAt:new Date(base+10000).toISOString()}};
    const next=(await sync(app,a.token,[mutation('metadata-progress-002','progress',{baseRevision:first.cursor,entry:incoming})],first.cursor)).json();
    expect(next.records[0].entry.book).toEqual(original.book);
    expect(next.records[0].entry.position.characterOffset).toBe(70);
    expect(next.records[0].entry.addedAt).toBe(original.addedAt);
  });
  it('replaces source-specific fields and anchors while retaining logical identity and shelf date',async()=>{
    const app=await setup(),a=await register(app,'switch_anchor_reader'),base=Date.now()-60000;
    const original:ShelfEntry={...entry(),addedAt:new Date(base).toISOString(),book:{...sampleBook,publicationFormat:'txt',fileHash:'a'.repeat(64),fileDownloadURL:'https://old.example/book.txt'},position:{chapterID:'old-chapter',chapterIndex:7,characterOffset:900,chapterFraction:.9,updatedAt:new Date(base+20000).toISOString()}};
    const first=(await sync(app,a.token,[mutation('switch-add-001','add',{entry:original})])).json();
    const switched:ShelfEntry={book:{...sampleBook,sourceID:'new-source',sourceName:'新来源',url:'https://new.example/book/'},addedAt:new Date(base+30000).toISOString(),position:{chapterID:'new-chapter',chapterIndex:6,characterOffset:400,chapterFraction:.4,updatedAt:new Date(base+10000).toISOString()}};
    const next=(await sync(app,a.token,[mutation('switch-source-002','add',{baseRevision:first.cursor,changedAt:new Date(base+30000).toISOString(),entry:switched})],first.cursor)).json();
    expect(next.rejected).toEqual([]);
    expect(next.records[0].entry.book).toEqual(switched.book);
    expect(next.records[0].entry.position).toEqual(switched.position);
    expect(next.records[0].entry.addedAt).toBe(original.addedAt);
    const replay=(await sync(app,a.token,[mutation('switch-source-002','add',{baseRevision:first.cursor,entry:original})],next.cursor)).json();
    expect(replay.cursor).toBe(next.cursor);
    expect(replay.records[0].entry.book).toEqual(switched.book);
  });
  it('rejects an old-source progress upload and returns the authoritative switch for reconciliation',async()=>{
    const app=await setup(),a=await register(app,'stale_progress_reader'),base=Date.now()-60000;
    const original:ShelfEntry={...entry(),position:{chapterID:'old-chapter',chapterIndex:2,characterOffset:20,chapterFraction:.2,updatedAt:new Date(base).toISOString()}};
    const first=(await sync(app,a.token,[mutation('stale-source-add-001','add',{entry:original})])).json();
    const switched:ShelfEntry={...original,book:{...sampleBook,sourceID:'new-source',url:'https://new.example/book/'},position:{...original.position!,chapterID:'new-chapter',characterOffset:40,chapterFraction:.4,updatedAt:new Date(base+10000).toISOString()}};
    const next=(await sync(app,a.token,[mutation('stale-source-switch-002','add',{baseRevision:first.cursor,entry:switched})],first.cursor)).json();
    const stale={...original,position:{...original.position!,characterOffset:90,chapterFraction:.9,updatedAt:new Date(base+20000).toISOString()}};
    const response=(await sync(app,a.token,[mutation('stale-source-progress-003','progress',{baseRevision:first.cursor,entry:stale})],next.cursor)).json();
    expect(response.acknowledged).toContain('stale-source-progress-003');
    expect(response.rejected).toEqual([{id:'stale-source-progress-003',reason:'source-changed'}]);
    expect(response.cursor).toBe(next.cursor);
    expect(response.records[0].entry).toEqual(switched);
  });
  it('requires the current revision for a competing source switch, including a forged future revision',async()=>{
    const app=await setup(),a=await register(app,'competing_switch_reader');
    const first=(await sync(app,a.token,[mutation('competing-add-001')])).json();
    const switched={...entry(),book:{...sampleBook,sourceID:'source-b',url:'https://b.example/book/'}};
    const next=(await sync(app,a.token,[mutation('competing-switch-002','add',{baseRevision:first.cursor,entry:switched})],first.cursor)).json();
    const other={...entry(),book:{...sampleBook,sourceID:'source-c',url:'https://c.example/book/'}};
    const stale=(await sync(app,a.token,[mutation('competing-stale-003','add',{baseRevision:first.cursor,entry:other})],next.cursor)).json();
    expect(stale.rejected[0].reason).toBe('source-changed');
    expect(stale.records[0].entry.book).toEqual(switched.book);
    const future=(await sync(app,a.token,[mutation('competing-future-004','add',{baseRevision:next.cursor+100,entry:other})],next.cursor)).json();
    expect(future.rejected[0].reason).toBe('source-changed');
    expect(future.cursor).toBe(next.cursor);
    const refreshed=(await sync(app,a.token,[mutation('competing-current-005','add',{baseRevision:next.cursor,entry:other})],next.cursor)).json();
    expect(refreshed.rejected).toEqual([]);
    expect(refreshed.records[0].entry.book).toEqual(other.book);
  });
  it('recognizes a changed book URL within one source and does not retain an unmapped old anchor',async()=>{
    const app=await setup(),a=await register(app,'switch_url_reader');
    const original={...entry(),position:{chapterID:'old-chapter',chapterIndex:8,characterOffset:80,chapterFraction:.8,updatedAt:new Date().toISOString()}};
    const first=(await sync(app,a.token,[mutation('url-add-001','add',{entry:original})])).json();
    const switched={...entry(),book:{...sampleBook,url:'https://same-source.example/new-book/'}};
    const next=(await sync(app,a.token,[mutation('url-switch-002','add',{baseRevision:first.cursor,entry:switched})],first.cursor)).json();
    expect(next.rejected).toEqual([]);
    expect(next.records[0].entry.book.url).toBe(switched.book.url);
    expect(next.records[0].entry.position).toBeUndefined();
  });
  it('preserves an existing file hash when a same-source add omits it',async()=>{
    const app=await setup(),a=await register(app,'same_source_add_reader');
    const original={...entry(),book:{...sampleBook,publicationFormat:'txt',fileHash:'a'.repeat(64)}};
    const first=(await sync(app,a.token,[mutation('same-add-001','add',{entry:original})])).json();
    const next=(await sync(app,a.token,[mutation('same-add-stale-002','add',{baseRevision:0,entry:{...entry(),book:{...sampleBook,title:'更新书名'}}})],first.cursor)).json();
    expect(next.rejected).toEqual([]);
    expect(next.records[0].entry.book.fileHash).toBe(original.book.fileHash);
    expect(next.records[0].entry.book.publicationFormat).toBe('txt');
    expect(next.records[0].entry.book.title).toBe('更新书名');
  });
  it('treats a source switch as a library change so an older offline removal cannot erase it',async()=>{
    const app=await setup(),a=await register(app,'switch_membership_reader'),base=Date.now()-60000;
    const first=(await sync(app,a.token,[mutation('membership-add-001','add',{changedAt:new Date(base).toISOString()})])).json();
    const switched={...entry(),book:{...sampleBook,sourceID:'new-source',url:'https://new.example/book/'}};
    const next=(await sync(app,a.token,[mutation('membership-switch-002','add',{baseRevision:first.cursor,changedAt:new Date(base+20000).toISOString(),entry:switched})],first.cursor)).json();
    const stale=(await sync(app,a.token,[mutation('membership-remove-003','remove',{baseRevision:first.cursor,changedAt:new Date(base+10000).toISOString()})],next.cursor)).json();
    expect(stale.rejected).toEqual([{id:'membership-remove-003',reason:'newer-library-change'}]);
    expect(stale.records[0].entry.book).toEqual(switched.book);
    expect(stale.cursor).toBe(next.cursor);
  });
  it('retains tombstones so stale offline devices cannot resurrect removed books',async()=>{
    const app=await setup(),a=await register(app,'offline_reader');
    await sync(app,a.token,[mutation('offline-add-001')]);
    const removed=(await sync(app,a.token,[mutation('offline-del-002','remove',{baseRevision:1})],1)).json();
    expect(removed.records[0].entry).toBeNull();
    const stale=(await sync(app,a.token,[mutation('offline-old-003')],removed.cursor)).json();
    expect(stale.rejected[0].reason).toBe('removed-elsewhere');
    expect(stale.records[0].entry).toBeNull();
    const readd=(await sync(app,a.token,[mutation('offline-new-004','add',{baseRevision:removed.cursor})],removed.cursor)).json();
    expect(readd.records[0].entry.book.id).toBe(sampleBook.id);
  });
  it('authenticates passwords, revokes sessions and never grants another account by username alone',async()=>{
    const app=await setup(),a=await register(app,'secure_reader');
    const bad=await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'secure_reader',password:'incorrect-password'}});expect(bad.statusCode).toBe(401);
    const again=await app.inject({method:'POST',url:'/api/auth/login',payload:{username:'SECURE_READER',password:'test-password-long-enough'}});expect(again.json().user.id).toBe(a.user.id);
    expect((await app.inject({method:'POST',url:'/api/auth/logout',headers:{Authorization:'Bearer '+a.token},payload:{}})).statusCode).toBe(200);
    expect((await sync(app,a.token)).statusCode).toBe(401);
    expect((await sync(app,again.json().token)).statusCode).toBe(200);
  });
  it('persists through restart with private permissions and no plaintext password or session token',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'qingread-cloud-')),path=join(dir,'accounts.sqlite');
    const db=new CloudDatabase(path),session=await db.authenticate({username:'persistent_reader',password:'private-passphrase-not-in-db'},true);
    db.sync(session.user,{anchorFormat,cursor:0,mutations:[mutation('persist-add-001')]});db.close();
    try{
      const bytes=await readFile(path);expect(bytes.includes(Buffer.from('private-passphrase-not-in-db'))).toBe(false);expect(bytes.includes(Buffer.from(session.token))).toBe(false);
      expect((await stat(path)).mode&0o777).toBe(0o600);
      const reopened=new CloudDatabase(path);try{expect(reopened.authorize('Bearer '+session.token).id).toBe(session.user.id);expect(reopened.sync(session.user,{anchorFormat,cursor:0,mutations:[]}).records).toHaveLength(1);}finally{reopened.close();}
    }finally{await rm(dir,{recursive:true,force:true});}
  });
  it('rejects oversized batches, bad anchors, malicious links and foreign browser origins',async()=>{
    const app=await setup(),a=await register(app,'schema_reader');
    expect((await sync(app,a.token,Array.from({length:51},(_,i)=>mutation('large-batch-'+i)))).statusCode).toBe(400);
    expect((await sync(app,a.token,[mutation('unsafe-url-001','add',{entry:{...entry(),book:{...sampleBook,url:'javascript:alert(1)'}}})])).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:'/api/sync',headers:{Authorization:'Bearer '+a.token,Origin:'https://evil.example'},payload:{anchorFormat,cursor:0,mutations:[]}})).statusCode).toBe(403);
  });
});

describe('cloud organization and annotation convergence',()=>{
  it('preserves notes and organization across old clients, source conflicts and note deletion',async()=>{
    const app=await setup(),a=await register(app,'annotation-reader'),now=Date.now()-10000;
    const note={id:'annotation-first',kind:'note',chapterID:'old-chapter',chapterIndex:0,chapterTitle:'第一章',characterOffset:5,characterLength:2,quote:'正文',note:'离线笔记',sourceID:sampleBook.sourceID,sourceURL:sampleBook.url,updatedAt:new Date(now).toISOString()};
    const original={...entry(),organization:{pinned:true,status:'later',group:'文学',updatedAt:new Date(now).toISOString()},annotations:[note]};
    const first=(await sync(app,a.token,[mutation('annotation-add-0001','add',{entry:original})])).json();
    const switched={...original,book:{...sampleBook,sourceID:'replacement',url:'https://replacement.example/book'},annotations:undefined};
    const second=(await sync(app,a.token,[mutation('annotation-source-02','add',{baseRevision:first.cursor,entry:switched})],first.cursor)).json();
    expect(second.records[0].entry.annotations).toHaveLength(1);
    const offlineNote={...note,id:'annotation-offline',note:'另一台设备离线新增',updatedAt:new Date(now+1000).toISOString()};
    const stale=(await sync(app,a.token,[mutation('annotation-stale-003','add',{baseRevision:first.cursor,entry:{...original,annotations:[note,offlineNote]}})],second.cursor)).json();
    expect(stale.rejected[0].reason).toBe('source-changed');expect(stale.records[0].entry.book.sourceID).toBe('replacement');expect(stale.records[0].entry.annotations).toHaveLength(2);
    const deleted={...offlineNote,updatedAt:new Date(now+2000).toISOString(),deletedAt:new Date(now+2000).toISOString()};
    const erased=(await sync(app,a.token,[mutation('annotation-delete-04','add',{baseRevision:stale.cursor,entry:{...switched,annotations:[deleted]}})],stale.cursor)).json();
    const old=(await sync(app,a.token,[mutation('annotation-old-0005','add',{baseRevision:erased.cursor,entry:{...switched,annotations:[offlineNote],organization:undefined}})],erased.cursor)).json();
    expect(old.records[0].entry.organization.group).toBe('文学');expect(old.records[0].entry.annotations.find((n:{id:string})=>n.id===offlineNote.id).deletedAt).toBeTruthy();
  });
});
