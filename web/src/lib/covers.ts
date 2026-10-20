import type { Book } from '../shared/types';
import { api } from './api';
import { ServerAuthenticationError } from './connection';
const cached=new Map<string,{blob?:Blob;expires:number}>();
const inFlight=new Map<string,Promise<Blob|undefined>>();
const waiters:(()=>void)[]=[];let active=0,bytes=0;
async function enter(){if(active<3){active++;return;}await new Promise<void>(resolve=>waiters.push(resolve));}
function leave(){const next=waiters.shift();if(next)next();else active--;}
export function loadCover(book:Book):Promise<Blob|undefined>{
 const key=api.coverURL(book),old=cached.get(key);
 if(old&&old.expires>Date.now())return Promise.resolve(old.blob);
 const pending=inFlight.get(key);if(pending)return pending;
 const run=async()=>{
  await enter();
  try{
   const blob=await api.cover(book,AbortSignal.timeout(15_000));
   if(old?.blob)bytes-=old.blob.size;cached.delete(key);
   while(bytes+blob.size>12*1024**2||cached.size>=150){const first=cached.keys().next().value;if(!first)break;bytes-=cached.get(first)?.blob?.size??0;cached.delete(first);}
   cached.set(key,{blob,expires:Date.now()+86400_000});bytes+=blob.size;return blob;
  }catch(error){
   if(old?.blob){old.expires=Date.now()+60_000;return old.blob;}
   if(!(error instanceof ServerAuthenticationError))cached.set(key,{expires:Date.now()+30_000});
   throw error;
  }finally{leave();}
 };
 const promise=run();inFlight.set(key,promise);void promise.finally(()=>inFlight.delete(key)).catch(()=>{});return promise;
}
