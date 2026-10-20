import { openDB, type IDBPDatabase } from 'idb';
import { useSyncExternalStore } from 'react';
import type { Book, Chapter, ChapterContent, LibraryState, ReaderSettings, ShelfEntry, SourceDefinition, LocalPublication, ReadingPosition } from '../shared/types';
import { defaultSettings } from '../shared/types';
import { sampleBook, sampleChapter, sampleContent } from './sample';
import { parsePublication } from './importPublication';
import { api } from './api';
import { sha256 } from '@noble/hashes/sha2.js';
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
  return{book,addedAt:value.addedAt,position};
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
  private state:LibraryState={ready:false,shelf:[],settings:defaultSettings,sources:[],disabledSourceIDs:[]};
  private listeners=new Set<()=>void>();
  private db:Promise<IDBPDatabase>;
  private writing=Promise.resolve();
  private requests=new Map<string,Promise<ChapterContent>>();
  private generation=0;
  private progress:Record<string,Record<string,number>>=Object.create(null);
  private coverURLs=new Map<string,string>();
  private persistenceBlocked=false;
  private cloud={cursor:0,revisions:{} as Record<string,number>,pending:[] as CloudMutation[],deferred:{} as Record<string,CloudRecord>};
  readonly initialized:Promise<void>;
  constructor(name='qingread-web-v1',private cloudEnabled=false){
    this.db=openDB(name,2,{upgrade(db){for(const store of ['meta','chapters','contents','imports','files','covers','localContents'])if(!db.objectStoreNames.contains(store))db.createObjectStore(store);}});
    this.initialized=this.hydrate();
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
      if(raw===undefined&&!this.cloudEnabled)shelf.push({book:sampleBook,addedAt:new Date().toISOString()});
      else if(Array.isArray(saved?.shelf))for(const entry of saved.shelf){try{shelf.push(shelfEntry(entry));}catch{isolated++;}}
      else isolated++;
      if(isolated){
        // Preserve the original snapshot before a later source refresh saves the
        // healthy entries. A corrupt row must never make all books disappear.
        await db.put('meta',{savedAt:new Date().toISOString(),state:raw},'quarantined-state');
      }
      this.progress=progressRecords(await db.get('meta','progress'));
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
      this.state={ready:true,shelf,settings:normalizeSettings(record(saved?.settings)?saved.settings:{}),sources,disabledSourceIDs:sourceIDs(saved?.disabledSourceIDs),storageError:warnings.length?[...new Set(warnings)].join(' '):undefined};
    } catch(error){
      // A transient IndexedDB read failure must not replace a real library with
      // the sample shelf when the asynchronous API source refresh completes.
      this.persistenceBlocked=true;this.state={...this.state,ready:true,shelf:[]};
      this.report(new Error(`本地数据未能安全加载，原数据未覆盖。请刷新重试。${error instanceof Error?error.message:''}`));
    }
    this.emit();
  }
  private persist(){
    if(this.persistenceBlocked){this.emit();return this.writing;}
    const saved={...this.state,shelf:this.state.shelf.map(e=>({...e,book:{...e.book,coverURL:e.book.coverURL?.startsWith('blob:')?undefined:e.book.coverURL}}))};
    const progress=structuredClone(this.progress),cloud=structuredClone(this.cloud);
    this.writing=this.writing.catch(()=>{}).then(async()=>{const db=await this.db,tx=db.transaction('meta','readwrite');await tx.store.put(saved,'state');await tx.store.put(progress,'progress');await tx.store.put(cloud,'cloud');await tx.done;}).catch(e=>this.report(e));
    this.emit();return this.writing;
  }
  private enqueue(action:CloudMutation['action'],bookID:string,entry?:ShelfEntry){
    if(!this.cloudEnabled)return;
    const previous=this.cloud.pending.find(m=>m.bookID===bookID);
    const mutation:CloudMutation={id:crypto.randomUUID(),action:action==='progress'&&previous?.action==='add'?'add':action,bookID,baseRevision:this.cloud.revisions[bookID]??0,changedAt:new Date().toISOString(),...(entry?{entry:{...entry,book:{...entry.book,coverURL:entry.book.coverURL?.startsWith('blob:')?undefined:entry.book.coverURL}}}:{})};
    this.cloud.pending=[...this.cloud.pending.filter(m=>m.bookID!==bookID),mutation];
  }
  async add(book:Book){await this.initialized;if(this.state.shelf.some(e=>e.book.id===book.id))return;const entry={book,addedAt:new Date().toISOString()};this.state={...this.state,shelf:[...this.state.shelf,entry]};this.enqueue('add',book.id,entry);await this.persist();}
  async remove(book:Book){
    await this.initialized;if(this.persistenceBlocked)return;this.generation++;
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
    const value=bounded(fraction,0,1,0), position:ReadingPosition={chapterID:chapter.id,chapterIndex:chapter.index,chapterFraction:value,characterOffset:Math.max(0,Math.floor(characterOffset)||0),updatedAt:new Date().toISOString()};
    const existing=this.state.shelf.find(e=>e.book.id===book.id);
    this.state={...this.state,shelf:[...this.state.shelf.filter(e=>e.book.id!==book.id),{book:existing?.book||book,position,addedAt:existing?.addedAt||new Date().toISOString()}]};
    this.progress[book.id]??=Object.create(null);this.progress[book.id][chapter.id]=Math.max(this.progress[book.id][chapter.id]??0,value);
    this.enqueue(existing?'progress':'add',book.id,this.state.shelf.find(e=>e.book.id===book.id));
    await this.persist();
    if(!this.persistenceBlocked)try{await(await this.db).put('meta',this.progress,'progress');}catch(e){this.report(e);}
  }
  async updateSettings(settings:Partial<ReaderSettings>){await this.initialized;this.state={...this.state,settings:normalizeSettings({...this.state.settings,...settings})};await this.persist();}
  async toggleSource(id:string){await this.initialized;const ids=new Set(this.state.disabledSourceIDs);ids.has(id)?ids.delete(id):ids.add(id);this.state={...this.state,disabledSourceIDs:[...ids]};await this.persist();}
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
  async cacheChapters(book:Book,chapters:Chapter[]){try{await(await this.db).put('chapters',chapters,book.id);}catch(e){this.report(e);}}
  async cacheContent(book:Book,content:ChapterContent){if(!content.paragraphs.length)return;try{await(await this.db).put('contents',content,contentKey(book,content.chapter));}catch(e){this.report(e);}}
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
    const generation=this.generation,key=contentKey(book,chapter);
    let pending=this.requests.get(key);
    if(!pending){pending=api.content(book,chapter).finally(()=>this.requests.delete(key));this.requests.set(key,pending);}
    const content=await pending;
    if(signal?.aborted)throw new DOMException('已取消','AbortError');
    if(generation===this.generation)await this.cacheContent(book,content);
    return content;
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
  async clearCache(){this.generation++;const db=await this.db,tx=db.transaction(['chapters','contents'],'readwrite');await Promise.all([tx.objectStore('chapters').clear(),tx.objectStore('contents').clear()]);await tx.done;this.emit();}
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
  async syncRequest(){await this.initialized;await this.writing;return{cursor:this.cloud.cursor,mutations:structuredClone(this.cloud.pending.slice(0,50))};}
  hasPendingSync(){return this.cloud.pending.length>0;}
  async acceptSync(snapshot:CloudSnapshot){
    await this.initialized;
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
      const previous=this.state.shelf.find(e=>e.book.id===bookID);
      this.state={...this.state,shelf:this.state.shelf.filter(e=>e.book.id!==bookID)};
      if(remote.entry){
        const entry=shelfEntry(remote.entry),cover=this.coverURLs.get(bookID);
        if(cover)entry.book={...entry.book,coverURL:cover};
        this.state.shelf.push(entry);
        if(entry.position){this.progress[bookID]??=Object.create(null);this.progress[bookID][entry.position.chapterID]=Math.max(this.progress[bookID][entry.position.chapterID]??0,entry.position.chapterFraction);}
      }else if(previous){delete this.progress[bookID];}
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
  detachLibrary();library=next;detachLibrary=library.subscribe(notifyLibrary);notifyLibrary();
}
const subscribeLibrary=(listener:()=>void)=>{libraryListeners.add(listener);return()=>{libraryListeners.delete(listener);};};
const librarySnapshot=()=>library.getSnapshot();
export const useLibrary=()=>useSyncExternalStore(subscribeLibrary,librarySnapshot,librarySnapshot);
