import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserLibrary } from '../src/lib/store';
import { api } from '../src/lib/api';
import { nativeBackground } from '../src/lib/androidBackground';
import { harmonyDownloads, type HarmonyTransfer } from '../src/lib/harmonyBackground';
import { serverDownloads, type ServerDownloadJob } from '../src/lib/serverDownloads';
import type { Book, BookUpdateState, Chapter, ChapterContent } from '../src/shared/types';

const platform=vi.hoisted(()=>({android:false,harmony:false}));
vi.mock('../src/lib/android',()=>({isAndroidApp:()=>platform.android}));
vi.mock('../src/lib/androidBackground',()=>({nativeBackground:{
  readCompleted:vi.fn(),acknowledge:vi.fn(),list:vi.fn(),updates:vi.fn(),
  clearCache:vi.fn(),removeBook:vi.fn(),pause:vi.fn(),resume:vi.fn(),cancel:vi.fn(),enqueue:vi.fn(),
}}));
vi.mock('../src/lib/harmonyBackground',()=>({supportsHarmonyDownloads:()=>platform.harmony,harmonyDownloads:{list:vi.fn(),enqueue:vi.fn(),action:vi.fn(),removeBook:vi.fn(),clearCache:vi.fn(),acknowledge:vi.fn(),save:vi.fn()}}));
const book:Book={id:'a|https://books.test/book',title:'测试书',author:'作者',summary:'',sourceID:'a',sourceName:'甲',url:'https://books.test/book'};
const chapters:Chapter[]=Array.from({length:3},(_,index)=>({id:'chapter-'+index,title:`第${index+1}章`,url:`https://books.test/chapter/${index}`,index}));
const contents:ChapterContent[]=chapters.map(chapter=>({chapter,paragraphs:['已经保存的正文']}));
const credentials={address:'https://reader.test/api',token:'a'.repeat(43)};
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return{promise,resolve};};
async function fresh(profile='background-'+crypto.randomUUID()){
  const store=new BrowserLibrary(profile,true);await store.add(book);await store.cacheChapters(book,chapters);return store;
}
function prepared(patch:Partial<ServerDownloadJob>={}):ServerDownloadJob{
  return{id:'server-job',book,bookID:book.id,bookTitle:book.title,sourceID:book.sourceID,sourceURL:book.url,engine:'server',status:'completed',chapterIDs:chapters.map(c=>c.id),completedChapterIDs:chapters.map(c=>c.id),failedChapterIDs:[],total:3,completed:3,createdAt:'2026-10-20T12:00:00Z',updatedAt:'2026-10-21T12:00:00Z',bytes:100,expiresAt:'2026-10-28T12:00:00Z',...patch};
}
function mockServer(job=prepared()){
  const list=vi.spyOn(serverDownloads,'list').mockImplementation(async()=>({jobs:[job],usedBytes:job.bytes,limitBytes:100*1024*1024}));
  const create=vi.spyOn(serverDownloads,'create').mockResolvedValue(job);
  const action=vi.spyOn(serverDownloads,'action').mockResolvedValue(job);
  const save=vi.spyOn(serverDownloads,'save').mockImplementation(async(_connection,_id,onChapter)=>{
    for(const value of contents)await onChapter(value);
    return{chapters:contents.length,job};
  });
  return{job,list,create,action,save};
}
beforeEach(()=>{
  platform.android=false;platform.harmony=false;
  vi.mocked(harmonyDownloads.list).mockResolvedValue([]);vi.mocked(harmonyDownloads.enqueue).mockResolvedValue();vi.mocked(harmonyDownloads.action).mockResolvedValue();vi.mocked(harmonyDownloads.removeBook).mockResolvedValue();vi.mocked(harmonyDownloads.clearCache).mockResolvedValue();vi.mocked(harmonyDownloads.acknowledge).mockResolvedValue();vi.mocked(harmonyDownloads.save).mockImplementation(async(_profile,_transfer,onChapter)=>{for(const value of contents)await onChapter(value);});
  vi.mocked(nativeBackground.readCompleted).mockResolvedValue({items:[]});
  vi.mocked(nativeBackground.list).mockResolvedValue({jobs:[]});
  vi.mocked(nativeBackground.updates).mockResolvedValue({updates:{}});
  vi.mocked(nativeBackground.acknowledge).mockResolvedValue();
  vi.mocked(nativeBackground.clearCache).mockResolvedValue();
  vi.mocked(nativeBackground.removeBook).mockResolvedValue();
});
afterEach(()=>{vi.restoreAllMocks();vi.clearAllMocks();});

