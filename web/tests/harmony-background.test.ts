// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost/"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { configureHarmonyBackground, harmonyDownloads, harmonyUpdates, type HarmonyTransfer } from '../src/lib/harmonyBackground';
import type { ServerDownloadJob } from '../src/lib/serverDownloads';
import type { ChapterContent } from '../src/shared/types';
const book={id:'book',title:'测试',author:'',summary:'',sourceID:'source',sourceName:'书源',url:'https://source.example/book'};
const job:ServerDownloadJob={id:'11111111-1111-4111-8111-111111111111',bookID:book.id,bookTitle:book.title,sourceID:book.sourceID,sourceURL:book.url,status:'completed',chapterIDs:['c0'],completedChapterIDs:['c0'],failedChapterIDs:[],total:1,completed:1,createdAt:'2026-10-24T00:00:00.000Z',updatedAt:'2026-10-24T00:00:00.000Z',book,engine:'server',bytes:100,expiresAt:'2026-10-31T00:00:00.000Z'};
const transfer:HarmonyTransfer={id:job.id,bookID:book.id,sourceID:book.sourceID,sourceURL:book.url,revision:job.updatedAt,status:'completed',receivedBytes:100};
const chapter:ChapterContent={chapter:{id:'c0',title:'第一章',url:book.url+'/0',index:0},paragraphs:['中文正文。']};
const profile='qingread-cloud-https://reader.example/api|22222222-2222-4222-8222-222222222222';
let calls:{method:string;params:Record<string,unknown>}[];
let respond:(method:string,params:Record<string,unknown>)=>unknown;
const digest=(value:Uint8Array)=>Array.from(sha256(value),byte=>byte.toString(16).padStart(2,'0')).join('');
const ndjson=(candidate=job,contents=[chapter])=>JSON.stringify({type:'manifest',job:candidate})+'\n'+contents.map(content=>JSON.stringify({type:'chapter',content})+'\n').join('')+JSON.stringify({type:'complete',chapters:contents.length})+'\n';
function fileResponse(text:string,options:{wrongHash?:boolean;wrongOffset?:boolean}={}){
  const bytes=new TextEncoder().encode(text),hash=options.wrongHash?'0'.repeat(64):digest(bytes);
  return (_method:string,params:Record<string,unknown>)=>{const offset=Number(params.offset),limit=Number(params.limit),chunk=bytes.slice(offset,offset+limit);return{base64:Buffer.from(chunk).toString('base64'),nextOffset:offset+chunk.length+(options.wrongOffset?1:0),done:offset+chunk.length===bytes.length,totalBytes:bytes.length,sha256:hash};};
}
beforeEach(()=>{
  calls=[];respond=()=>({});
  Object.defineProperty(window,'__QINGREAD_HARMONY__',{configurable:true,value:{bridgeVersion:2,version:'1.0.0',build:'1',capabilities:['backgroundDownloads','updateNotifications']}});
  Object.defineProperty(window,'QingReadNative',{configurable:true,value:{request:vi.fn(async(raw:string)=>{const request=JSON.parse(raw);calls.push(request);return JSON.stringify({id:request.id,ok:true,result:await respond(request.method,request.params)});})}});
});
afterEach(()=>{vi.useRealTimers();delete(window as unknown as Record<string,unknown>).__QINGREAD_HARMONY__;delete(window as unknown as Record<string,unknown>).QingReadNative;});
describe('Harmony prepared downloads',()=>{
  it('retries rejected configuration and sends logout before an older configuration finishes',async()=>{
    let finish!:(value:unknown)=>void;const pending=new Promise(resolve=>finish=resolve);let rejected=false;
    respond=(method,params)=>{if(method!=='background.configure'||params.profile===null)return{};if(!rejected){rejected=true;throw new Error('系统正在更新下载状态');}return pending;};
    const changed={profile:profile+'-changed',apiBase:'https://reader.example/api',authToken:'b'.repeat(43)};
    await expect(configureHarmonyBackground(changed)).rejects.toThrow('系统正在更新下载状态');const switching=configureHarmonyBackground(changed),logout=configureHarmonyBackground({profile:null});
    await logout;expect(calls.filter(value=>value.method==='background.configure')).toHaveLength(3);finish({});await switching;await configureHarmonyBackground({profile:null});
    expect(calls.filter(value=>value.method==='background.configure').map(value=>value.params.profile)).toEqual([changed.profile,changed.profile,null]);
  });
  it('sends only configured identity and a fixed job descriptor, never arbitrary URLs or headers',async()=>{
    await configureHarmonyBackground({profile,apiBase:'https://reader.example/api',authToken:'a'.repeat(43)});await harmonyDownloads.enqueue(profile,job);
    const request=calls.find(call=>call.method==='downloads.enqueue')!;expect(Object.keys(request.params).sort()).toEqual(['bookID','bytes','id','profile','revision','sourceID','sourceURL']);expect(request.params).not.toHaveProperty('headers');expect(request.params).not.toHaveProperty('saveas');expect(request.params).not.toHaveProperty('url');
  });
  it('validates a full native file before writing chapters, then imports with bounded memory',async()=>{
    respond=fileResponse(ndjson());const written:ChapterContent[]=[];
    await harmonyDownloads.save(profile,transfer,async content=>{expect(calls.filter(call=>call.method==='downloads.read').length).toBeGreaterThanOrEqual(2);written.push(content);},new AbortController().signal);
    expect(written).toEqual([chapter]);expect(calls.every(call=>call.method!=='downloads.acknowledge')).toBe(true);
  });
  it('rejects a bad digest, truncated offsets and foreign source before any cache callback',async()=>{
    for(const [text,options]of[[ndjson(),{wrongHash:true}],[ndjson(),{wrongOffset:true}],[ndjson({...job,sourceID:'other'}),{}]]as const){respond=fileResponse(text,options);const write=vi.fn();await expect(harmonyDownloads.save(profile,transfer,write,new AbortController().signal)).rejects.toThrow();expect(write).not.toHaveBeenCalled();}
  });
  it('does not import a different native file substituted between validation and cache writing',async()=>{
    const original=fileResponse(ndjson()),changed=fileResponse(ndjson(job,[{...chapter,paragraphs:['被替换正文']}])) ;let pass=0;
    respond=(method,params)=>{if(Number(params.offset)===0)pass++;return(pass===1?original:changed)(method,params);};
    const write=vi.fn();await expect(harmonyDownloads.save(profile,transfer,write,new AbortController().signal)).rejects.toThrow('文件已变更');expect(write).not.toHaveBeenCalled();
  });
  it('propagates account-switch cancellation and never acknowledges incomplete local writes',async()=>{
    respond=fileResponse(ndjson());const controller=new AbortController(),write=vi.fn(async()=>{controller.abort();});
    await expect(harmonyDownloads.save(profile,transfer,write,controller.signal)).rejects.toMatchObject({name:'AbortError'});expect(calls.some(call=>call.method==='downloads.acknowledge')).toBe(false);
  });
  it('paces both passes of a large valid NDJSON file across the native rolling limit',async()=>{
    vi.useFakeTimers();const contents:ChapterContent[]=Array.from({length:420},(_,index)=>({chapter:{id:'c'+index,title:'第'+index+'章',url:book.url+'/'+index,index},paragraphs:['a'.repeat(16384)]}));
    const candidate={...job,total:contents.length,completed:contents.length,chapterIDs:contents.map(value=>value.chapter.id),completedChapterIDs:contents.map(value=>value.chapter.id)};
    const reader=fileResponse(ndjson(candidate,contents)),times:number[]=[];let maximum=0,count=0;
    respond=(method,params)=>{const now=Date.now();while(times.length&&times[0]<=now-10000)times.shift();times.push(now);maximum=Math.max(maximum,times.length);if(times.length>512)throw new Error('native request budget exceeded');return reader(method,params);};
    const started=Date.now(),operation=harmonyDownloads.save(profile,transfer,async()=>{count++;},new AbortController().signal);
    await vi.runAllTimersAsync();await operation;expect(count).toBe(420);expect(maximum).toBeLessThanOrEqual(256);expect(Date.now()-started).toBeGreaterThanOrEqual(10000);
  });
});
describe('Harmony update watches',()=>{
  it('waits for a 20-second permission decision while ordinary requests retain their 15-second timeout',async()=>{
    vi.useFakeTimers();let decide!:(value:unknown)=>void,settled=false;const decision=new Promise(resolve=>decide=resolve);
    respond=(method)=>method==='updates.requestPermission'?decision:new Promise(()=>{});
    const permission=harmonyUpdates.requestPermission().finally(()=>{settled=true;});const ordinary=expect(harmonyUpdates.snapshot(profile)).rejects.toThrow('系统操作超时');
    await vi.advanceTimersByTimeAsync(20_000);await ordinary;expect(settled).toBe(false);decide({notifications:'granted'});await expect(permission).resolves.toEqual({notifications:'granted'});
    respond=()=>({notifications:'denied'});await expect(harmonyUpdates.requestPermission()).resolves.toEqual({notifications:'denied'});
  });
  it('keeps watch snapshots small and sends no cloud password or full unread history',async()=>{
    await harmonyUpdates.watch(profile,true,[{book,baseline:{knownChapterCount:5,lastKnownChapterID:'tail',lastKnownChapterTitle:'末章',checkedAt:job.updatedAt,unreadChapterIDs:Array.from({length:500},(_,index)=>'c'+index)}}]);
    const request=calls.at(-1)!;expect(request.method).toBe('updates.watch');expect(JSON.stringify(request.params)).not.toContain('unreadChapterIDs');expect(JSON.stringify(request.params)).not.toContain('summary');
  });
  it('requests notification permission only when the explicit request method is called',async()=>{
    respond=()=>({enabled:false,notifications:'prompt',updates:{}});await harmonyUpdates.snapshot(profile);expect(calls.some(call=>call.method==='updates.requestPermission')).toBe(false);await harmonyUpdates.requestPermission();expect(calls.at(-1)?.method).toBe('updates.requestPermission');
  });
});
