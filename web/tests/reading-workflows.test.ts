import 'fake-indexeddb/auto';
import { IDBObjectStore as FakeObjectStore } from 'fake-indexeddb';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { BrowserLibrary } from '../src/lib/store';
import { api } from '../src/lib/api';
import { appendedChapters, chapterNumber, matchChapter, sameEditionTitle } from '../src/lib/readingWorkflows';
import type { Book, Chapter, ChapterContent, SourceDefinition } from '../src/shared/types';
import { anchorFormat } from '../src/shared/sync';
const book:Book={id:'source-a|https://a.test/book',title:'我的书',author:'作者',summary:'',sourceID:'source-a',sourceName:'甲',url:'https://a.test/book'};
const candidate:Book={...book,id:'source-b|https://b.test/book',sourceID:'source-b',sourceName:'乙',url:'https://b.test/book'};
const chapters=(prefix:string,count:number):Chapter[]=>Array.from({length:count},(_,index)=>({id:prefix+index,title:`第${index+1}章 故事${index+1}`,url:`https://${prefix}.test/${index}`,index}));
const content=(chapter:Chapter,length=100):ChapterContent=>({chapter,paragraphs:['字'.repeat(length)]});
const fresh=()=>new BrowserLibrary('workflows-'+crypto.randomUUID(),true);
async function seed(count=3){const store=fresh();await store.add(book);const items=chapters('a',count);await store.cacheChapters(book,items);return{store,items};}
afterEach(()=>vi.restoreAllMocks());
describe('conservative reading workflow matching',()=>{
  it('matches exact titles, unique titles without chapter numbers, then unique Chinese chapter numbers',()=>{
    expect(chapterNumber('第一千零二章 开始')).toBe(1002);expect(chapterNumber('第１２章开始')).toBe(12);
    expect(matchChapter({...chapters('a',1)[0],title:'第1章　启程'},[{...chapters('b',1)[0],title:'第９章 启程'}]).match).toBe('title');
    expect(matchChapter({...chapters('a',1)[0],title:'第十二章 旧名'},[{...chapters('b',1)[0],title:'第12章 新名'}]).match).toBe('number');
    expect(matchChapter({...chapters('a',1)[0],title:'第十二章 旧名'},[{...chapters('b',1)[0],title:'第12章 新名'},{...chapters('c',1)[0],title:'第十二章 另一卷'}]).match).toBe('manual');
    expect(sameEditionTitle(book,{...candidate,title:'别的书'})).toBe(false);expect(sameEditionTitle(book,{...candidate,author:'其他作者'})).toBe(false);
    expect(sameEditionTitle(book,{...candidate,publicationFormat:'epub'})).toBe(false);
    expect(appendedChapters({lastKnownChapterID:'lost',lastKnownChapterTitle:'消失的目录'},chapters('b',10))).toEqual([]);
  });
});
describe('library update tracking',()=>{
  it('uses an existing directory baseline, preserves old content/progress and rate limits checks',async()=>{
    const{store,items}=await seed();await store.cacheContent(book,content(items[1]));await store.savePosition(book,items[1],.5,49);
    const spy=vi.spyOn(api,'chapters').mockResolvedValue(chapters('a',5));
    await store.checkForUpdates();expect(store.getSnapshot().updates[book.id].unreadChapterIDs).toEqual(['a3','a4']);
    expect((await store.getChapters(book))?.length).toBe(5);expect((await store.getContent(book,items[1]))?.paragraphs).toHaveLength(1);expect(store.getSnapshot().shelf[0].position?.characterOffset).toBe(49);
    await store.checkForUpdates(book,{force:true});expect(spy).toHaveBeenCalledTimes(1);
    await store.savePosition(book,chapters('a',5)[3],.2,20);expect(store.getSnapshot().updates[book.id].unreadChapterIDs).toEqual(['a4']);
  });
  it('rate limits failed attempts across reopening without erasing the cached directory',async()=>{
    const name='updates-'+crypto.randomUUID(),store=new BrowserLibrary(name,true),items=chapters('a',3);await store.add(book);await store.cacheChapters(book,items);const spy=vi.spyOn(api,'chapters').mockRejectedValue(new Error('暂时不可达'));await store.checkForUpdates();expect(await store.getChapters(book)).toEqual(items);const reopened=new BrowserLibrary(name,true);await reopened.initialized;await reopened.checkForUpdates(book,{force:true});expect(spy).toHaveBeenCalledTimes(1);expect(reopened.getSnapshot().updates[book.id].checkedAt).toBeTruthy();
  });
  it('does not report an entire uncached book as new, nor reordered unmatched catalogs',async()=>{
    const store=fresh();await store.add(book);vi.spyOn(api,'chapters').mockResolvedValue(chapters('a',5));await store.checkForUpdates();expect(store.getSnapshot().updates[book.id].unreadChapterIDs).toEqual([]);
    const other=await seed();vi.mocked(api.chapters).mockResolvedValue(chapters('b',10).map(item=>({...item,title:'全新'+item.index})));await other.store.checkForUpdates();expect(other.store.getSnapshot().updates[book.id].unreadChapterIDs).toEqual([]);
  });
});
describe('transactional source switching',()=>{
  it('retains logical identity, replaces old cache and maps progress by fraction; old reader cannot corrupt new source',async()=>{
    const{store,items}=await seed();await store.cacheContent(book,content(items[1],100));await store.savePosition(book,items[1],.5,49);
    const next=chapters('b',4);vi.spyOn(api,'chapters').mockResolvedValue(next);vi.spyOn(api,'content').mockResolvedValue(content(next[1],400));
    const plan=await store.prepareSourceSwitch(book,candidate);expect(plan.matchedChapterID).toBe(next[1].id);const switched=await store.commitSourceSwitch(plan);
    expect(switched.id).toBe(book.id);expect(switched.sourceID).toBe(candidate.sourceID);expect(store.getSnapshot().shelf[0].position?.characterOffset).toBe(199);expect(await store.getContent(switched,items[1])).toBeUndefined();expect(await store.hasContent(switched,next[1])).toBe(true);
    await store.savePosition(book,items[1],.9,90);await store.cacheChapters(book,items);expect(store.getSnapshot().shelf[0].position?.chapterID).toBe(next[1].id);expect((await store.getChapters(switched))?.[0].id).toBe(next[0].id);
    expect((await store.syncRequest()).mutations[0]).toMatchObject({action:'add',bookID:book.id,entry:{book:{sourceID:candidate.sourceID}}});await expect(store.commitSourceSwitch(plan)).rejects.toThrow('已变更');
  });
  it('publishes a new source only after commit when a cancelled download emits during the transaction',async()=>{
    const name='switch-publish-'+crypto.randomUUID(),store=new BrowserLibrary(name,true),items=chapters('a',3),next=chapters('b',3);await store.add(book);await store.cacheChapters(book,items);await store.savePosition(book,items[0],.5,49);
    const spy=vi.spyOn(api,'content').mockImplementation((value,chapter,signal)=>value.sourceID===candidate.sourceID?Promise.resolve(content(chapter,200)):new Promise((_resolve,reject)=>signal?.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true})));
    const job=await store.enqueueDownload(book,{kind:'all'});await vi.waitFor(()=>expect(spy).toHaveBeenCalled());vi.spyOn(api,'chapters').mockResolvedValue(next);const plan=await store.prepareSourceSwitch(book,candidate),controller=new AbortController();
    // App remounts the reader when its source changes and the old picker aborts on unmount.
    const detach=store.subscribe(()=>{if(store.getSnapshot().shelf[0]?.book.sourceID===candidate.sourceID)controller.abort();});
    const replacement=await store.commitSourceSwitch(plan,undefined,controller.signal);detach();expect(replacement.sourceID).toBe(candidate.sourceID);expect(controller.signal.aborted).toBe(true);expect(store.getSnapshot().downloads.find(value=>value.id===job.id)?.status).toBe('cancelled');
    await new Promise(resolve=>setTimeout(resolve,10));const reopened=new BrowserLibrary(name,true);await reopened.initialized;expect(reopened.getSnapshot().shelf[0].book.sourceID).toBe(candidate.sourceID);expect(reopened.getSnapshot().shelf[0].position?.chapterID).toBe(next[0].id);expect(await reopened.hasContent(replacement,next[0])).toBe(true);expect(await reopened.getContent(replacement,items[0])).toBeUndefined();
  });
  it('keeps the old shelf, directory and position when new content fails',async()=>{
    const{store,items}=await seed();await store.savePosition(book,items[0],.4,40);const before=structuredClone(store.getSnapshot().shelf);
    vi.spyOn(api,'chapters').mockResolvedValue(chapters('b',3));vi.spyOn(api,'content').mockRejectedValue(new Error('网络断开'));const plan=await store.prepareSourceSwitch(book,candidate);await expect(store.commitSourceSwitch(plan)).rejects.toThrow('网络断开');expect(store.getSnapshot().shelf).toEqual(before);expect(await store.getChapters(book)).toEqual(items);
  });
  it('cancels slow replacement content without changing the old shelf or cache',async()=>{
    const{store,items}=await seed();await store.cacheContent(book,content(items[0]));await store.savePosition(book,items[0],.4,40);const before=structuredClone(store.getSnapshot().shelf),controller=new AbortController();
    vi.spyOn(api,'chapters').mockResolvedValue(chapters('b',3));let finish!:(value:ChapterContent)=>void;const spy=vi.spyOn(api,'content').mockReturnValue(new Promise(resolve=>finish=resolve));const plan=await store.prepareSourceSwitch(book,candidate);const pending=store.commitSourceSwitch(plan,undefined,controller.signal);await vi.waitFor(()=>expect(spy).toHaveBeenCalled());expect(spy.mock.calls[0][2]).toBe(controller.signal);controller.abort();finish(content(chapters('b',3)[0]));await expect(pending).rejects.toMatchObject({name:'AbortError'});expect(store.getSnapshot().shelf).toEqual(before);expect(await store.getChapters(book)).toEqual(items);expect(await store.hasContent(book,items[0])).toBe(true);await expect(store.commitSourceSwitch(plan)).rejects.toThrow('已变更');
  });
  it('rolls back both cache and shelf when storing the replacement fails',async()=>{
    const{store,items}=await seed();await store.cacheContent(book,content(items[0]));await store.savePosition(book,items[0],.5,49);const before=structuredClone(store.getSnapshot().shelf);
    const next=chapters('b',3);vi.spyOn(api,'chapters').mockResolvedValue(next);vi.spyOn(api,'content').mockResolvedValue(content(next[0]));const plan=await store.prepareSourceSwitch(book,candidate);
    const original=FakeObjectStore.prototype.put;
    const spy=vi.spyOn(FakeObjectStore.prototype,'put').mockImplementation(function(this:InstanceType<typeof FakeObjectStore>,value,key){if(this.name==='contents'&&(value as ChapterContent)?.chapter?.id==='b0')throw new DOMException('quota','QuotaExceededError');return original.call(this,value,key);});
    await expect(store.commitSourceSwitch(plan)).rejects.toThrow('quota');spy.mockRestore();expect(store.getSnapshot().shelf).toEqual(before);expect(await store.getChapters(book)).toEqual(items);expect(await store.hasContent(book,items[0])).toBe(true);
  });
  it('rejects ambiguous matching, foreign-library plans and inactive-account plans',async()=>{
    const{store,items}=await seed();await store.savePosition(book,items[0],.4,40);vi.spyOn(api,'chapters').mockResolvedValue(chapters('b',2).map(item=>({...item,title:'未知'})));const plan=await store.prepareSourceSwitch(book,candidate);expect(plan.match).toBe('manual');await expect(store.commitSourceSwitch(plan)).rejects.toThrow('请选择');const other=await seed();await expect(other.store.commitSourceSwitch(plan)).rejects.toThrow('账号已变更');await store.setProfileActive(false);await expect(store.commitSourceSwitch(plan)).rejects.toThrow('账号已变更');
  });
  it('invalidates old cached chapters and late content when cloud sync changes the source under the same logical ID',async()=>{
    const{store,items}=await seed();await store.cacheContent(book,content(items[0]));const sent=(await store.syncRequest()).mutations[0];
    let finish!:(value:ChapterContent)=>void;vi.spyOn(api,'content').mockReturnValue(new Promise(resolve=>finish=resolve));const late=store.loadContent(book,items[1]);await vi.waitFor(()=>expect(api.content).toHaveBeenCalled());
    await store.acceptSync({anchorFormat,cursor:1,acknowledged:[sent.id],rejected:[],hasMore:false,serverTime:new Date().toISOString(),records:[{bookID:book.id,revision:1,changedAt:new Date().toISOString(),entry:{book:{...candidate,id:book.id},addedAt:new Date().toISOString()}}]});finish(content(items[1]));await expect(late).rejects.toMatchObject({name:'AbortError'});expect(await store.getChapters(book)).toBeUndefined();expect(await store.hasContent(book,items[0])).toBe(false);expect(await store.hasContent(book,items[1])).toBe(false);
  });
});
describe('persistent local download queue',()=>{
  it('downloads serially, skips cached content and retries only a bounded number of times',async()=>{
    const{store,items}=await seed();await store.cacheContent(book,content(items[0]));let active=0,max=0;
    const spy=vi.spyOn(api,'content').mockImplementation(async(_book,chapter)=>{active++;max=Math.max(max,active);await new Promise(resolve=>setTimeout(resolve,1));active--;if(chapter.id===items[2].id)throw new Error('源不可用');return content(chapter);});
    const job=await store.enqueueDownload(book,{kind:'all'});await vi.waitFor(()=>expect(store.getSnapshot().downloads[0].status).toBe('failed'),{timeout:3000});expect(max).toBe(1);expect(spy.mock.calls.filter(call=>call[1].id===items[0].id)).toHaveLength(0);expect(spy.mock.calls.filter(call=>call[1].id===items[2].id)).toHaveLength(3);expect(store.getSnapshot().downloads[0].completed).toBe(2);
    spy.mockImplementation(async(_book,chapter)=>content(chapter));await store.retryDownload(job.id);await vi.waitFor(()=>expect(store.getSnapshot().downloads[0].status).toBe('completed'));expect(await store.hasContent(book,items[2])).toBe(true);
  });
  it('coalesces concurrent identical active downloads and bounds completed history without keeping large ID arrays',async()=>{
    const{store,items}=await seed(1);let finish!:(value:ChapterContent)=>void;const spy=vi.spyOn(api,'content').mockReturnValue(new Promise(resolve=>finish=resolve));
    const[first,second]=await Promise.all([store.enqueueDownload(book,{kind:'all'}),store.enqueueDownload(book,{kind:'all'})]);expect(first.id).toBe(second.id);expect(store.getSnapshot().downloads).toHaveLength(1);await vi.waitFor(()=>expect(spy).toHaveBeenCalledTimes(1));finish(content(items[0]));await vi.waitFor(()=>expect(store.getSnapshot().downloads[0].status).toBe('completed'));
    for(let i=0;i<25;i++)await store.enqueueDownload(book,{kind:'all'});
    expect(store.getSnapshot().downloads).toHaveLength(20);expect(store.getSnapshot().downloads.every(job=>job.total===1&&job.completed===1&&job.chapterIDs.length===0&&job.completedChapterIDs.length===0)).toBe(true);
  });
  it('persists running tasks as paused on reopening and keeps accounts isolated',async()=>{
    const name='queue-'+crypto.randomUUID(),store=new BrowserLibrary(name,true);await store.add(book);await store.cacheChapters(book,chapters('a',3));
    let finish!:(value:ChapterContent)=>void;vi.spyOn(api,'content').mockReturnValue(new Promise(resolve=>finish=resolve));await store.enqueueDownload(book,{kind:'range',from:0,to:1});await vi.waitFor(()=>expect(api.content).toHaveBeenCalled());
    const reopened=new BrowserLibrary(name,true);await reopened.initialized;expect(reopened.getSnapshot().downloads[0].status).toBe('paused');const other=fresh();await other.initialized;expect(other.getSnapshot().downloads).toEqual([]);
    await store.setProfileActive(false);finish(content(chapters('a',3)[0]));await vi.waitFor(()=>expect(store.getSnapshot().downloads[0].status).toBe('paused'));expect(await store.hasContent(book,chapters('a',3)[0])).toBe(false);
  });
  it('pauses a pending network request immediately and can resume without waiting for it to finish',async()=>{
    const{store,items}=await seed(1);let aborted=0;
    const spy=vi.spyOn(api,'content').mockImplementation((_book,chapter,signal)=>new Promise((resolve,reject)=>{if(spy.mock.calls.length>1){resolve(content(chapter));return;}signal?.addEventListener('abort',()=>{aborted++;reject(new DOMException('cancelled','AbortError'));},{once:true});}));
    const job=await store.enqueueDownload(book,{kind:'all'});await vi.waitFor(()=>expect(spy).toHaveBeenCalledTimes(1));await store.pauseDownload(job.id);await vi.waitFor(()=>expect(aborted).toBe(1));expect(store.getSnapshot().downloads[0].status).toBe('paused');await store.resumeDownload(job.id);await vi.waitFor(()=>expect(store.getSnapshot().downloads[0].status).toBe('completed'));expect(await store.hasContent(book,items[0])).toBe(true);
  });
  it('does not continue a queued book after removal or cache clearing',async()=>{
    const{store,items}=await seed();let finish!:(value:ChapterContent)=>void;const spy=vi.spyOn(api,'content').mockReturnValue(new Promise(resolve=>finish=resolve));await store.enqueueDownload(book,{kind:'all'});await vi.waitFor(()=>expect(spy).toHaveBeenCalled());await store.clearCache();finish(content(items[0]));await new Promise(resolve=>setTimeout(resolve,10));expect(spy).toHaveBeenCalledTimes(1);expect(await store.hasContent(book,items[0])).toBe(false);await store.remove(book);expect(store.getSnapshot().downloads[0].status).toBe('cancelled');
  });
  it('reports a connection error when every enabled source fails instead of pretending no editions exist',async()=>{
    const{store}=await seed();await store.initializeSources([{id:candidate.sourceID,name:'乙',summary:'',homeURL:'https://b.test',kind:'html'}]);vi.spyOn(api,'search').mockResolvedValue({books:[],failures:[{sourceID:candidate.sourceID,sourceName:'乙',message:'timeout'}]});await expect(store.findSourceCandidates(book)).rejects.toThrow('书源暂时无法连接');
  });
  it('restores metadata only inside its own database',async()=>{
    const{store}=await seed();expect(store.getSnapshot().downloads).toEqual([]);
    const sources:SourceDefinition[]=[{id:candidate.sourceID,name:'乙',summary:'',homeURL:'https://b.test',kind:'html'}];await store.initializeSources(sources);await store.toggleSource(candidate.sourceID);vi.spyOn(api,'search').mockResolvedValue({books:[candidate],failures:[]});expect(await store.findSourceCandidates(book)).toEqual([]);expect(api.search).not.toHaveBeenCalled();
  });
});