describe('Android staging and tracking isolation',()=>{
  it('retains disabled-source staging until it has actually been saved after re-enabling',async()=>{
    platform.android=true;const store=await fresh();
    vi.mocked(nativeBackground.readCompleted).mockResolvedValue({items:[{id:'staged-1',book,content:contents[0]}]});
    await store.toggleSource(book.sourceID);await store.syncNativeBackground();
    expect(await store.hasContent(book,chapters[0])).toBe(false);
    expect(nativeBackground.acknowledge).not.toHaveBeenCalled();
    await store.toggleSource(book.sourceID);
    vi.mocked(nativeBackground.acknowledge).mockImplementation(async()=>{expect(await store.hasContent(book,chapters[0])).toBe(true);});
    await store.syncNativeBackground();
    expect(nativeBackground.acknowledge).toHaveBeenCalledExactlyOnceWith({profile:store.profile,ids:['staged-1']});
  });
  it('does not let an older native catalog replace a newer foreground baseline or unread badge',async()=>{
    platform.android=true;const store=await fresh();
    const newest={...chapters[2],id:'chapter-3',index:3,title:'第4章'};
    vi.spyOn(api,'chapters').mockResolvedValue([...chapters,newest]);await store.checkForUpdates();
    const baseline=structuredClone(store.getSnapshot().updates[book.id]);expect(baseline.unreadChapterIDs).toEqual([newest.id]);
    const stale:BookUpdateState={knownChapterCount:3,lastKnownChapterID:chapters[2].id,unreadChapterIDs:[],checkedAt:'2026-01-01T00:00:00Z'};
    vi.mocked(nativeBackground.updates).mockResolvedValue({updates:{[book.id]:stale}});await store.syncNativeBackground();
    expect(store.getSnapshot().updates[book.id]).toEqual(baseline);
    vi.mocked(nativeBackground.updates).mockResolvedValue({updates:{[book.id]:{...stale,checkedAt:undefined}}});await store.syncNativeBackground();
    expect(store.getSnapshot().updates[book.id]).toEqual(baseline);
  });
  it('does not write or acknowledge an old profile response after that profile is deactivated',async()=>{
    platform.android=true;const store=await fresh(),pending=deferred<Awaited<ReturnType<typeof nativeBackground.readCompleted>>>();
    vi.mocked(nativeBackground.readCompleted).mockReturnValue(pending.promise);const pump=store.syncNativeBackground();
    await vi.waitFor(()=>expect(nativeBackground.readCompleted).toHaveBeenCalled());await store.setProfileActive(false);
    pending.resolve({items:[{id:'late',book,content:contents[0]}]});await pump;
    expect(await store.hasContent(book,chapters[0])).toBe(false);expect(nativeBackground.acknowledge).not.toHaveBeenCalled();
  });
});

