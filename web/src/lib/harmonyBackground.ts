import { sha256 } from '@noble/hashes/sha2.js';
import type { Book, BookUpdateState } from '../shared/types';
import { hasHarmonyCapability, harmonyRequest } from './harmonyNative';
import { savePreparedDownloadStream, type ServerDownloadJob } from './serverDownloads';
import type { ChapterContent, ChapterDownloadStatus } from '../shared/types';

export interface HarmonyTransfer {
  id:string;bookID:string;sourceID:string;sourceURL:string;revision:string;
  status:ChapterDownloadStatus;receivedBytes:number;totalBytes?:number;error?:string;
}
export interface HarmonyBackgroundConfiguration {profile:string|null;apiBase?:string;authToken?:string;accessToken?:string}
export interface HarmonyUpdatesSnapshot {enabled:boolean;notifications:'granted'|'denied'|'prompt';updates:Record<string,BookUpdateState>}
export const supportsHarmonyDownloads=()=>hasHarmonyCapability('backgroundDownloads');
export const supportsHarmonyUpdates=()=>hasHarmonyCapability('updateNotifications');
let configuring=Promise.resolve();
let activeConfiguration='';
let requestedConfiguration='';
let configurationRevision=0;
export async function configureHarmonyBackground(value:HarmonyBackgroundConfiguration):Promise<void>{
  if(!supportsHarmonyDownloads()&&!supportsHarmonyUpdates())return;
  const signature=JSON.stringify(value);
  if(signature===activeConfiguration)return;
  if(signature===requestedConfiguration)return configuring;
  const revision=++configurationRevision;activeConfiguration='';requestedConfiguration=signature;
  // Send profile revocation immediately. The native owner serializes cleanup;
  // waiting for an earlier bridge call here would postpone logout's fence.
  const work=harmonyRequest<void>(supportsHarmonyDownloads()?'backgroundDownloads':'updateNotifications','background.configure',value).then(()=>{
    if(revision===configurationRevision){activeConfiguration=signature;requestedConfiguration='';}
  },error=>{if(revision===configurationRevision)requestedConfiguration='';throw error;});
  configuring=work;return work;
}
function downloadRequest<T>(method:string,params:object):Promise<T>{return harmonyRequest('backgroundDownloads','downloads.'+method,params);}
function validTransfer(value:unknown):value is HarmonyTransfer{
  if(!value||typeof value!=='object')return false;
  const item=value as HarmonyTransfer;
  return typeof item.id==='string'&&typeof item.bookID==='string'&&typeof item.sourceID==='string'&&typeof item.sourceURL==='string'&&typeof item.revision==='string'&&Number.isFinite(Date.parse(item.revision))&&['queued','running','paused','completed','failed','cancelled'].includes(item.status)&&Number.isSafeInteger(item.receivedBytes)&&item.receivedBytes>=0&&item.receivedBytes<=128*1024*1024&&(item.totalBytes===undefined||Number.isSafeInteger(item.totalBytes)&&item.totalBytes>=0&&item.totalBytes<=128*1024*1024);
}
export const harmonyDownloads={
  async list(profile:string):Promise<HarmonyTransfer[]>{await configuring;const value=await downloadRequest<{transfers:unknown}>('list',{profile});if(!Array.isArray(value?.transfers)||value.transfers.length>50||!value.transfers.every(validTransfer))throw new Error('系统下载状态无效，请重试');return value.transfers;},
  async enqueue(profile:string,job:ServerDownloadJob):Promise<void>{await configuring;await downloadRequest('enqueue',{profile,id:job.id,bookID:job.bookID,sourceID:job.sourceID,sourceURL:job.sourceURL,revision:job.updatedAt,bytes:job.bytes});},
  async action(profile:string,id:string,action:'pause'|'resume'|'cancel'):Promise<void>{await configuring;await downloadRequest(action,{profile,id});},
  async removeBook(profile:string,bookID:string):Promise<void>{await configuring;await downloadRequest('removeBook',{profile,bookID});},
  async clearCache(profile:string):Promise<void>{await configuring;await downloadRequest('clearCache',{profile});},
  async acknowledge(profile:string,transfer:HarmonyTransfer):Promise<void>{await downloadRequest('acknowledge',{profile,id:transfer.id,revision:transfer.revision});},
  async save(profile:string,transfer:HarmonyTransfer,onChapter:(content:ChapterContent)=>Promise<void>,signal:AbortSignal):Promise<void>{
    // Validate the complete immutable native file before writing its chapters.
    const fingerprint:{hash?:string;bytes?:number}={};
    const first=await savePreparedDownloadStream(transfer.id,nativeDownloadStream(profile,transfer,signal,fingerprint),async()=>{},signal);
    assertManifest(transfer,first.job);
    const saved=await savePreparedDownloadStream(transfer.id,nativeDownloadStream(profile,transfer,signal,fingerprint),onChapter,signal);
    assertManifest(transfer,saved.job);
  },
};
function assertManifest(transfer:HarmonyTransfer,job:ServerDownloadJob){if(job.id!==transfer.id||job.bookID!==transfer.bookID||job.sourceID!==transfer.sourceID||job.sourceURL!==transfer.sourceURL||job.updatedAt!==transfer.revision)throw new Error('系统下载与当前书籍不匹配');}
const readMessages:number[]=[];
async function paceRead(signal:AbortSignal){
  for(;;){
    if(signal.aborted)throw new DOMException('已取消','AbortError');
    const now=Date.now();while(readMessages.length&&readMessages[0]<=now-10_010)readMessages.shift();
    if(readMessages.length<256){readMessages.push(now);return;}
    await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(new DOMException('已取消','AbortError'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},Math.max(1,Math.min(10_010,readMessages[0]+10_010-now)));signal.addEventListener('abort',abort,{once:true});});
  }
}
function nativeDownloadStream(profile:string,transfer:HarmonyTransfer,signal:AbortSignal,fingerprint:{hash?:string;bytes?:number}):ReadableStream<Uint8Array>{
  let offset=0,expectedHash='',expectedBytes:number|undefined,stopped=false;
  const digest=sha256.create();
  return new ReadableStream<Uint8Array>({
    async pull(controller){
      if(stopped)return;
      try{
        await paceRead(signal);
        const result=await downloadRequest<{base64:unknown;nextOffset:unknown;done:unknown;sha256:unknown;totalBytes:unknown}>('read',{profile,id:transfer.id,revision:transfer.revision,offset,limit:49152});
        if(signal.aborted)throw new DOMException('已取消','AbortError');
        if(typeof result?.base64!=='string'||result.base64.length>65536||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.base64)||typeof result.done!=='boolean'||!Number.isSafeInteger(result.nextOffset)||!Number.isSafeInteger(result.totalBytes)||Number(result.totalBytes)<1||Number(result.totalBytes)>128*1024*1024||typeof result.sha256!=='string'||!/^[a-f0-9]{64}$/.test(result.sha256))throw new Error('系统下载分块无效');
        const bytes=Uint8Array.from(atob(result.base64),character=>character.charCodeAt(0));
        if(bytes.length>49152||Number(result.nextOffset)!==offset+bytes.length||!result.done&&!bytes.length||Number(result.nextOffset)>Number(result.totalBytes)||result.done&&Number(result.nextOffset)!==Number(result.totalBytes))throw new Error('系统下载不完整');
        if(expectedHash&&expectedHash!==result.sha256||expectedBytes!==undefined&&expectedBytes!==result.totalBytes)throw new Error('系统下载文件已变更');
        if(fingerprint.hash&&fingerprint.hash!==result.sha256||fingerprint.bytes!==undefined&&fingerprint.bytes!==result.totalBytes)throw new Error('系统下载文件已变更');
        fingerprint.hash=result.sha256;fingerprint.bytes=Number(result.totalBytes);
        expectedHash=result.sha256;expectedBytes=Number(result.totalBytes);offset=Number(result.nextOffset);digest.update(bytes);
        if(result.done){const actual=Array.from(digest.digest(),value=>value.toString(16).padStart(2,'0')).join('');if(actual!==expectedHash)throw new Error('系统下载校验失败，请重新下载');}
        if(bytes.length)controller.enqueue(bytes);
        if(result.done){stopped=true;controller.close();}
      }catch(error){stopped=true;controller.error(error);}
    },
    cancel(){stopped=true;},
  });
}
export const harmonyUpdates={
  async snapshot(profile:string):Promise<HarmonyUpdatesSnapshot>{await configuring;const value=await harmonyRequest<HarmonyUpdatesSnapshot>('updateNotifications','updates.snapshot',{profile});if(!value||typeof value.enabled!=='boolean'||!['granted','denied','prompt'].includes(value.notifications)||!value.updates||typeof value.updates!=='object'||Array.isArray(value.updates)||Object.keys(value.updates).length>20)throw new Error('后台追更状态无效');return value;},
  async requestPermission():Promise<{notifications:'granted'|'denied'|'prompt'}>{return harmonyRequest('updateNotifications','updates.requestPermission');},
  async watch(profile:string,enabled:boolean,books:{book:Book;baseline?:BookUpdateState;readChapterID?:string}[]):Promise<void>{
    await configuring;
    await harmonyRequest('updateNotifications','updates.watch',{profile,enabled,books:books.slice(0,20).map(({book,baseline,readChapterID})=>({book:{id:book.id,title:book.title,sourceID:book.sourceID,sourceName:book.sourceName,url:book.url},baseline:baseline?{knownChapterCount:baseline.knownChapterCount,lastKnownChapterID:baseline.lastKnownChapterID,lastKnownChapterTitle:baseline.lastKnownChapterTitle,checkedAt:baseline.checkedAt}:undefined,readChapterID}))});
  },
};
