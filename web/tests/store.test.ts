import 'fake-indexeddb/auto';
import {IDBObjectStore as FakeObjectStore} from 'fake-indexeddb';
import {openDB} from 'idb';
import {describe,it,expect,beforeAll,afterEach,vi} from 'vitest';
import {JSDOM} from 'jsdom';
import {BrowserLibrary,normalizeSettings} from '../src/lib/store';
import {sampleBook,sampleChapter} from '../src/lib/sample';
import {api} from '../src/lib/api';
import {defaultSettings} from '../src/shared/types';
const fresh=()=>new BrowserLibrary('qingread-test-'+crypto.randomUUID());
beforeAll(()=>{globalThis.DOMParser=new JSDOM('').window.DOMParser;});
afterEach(()=>vi.restoreAllMocks());
async function seededDatabase(state:unknown){
  const name='qingread-test-'+crypto.randomUUID();
  const db=await openDB(name,2,{upgrade(db){for(const store of ['meta','chapters','contents','imports','files','covers','localContents'])db.createObjectStore(store);}});
  await db.put('meta',state,'state');
  return{name,db};
}
describe('browser storage',()=>{
  it('retains each chapter maximum while latest position can move backwards',async()=>{
    const store=fresh();await store.initialized;
    await store.savePosition(sampleBook,sampleChapter,.8,80);await store.savePosition(sampleBook,sampleChapter,.2,20);
    expect(await store.chapterProgress(sampleBook,sampleChapter)).toBe(.8);
    expect(store.getSnapshot().shelf[0].position?.chapterFraction).toBe(.2);
    const backup=await store.exportBackup();const reopened=fresh();await reopened.initialized;await reopened.importBackup(new File([backup],'backup.json'));
    expect(await reopened.chapterProgress(sampleBook,sampleChapter)).toBe(.8);
  });
  it('preserves imported files and reading progress through cache clearing, deduplicates files',async()=>{
    const store=fresh();await store.initialized;const file=new File(['第一章\n本地正文。'],'book.txt');
    const book=await store.importFile(file);await store.importFile(new File([file],'duplicate.txt'));
    expect(store.getSnapshot().shelf.filter(e=>e.book.id===book.id)).toHaveLength(1);
    const chapters=(await store.getChapters(book))!;await store.savePosition(book,chapters[0],.5,3);
    await store.clearCache();expect(await store.getPublication(book)).toBeDefined();
    expect((await store.getContent(book,chapters[0]))?.paragraphs).toEqual(['本地正文。']);
    await store.remove(book);expect(await store.getPublication(book)).toBeUndefined();expect(await store.chapterProgress(book,chapters[0])).toBeUndefined();
  });
  it('never restores a late prefetch after clearing cached content',async()=>{
    const store=fresh();await store.initialized;
    const book={...sampleBook,id:'remote',sourceID:'remote'},chapter={...sampleChapter,id:'remote-chapter',index:1};
    let resolve!:(value:{chapter:typeof chapter;paragraphs:string[]})=>void;
    const request=new Promise<{chapter:typeof chapter;paragraphs:string[]}>(r=>resolve=r);
    const spy=vi.spyOn(api,'content').mockReturnValue(request);
    const pending=store.prefetch(book,[{...chapter,index:0},chapter],0);
    await vi.waitFor(()=>expect(spy).toHaveBeenCalled());await store.clearCache();resolve({chapter,paragraphs:['late']});await pending;
    expect(await store.hasContent(book,chapter)).toBe(false);spy.mockRestore();
  });
  it('clamps corrupt numeric reader settings',()=>{
    const s=normalizeSettings({fontSize:999,paragraphSpacing:-5,speechRate:NaN});expect(s.fontSize).toBe(34);expect(s.paragraphSpacing).toBe(0);expect(s.speechRate).toBe(1);
  });
  it('rejects malformed backups entirely before changing the existing shelf or progress',async()=>{
    const store=fresh();await store.initialized;await store.savePosition(sampleBook,sampleChapter,.7,70);
    const existing=structuredClone(store.getSnapshot());
    const valid={book:{...sampleBook,id:'new-book'},addedAt:'2026-10-20T12:00:00.000Z'};
    const invalid=[
      {book:{...sampleBook,id:'missing-date'}},
      {...valid,book:{...sampleBook,id:'object-author',author:{text:'作者'}}},
      {...valid,position:{chapterID:'chapter',chapterIndex:-1,chapterFraction:.5,characterOffset:0,updatedAt:valid.addedAt}},
      {...valid,position:{chapterID:'chapter',chapterIndex:0,chapterFraction:.5,characterOffset:0,updatedAt:{date:'today'}}},
    ];
    for(const bad of invalid){
      const backup={format:'qingread-backup',version:1,shelf:[valid,bad],settings:{fontSize:30},progress:{[sampleBook.id]:{[sampleChapter.id]:1}}};
      await expect(store.importBackup(new File([JSON.stringify(backup)],'bad.json'))).rejects.toThrow();
      expect(store.getSnapshot()).toEqual(existing);expect(await store.chapterProgress(sampleBook,sampleChapter)).toBe(.7);
    }
    const backup=JSON.parse(await(await store.exportBackup()).text());expect(backup.shelf).toEqual(existing.shelf);
  });
  it('isolates corrupt persisted rows, preserving healthy books and the original snapshot',async()=>{
    const valid={book:sampleBook,addedAt:'2026-10-20T12:00:00.000Z'};
    const raw={shelf:[valid,{book:{...sampleBook,id:'broken'}}],settings:defaultSettings,sources:[],disabledSourceIDs:[]};
    const{name,db}=await seededDatabase(raw);const store=new BrowserLibrary(name);await store.initialized;
    expect(store.getSnapshot().shelf).toEqual([valid]);expect(store.getSnapshot().storageError).toContain('隔离');
    await store.initializeSources([]);
    expect((await db.get('meta','quarantined-state')).state).toEqual(raw);
    expect((await db.get('meta','state')).shelf).toEqual([valid]);
    const reopened=new BrowserLibrary(name);await reopened.initialized;expect(reopened.getSnapshot().shelf).toEqual([valid]);
    db.close();
  });
  it('never overwrites the saved library after a transient hydration failure',async()=>{
    const raw={shelf:[{book:sampleBook,addedAt:'2026-10-20T12:00:00.000Z'}],settings:defaultSettings,sources:[],disabledSourceIDs:[]};
    const{name,db}=await seededDatabase(raw),original=FakeObjectStore.prototype.get;
    const spy=vi.spyOn(FakeObjectStore.prototype,'get').mockImplementation(function(this:InstanceType<typeof FakeObjectStore>,query){
      if(this.name==='meta'&&query==='state')throw new DOMException('temporary read failure','UnknownError');
      return original.call(this,query);
    });
    const store=new BrowserLibrary(name);await store.initialized;spy.mockRestore();
    expect(store.getSnapshot().storageError).toContain('原数据未覆盖');
    await store.initializeSources([]);await store.updateSettings({fontSize:28});
    expect(await db.get('meta','state')).toEqual(raw);
    await expect(store.importBackup(new File([JSON.stringify({format:'qingread-backup',version:1,shelf:[]})],'valid.json'))).rejects.toThrow('安全加载');
    expect(await db.get('meta','state')).toEqual(raw);db.close();
  });
});