describe('server-prepared downloads on each device',()=>{
  it('rejects resuming a disabled source before sending a server action',async()=>{
    const store=await fresh(),mocks=mockServer(prepared({status:'paused',completed:0,completedChapterIDs:[]}));
    store.configureServerDownloads(credentials);await store.syncServerDownloads();await store.toggleSource(book.sourceID);
    await expect(store.resumeDownload(mocks.job.id)).rejects.toThrow('当前书源不可用');expect(mocks.action).not.toHaveBeenCalled();
  });
  it('shows other-device jobs without auto-saving and persists ownership only on the creating device',async()=>{
    const owner=await fresh(),mocks=mockServer();owner.configureServerDownloads(credentials);
    await owner.syncServerDownloads();expect(mocks.save).not.toHaveBeenCalled();expect(owner.getSnapshot().downloads[0].storedOnDevice).toBe(false);
    await owner.enqueueDownload(book,{kind:'all'});
    const reopened=await fresh(owner.profile);reopened.configureServerDownloads(credentials);await reopened.syncServerDownloads();
    expect(mocks.save).toHaveBeenCalledTimes(1);expect(await reopened.hasContent(book,chapters[0])).toBe(true);expect(reopened.getSnapshot().downloads[0].storedOnDevice).toBe(true);
    const other=await fresh();other.configureServerDownloads(credentials);await other.syncServerDownloads();
    expect(mocks.save).toHaveBeenCalledTimes(1);expect(await other.hasContent(book,chapters[0])).toBe(false);expect(other.getSnapshot().downloads[0].storedOnDevice).toBe(false);
  });
  it('keeps a cleared completed package ignored across reopening until the user explicitly saves it',async()=>{
    const store=await fresh(),mocks=mockServer();store.configureServerDownloads(credentials);
    await store.enqueueDownload(book,{kind:'all'});await store.syncServerDownloads();expect(mocks.save).toHaveBeenCalledTimes(1);
    await store.clearCache();expect(await store.hasContent(book,chapters[0])).toBe(false);expect(mocks.action).not.toHaveBeenCalled();
    const reopened=await fresh(store.profile);reopened.configureServerDownloads(credentials);await reopened.syncServerDownloads();
    expect(mocks.save).toHaveBeenCalledTimes(1);expect(await reopened.hasContent(book,chapters[0])).toBe(false);expect(reopened.getSnapshot().downloads[0].storedOnDevice).toBe(false);
    await reopened.savePreparedDownload(mocks.job.id);expect(mocks.save).toHaveBeenCalledTimes(2);expect(await reopened.hasContent(book,chapters[0])).toBe(true);expect(reopened.getSnapshot().downloads[0].storedOnDevice).toBe(true);
  });
  it('cancels an active cloud preparation when clearing this device cache',async()=>{
    const store=await fresh(),mocks=mockServer(prepared({status:'running',completed:0,completedChapterIDs:[]}));store.configureServerDownloads(credentials);
    await store.enqueueDownload(book,{kind:'all'});await store.clearCache();
    expect(mocks.action).toHaveBeenCalledExactlyOnceWith(credentials,mocks.job.id,'cancel');expect(mocks.save).not.toHaveBeenCalled();
  });
  it('rejects a late server chapter after clearing while the stream was in flight',async()=>{
    const store=await fresh(),mocks=mockServer(),gate=deferred<void>();store.configureServerDownloads(credentials);
    mocks.save.mockImplementation(async(_connection,_id,onChapter)=>{await gate.promise;await onChapter(contents[0]);return{chapters:1,job:mocks.job};});
    await store.enqueueDownload(book,{kind:'all'});const pump=store.syncServerDownloads();await vi.waitFor(()=>expect(mocks.save).toHaveBeenCalled());
    await store.clearCache();gate.resolve();await pump;expect(await store.hasContent(book,chapters[0])).toBe(false);
    await store.syncServerDownloads();expect(mocks.save).toHaveBeenCalledTimes(1);
  });
  it('does not save old account content after deactivation during a server stream',async()=>{
    const store=await fresh(),mocks=mockServer(),gate=deferred<void>();store.configureServerDownloads(credentials);
    mocks.save.mockImplementation(async(_connection,_id,onChapter)=>{await gate.promise;await onChapter(contents[0]);return{chapters:1,job:mocks.job};});
    await store.enqueueDownload(book,{kind:'all'});const pump=store.syncServerDownloads();await vi.waitFor(()=>expect(mocks.save).toHaveBeenCalled());
    await store.setProfileActive(false);gate.resolve();await pump;expect(await store.hasContent(book,chapters[0])).toBe(false);
    const other=await fresh();other.configureServerDownloads(credentials);await other.syncServerDownloads();expect(mocks.save).toHaveBeenCalledTimes(1);expect(await other.hasContent(book,chapters[0])).toBe(false);
  });
});

