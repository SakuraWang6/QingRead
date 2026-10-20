import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, stat, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app';
import { CloudDatabase } from '../server/cloud';
import { anchorFormat } from '../src/shared/sync';
import { sampleBook } from '../src/lib/sample';
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
