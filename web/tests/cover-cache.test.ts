import {describe,it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CoverCache} from '../server/cover-cache';
import {ServiceError} from '../server/network';
describe('cover reuse',()=>{
 it('merges simultaneous loads and reuses saved artwork after process restart',async()=>{
  const root=await mkdtemp(join(tmpdir(),'qingread-covers-'));let count=0;
  try{
   const cache=new CoverCache(root),load=async()=>{count++;await new Promise(resolve=>setTimeout(resolve,5));return{bytes:Buffer.from([255,216,255,1]),type:'image/jpeg'};};
   const [a,b]=await Promise.all([cache.get('book',load),cache.get('book',load)]);expect(count).toBe(1);expect(a.image.bytes).toEqual(b.image.bytes);
   expect((await cache.get('book',load)).cache).toBe('memory');
   expect((await new CoverCache(root).get('book',load)).cache).toBe('disk');expect(count).toBe(1);
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it('briefly reuses a missing-cover result without changing its HTTP error',async()=>{
  const cache=new CoverCache();let calls=0;
  const load=async()=>{calls++;throw new ServiceError('没有封面',404);};
  await expect(cache.get('missing',load)).rejects.toMatchObject({statusCode:404});await expect(cache.get('missing',load)).rejects.toMatchObject({statusCode:404});expect(calls).toBe(1);
 });
});
