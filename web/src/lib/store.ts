import { openDB, type IDBPDatabase } from 'idb';
import { useSyncExternalStore } from 'react';
import type { Book, Chapter, ChapterContent, LibraryState, ReaderSettings, ShelfEntry, SourceDefinition, LocalPublication, ReadingPosition, BookUpdateState, ChapterDownloadJob, ChapterDownloadSelection, SourceSwitchPlan, UpdateCheckResult } from '../shared/types';
import { defaultSettings } from '../shared/types';
import type { ReadingAnnotation, ShelfOrganization } from '../shared/types';
import { libraryData } from '../shared/libraryData';
import { isAndroidApp } from './android';
import { nativeBackground } from './androidBackground';
import { serverDownloads, type ServerDownloadConnection, type ServerDownloadJob } from './serverDownloads';
import { sampleBook, sampleChapter, sampleContent } from './sample';
import { parsePublication } from './importPublication';
import { api } from './api';
import { sha256 } from '@noble/hashes/sha2.js';
import { appendedChapters, isChapterBook, matchChapter, remappedPosition, sameEditionTitle } from './readingWorkflows';
import type { CloudMutation, CloudRecord, CloudSnapshot } from '../shared/sync';

const contentKey=(book:Book,chapter:Chapter)=>`${book.id}\0${chapter.id}`;
const bounded=(n:number,lo:number,hi:number,fallback:number)=>Number.isFinite(n)?Math.max(lo,Math.min(hi,n)):fallback;
const record=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const safeID=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=8192&&!value.includes('\0')&&!['__proto__','constructor','prototype'].includes(value);
const validDate=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value));
function shelfEntry(value:unknown):ShelfEntry {
  if(!record(value)||!record(value.book)||!validDate(value.addedAt))throw new Error('备份书架条目或加入日期无效');
  const b=value.book;
  if(!safeID(b.id)||!safeID(b.sourceID)||['title','author','summary','sourceName','url'].some(key=>typeof b[key]!=='string')||!(b.title as string).trim())throw new Error('备份包含无效书籍字段');
  let url:URL;try{url=new URL(b.url as string);}catch{throw new Error('备份包含无效书籍网址');}
  if(!['https:','http:','qingread-local:','qingread-import:'].includes(url.protocol))throw new Error('备份包含无效书籍网址');
  if(b.publicationFormat!=null&&!['epub','pdf','txt'].includes(b.publicationFormat as string))throw new Error('备份包含无效电子书类型');
  if(b.fileDownloadURL!=null&&typeof b.fileDownloadURL!=='string')throw new Error('备份包含无效下载网址');
  const book:Book={id:b.id,title:b.title as string,author:b.author as string,summary:b.summary as string,sourceID:b.sourceID,sourceName:b.sourceName as string,url:b.url as string,
    publicationFormat:b.publicationFormat as Book['publicationFormat'],fileDownloadURL:b.fileDownloadURL as Book['fileDownloadURL'],fileHash:typeof b.fileHash==='string'&&/^[a-f0-9]{64}$/.test(b.fileHash)?b.fileHash:undefined,coverURL:typeof b.coverURL==='string'&&b.coverURL.startsWith('https://')?b.coverURL:undefined};
  let position:ReadingPosition|undefined;
  if(value.position!==undefined){
    const p=value.position;
    if(!record(p)||!safeID(p.chapterID)||!validDate(p.updatedAt)||!Number.isSafeInteger(p.chapterIndex)||Number(p.chapterIndex)<0||!Number.isSafeInteger(p.characterOffset)||Number(p.characterOffset)<0||typeof p.chapterFraction!=='number'||!Number.isFinite(p.chapterFraction)||p.chapterFraction<0||p.chapterFraction>1)throw new Error('备份包含无效阅读进度');
    position={chapterID:p.chapterID,updatedAt:p.updatedAt,chapterIndex:p.chapterIndex as number,characterOffset:p.characterOffset as number,chapterFraction:p.chapterFraction};
  }
  return{book,addedAt:value.addedAt,position,...libraryData(value)};
}
function progressRecords(value:unknown,strict=false):Record<string,Record<string,number>> {
  const result:Record<string,Record<string,number>>=Object.create(null);
  if(value===undefined)return result;
  if(!record(value)){if(strict)throw new Error('备份包含无效章节进度');return result;}
  for(const [bookID,chapters]of Object.entries(value)){
    if(!safeID(bookID)||!record(chapters)){if(strict)throw new Error('备份包含无效章节进度');continue;}
    result[bookID]=Object.create(null);
    for(const [id,fraction]of Object.entries(chapters)){
      if(!safeID(id)||typeof fraction!=='number'||!Number.isFinite(fraction)||fraction<0||fraction>1){if(strict)throw new Error('备份包含无效章节进度');continue;}
      result[bookID][id]=fraction;
    }
  }
  return result;
}
function sourceIDs(value:unknown):string[]{return Array.isArray(value)?value.filter(safeID):[];}
export function normalizeSettings(input:Partial<ReaderSettings>):ReaderSettings {
  const s={...defaultSettings,...input};
  return {...s,fontSize:bounded(s.fontSize,16,34,21),lineSpacing:bounded(s.lineSpacing,4,22,9),paragraphSpacing:bounded(s.paragraphSpacing,0,28,6),horizontalMargin:bounded(s.horizontalMargin,16,40,24),speechRate:bounded(s.speechRate,.6,1.8,1),
    theme:['paper','dusk','mint','gray','rose','night'].includes(s.theme)?s.theme:'paper',turnMode:['slide','cover','scroll'].includes(s.turnMode)?s.turnMode:'slide',font:['song','system','rounded'].includes(s.font)?s.font:'song',speechEngine:s.speechEngine==='kokoro'?'kokoro':'system',isBold:s.isBold===true,isNightMode:s.isNightMode===true,speechVoiceIdentifier:typeof s.speechVoiceIdentifier==='string'?s.speechVoiceIdentifier:'',kokoroVoiceID:bounded(s.kokoroVoiceID,3,102,46)};
}
export class BrowserLibrary {
  private state:LibraryState={ready:false,shelf:[],settings:defaultSettings,sources:[],disabledSourceIDs:[],updates:{},checkingUpdates:false,downloads:[]};
  private listeners=new Set<()=>void>();
  private db:Promise<IDBPDatabase>;
  private writing=Promise.resolve();
  private requests=new Map<string,{promise:Promise<ChapterContent>;controller:AbortController;readers:number}>();
  private generation=0;
  private progress:Record<string,Record<string,number>>=Object.create(null);
  private coverURLs=new Map<string,string>();
  private persistenceBlocked=false;
  private active=true;
  private downloadRunner?:Promise<void>;
  private downloadAbort?:AbortController;
  private updateAbort?:AbortController;
  private switchPlans=new WeakMap<SourceSwitchPlan,number>();
  private switchCommits=new Map<string,Promise<Book>>();
  private workflowGeneration=0;
  private invalidatingBooks=new Set<string>();
  private sourceCommitBarrier?:Promise<void>;
  private removedBooks=new Set<string>();
  private nativeSyncing=false;
  private serverConnection?:ServerDownloadConnection;
  private serverSyncing=false;
  private serverSaveAttempts=new Map<string,number>();
  configureServerDownloads(connection?:ServerDownloadConnection){this.serverConnection=connection;}
  private cloud={cursor:0,revisions:{} as Record<string,number>,pending:[] as CloudMutation[],deferred:{} as Record<string,CloudRecord>};
  readonly initialized:Promise<void>;
  constructor(readonly profile='qingread-web-v1',private cloudEnabled=false){
    this.db=openDB(profile,2,{upgrade(db){for(const store of ['meta','chapters','contents','imports','files','covers','localContents'])if(!db.objectStoreNames.contains(store))db.createObjectStore(store);}});
    this.initialized=this.hydrate();
    if(typeof document!=='undefined')document.addEventListener('visibilitychange',()=>{if(document.hidden){this.updateAbort?.abort();void this.pauseDownloadsForBackground();}});
  }
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>this.listeners.delete(listener);};
  getSnapshot=()=>this.state;
  private emit(){this.listeners.forEach(fn=>fn());}
  private report(error:unknown){this.state={...this.state,storageError:`本地保存未完成：${error instanceof Error?error.message:'浏览器存储不可用'}`};this.emit();}
  private async hydrate(){
    try {
      const db=await this.db;
      const raw:unknown=await db.get('meta','state');
      const saved=record(raw)?raw:undefined;
      const shelf:ShelfEntry[]=[];let isolated=0;
      if(raw===undefined){if(!this.cloudEnabled)shelf.push({book:sampleBook,addedAt:new Date().toISOString()});}
      else if(Array.isArray(saved?.shelf))for(const entry of saved.shelf){try{shelf.push(shelfEntry(entry));}catch{isolated++;}}
      else isolated++;
      if(isolated){
        // Preserve the original snapshot before a later source refresh saves the
        // healthy entries. A corrupt row must never make all books disappear.
        await db.put('meta',{savedAt:new Date().toISOString(),state:raw},'quarantined-state');
      }
      this.progress=progressRecords(await db.get('meta','progress'));
      const workflows=await db.get('meta','workflows');
      const updates:Record<string,BookUpdateState>={},downloads:ChapterDownloadJob[]=[];
      if(record(workflows)){
        if(record(workflows.updates))for(const [id,value]of Object.entries(workflows.updates))if(safeID(id)&&record(value)&&Number.isSafeInteger(value.knownChapterCount)&&Array.isArray(value.unreadChapterIDs))updates[id]={knownChapterCount:Number(value.knownChapterCount),lastKnownChapterID:typeof value.lastKnownChapterID==='string'?value.lastKnownChapterID:undefined,lastKnownChapterTitle:typeof value.lastKnownChapterTitle==='string'?value.lastKnownChapterTitle:undefined,unreadChapterIDs:value.unreadChapterIDs.filter(safeID),checkedAt:validDate(value.checkedAt)?value.checkedAt:undefined};
        if(Array.isArray(workflows.downloads))for(const value of workflows.downloads)if(record(value)&&safeID(value.id)&&safeID(value.bookID)&&typeof value.bookTitle==='string'&&typeof value.sourceID==='string'&&typeof value.sourceURL==='string'&&Array.isArray(value.chapterIDs)&&Array.isArray(value.completedChapterIDs)&&Array.isArray(value.failedChapterIDs)&&validDate(value.createdAt)&&validDate(value.updatedAt)){
          const status=value.engine==='server'||value.engine==='native'?value.status:value.status==='running'||value.status==='queued'?'paused':value.status;
          if(!['queued','running','paused','completed','failed','cancelled'].includes(String(status)))continue;
          const chapterIDs=value.chapterIDs.filter(safeID),completedChapterIDs=value.completedChapterIDs.filter(safeID);
          downloads.push({...value,status,chapterIDs,completedChapterIDs,failedChapterIDs:value.failedChapterIDs.filter(safeID),total:value.engine==='server'||status==='completed'||status==='cancelled'?bounded(Number(value.total),0,100000,chapterIDs.length):chapterIDs.length,completed:value.engine==='server'||status==='completed'||status==='cancelled'?bounded(Number(value.completed),0,Number(value.total)||chapterIDs.length,0):completedChapterIDs.length}as unknown as ChapterDownloadJob);
        }
      }
      const cloud=await db.get('meta','cloud');
      if(record(cloud)&&Number.isSafeInteger(cloud.cursor)&&Array.isArray(cloud.pending)&&record(cloud.revisions))this.cloud=cloud as typeof this.cloud;
      const warnings:string[]=isolated?[`已隔离 ${isolated} 条异常书架记录，原始快照已保留。`]:[];
      // Migrate early preview records: keep large files separate from catalog metadata.
      for(const old of await db.getAll('imports') as LocalPublication[]){
        try{
        if(!old||!old.book)continue;
        if(!old.file&&!old.contents)continue;
        const tx=db.transaction(['imports','files','covers','localContents'],'readwrite');
        if(old.file)await tx.objectStore('files').put(old.file,old.book.id);
        if(old.cover)await tx.objectStore('covers').put(old.cover,old.book.id);
        for(const content of old.contents||[])await tx.objectStore('localContents').put(content,contentKey(old.book,content.chapter));
        await tx.objectStore('imports').put({book:old.book,chapters:old.chapters,fileSize:old.file?.size||0},old.book.id);await tx.done;
        }catch{warnings.push('部分旧版导入文件未能迁移，原始记录保留，请释放空间后刷新重试。');}
      }
      for(const entry of shelf){try{const cover=await db.get('covers',entry.book.id) as Blob|undefined;if(cover instanceof Blob){const url=URL.createObjectURL(cover);this.coverURLs.set(entry.book.id,url);entry.book={...entry.book,coverURL:url};}}catch{warnings.push('部分封面未能读取，书籍仍保留。');}}
      const sources=Array.isArray(saved?.sources)?saved.sources.filter((source):source is SourceDefinition=>{
        if(!record(source)||!safeID(source.id)||['name','summary','homeURL'].some(key=>typeof source[key]!=='string'))return false;
        try{return new URL(source.homeURL as string).protocol==='https:';}catch{return false;}
      }):[];
      this.state={ready:true,shelf,settings:normalizeSettings(record(saved?.settings)?saved.settings:{}),sources,disabledSourceIDs:sourceIDs(saved?.disabledSourceIDs),updates,checkingUpdates:false,downloads,storageError:warnings.length?[...new Set(warnings)].join(' '):undefined};
      this.compactDownloadHistory();
    } catch(error){
      // A transient IndexedDB read failure must not replace a real library with
      // the sample shelf when the asynchronous API source refresh completes.
      this.persistenceBlocked=true;this.state={...this.state,ready:true,shelf:[]};
      this.report(new Error(`本地数据未能安全加载，原数据未覆盖。请刷新重试。${error instanceof Error?error.message:''}`));
    }
    this.emit();
  }
  private persist():Promise<void>{
    if(this.sourceCommitBarrier){this.emit();return this.sourceCommitBarrier.then(()=>this.persist());}
    if(this.persistenceBlocked){this.emit();return this.writing;}
    const saved={...this.state,updates:undefined,downloads:undefined,checkingUpdates:undefined,shelf:this.state.shelf.map(e=>({...e,book:{...e.book,coverURL:e.book.coverURL?.startsWith('blob:')?undefined:e.book.coverURL}}))};
    const progress=structuredClone(this.progress),cloud=structuredClone(this.cloud),workflows=structuredClone({updates:this.state.updates,downloads:this.state.downloads});
    this.writing=this.writing.catch(()=>{}).then(async()=>{const db=await this.db,tx=db.transaction('meta','readwrite');await tx.store.put(saved,'state');await tx.store.put(progress,'progress');await tx.store.put(cloud,'cloud');await tx.store.put(workflows,'workflows');await tx.done;}).catch(e=>this.report(e));
    this.emit();return this.writing;
  }
  private enqueue(action:CloudMutation['action'],bookID:string,entry?:ShelfEntry){
    if(!this.cloudEnabled)return;
    const previous=this.cloud.pending.find(m=>m.bookID===bookID);
    const mutation:CloudMutation={id:crypto.randomUUID(),action:action==='progress'&&previous?.action==='add'?'add':action,bookID,baseRevision:this.cloud.revisions[bookID]??0,changedAt:new Date().toISOString(),...(entry?{entry:{...entry,book:{...entry.book,coverURL:entry.book.coverURL?.startsWith('blob:')?undefined:entry.book.coverURL}}}:{})};
    this.cloud.pending=[...this.cloud.pending.filter(m=>m.bookID!==bookID),mutation];
  }
  async add(book:Book){await this.initialized;this.removedBooks.delete(book.id);if(this.state.shelf.some(e=>e.book.id===book.id))return;const entry={book,addedAt:new Date().toISOString()};this.state={...this.state,shelf:[...this.state.shelf,entry]};this.enqueue('add',book.id,entry);await this.persist();}
  async organize(bookIDs:string[],patch:Partial<Pick<ShelfOrganization,'pinned'|'status'|'group'>>){
    await this.initialized;await Promise.allSettled(bookIDs.map(id=>this.switchCommits.get(id)).filter(Boolean));
    if(!this.active)return;
    const selected=new Set(bookIDs);
    this.state={...this.state,shelf:this.state.shelf.map(entry=>{
      if(!selected.has(entry.book.id))return entry;
      const organization={pinned:false,status:'reading' as const,group:'',...entry.organization,...patch,updatedAt:new Date().toISOString()};
      const value={...entry,...libraryData({organization})};this.enqueue('add',entry.book.id,value);return value;
    })};await this.persist();
  }
  async annotate(book:Book,annotation:ReadingAnnotation){
    await this.initialized;await this.switchCommits.get(book.id);if(!this.active)return;
    await this.add(book);
    const previous=this.state.shelf.find(entry=>entry.book.id===book.id);
    if(!previous||previous.book.sourceID!==book.sourceID||previous.book.url!==book.url)throw new Error('书源已变更，请重新定位');
    const annotations=[...(previous.annotations??[]).filter(note=>note.id!==annotation.id),annotation];
    const entry={...previous,...libraryData({annotations})};
    this.state={...this.state,shelf:this.state.shelf.map(value=>value.book.id===book.id?entry:value)};
    this.enqueue('add',book.id,entry);await this.persist();
  }
  async deleteAnnotation(book:Book,id:string){
    const note=this.state.shelf.find(entry=>entry.book.id===book.id)?.annotations?.find(value=>value.id===id);if(!note)return;
    const now=new Date().toISOString();await this.annotate(book,{...note,updatedAt:now,deletedAt:now});
  }
  async searchCached(book:Book,query:string,signal?:AbortSignal):Promise<{chapter:Chapter;offset:number;excerpt:string}[]>{
    query=query.trim();if(!query||query.length>100)return[];const generation=this.generation;
    const chapters=await this.getChapters(book)??[],results:{chapter:Chapter;offset:number;excerpt:string}[]=[];
    for(const chapter of chapters){
      if(signal?.aborted||!this.active||generation!==this.generation)break;
      const value=await this.getContent(book,chapter);
      const text=value?.paragraphs.join('\n')??'';let start=0;
      while(results.length<100){const offset=text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase(),start);if(offset<0)break;results.push({chapter,offset,excerpt:text.slice(Math.max(0,offset-25),offset+query.length+60)});start=offset+Math.max(1,query.length);}
      if(results.length>=100)break;
    }
    return results;
  }
  async remove(book:Book){
    if(isAndroidApp())await nativeBackground.removeBook({profile:this.profile,bookID:book.id});
    await this.initialized;await this.switchCommits.get(book.id)?.catch(()=>{});if(this.persistenceBlocked)return;this.generation++;this.removedBooks.add(book.id);this.cancelBookDownloads(book.id);delete this.state.updates[book.id];
    this.state={...this.state,shelf:this.state.shelf.filter(e=>e.book.id!==book.id)};delete this.progress[book.id];
    this.enqueue('remove',book.id);
    await this.persist();
    const db=await this.db,tx=db.transaction(['chapters','contents','imports','meta','files','covers','localContents'],'readwrite');
    await tx.objectStore('chapters').delete(book.id);await tx.objectStore('imports').delete(book.id);await tx.objectStore('files').delete(book.id);await tx.objectStore('covers').delete(book.id);for(const key of await tx.objectStore('localContents').getAllKeys())if(String(key).startsWith(book.id+'\0'))await tx.objectStore('localContents').delete(key);
    for(const key of await tx.objectStore('contents').getAllKeys())if(String(key).startsWith(book.id+'\0'))await tx.objectStore('contents').delete(key);
    await tx.objectStore('meta').put(this.progress,'progress');await tx.done;
    const url=this.coverURLs.get(book.id);if(url)URL.revokeObjectURL(url);this.coverURLs.delete(book.id);
  }
  async savePosition(book:Book,chapter:Chapter,fraction:number,characterOffset:number){
    await this.initialized;
    const generation=this.generation,tracking=this.state.updates[book.id];
    const chapters=tracking?.unreadChapterIDs.length?await this.getChapters(book):undefined;
    const existing=this.state.shelf.find(entry=>entry.book.id===book.id);
    if(!this.active||generation!==this.generation||this.removedBooks.has(book.id)||this.invalidatingBooks.has(book.id)||this.switchCommits.has(book.id)||(existing&&(existing.book.sourceID!==book.sourceID||existing.book.url!==book.url)))return;
    const value=bounded(fraction,0,1,0),position:ReadingPosition={chapterID:chapter.id,chapterIndex:chapter.index,chapterFraction:value,characterOffset:Math.max(0,Math.floor(characterOffset)||0),updatedAt:new Date().toISOString()};
    this.state={...this.state,shelf:[...this.state.shelf.filter(entry=>entry.book.id!==book.id),{...existing,book:existing?.book||book,position,addedAt:existing?.addedAt||new Date().toISOString()}]};
    if(tracking?.unreadChapterIDs.length&&chapters){const readIndex=chapters.findIndex(item=>item.id===chapter.id);if(readIndex>=0)this.state={...this.state,updates:{...this.state.updates,[book.id]:{...tracking,unreadChapterIDs:tracking.unreadChapterIDs.filter(id=>chapters.findIndex(item=>item.id===id)>readIndex)}}};}
    this.progress[book.id]??=Object.create(null);this.progress[book.id][chapter.id]=Math.max(this.progress[book.id][chapter.id]??0,value);
    this.enqueue(existing?'progress':'add',book.id,this.state.shelf.find(entry=>entry.book.id===book.id));await this.persist();
  }
  async updateSettings(settings:Partial<ReaderSettings>){await this.initialized;this.state={...this.state,settings:normalizeSettings({...this.state.settings,...settings})};await this.persist();}
  async toggleSource(id:string){await this.initialized;const ids=new Set(this.state.disabledSourceIDs);ids.has(id)?ids.delete(id):ids.add(id);this.state={...this.state,disabledSourceIDs:[...ids]};if(ids.has(id))for(const job of [...this.state.downloads])if(job.sourceID===id&&['queued','running'].includes(job.status))await this.pauseDownload(job.id);await this.persist();}
  async initializeSources(sources:SourceDefinition[]){await this.initialized;this.state={...this.state,sources};await this.persist();}
  async getChapters(book:Book):Promise<Chapter[]|undefined>{
    if(book.id===sampleBook.id)return[sampleChapter];
    const db=await this.db,publication=await db.get('imports',book.id) as LocalPublication|undefined;
    return publication?.chapters||await db.get('chapters',book.id);
  }
  async getContent(book:Book,chapter:Chapter):Promise<ChapterContent|undefined>{
    if(book.id===sampleBook.id)return sampleContent;
    const db=await this.db,publication=await db.get('imports',book.id) as LocalPublication|undefined;
    if(publication)return await db.get('localContents',contentKey(book,chapter));
    return await db.get('contents',contentKey(book,chapter));
  }
  async cacheChapters(book:Book,chapters:Chapter[]){try{const db=await this.db,current=this.state.shelf.find(entry=>entry.book.id===book.id)?.book;if(this.invalidatingBooks.has(book.id)||this.removedBooks.has(book.id)||(current&&(current.sourceID!==book.sourceID||current.url!==book.url)))return;await db.put('chapters',chapters,book.id);}catch(e){this.report(e);}}
  async cacheContent(book:Book,content:ChapterContent){if(!content.paragraphs.length)return;try{const db=await this.db,current=this.state.shelf.find(entry=>entry.book.id===book.id)?.book;if(this.invalidatingBooks.has(book.id)||this.removedBooks.has(book.id)||(current&&(current.sourceID!==book.sourceID||current.url!==book.url)))return;await db.put('contents',content,contentKey(book,content.chapter));}catch(e){this.report(e);}}
  async chapterProgress(book:Book,chapter:Chapter){await this.initialized;return this.progress[book.id]?.[chapter.id];}
  async hasContent(book:Book,chapter:Chapter){
    if(book.id===sampleBook.id)return true;const db=await this.db,key=contentKey(book,chapter);
    return (await db.getKey('localContents',key))!==undefined||(await db.getKey('contents',key))!==undefined;
  }
  async chapterStates(book:Book,chapters:Chapter[]):Promise<Record<string,{cached:boolean;progress?:number}>>{
    await this.initialized;const db=await this.db,tx=db.transaction(['contents','localContents'],'readonly');
    const keys=new Set([...(await tx.objectStore('contents').getAllKeys()),...(await tx.objectStore('localContents').getAllKeys())]);await tx.done;
    return Object.fromEntries(chapters.map(chapter=>[chapter.id,{cached:book.id===sampleBook.id||keys.has(contentKey(book,chapter)),progress:this.progress[book.id]?.[chapter.id]}]));
  }
  async loadContent(book:Book,chapter:Chapter,signal?:AbortSignal):Promise<ChapterContent>{
    const cached=await this.getContent(book,chapter);if(cached)return cached;
    if(signal?.aborted)throw new DOMException('已取消','AbortError');
    const generation=this.generation,key=contentKey(book,chapter)+'\0'+book.sourceID+'\0'+book.url+'\0'+generation;
    let pending=this.requests.get(key);
    if(!pending){
      const controller=new AbortController(),request={controller,readers:0,promise:undefined as unknown as Promise<ChapterContent>};
      request.promise=api.content(book,chapter,controller.signal).finally(()=>{if(this.requests.get(key)===request)this.requests.delete(key);});
      pending=request;this.requests.set(key,request);
    }
    pending.readers++;
    let onAbort:(()=>void)|undefined;
    try{
      const content=signal?await Promise.race([pending.promise,new Promise<never>((_resolve,reject)=>{onAbort=()=>reject(new DOMException('已取消','AbortError'));if(signal.aborted)onAbort();else signal.addEventListener('abort',onAbort,{once:true});})]):await pending.promise;
      if(signal?.aborted||generation!==this.generation)throw new DOMException('书籍或缓存已变更','AbortError');
      await this.cacheContent(book,content);return content;
    }finally{
      if(onAbort)signal?.removeEventListener('abort',onAbort);pending.readers--;
      if(!pending.readers&&signal?.aborted){pending.controller.abort();if(this.requests.get(key)===pending)this.requests.delete(key);}
    }
  }
  async prefetch(book:Book,chapters:Chapter[],index:number,signal?:AbortSignal){
    const generation=this.generation;
    if(book.id===sampleBook.id||book.sourceID==='local-file'||this.state.disabledSourceIDs.includes(book.sourceID))return;
    for(const chapter of chapters.slice(index+1,index+11)){
      if(signal?.aborted||generation!==this.generation)return;
      try{await this.loadContent(book,chapter,signal);}catch{return;}
    }
  }
  async getPublication(book:Book):Promise<Blob|undefined>{return await(await this.db).get('files',book.id);}
  async importFile(file:File,metadata?:Book){
    await this.initialized;if(this.persistenceBlocked)throw new Error('本地数据尚未安全加载，请刷新后再导入');const publication=await parsePublication(file,metadata,this.state.shelf.map(e=>e.book)),db=await this.db;
    if(await db.get('imports',publication.book.id))return this.state.shelf.find(e=>e.book.id===publication.book.id)?.book||publication.book;
    const tx=db.transaction(['imports','files','covers','localContents'],'readwrite');
    await tx.objectStore('imports').put({book:publication.book,chapters:publication.chapters,fileSize:publication.file?.size||0},publication.book.id);
    if(publication.file)await tx.objectStore('files').put(publication.file,publication.book.id);
    if(publication.cover)await tx.objectStore('covers').put(publication.cover,publication.book.id);
    for(const content of publication.contents)await tx.objectStore('localContents').put(content,contentKey(publication.book,content.chapter));
    await tx.done;
    if(publication.cover){const url=URL.createObjectURL(publication.cover);this.coverURLs.set(publication.book.id,url);publication.book={...publication.book,coverURL:url};}
    const existing=this.state.shelf.find(entry=>entry.book.id===publication.book.id);
    if(existing){
      existing.book={...existing.book,fileHash:publication.book.fileHash,coverURL:publication.book.coverURL??existing.book.coverURL};
      this.enqueue('add',existing.book.id,existing);await this.persist();return existing.book;
    }
    await this.add(publication.book);return publication.book;
  }
  async clearCache(){if(this.serverConnection)for(const job of this.state.downloads)if(job.engine==='server'&&!['completed','cancelled'].includes(job.status))await serverDownloads.action(this.serverConnection,job.id,'cancel');const nativeDB=await this.db,ignored=await nativeDB.get('meta','server-downloads-ignored')??{};for(const j of this.state.downloads)if(j.engine==='server')ignored[j.id]=true;await nativeDB.put('meta',ignored,'server-downloads-ignored');await nativeDB.delete('meta','server-downloads-saved');this.serverSaveAttempts.clear();if(isAndroidApp())await nativeBackground.clearCache({profile:this.profile});this.generation++;await this.pauseDownloadsForBackground();const db=await this.db,tx=db.transaction(['chapters','contents'],'readwrite');await Promise.all([tx.objectStore('chapters').clear(),tx.objectStore('contents').clear()]);await tx.done;this.emit();}
  async cacheStats(){const db=await this.db;const contents=await db.getAll('contents') as ChapterContent[];const imports=await db.getAll('imports') as {chapters:Chapter[];fileSize:number}[];return{chapters:contents.length+imports.reduce((n,p)=>n+p.chapters.length,0),bytes:contents.reduce((n,c)=>n+new TextEncoder().encode(JSON.stringify(c)).byteLength,0)+imports.reduce((n,p)=>n+p.fileSize,0)};}
  async exportBackup(){await this.initialized;if(this.persistenceBlocked)throw new Error('本地数据尚未安全加载，请刷新后再导出');await this.writing;return new Blob([JSON.stringify({format:'qingread-backup',version:1,anchorFormat:'body-utf16-v1',exportedAt:new Date().toISOString(),shelf:this.state.shelf.map(e=>({...e,book:{...e.book,coverURL:e.book.coverURL?.startsWith('blob:')?undefined:e.book.coverURL}})),settings:this.state.settings,disabledSourceIDs:this.state.disabledSourceIDs,progress:this.progress},null,2)],{type:'application/json'});}
  async importBackup(file:File){
    if(file.size>10*1024*1024)throw new Error('书架备份最大支持 10 MB');
    const data:unknown=JSON.parse(await file.text());
    if(!record(data)||data.format!=='qingread-backup'||data.version!==1||!Array.isArray(data.shelf)||data.shelf.length>5000)throw new Error('这不是支持的清读网页书架备份');
    // Validate the entire payload before touching either memory or IndexedDB.
    const shelf=data.shelf.map(shelfEntry),incomingProgress=progressRecords(data.progress,true);
    if(data.settings!==undefined&&!record(data.settings))throw new Error('备份包含无效阅读设置');
    if(data.disabledSourceIDs!==undefined&&(!Array.isArray(data.disabledSourceIDs)||data.disabledSourceIDs.some(id=>!safeID(id))))throw new Error('备份包含无效书源设置');
    await this.initialized;if(this.persistenceBlocked)throw new Error('本地数据尚未安全加载，请刷新后再恢复备份');
    await this.writing;
    const merged=new Map(this.state.shelf.map(e=>[e.book.id,e]));
    for(const entry of shelf){const previous=merged.get(entry.book.id);if(!previous||Date.parse(entry.position?.updatedAt||entry.addedAt)>Date.parse(previous.position?.updatedAt||previous.addedAt))merged.set(entry.book.id,entry);}
    const progress=progressRecords(this.progress);
    for(const [bookID,chapters]of Object.entries(incomingProgress)){progress[bookID]??=Object.create(null);for(const [id,fraction]of Object.entries(chapters))progress[bookID][id]=Math.max(progress[bookID][id]??0,fraction);}
    const state:LibraryState={...this.state,shelf:[...merged.values()],settings:normalizeSettings(data.settings||{}),disabledSourceIDs:data.disabledSourceIDs===undefined?this.state.disabledSourceIDs:sourceIDs(data.disabledSourceIDs)};
    const db=await this.db,tx=db.transaction('meta','readwrite');
    await tx.store.put(state,'state');await tx.store.put(progress,'progress');await tx.done;
    this.progress=progress;
    this.state={...state,shelf:state.shelf.map(entry=>{const cover=this.coverURLs.get(entry.book.id);return cover?{...entry,book:{...entry.book,coverURL:cover}}:entry;})};
    for(const entry of shelf)this.enqueue('add',entry.book.id,this.state.shelf.find(e=>e.book.id===entry.book.id));
    await this.persist();
  }
  /** Refresh directories serially. Automatic checks have a 15-minute per-book cooldown. */
  async checkForUpdates(book?:Book,options:{force?:boolean}={}):Promise<UpdateCheckResult>{
    await this.initialized;
    const result:UpdateCheckResult={checked:0,updated:0,failures:[]};
    if(!this.active||this.persistenceBlocked||this.state.checkingUpdates)return result;
    const controller=new AbortController(),generation=this.workflowGeneration;this.updateAbort=controller;
    const targets=(book?[book]:this.state.shelf.map(entry=>entry.book)).filter(value=>isChapterBook(value)&&!this.state.disabledSourceIDs.includes(value.sourceID));
    this.state={...this.state,checkingUpdates:true};this.emit();
    try{for(const target of targets){
      if(controller.signal.aborted||generation!==this.workflowGeneration||!this.active)break;
      const current=this.state.shelf.find(entry=>entry.book.id===target.id)?.book;
      if(!current||current.sourceID!==target.sourceID||current.url!==target.url)continue;
      const tracking=this.state.updates[target.id],cooldown=options.force?60_000:15*60_000;
      if(tracking?.checkedAt&&Date.now()-Date.parse(tracking.checkedAt)<cooldown)continue;
      const previous=await this.getChapters(target),last=previous?.at(-1);
      const baseline:BookUpdateState=tracking??{knownChapterCount:previous?.length??0,lastKnownChapterID:last?.id,lastKnownChapterTitle:last?.title,unreadChapterIDs:[]};
      this.state={...this.state,updates:{...this.state.updates,[target.id]:{...baseline,checkedAt:new Date().toISOString(),checking:true,error:undefined}}};await this.persist();
      try{
        const chapters=await api.chapters(target,controller.signal);
        if(!chapters.length)throw new Error('目录为空');
        const latest=this.state.shelf.find(entry=>entry.book.id===target.id);
        if(controller.signal.aborted||generation!==this.workflowGeneration||!latest||latest.book.sourceID!==target.sourceID||latest.book.url!==target.url)break;
        const appended=appendedChapters(baseline,chapters),readIndex=chapters.findIndex(chapter=>chapter.id===latest.position?.chapterID);
        const unread=new Set([...baseline.unreadChapterIDs,...appended.map(chapter=>chapter.id)]);
        const unreadChapterIDs=chapters.filter((chapter,index)=>unread.has(chapter.id)&&index>readIndex).map(chapter=>chapter.id);
        await this.cacheChapters(target,chapters);
        const end=chapters.at(-1)!;
        this.state={...this.state,updates:{...this.state.updates,[target.id]:{knownChapterCount:chapters.length,lastKnownChapterID:end.id,lastKnownChapterTitle:end.title,unreadChapterIDs,checkedAt:new Date().toISOString()}}};
        result.checked++;if(appended.length)result.updated++;
      }catch(error){
        if(controller.signal.aborted)break;
        const message=error instanceof Error?error.message:'检查失败';result.failures.push(`${target.title}：${message}`);
        this.state={...this.state,updates:{...this.state.updates,[target.id]:{...baseline,checkedAt:new Date().toISOString(),error:message}}};
      }
      await this.persist();
    }}finally{
      const updates=Object.fromEntries(Object.entries(this.state.updates).map(([id,value])=>[id,{...value,checking:false}]));
      this.state={...this.state,checkingUpdates:false,updates};if(this.updateAbort===controller)this.updateAbort=undefined;await this.persist();
    }
    return result;
  }
  async findSourceCandidates(book:Book,signal?:AbortSignal):Promise<Book[]>{
    await this.initialized;if(!this.active||!isChapterBook(book))return[];const generation=this.workflowGeneration;
    const sourceIDs=this.state.sources.filter(source=>!this.state.disabledSourceIDs.includes(source.id)).map(source=>source.id);
    if(!sourceIDs.length)return[];
    const response=await api.search(book.title,sourceIDs,signal);
    if(!this.active||generation!==this.workflowGeneration||signal?.aborted)return[];
    if(!response.books.length&&response.failures.length>=sourceIDs.length)throw new Error('书源暂时无法连接，请稍后重试');
    return response.books.filter(candidate=>sameEditionTitle(book,candidate)&&!this.state.disabledSourceIDs.includes(candidate.sourceID)&&(candidate.sourceID!==book.sourceID||candidate.url!==book.url));
  }
  async prepareSourceSwitch(book:Book,candidate:Book,signal?:AbortSignal):Promise<SourceSwitchPlan>{
    await this.initialized;const generation=this.generation;
    const original=this.state.shelf.find(entry=>entry.book.id===book.id);
    if(!this.active||!original||original.book.sourceID!==book.sourceID||original.book.url!==book.url)throw new Error('书籍已变更，请重新选择');
    if(!isChapterBook(book)||!sameEditionTitle(book,candidate)||this.state.disabledSourceIDs.includes(candidate.sourceID)||(candidate.sourceID===book.sourceID&&candidate.url===book.url))throw new Error('无法使用此书源');
    const oldChapters=await this.getChapters(book)??await api.chapters(book,signal);
    const chapters=await api.chapters(candidate,signal);if(!chapters.length)throw new Error('新书源目录为空');
    if(signal?.aborted||generation!==this.generation||!this.active)throw new Error('操作已取消');
    const matched=original.position?matchChapter(oldChapters.find(chapter=>chapter.id===original.position?.chapterID),chapters):{matchedChapterID:chapters[0].id,match:'title' as const};
    const plan:SourceSwitchPlan={bookID:book.id,originalSourceID:book.sourceID,originalURL:book.url,candidate,chapters,position:original.position?{...original.position}:undefined,...matched};
    this.switchPlans.set(plan,generation);return plan;
  }
  async commitSourceSwitch(plan:SourceSwitchPlan,chapterID?:string,signal?:AbortSignal):Promise<Book>{
    if(this.switchCommits.has(plan.bookID))throw new Error('正在切换书源');
    const pending=this.performSourceSwitch(plan,chapterID,signal);this.switchCommits.set(plan.bookID,pending);
    try{return await pending;}catch(error){if(signal?.aborted){this.switchPlans.delete(plan);throw new DOMException('已取消','AbortError');}throw error;}finally{this.switchCommits.delete(plan.bookID);}
  }
  private async performSourceSwitch(plan:SourceSwitchPlan,chapterID?:string,signal?:AbortSignal):Promise<Book>{
    await this.initialized;
    const generation=this.switchPlans.get(plan);
    const valid=()=>!signal?.aborted&&this.active&&generation!==undefined&&generation===this.generation&&!this.state.disabledSourceIDs.includes(plan.candidate.sourceID)&&this.state.shelf.some(entry=>entry.book.id===plan.bookID&&entry.book.sourceID===plan.originalSourceID&&entry.book.url===plan.originalURL&&(entry.position?.chapterID===plan.position?.chapterID));
    if(!valid())throw new Error('书籍或账号已变更，请重新选择书源');
    const chapter=plan.chapters.find(value=>value.id===(chapterID??plan.matchedChapterID));
    if(!chapter)throw new Error('请选择对应章节');
    const downloaded=await api.content(plan.candidate,chapter,signal);if(!downloaded.paragraphs.length)throw new Error('新书源正文为空');
    await this.writing;const db=await this.db;if(!valid())throw new Error('书籍或账号已变更，请重新选择书源');
    const existing=this.state.shelf.find(entry=>entry.book.id===plan.bookID)!;
    const book:Book={...plan.candidate,id:plan.bookID},content:ChapterContent={...downloaded,chapter};
    const entry:ShelfEntry={...existing,book,position:remappedPosition(chapter,existing.position,content.paragraphs.join('\n').length)};
    // Keep the published snapshot on the old source until IndexedDB commits.
    // Queue and update callbacks can still change their own state meanwhile;
    // defer their persistence, then merge those changes into the new snapshot.
    let release!:()=>void;
    this.sourceCommitBarrier=new Promise<void>(resolve=>{release=resolve;});
    this.invalidatingBooks.add(book.id);this.generation++;this.requests.clear();this.cancelBookDownloads(book.id);
    const end=plan.chapters.at(-1)!;
    const tracking:BookUpdateState={knownChapterCount:plan.chapters.length,lastKnownChapterID:end.id,lastKnownChapterTitle:end.title,unreadChapterIDs:[],checkedAt:new Date().toISOString()};
    const replacementState=():LibraryState=>({...this.state,shelf:this.state.shelf.map(value=>value.book.id===book.id?entry:value),updates:{...this.state.updates,[book.id]:tracking}});
    const replacementProgress=()=>({...this.progress,[book.id]:{[chapter.id]:entry.position!.chapterFraction}});
    const mutation:CloudMutation={id:crypto.randomUUID(),action:'add',bookID:book.id,baseRevision:this.cloud.revisions[book.id]??0,changedAt:new Date().toISOString(),entry};
    const replacementCloud=()=>this.cloudEnabled?{...this.cloud,pending:[...this.cloud.pending.filter(value=>value.bookID!==book.id),mutation]}:this.cloud;
    let abortTransaction:(()=>void)|undefined,transactionDone:Promise<unknown>|undefined,onAbort:(()=>void)|undefined;
    try{
      const tx=db.transaction(['chapters','contents','meta'],'readwrite');abortTransaction=()=>tx.abort();transactionDone=tx.done;onAbort=()=>{try{tx.abort();}catch{/* A finished transaction remains committed. */}};signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();
      await tx.objectStore('chapters').delete(book.id);
      for(const key of await tx.objectStore('contents').getAllKeys())if(String(key).startsWith(book.id+'\0'))await tx.objectStore('contents').delete(key);
      await tx.objectStore('chapters').put(plan.chapters,book.id);await tx.objectStore('contents').put(content,contentKey(book,chapter));
      await tx.objectStore('meta').put(replacementState(),'state');await tx.objectStore('meta').put(replacementProgress(),'progress');await tx.objectStore('meta').put(replacementCloud(),'cloud');await tx.objectStore('meta').put({updates:{...this.state.updates,[book.id]:tracking},downloads:this.state.downloads},'workflows');await tx.done;
      this.state=replacementState();this.progress=replacementProgress();this.cloud=replacementCloud();this.switchPlans.delete(plan);
    }catch(error){try{abortTransaction?.();}catch{/* Already aborted transactions need no second abort. */}await transactionDone?.catch(()=>{});throw error;}
    finally{
      if(onAbort)signal?.removeEventListener('abort',onAbort);this.invalidatingBooks.delete(book.id);this.sourceCommitBarrier=undefined;release();this.emit();
    }
    return book;
  }
  private compactDownloadHistory(){
    const ended=this.state.downloads.filter(job=>['completed','cancelled','failed'].includes(job.status)).sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt));
    const retained=new Set(ended.slice(0,20).map(job=>job.id));
    this.state={...this.state,downloads:this.state.downloads.filter(job=>!['completed','cancelled','failed'].includes(job.status)||retained.has(job.id)).map(job=>job.status==='completed'||job.status==='cancelled'?{...job,chapterIDs:[],completedChapterIDs:[],failedChapterIDs:[]}:job)};
  }
  private patchDownload(id:string,patch:Partial<ChapterDownloadJob>){this.state={...this.state,downloads:this.state.downloads.map(job=>job.id===id?{...job,...patch,updatedAt:new Date().toISOString()}:job)};if(patch.status&&['completed','cancelled','failed'].includes(patch.status))this.compactDownloadHistory();this.emit();}
  private cancelBookDownloads(bookID:string){if(this.serverConnection&&this.active)for(const job of this.state.downloads)if(job.bookID===bookID&&job.engine==='server'&&!['completed','cancelled'].includes(job.status))void serverDownloads.action(this.serverConnection,job.id,'cancel').catch(()=>{});if(isAndroidApp()&&this.active)void nativeBackground.removeBook({profile:this.profile,bookID}).catch(e=>this.report(e));for(const job of this.state.downloads)if(job.bookID===bookID&&['queued','running','paused','failed'].includes(job.status)){if(job.status==='running')this.downloadAbort?.abort();this.patchDownload(job.id,{status:'cancelled'});}}
  async enqueueDownload(book:Book,selection:ChapterDownloadSelection):Promise<ChapterDownloadJob>{
    await this.initialized;
    if(!this.active||!isChapterBook(book)||this.state.disabledSourceIDs.includes(book.sourceID))throw new Error('此书无法下载章节');
    const saved=this.state.shelf.find(entry=>entry.book.id===book.id);if(!saved||saved.book.sourceID!==book.sourceID||saved.book.url!==book.url)throw new Error('请先将书籍加入书架');
    const chapters=await this.getChapters(book)??await api.chapters(book);if(!chapters.length)throw new Error('目录为空');
    const current=Math.max(0,chapters.findIndex(chapter=>chapter.id===saved.position?.chapterID));
    let targets:Chapter[];
    if(selection.kind==='all')targets=chapters;
    else if(selection.kind==='next')targets=chapters.slice(current,current+selection.count);
    else{const {from,to}=selection;if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<from||to>=chapters.length)throw new Error('请选择有效的章节范围');targets=chapters.slice(from,to+1);}
    if(!this.active||this.state.disabledSourceIDs.includes(book.sourceID)||!this.state.shelf.some(entry=>entry.book.id===book.id&&entry.book.sourceID===book.sourceID&&entry.book.url===book.url))throw new Error('书籍或账号已变更');
    await this.cacheChapters(book,chapters);
    const states=await this.chapterStates(book,targets),completedChapterIDs=targets.filter(chapter=>states[chapter.id].cached).map(chapter=>chapter.id),now=new Date().toISOString();
    const job:ChapterDownloadJob={id:crypto.randomUUID(),bookID:book.id,bookTitle:book.title,sourceID:book.sourceID,sourceURL:book.url,status:completedChapterIDs.length===targets.length?'completed':'queued',chapterIDs:targets.map(chapter=>chapter.id),total:targets.length,completed:completedChapterIDs.length,completedChapterIDs,failedChapterIDs:[],createdAt:now,updatedAt:now};
    const duplicate=this.state.downloads.find(value=>['queued','running','paused'].includes(value.status)&&value.bookID===book.id&&value.sourceID===book.sourceID&&value.sourceURL===book.url&&value.chapterIDs.length===job.chapterIDs.length&&value.chapterIDs.every((id,index)=>id===job.chapterIDs[index]));
    if(duplicate){if(duplicate.status==='paused')await this.resumeDownload(duplicate.id);return this.state.downloads.find(value=>value.id===duplicate.id)!;}
    if(isAndroidApp()){
      const result=await nativeBackground.enqueue({profile:this.profile,job:{id:job.id,book,chapters:targets,completedChapterIDs}});
      if(!this.active)throw new Error('账号已切换');this.state={...this.state,downloads:[{...result.job,engine:'native'},...this.state.downloads]};this.compactDownloadHistory();await this.persist();return result.job;
    }
    if(this.serverConnection&&completedChapterIDs.length<targets.length){
      const created=await serverDownloads.create(this.serverConnection,book.id,targets.filter(c=>!completedChapterIDs.includes(c.id)));
      if(!this.active)throw new Error('账号已切换');const ownDB=await this.db,owned=await ownDB.get('meta','server-downloads-owned')??{};owned[created.id]=true;await ownDB.put('meta',owned,'server-downloads-owned');this.state={...this.state,downloads:[created,...this.state.downloads.filter(j=>j.id!==created.id)]};await this.persist();return created;
    }
    this.state={...this.state,downloads:[job,...this.state.downloads]};this.compactDownloadHistory();await this.persist();this.startDownloadRunner();return this.state.downloads.find(value=>value.id===job.id)??job;
  }
  async pauseDownload(id:string){if(this.state.downloads.some(j=>j.id===id&&j.engine==='server')&&this.serverConnection){await serverDownloads.action(this.serverConnection,id,'pause');await this.syncServerDownloads();return;}if(isAndroidApp()&&this.state.downloads.some(j=>j.id===id&&j.engine==='native')){await nativeBackground.pause({profile:this.profile,id});await this.syncNativeBackground();return;}const job=this.state.downloads.find(value=>value.id===id);if(!job||!['queued','running'].includes(job.status))return;if(job.status==='running')this.downloadAbort?.abort();this.patchDownload(id,{status:'paused'});await this.persist();}
  async resumeDownload(id:string){const candidate=this.state.downloads.find(j=>j.id===id),current=candidate&&this.state.shelf.find(e=>e.book.id===candidate.bookID)?.book;if(candidate&&(!this.active||!current||current.sourceID!==candidate.sourceID||current.url!==candidate.sourceURL||this.state.disabledSourceIDs.includes(candidate.sourceID)))throw new Error('当前书源不可用');if(this.state.downloads.some(j=>j.id===id&&j.engine==='server')&&this.serverConnection){await serverDownloads.action(this.serverConnection,id,'resume');await this.syncServerDownloads();return;}await this.initialized;const job=this.state.downloads.find(value=>value.id===id);if(!job||!['paused','failed'].includes(job.status))return;const book=this.state.shelf.find(entry=>entry.book.id===job.bookID)?.book;if(!this.active||!book||book.sourceID!==job.sourceID||book.url!==job.sourceURL||this.state.disabledSourceIDs.includes(job.sourceID))throw new Error('当前书源不可用');if(isAndroidApp()){const native=(await nativeBackground.list({profile:this.profile})).jobs.find(j=>j.id===id);if(native)await nativeBackground.resume({profile:this.profile,id});else{const chapters=(await this.getChapters(book)??await api.chapters(book)).filter(c=>job.chapterIDs.includes(c.id));await nativeBackground.enqueue({profile:this.profile,job:{id,book,chapters,completedChapterIDs:job.completedChapterIDs}});}await this.syncNativeBackground();return;}this.patchDownload(id,{status:'queued',error:undefined,failedChapterIDs:[]});await this.persist();this.startDownloadRunner();}
  async retryDownload(id:string){return this.resumeDownload(id);}
  async cancelDownload(id:string){if(this.state.downloads.some(j=>j.id===id&&j.engine==='server')&&this.serverConnection){await serverDownloads.action(this.serverConnection,id,'cancel');await this.syncServerDownloads();return;}if(isAndroidApp()&&this.state.downloads.some(j=>j.id===id&&j.engine==='native')){await nativeBackground.cancel({profile:this.profile,id});await this.syncNativeBackground();return;}const job=this.state.downloads.find(value=>value.id===id);if(!job)return;if(job.status==='running')this.downloadAbort?.abort();this.patchDownload(id,{status:'cancelled'});await this.persist();}
  async pauseDownloadsForBackground(){if(isAndroidApp())return;for(const job of this.state.downloads)if(job.engine!=='server'&&['queued','running'].includes(job.status))this.patchDownload(job.id,{status:'paused'});this.downloadAbort?.abort();await this.persist();}
  private startDownloadRunner(){if(isAndroidApp()||this.downloadRunner||!this.active)return;this.downloadRunner=this.runDownloads().catch(async error=>{for(const job of this.state.downloads)if(job.status==='running')this.patchDownload(job.id,{status:'failed',error:error instanceof Error?error.message:'下载失败'});await this.persist();}).finally(()=>{this.downloadRunner=undefined;if(this.active&&this.state.downloads.some(job=>job.engine!=='server'&&job.engine!=='native'&&job.status==='queued'))this.startDownloadRunner();});}
  async syncNativeBackground(){
    if(!isAndroidApp()||!this.active||this.nativeSyncing)return;this.nativeSyncing=true;
    try{
      const generation=this.generation,db=await this.db;
      for(let round=0;round<10;round++){
        const {items}=await nativeBackground.readCompleted({profile:this.profile,limit:20});if(!this.active||generation!==this.generation)return;
        const ids:string[]=[];
        for(const item of items){
          const current=this.state.shelf.find(e=>e.book.id===item.book.id)?.book;
          if(!current||this.invalidatingBooks.has(current.id)||this.state.disabledSourceIDs.includes(current.sourceID))continue;
          if(current.sourceID===item.book.sourceID&&current.url===item.book.url)await db.put('contents',item.content,contentKey(current,item.content.chapter));
          if(!this.active||generation!==this.generation)return;ids.push(item.id);
        }
        if(ids.length)await nativeBackground.acknowledge({profile:this.profile,ids});if(items.length<20)break;
      }
      const [{jobs},{updates}]=await Promise.all([nativeBackground.list({profile:this.profile}),nativeBackground.updates({profile:this.profile})]);if(!this.active||generation!==this.generation)return;
      const safe=jobs.map(job=>({...job,engine:'native' as const})).filter(job=>this.state.shelf.some(e=>e.book.id===job.bookID&&e.book.sourceID===job.sourceID&&e.book.url===job.sourceURL));
      this.state={...this.state,updates:{...this.state.updates}};
      for(const [id,value]of Object.entries(updates)){const entry=this.state.shelf.find(e=>e.book.id===id);if(!entry||Date.parse(value.checkedAt??'')<(Date.parse(this.state.updates[id]?.checkedAt??'')||0)||!value.checkedAt)continue;const chapters=await this.getChapters(entry.book)??[];if(!this.active||generation!==this.generation)return;const current=this.state.shelf.find(e=>e.book.id===id);if(!current||current.book.sourceID!==entry.book.sourceID||current.book.url!==entry.book.url)continue;const read=chapters.findIndex(c=>c.id===current.position?.chapterID);this.state.updates[id]={...value,unreadChapterIDs:value.unreadChapterIDs.filter(chapterID=>{const index=chapters.findIndex(c=>c.id===chapterID);return index<0||index>read;})};}
      if(safe.some(job=>this.state.downloads.find(old=>old.id===job.id)?.updatedAt!==job.updatedAt)||safe.length!==this.state.downloads.length)this.state={...this.state,downloads:[...safe,...this.state.downloads.filter(job=>job.engine!=='native'&&!safe.some(n=>n.id===job.id))]};
      await this.persist();
    }catch(e){if(this.active)this.report(e);}finally{this.nativeSyncing=false;}
  }
  async syncServerDownloads(){
    const connection=this.serverConnection;if(isAndroidApp()||!connection||!this.active||this.serverSyncing)return;this.serverSyncing=true;
    try{
      const db=await this.db,{jobs}=await serverDownloads.list(connection);if(!this.active||this.serverConnection!==connection)return;
      const saved=(await db.get('meta','server-downloads-saved')??{}) as Record<string,string>,owned=await db.get('meta','server-downloads-owned')??{},ignored=await db.get('meta','server-downloads-ignored')??{};
      const valid=jobs.filter(job=>this.state.shelf.some(e=>e.book.id===job.bookID&&e.book.sourceID===job.sourceID&&e.book.url===job.sourceURL));
      this.state={...this.state,downloads:[...valid.map(job=>({...job,storedOnDevice:saved[job.id]===job.updatedAt&&!ignored[job.id]})),...this.state.downloads.filter(job=>job.engine!=='server')]};this.compactDownloadHistory();this.emit();
      for(const job of valid){
        if(!owned[job.id]||ignored[job.id]||job.status!=='completed'||saved[job.id]===job.updatedAt||Date.now()-(this.serverSaveAttempts.get(job.id)??0)<60_000||this.state.disabledSourceIDs.includes(job.sourceID))continue;
        this.serverSaveAttempts.set(job.id,Date.now());await this.saveServerDownload(job,connection);if(!this.active||this.serverConnection!==connection)return;saved[job.id]=job.updatedAt;
      }
      await this.persist();
    }catch(e){if(this.active)this.report(e);}finally{this.serverSyncing=false;}
  }
  async savePreparedDownload(id:string){const connection=this.serverConnection;if(!connection||!this.active)throw new Error('请先登录');const job=(await serverDownloads.list(connection)).jobs.find(j=>j.id===id);if(!job)throw new Error('云端任务已失效');const db=await this.db,owned=await db.get('meta','server-downloads-owned')??{},ignored=await db.get('meta','server-downloads-ignored')??{};owned[id]=true;delete ignored[id];await db.put('meta',owned,'server-downloads-owned');await db.put('meta',ignored,'server-downloads-ignored');await this.saveServerDownload(job,connection);await this.persist();}
  private async saveServerDownload(job:ServerDownloadJob,connection:ServerDownloadConnection){
    const generation=this.generation,db=await this.db;
    await serverDownloads.save(connection,job.id,async content=>{
      const current=this.state.shelf.find(e=>e.book.id===job.bookID)?.book;
      if(!this.active||generation!==this.generation||this.serverConnection!==connection||!current||current.sourceID!==job.sourceID||current.url!==job.sourceURL||this.state.disabledSourceIDs.includes(job.sourceID))throw new Error('账号或书源已变更');
      await db.put('contents',content,contentKey(current,content.chapter));
    });
    if(!this.active||generation!==this.generation||this.serverConnection!==connection)return;
    const saved=await db.get('meta','server-downloads-saved')??{};saved[job.id]=job.updatedAt;await db.put('meta',saved,'server-downloads-saved');this.patchDownload(job.id,{storedOnDevice:true});
  }
  private async runDownloads(){
    while(this.active){
      const job=[...this.state.downloads].reverse().find(value=>value.engine!=='server'&&value.engine!=='native'&&value.status==='queued');if(!job)return;
      const book=this.state.shelf.find(entry=>entry.book.id===job.bookID)?.book;
      if(!book||book.sourceID!==job.sourceID||book.url!==job.sourceURL||this.state.disabledSourceIDs.includes(job.sourceID)){this.patchDownload(job.id,{status:'paused',error:'书籍或书源已变更'});await this.persist();continue;}
      const controller=new AbortController();this.downloadAbort=controller;this.patchDownload(job.id,{status:'running',error:undefined});await this.persist();
      const chapters=await this.getChapters(book),completed=new Set(job.completedChapterIDs),failed:string[]=[];let lastError:string|undefined,lastPersisted=Date.now();
      for(const id of job.chapterIDs){
        if(controller.signal.aborted||!this.active||this.state.downloads.find(value=>value.id===job.id)?.status!=='running')break;
        const chapter=chapters?.find(value=>value.id===id);if(!chapter){failed.push(id);lastError='章节已从目录移除';continue;}
        let success=false;
        for(let attempt=0;attempt<3;attempt++){
          if(controller.signal.aborted)break;
          try{await this.loadContent(book,chapter,controller.signal);if(!await this.hasContent(book,chapter))throw new Error('本地保存失败');success=true;break;}
          catch(error){if(controller.signal.aborted)break;lastError=error instanceof Error?error.message:'下载失败';if(attempt<2)await new Promise(resolve=>setTimeout(resolve,250*(attempt+1)));}
        }
        if(controller.signal.aborted)break;
        if(success)completed.add(id);else failed.push(id);
        this.patchDownload(job.id,{completed:completed.size,completedChapterIDs:[...completed],failedChapterIDs:[...failed],error:failed.length?lastError:undefined});if(completed.size%5===0||Date.now()-lastPersisted>2000){await this.persist();lastPersisted=Date.now();}
      }
      if(this.state.downloads.find(value=>value.id===job.id)?.status==='running')this.patchDownload(job.id,{status:controller.signal.aborted?'paused':failed.length?'failed':'completed',error:failed.length?lastError:undefined,failedChapterIDs:failed,completed:completed.size,completedChapterIDs:[...completed]});
      if(this.downloadAbort===controller)this.downloadAbort=undefined;await this.persist();
    }
  }
  async setProfileActive(active:boolean){this.active=active;if(!active){this.serverConnection=undefined;this.generation++;this.workflowGeneration++;this.switchPlans=new WeakMap();this.updateAbort?.abort();await this.pauseDownloadsForBackground();}}

  async syncRequest(){await this.initialized;await this.writing;const mutations:CloudMutation[]=[];let bytes=0;for(const m of this.cloud.pending.slice(0,50)){const size=new TextEncoder().encode(JSON.stringify(m)).length;if(mutations.length&&bytes+size>2*1024*1024)break;mutations.push(m);bytes+=size;}return{cursor:this.cloud.cursor,mutations:structuredClone(mutations)};}
  hasPendingSync(){return this.cloud.pending.length>0;}
  async acceptSync(snapshot:CloudSnapshot){
    await this.initialized;await Promise.allSettled([...this.switchCommits.values()]);
    const ack=new Set(snapshot.acknowledged);
    this.cloud.pending=this.cloud.pending.filter(m=>!ack.has(m.id));
    const pending=new Set(this.cloud.pending.map(m=>m.bookID));
    this.cloud.deferred??={};
    for(const remote of snapshot.records){
      if(remote.revision<(this.cloud.revisions[remote.bookID]??0))continue;
      this.cloud.revisions[remote.bookID]=remote.revision;this.cloud.deferred[remote.bookID]=remote;
    }
    for(const [bookID,remote]of Object.entries(this.cloud.deferred)){
      if(pending.has(bookID))continue;
      const previous=this.state.shelf.find(entry=>entry.book.id===bookID);
      if(remote.entry){
        const entry=shelfEntry(remote.entry);
        if(previous&&(previous.book.sourceID!==entry.book.sourceID||previous.book.url!==entry.book.url)){
          this.invalidatingBooks.add(bookID);this.generation++;this.requests.clear();this.cancelBookDownloads(bookID);
          try{
            const db=await this.db,tx=db.transaction(['chapters','contents'],'readwrite');
            await tx.objectStore('chapters').delete(bookID);for(const key of await tx.objectStore('contents').getAllKeys())if(String(key).startsWith(bookID+'\0'))await tx.objectStore('contents').delete(key);await tx.done;
            delete this.progress[bookID];delete this.state.updates[bookID];
          }finally{this.invalidatingBooks.delete(bookID);}
        }
        this.removedBooks.delete(bookID);const cover=this.coverURLs.get(bookID);if(cover)entry.book={...entry.book,coverURL:cover};
        this.state={...this.state,shelf:[...this.state.shelf.filter(value=>value.book.id!==bookID),entry]};
        if(entry.position){this.progress[bookID]??=Object.create(null);this.progress[bookID][entry.position.chapterID]=Math.max(this.progress[bookID][entry.position.chapterID]??0,entry.position.chapterFraction);}
      }else if(previous){
        this.generation++;this.removedBooks.add(bookID);this.cancelBookDownloads(bookID);delete this.progress[bookID];delete this.state.updates[bookID];this.state={...this.state,shelf:this.state.shelf.filter(entry=>entry.book.id!==bookID)};
      }
      delete this.cloud.deferred[bookID];
    }
    this.cloud.cursor=snapshot.cursor;
    await this.persist();
  }
  async mergeFrom(source:BrowserLibrary){
    await this.initialized;await source.initialized;await source.writing;
    const backup=await source.exportBackup();
    await this.importBackup(new File([backup],'local-library.json'));
    const from=await source.db,to=await this.db;
    const bookIDs=new Set(source.state.shelf.map(e=>e.book.id));
    for(const name of ['imports','files','covers','chapters'])for(const bookID of bookIDs){const value=await from.get(name,bookID);if(value!==undefined)await to.put(name,value,bookID);}
    for(const name of ['contents','localContents'])for(const key of await from.getAllKeys(name)){if(typeof key==='string'&&bookIDs.has(key.split('\0')[0]))await to.put(name,await from.get(name,key),key);}
    for(const bookID of bookIDs){
      const cover=await to.get('covers',bookID) as Blob|undefined;if(cover instanceof Blob&&!this.coverURLs.has(bookID))this.coverURLs.set(bookID,URL.createObjectURL(cover));
      const file=await to.get('files',bookID) as Blob|undefined,entry=this.state.shelf.find(e=>e.book.id===bookID);
      if(entry&&file instanceof Blob&&!entry.book.fileHash){
        const hash=sha256.create(),reader=file.stream().getReader();
        for(;;){const next=await reader.read();if(next.done)break;hash.update(next.value);}
        const fileHash=Array.from(hash.digest(),v=>v.toString(16).padStart(2,'0')).join('');
        entry.book={...entry.book,fileHash};this.enqueue('add',bookID,entry);
      }
    }
    await this.persist();
  }
}
export const guestLibrary=new BrowserLibrary();
export let library=guestLibrary;
const libraryListeners=new Set<()=>void>();
const notifyLibrary=()=>libraryListeners.forEach(fn=>fn());
let detachLibrary=library.subscribe(notifyLibrary);
const profiles=new Map<string,BrowserLibrary>();
export async function switchLibraryProfile(profile:string|null){
  let next=guestLibrary;
  if(profile){next=profiles.get(profile)??new BrowserLibrary('qingread-cloud-'+profile,true);profiles.set(profile,next);}
  await next.initialized;
  if(library!==next)await library.setProfileActive(false);await next.setProfileActive(true);
  detachLibrary();library=next;detachLibrary=library.subscribe(notifyLibrary);notifyLibrary();
}
const subscribeLibrary=(listener:()=>void)=>{libraryListeners.add(listener);return()=>{libraryListeners.delete(listener);};};
const librarySnapshot=()=>library.getSnapshot();
export const useLibrary=()=>useSyncExternalStore(subscribeLibrary,librarySnapshot,librarySnapshot);