const nativeTransfer=(job:ServerDownloadJob,status:HarmonyTransfer['status']='completed'):HarmonyTransfer=>({id:job.id,bookID:job.bookID,sourceID:job.sourceID,sourceURL:job.sourceURL,revision:job.updatedAt,status,receivedBytes:100,totalBytes:100});
describe('Harmony prepared-transfer ownership and cache acknowledgement',()=>{
  it('imports a completed system file only once when manual saves race each other',async()=>{
    platform.harmony=true;const store=await fresh(),mocks=mockServer(),listing=deferred<HarmonyTransfer[]>(),saving=deferred<void>();store.configureServerDownloads(credentials);
    vi.mocked(harmonyDownloads.list).mockReturnValue(listing.promise);vi.mocked(harmonyDownloads.save).mockImplementation(async(_profile,_transfer,onChapter)=>{await saving.promise;for(const value of contents)await onChapter(value);});
    const first=store.savePreparedDownload(mocks.job.id),second=store.savePreparedDownload(mocks.job.id);await vi.waitFor(()=>expect(harmonyDownloads.list).toHaveBeenCalledTimes(2));listing.resolve([nativeTransfer(mocks.job)]);
    await vi.waitFor(()=>expect(harmonyDownloads.save).toHaveBeenCalledOnce());await new Promise(resolve=>setTimeout(resolve,20));expect(harmonyDownloads.save).toHaveBeenCalledOnce();saving.resolve();await Promise.all([first,second]);
    expect(harmonyDownloads.save).toHaveBeenCalledOnce();expect(await store.hasContent(book,chapters[0])).toBe(true);expect(harmonyDownloads.acknowledge).toHaveBeenCalled();
  });
  it('keeps cloud preparation, system transfer and cached chapters distinct',async()=>{
    platform.harmony=true;const store=await fresh(),mocks=mockServer();store.configureServerDownloads(credentials);await store.enqueueDownload(book,{kind:'all'});await store.syncServerDownloads();
    expect(harmonyDownloads.enqueue).toHaveBeenCalled();expect(harmonyDownloads.save).not.toHaveBeenCalled();expect(await store.hasContent(book,chapters[0])).toBe(false);expect(store.getSnapshot().downloads[0].storedOnDevice).toBe(false);
    vi.mocked(harmonyDownloads.list).mockResolvedValue([nativeTransfer(mocks.job,'running')]);await store.syncServerDownloads();expect(store.getSnapshot().downloads[0].systemTransfer?.status).toBe('running');expect(harmonyDownloads.save).not.toHaveBeenCalled();
    vi.mocked(harmonyDownloads.list).mockResolvedValue([nativeTransfer(mocks.job)]);vi.mocked(harmonyDownloads.acknowledge).mockImplementation(async()=>{for(const chapter of chapters)expect(await store.hasContent(book,chapter)).toBe(true);expect(store.getSnapshot().downloads[0].storedOnDevice).toBe(true);});
    await store.syncServerDownloads();expect(harmonyDownloads.save).toHaveBeenCalledOnce();expect(harmonyDownloads.acknowledge).toHaveBeenCalledOnce();expect(mocks.save).not.toHaveBeenCalled();
  });
  it('does not delete native staging or mark cached when local writes fail; explicit retry is required',async()=>{
    platform.harmony=true;const store=await fresh(),mocks=mockServer();store.configureServerDownloads(credentials);await store.enqueueDownload(book,{kind:'all'});vi.mocked(harmonyDownloads.list).mockResolvedValue([nativeTransfer(mocks.job)]);
    vi.mocked(harmonyDownloads.save).mockRejectedValue(new Error('本机空间不足'));await store.syncServerDownloads();expect(harmonyDownloads.acknowledge).not.toHaveBeenCalled();expect(store.getSnapshot().downloads[0]).toMatchObject({storedOnDevice:false,systemTransfer:{status:'failed',error:'本机空间不足'}});
    await store.syncServerDownloads();expect(harmonyDownloads.save).toHaveBeenCalledOnce();await store.retryDownload(mocks.job.id);expect(harmonyDownloads.action).toHaveBeenCalledWith(store.profile,mocks.job.id,'resume');
  });
  it('rejects a late native chapter after account deactivation before writing or acknowledgement',async()=>{
    platform.harmony=true;const store=await fresh(),mocks=mockServer(),gate=deferred<void>();store.configureServerDownloads(credentials);await store.enqueueDownload(book,{kind:'all'});vi.mocked(harmonyDownloads.list).mockResolvedValue([nativeTransfer(mocks.job)]);
    vi.mocked(harmonyDownloads.save).mockImplementation(async(_profile,_transfer,onChapter)=>{await gate.promise;await onChapter(contents[0]);});const work=store.syncServerDownloads();await vi.waitFor(()=>expect(harmonyDownloads.save).toHaveBeenCalled());await store.setProfileActive(false);gate.resolve();await work;
    expect(await store.hasContent(book,chapters[0])).toBe(false);expect(harmonyDownloads.acknowledge).not.toHaveBeenCalled();
  });
  it('pauses a system transfer when its source is disabled even though cloud preparation is complete',async()=>{
    platform.harmony=true;const store=await fresh(),mocks=mockServer();store.configureServerDownloads(credentials);await store.enqueueDownload(book,{kind:'all'});vi.mocked(harmonyDownloads.list).mockResolvedValue([nativeTransfer(mocks.job,'running')]);await store.syncServerDownloads();await store.toggleSource(book.sourceID);
    expect(harmonyDownloads.action).toHaveBeenCalledWith(store.profile,mocks.job.id,'pause');await expect(store.resumeDownload(mocks.job.id)).rejects.toThrow('当前书源不可用');expect(harmonyDownloads.save).not.toHaveBeenCalled();
  });
  it('accepts update badges only for the same source and removes chapters already read',async()=>{
    platform.harmony=true;const store=await fresh();await store.savePosition(book,chapters[1],.5,4);
    const value:BookUpdateState={knownChapterCount:4,lastKnownChapterID:'new',unreadChapterIDs:[chapters[0].id,chapters[1].id,chapters[2].id,'new'],checkedAt:'2026-10-25T00:00:00Z'};
    await store.acceptHarmonyUpdates({[book.id]:value},[{...book,sourceID:'other'}]);expect(store.getSnapshot().updates[book.id]).toBeUndefined();await store.acceptHarmonyUpdates({[book.id]:value},[book]);expect(store.getSnapshot().updates[book.id].unreadChapterIDs).toEqual([chapters[2].id,'new']);
  });
});
