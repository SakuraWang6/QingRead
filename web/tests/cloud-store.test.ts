import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { BrowserLibrary } from '../src/lib/store';
import { sampleBook, sampleChapter } from '../src/lib/sample';
import { anchorFormat, type CloudSnapshot } from '../src/shared/sync';
const fresh=()=>new BrowserLibrary('cloud-test-'+crypto.randomUUID(),true);
const snapshot=(patch:Partial<CloudSnapshot>={}):CloudSnapshot=>({anchorFormat,cursor:1,acknowledged:[],rejected:[],records:[],hasMore:false,serverTime:new Date().toISOString(),...patch});
describe('offline account storage',()=>{
  it('separates accounts and persists a coalesced outbox across reopening',async()=>{
    const name='cloud-test-'+crypto.randomUUID(),a=new BrowserLibrary(name,true),b=fresh();await a.initialized;await b.initialized;
    await a.add(sampleBook);await a.savePosition(sampleBook,sampleChapter,.4,40);await a.savePosition(sampleBook,sampleChapter,.7,70);
    expect(b.getSnapshot().shelf).toEqual([]);
    const reopened=new BrowserLibrary(name,true);await reopened.initialized;
    const pending=await reopened.syncRequest();expect(pending.mutations).toHaveLength(1);expect(pending.mutations[0].action).toBe('add');expect(pending.mutations[0].entry?.position?.chapterFraction).toBe(.7);
  });
  it('does not erase a new local position when an older request is acknowledged',async()=>{
    const store=fresh();await store.add(sampleBook);const sent=(await store.syncRequest()).mutations[0];
    await store.savePosition(sampleBook,sampleChapter,.8,80);
    await store.acceptSync(snapshot({acknowledged:[sent.id],records:[{bookID:sampleBook.id,entry:sent.entry!,revision:1,changedAt:new Date().toISOString()}]}));
    expect(store.hasPendingSync()).toBe(true);expect(store.getSnapshot().shelf[0].position?.characterOffset).toBe(80);
    const next=(await store.syncRequest()).mutations[0];await store.acceptSync(snapshot({cursor:2,acknowledged:[next.id],records:[{bookID:sampleBook.id,entry:next.entry!,revision:2,changedAt:new Date().toISOString()}]}));
    expect(store.hasPendingSync()).toBe(false);expect(store.getSnapshot().shelf[0].position?.characterOffset).toBe(80);
  });
  it('applies remote removals without deleting local publication files or inventing upload operations',async()=>{
    const store=fresh();await store.add(sampleBook);const sent=(await store.syncRequest()).mutations[0];
    await store.acceptSync(snapshot({acknowledged:[sent.id],records:[{bookID:sampleBook.id,entry:null,revision:1,changedAt:new Date().toISOString()}]}));
    expect(store.getSnapshot().shelf).toEqual([]);expect(store.hasPendingSync()).toBe(false);
  });
});
