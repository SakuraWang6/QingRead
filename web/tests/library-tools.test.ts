import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { BrowserLibrary } from '../src/lib/store';
import { libraryData, mergeLibraryData } from '../src/shared/libraryData';
import type { ReadingAnnotation } from '../src/shared/types';
import { sampleBook,sampleChapter } from '../src/lib/sample';
const note=(extra:Partial<ReadingAnnotation>={}):ReadingAnnotation=>({id:crypto.randomUUID(),kind:'note',chapterID:sampleChapter.id,chapterIndex:0,chapterTitle:sampleChapter.title,characterOffset:3,characterLength:5,quote:'桃花源',note:'引用',sourceID:sampleBook.sourceID,sourceURL:sampleBook.url,updatedAt:'2026-01-01T00:00:00.000Z',...extra});
describe('organized shelves and private annotations',()=>{
  it('keeps pins, groups, notes and tombstones when reading first saves progress',async()=>{
    const name='library-position-'+crypto.randomUUID(),store=new BrowserLibrary(name,true);
    await store.add(sampleBook);await store.organize([sampleBook.id],{pinned:true,status:'later',group:'文学'});
    const live=note(),deleted=note({deletedAt:'2026-01-02T00:00:00.000Z',updatedAt:'2026-01-02T00:00:00.000Z'});
    await store.annotate(sampleBook,live);await store.annotate(sampleBook,deleted);
    const before=structuredClone(store.getSnapshot().shelf[0]);
    await store.add(sampleBook);await store.savePosition(sampleBook,sampleChapter,.45,45);
    expect(store.getSnapshot().shelf[0]).toMatchObject({...before,position:{chapterID:sampleChapter.id,characterOffset:45}});
    expect((await store.syncRequest()).mutations[0].entry).toMatchObject({organization:before.organization,annotations:before.annotations});
    const reopened=new BrowserLibrary(name,true);await reopened.initialized;
    expect(reopened.getSnapshot().shelf[0]).toMatchObject({organization:before.organization,annotations:before.annotations,position:{characterOffset:45}});
  });
  it('persists organization, note tombstones, and searches only local content without network',async()=>{
    const name='library-tools-'+crypto.randomUUID(),store=new BrowserLibrary(name,true);await store.add(sampleBook);await store.organize([sampleBook.id],{pinned:true,status:'later',group:'文学'});const item=note();await store.annotate(sampleBook,item);
    await store.deleteAnnotation(sampleBook,item.id);const reopened=new BrowserLibrary(name,true);await reopened.initialized;
    expect(reopened.getSnapshot().shelf[0].organization).toMatchObject({pinned:true,status:'later',group:'文学'});expect(reopened.getSnapshot().shelf[0].annotations?.[0].deletedAt).toBeTruthy();
    expect((await reopened.searchCached(sampleBook,'桃花')).length).toBeGreaterThan(0);
    const another=new BrowserLibrary('another-'+crypto.randomUUID(),true);await another.initialized;expect(another.getSnapshot().shelf).toEqual([]);
  });
  it('merges independent offline notes and never resurrects a deleted note from an old device',()=>{
    const a=note(),b=note(),deleted={...a,deletedAt:'2026-01-02T00:00:00.000Z',updatedAt:'2026-01-02T00:00:00.000Z'};
    const merged=mergeLibraryData({annotations:[deleted]},{annotations:[a,b]});expect(merged.annotations).toHaveLength(2);expect(merged.annotations?.find(n=>n.id===a.id)?.deletedAt).toBeTruthy();
    expect(mergeLibraryData({annotations:[a]},{annotations:[{...a,deletedAt:a.updatedAt}]}).annotations?.[0].deletedAt).toBeTruthy();
  });
  it('rejects oversized or malformed user data without retaining arbitrary keys',()=>{
    expect(()=>libraryData({annotations:[note({note:'x'.repeat(1001)})]})).toThrow();expect(()=>libraryData({organization:{pinned:true,status:'invalid',group:'',updatedAt:new Date().toISOString()}})).toThrow();
    const clean=libraryData({annotations:[{...note(),unexpected:'private extra'}]});expect(clean.annotations?.[0]).not.toHaveProperty('unexpected');
  });
});
