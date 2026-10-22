import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { Book, Chapter, ChapterContent, ChapterDownloadJob, ChapterDownloadStatus } from '../src/shared/types.js';
import type { CloudUser } from '../src/shared/sync.js';
import type { CloudDatabase } from './cloud.js';
import { content as loadContent, userError, validatedBook } from './reading.js';
import { ServiceError, validateSourceURL } from './network.js';

const MiB = 1024 ** 2, day = 86_400_000;
const activeStatuses = "('queued','running','paused')";
const uuid = /^[a-f0-9-]{36}$/;
const fingerprint = (book: Book) => createHash('sha256').update(book.sourceID + '\0' + book.url).digest('hex');
const sessionHash = (header: string) => createHash('sha256').update(header.slice(7)).digest('hex');
export interface ServerDownloadJob extends ChapterDownloadJob { book: Book; engine: 'server'; bytes: number; expiresAt: string }
interface JobRow { id: string; user_id: string; book_id: string; book: string; source_key: string; selection_hash: string; session_hash: string; status: ChapterDownloadStatus; generation: number; error: string | null; created: number; updated: number; bytes: number; total:number }
interface TaskRow { chapter_id: string; ordinal: number; chapter: string; status: 'pending'|'completed'|'failed'; attempts: number; bytes: number; digest:string|null }
export interface OfflineAccountAccess { fileBooks(user: CloudUser): Book[]; hasSession(userID: string, hash: string): boolean }
interface JobOptions {
  load?: (book: Book, chapter: Chapter) => Promise<ChapterContent>;
  intervalMs?: number; userLimit?: number; globalLimit?: number; reserveDisk?: number; ttlMs?: number;
  maxUserActive?: number; maxGlobalActive?: number; now?: () => number;
  diskAvailable?: () => Promise<number>; autoStart?: boolean; cleanupOnClose?: boolean;
}

/** The serial server preparation queue is independent of browser and phone lifetime. */
export class OfflineJobs {
  private readonly db: DatabaseSync;
  private readonly load: NonNullable<JobOptions['load']>;
  private readonly now: () => number;
  private readonly ready: Promise<void>;
  private runner?: Promise<void>;
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  private waits = new Set<() => void>();
  private streams = new Map<string,number>();
  private streamCount = 0;
  private nextGlobalPrune = 0;
  private readonly limits: Required<Pick<JobOptions,'intervalMs'|'userLimit'|'globalLimit'|'reserveDisk'|'ttlMs'|'maxUserActive'|'maxGlobalActive'>>;
  constructor(private accounts: OfflineAccountAccess, private root: string, private options: JobOptions = {}) {
    mkdirSync(root,{recursive:true,mode:0o700});
    const database=join(root,'offline-jobs.sqlite');this.db=new DatabaseSync(database);chmodSync(database,0o600);
    this.db.exec(`PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,book_id TEXT NOT NULL,book TEXT NOT NULL,source_key TEXT NOT NULL,selection_hash TEXT NOT NULL,session_hash TEXT NOT NULL,status TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,error TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL,bytes INTEGER NOT NULL DEFAULT 0,total INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS jobs_owner ON jobs(user_id,status);
      CREATE TABLE IF NOT EXISTS chapters(job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,chapter_id TEXT NOT NULL,ordinal INTEGER NOT NULL,chapter TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,bytes INTEGER NOT NULL DEFAULT 0,digest TEXT,PRIMARY KEY(job_id,chapter_id));
      UPDATE jobs SET status='queued',generation=generation+1 WHERE status='running';`);
    if(!(this.db.prepare('PRAGMA table_info(jobs)').all() as {name:string}[]).some(column=>column.name==='total')){this.db.exec('ALTER TABLE jobs ADD COLUMN total INTEGER NOT NULL DEFAULT 0;UPDATE jobs SET total=(SELECT count(*) FROM chapters WHERE job_id=jobs.id)');}
    if(!(this.db.prepare('PRAGMA table_info(chapters)').all() as {name:string}[]).some(column=>column.name==='digest'))this.db.exec('ALTER TABLE chapters ADD COLUMN digest TEXT');
    this.load=options.load??loadContent;this.now=options.now??Date.now;
    this.limits={intervalMs:options.intervalMs??1000,userLimit:options.userLimit??100*MiB,globalLimit:options.globalLimit??512*MiB,reserveDisk:options.reserveDisk??5*1024**3,ttlMs:options.ttlMs??7*day,maxUserActive:options.maxUserActive??2,maxGlobalActive:options.maxGlobalActive??10};
    this.ready=this.prepare();
  }
  async initialize(){await this.ready;}
  async start(){await this.ready;if(this.closed)return;this.timer??=setInterval(()=>{void this.prune().then(()=>this.kick()).catch(()=>{});},60_000);this.timer.unref();this.kick();}
  private directory(row:Pick<JobRow,'user_id'|'id'>){if(!uuid.test(row.user_id)||!uuid.test(row.id))throw new ServiceError('下载任务不存在。',404);return join(this.root,'jobs',row.user_id,row.id);}
  private path(row:Pick<JobRow,'user_id'|'id'>,ordinal:number){if(!Number.isSafeInteger(ordinal)||ordinal<0||ordinal>=5000)throw new ServiceError('章节记录无效。',400);return join(this.directory(row),ordinal+'.json');}
  private row(userID:string,id:string):JobRow {if(!uuid.test(id))throw new ServiceError('下载任务不存在。',404);const row=this.db.prepare('SELECT * FROM jobs WHERE user_id=? AND id=?').get(userID,id) as unknown as JobRow|undefined;if(!row)throw new ServiceError('下载任务不存在。',404);return row;}
  private tasks(id:string):TaskRow[]{return this.db.prepare('SELECT * FROM chapters WHERE job_id=? ORDER BY ordinal').all(id) as unknown as TaskRow[];}
  private dto(row:JobRow,includeIDs=true):ServerDownloadJob {
    const book=JSON.parse(row.book) as Book,tasks=(includeIDs?this.db.prepare('SELECT chapter_id,status FROM chapters WHERE job_id=? ORDER BY ordinal').all(row.id):this.db.prepare("SELECT chapter_id,status FROM chapters WHERE job_id=? AND status='failed' ORDER BY ordinal LIMIT 20").all(row.id)) as unknown as Pick<TaskRow,'chapter_id'|'status'>[],completed=tasks.filter(task=>task.status==='completed');
    const completedCount=includeIDs?completed.length:Number(this.db.prepare("SELECT count(*) AS n FROM chapters WHERE job_id=? AND status='completed'").get(row.id)?.n??0);
    return {id:row.id,bookID:book.id,bookTitle:book.title,sourceID:book.sourceID,sourceURL:book.url,status:row.status,chapterIDs:includeIDs?tasks.map(task=>task.chapter_id):[],completedChapterIDs:includeIDs?completed.map(task=>task.chapter_id):[],failedChapterIDs:tasks.filter(task=>task.status==='failed').map(task=>task.chapter_id),total:row.total,completed:completedCount,error:row.error??undefined,createdAt:new Date(row.created).toISOString(),updatedAt:new Date(row.updated).toISOString(),book,engine:'server',bytes:row.bytes,expiresAt:new Date(row.updated+this.limits.ttlMs).toISOString()};
  }
  private async prepare(){
    const jobs=join(this.root,'jobs');await mkdir(jobs,{recursive:true,mode:0o700});
    for(const user of await readdir(jobs,{withFileTypes:true})){if(!user.isDirectory()||!uuid.test(user.name))continue;
      for(const job of await readdir(join(jobs,user.name),{withFileTypes:true})){if(!job.isDirectory()||!uuid.test(job.name))continue;
        const row=this.db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(job.name,user.name) as unknown as JobRow|undefined;
        if(!row){await rm(join(jobs,user.name,job.name),{recursive:true,force:true});continue;}
        const completed=new Map(this.tasks(row.id).filter(task=>task.status==='completed').map(task=>[task.ordinal+'.json',task]));
        for(const file of await readdir(this.directory(row),{withFileTypes:true})){if(!file.isFile())continue;const task=completed.get(file.name);if(file.name.startsWith('.writing-')||/^\d+\.json$/.test(file.name)&&!task)await rm(join(this.directory(row),file.name),{force:true});}
        let missing=false;for(const task of completed.values()){const info=await stat(this.path(row,task.ordinal)).catch(()=>null);if(!info?.isFile()||info.size!==task.bytes){missing=true;this.db.prepare("UPDATE chapters SET status='pending',bytes=0,digest=NULL WHERE job_id=? AND chapter_id=?").run(row.id,task.chapter_id);}}
        if(missing&&['completed','failed'].includes(row.status))this.setStatus(row,'queued','正在恢复缺失的云端章节');
      }
    }
    this.db.exec('UPDATE jobs SET bytes=(SELECT coalesce(sum(bytes),0) FROM chapters WHERE job_id=jobs.id)');await this.pruneRows();
    if(this.options.autoStart!==false)queueMicrotask(()=>{void this.start();});
  }
  private ownedBook(user:CloudUser,bookID:unknown):Book {
    if(typeof bookID!=='string'||!bookID||bookID.length>8192)throw new ServiceError('书籍标识无效。',400);
    const owned=this.accounts.fileBooks(user).find(book=>book.id===bookID);
    if(!owned)throw new ServiceError('请先同步这本书到自己的书架。',409);
    if(owned.publicationFormat||owned.fileDownloadURL||owned.sourceID.startsWith('local'))throw new ServiceError('整本文件请使用原文件同步。',400);
    return {...validatedBook(owned).book,id:owned.id};
  }
  private parseChapters(value:unknown,book:Book):Chapter[]{
    if(!Array.isArray(value)||!value.length||value.length>5000)throw new ServiceError('每个任务支持 1–5000 章。',413);
    const ids=new Set<string>();return value.map(raw=>{const chapter=raw as Chapter;if(!chapter||typeof chapter.id!=='string'||!chapter.id||chapter.id.length>8192||typeof chapter.title!=='string'||chapter.title.length>2000||typeof chapter.url!=='string'||chapter.url.length>3000||!Number.isSafeInteger(chapter.index)||chapter.index<0||chapter.index>100000||ids.has(chapter.id))throw new ServiceError('下载章节无效。',400);validateSourceURL(chapter.url,book.sourceID);ids.add(chapter.id);return{id:chapter.id,title:chapter.title,url:chapter.url,index:chapter.index};});
  }
  private activeCapacity(userID:string,except=''){
    const own=Number(this.db.prepare(`SELECT count(*) AS n FROM jobs WHERE user_id=? AND status IN ${activeStatuses} AND id<>?`).get(userID,except)?.n??0),all=Number(this.db.prepare(`SELECT count(*) AS n FROM jobs WHERE status IN ${activeStatuses} AND id<>?`).get(except)?.n??0);
    if(own>=this.limits.maxUserActive||all>=this.limits.maxGlobalActive)throw new ServiceError('云端准备任务较多，请先完成或取消已有任务。',429);
  }
  async create(user:CloudUser,authorization:string,body:unknown):Promise<ServerDownloadJob>{
    await this.ready;await this.prune(user);const value=body as Record<string,unknown>;
    if(!value||typeof value!=='object'||Object.keys(value).some(key=>!['bookID','chapters'].includes(key)))throw new ServiceError('下载请求无效。',400);
    const book=this.ownedBook(user,value.bookID),chapters=this.parseChapters(value.chapters,book),selection=createHash('sha256').update(JSON.stringify(chapters.map(chapter=>[chapter.id,chapter.url]))).digest('hex');
    const existing=this.db.prepare(`SELECT * FROM jobs WHERE user_id=? AND book_id=? AND source_key=? AND selection_hash=? AND status IN ${activeStatuses} ORDER BY created DESC LIMIT 1`).get(user.id,book.id,fingerprint(book),selection) as unknown as JobRow|undefined;if(existing)return this.dto(existing);
    this.activeCapacity(user.id);await this.capacity(user.id,0);
    const duplicate=this.db.prepare(`SELECT * FROM jobs WHERE user_id=? AND book_id=? AND source_key=? AND selection_hash=? AND status IN ${activeStatuses} ORDER BY created DESC LIMIT 1`).get(user.id,book.id,fingerprint(book),selection) as unknown as JobRow|undefined;if(duplicate)return this.dto(duplicate);
    this.activeCapacity(user.id);if(!this.accounts.fileBooks(user).some(value=>value.id===book.id&&fingerprint(value)===fingerprint(book)))throw new ServiceError('书籍已变更，请重新选择。',409);
    const id=randomUUID(),now=this.now();this.db.exec('BEGIN IMMEDIATE');
    try{this.db.prepare('INSERT INTO jobs(id,user_id,book_id,book,source_key,selection_hash,session_hash,status,created,updated,total) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,user.id,book.id,JSON.stringify(book),fingerprint(book),selection,sessionHash(authorization),'queued',now,now,chapters.length);const insert=this.db.prepare('INSERT INTO chapters(job_id,chapter_id,ordinal,chapter) VALUES(?,?,?,?)');chapters.forEach((chapter,index)=>insert.run(id,chapter.id,index,JSON.stringify(chapter)));this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
    this.kick();return this.dto(this.row(user.id,id));
  }
  private liveBook(row:JobRow){return this.accounts.fileBooks({id:row.user_id,username:''}).find(book=>book.id===row.book_id&&!book.publicationFormat&&!book.fileDownloadURL&&fingerprint(book)===row.source_key);}
  private current(row:JobRow):JobRow|undefined {if(this.closed)return;const latest=this.db.prepare('SELECT * FROM jobs WHERE id=?').get(row.id) as unknown as JobRow|undefined;return latest?.status==='running'&&latest.generation===row.generation?latest:undefined;}
  private setStatus(row:JobRow,status:ChapterDownloadStatus,error?:string){this.db.prepare('UPDATE jobs SET status=?,error=?,updated=?,generation=generation+1 WHERE id=?').run(status,error??null,this.now(),row.id);}
  private async valid(row:JobRow){
    if(!this.current(row))return false;
    if(!this.liveBook(row)){await this.discard(row,'书籍已移除或已换源');return false;}
    if(!this.accounts.hasSession(row.user_id,row.session_hash)){this.setStatus(row,'paused','登录已失效，请登录后继续准备');return false;}
    return true;
  }
  private usage(userID?:string){return Number((userID?this.db.prepare('SELECT coalesce(sum(bytes),0) AS n FROM jobs WHERE user_id=?').get(userID):this.db.prepare('SELECT coalesce(sum(bytes),0) AS n FROM jobs').get())?.n??0);}
  private async capacity(userID:string,extra:number){
    if(this.usage(userID)+extra>this.limits.userLimit)throw new ServiceError('账号云端准备空间已满，请取消旧任务。',413);
    if(this.usage()+extra>this.limits.globalLimit)throw new ServiceError('服务器云端准备空间已满。',507);
    const available=this.options.diskAvailable?await this.options.diskAvailable():await statfs(this.root).then(info=>info.bavail*info.bsize);
    if(available-extra<this.limits.reserveDisk)throw new ServiceError('服务器可用磁盘空间不足。',507);
  }
  private wait(ms:number){if(this.closed||ms<=0)return Promise.resolve();return new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);this.waits.delete(done);resolve();};const timer=setTimeout(done,ms);this.waits.add(done);});}
  private kick(){if(this.closed||this.runner||this.options.autoStart===false)return;this.runner=this.run().catch(()=>{}).finally(()=>{this.runner=undefined;if(!this.closed&&this.db.prepare("SELECT 1 FROM jobs WHERE status='queued' LIMIT 1").get())this.kick();});}
  /** Exposed for deterministic lifecycle tests and maintenance, never accepts a remote URL. */
  async runPending(){await this.ready;await this.runner;if(this.closed)return;this.runner=this.run();try{await this.runner;}finally{this.runner=undefined;}}
  private async run(){
    await this.ready;
    while(!this.closed){
      const next=this.db.prepare("SELECT * FROM jobs WHERE status='queued' ORDER BY updated,created LIMIT 1").get() as unknown as JobRow|undefined;if(!next)return;
      this.db.prepare("UPDATE jobs SET status='running',generation=generation+1,updated=? WHERE id=?").run(this.now(),next.id);const row=this.row(next.user_id,next.id);
      if(!await this.valid(row))continue;
      let consecutiveFailures=0;
      for(const task of this.tasks(row.id).filter(item=>item.status==='pending')){
        if(!await this.valid(row))break;
        let saved=false;
        for(let attempt=task.attempts;attempt<3;attempt++){
          if(!await this.valid(row))break;
          try{
            const chapter=JSON.parse(task.chapter) as Chapter,loaded=await this.load(JSON.parse(row.book),chapter);
            if(!loaded||!Array.isArray(loaded.paragraphs)||!loaded.paragraphs.length||loaded.paragraphs.some(value=>typeof value!=='string'))throw new ServiceError('章节正文无效。',502);
            const value:ChapterContent={chapter,paragraphs:loaded.paragraphs},data=Buffer.from(JSON.stringify(value));if(data.length>2*MiB)throw new ServiceError('章节内容过大。',413);
            if(!await this.valid(row))break;await this.capacity(row.user_id,data.length);if(!await this.valid(row))break;
            const temporary=join(this.directory(row),'.writing-'+randomUUID());await mkdir(this.directory(row),{recursive:true,mode:0o700});
            try{
              await writeFile(temporary,data,{flag:'wx',mode:0o600});if(!await this.valid(row))break;await rename(temporary,this.path(row,task.ordinal));
              if(!await this.valid(row)){await rm(this.path(row,task.ordinal),{force:true});break;}
              this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare("UPDATE chapters SET status='completed',attempts=?,bytes=?,digest=? WHERE job_id=? AND chapter_id=?").run(attempt+1,data.length,createHash('sha256').update(data).digest('hex'),row.id,task.chapter_id);this.db.prepare('UPDATE jobs SET bytes=bytes+?,updated=? WHERE id=?').run(data.length,this.now(),row.id);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
              saved=true;consecutiveFailures=0;
            }finally{await rm(temporary,{force:true});}
            break;
          }catch(error){
            if(!this.current(row))break;
            if(error instanceof ServiceError&&[401,403,413,429,507].includes(error.statusCode)){this.setStatus(row,'paused',userError(error));break;}
            this.db.prepare('UPDATE chapters SET attempts=?,status=? WHERE job_id=? AND chapter_id=?').run(attempt+1,attempt===2?'failed':'pending',row.id,task.chapter_id);
            await this.wait(this.limits.intervalMs*(attempt+1));
          }
        }
        if(!this.current(row))break;
        if(!saved&&++consecutiveFailures>=2){this.setStatus(row,'paused','书源暂时不可用，请稍后继续');break;}
        await this.wait(this.limits.intervalMs);
      }
      if(this.current(row)){const failed=this.tasks(row.id).some(task=>task.status==='failed');this.setStatus(row,failed?'failed':'completed',failed?'部分章节未能准备，可重试':undefined);}
    }
  }
  async list(user:CloudUser){await this.ready;await this.prune(user);const jobs=this.db.prepare('SELECT * FROM jobs WHERE user_id=? ORDER BY created DESC LIMIT 50').all(user.id) as unknown as JobRow[];return{jobs:jobs.map(row=>this.dto(row,false)),usedBytes:this.usage(user.id),limitBytes:this.limits.userLimit};}
  async action(user:CloudUser,authorization:string,id:string,action:'pause'|'resume'|'cancel'){
    await this.ready;const row=this.row(user.id,id);
    if(action==='cancel'){await this.discard(row);return this.dto(this.row(user.id,id));}
    if(action==='pause'){if(['queued','running'].includes(row.status))this.setStatus(row,'paused');return this.dto(this.row(user.id,id));}
    if(!['paused','failed'].includes(row.status))throw new ServiceError('任务无法继续。',409);
    if(!this.liveBook(row)){await this.discard(row,'书籍已移除或已换源');throw new ServiceError('书籍已移除或已换源。',409);}
    this.activeCapacity(user.id,id);await this.capacity(user.id,0);
    this.db.prepare("UPDATE chapters SET status='pending',attempts=0 WHERE job_id=? AND status='failed'").run(id);
    this.db.prepare("UPDATE jobs SET status='queued',session_hash=?,error=NULL,generation=generation+1,updated=? WHERE id=?").run(sessionHash(authorization),this.now(),id);this.kick();return this.dto(this.row(user.id,id));
  }
  private async discard(row:JobRow,error?:string){this.setStatus(row,'cancelled',error);this.db.prepare("DELETE FROM chapters WHERE job_id=?").run(row.id);this.db.prepare('UPDATE jobs SET bytes=0 WHERE id=?').run(row.id);await rm(this.directory(row),{recursive:true,force:true});}
  async prune(user?:CloudUser){await this.ready;if(user){await this.pruneRows(user.id);return;}if(this.now()<this.nextGlobalPrune)return;this.nextGlobalPrune=this.now()+60_000;await this.pruneRows();}
  private async pruneRows(userID?:string){
    const rows=(userID?this.db.prepare('SELECT * FROM jobs WHERE user_id=? ORDER BY user_id').all(userID):this.db.prepare('SELECT * FROM jobs ORDER BY user_id').all()) as unknown as JobRow[];let owner='',live=new Map<string,string>();
    for(const row of rows){
      if(owner!==row.user_id){owner=row.user_id;live=new Map(this.accounts.fileBooks({id:owner,username:''}).filter(book=>!book.publicationFormat&&!book.fileDownloadURL).map(book=>[book.id,fingerprint(book)]));}
      if(row.updated+this.limits.ttlMs<this.now()){this.db.prepare('DELETE FROM jobs WHERE id=?').run(row.id);await rm(this.directory(row),{recursive:true,force:true});}
      else if(row.status!=='cancelled'&&live.get(row.book_id)!==row.source_key)await this.discard(row,'书籍已移除或已换源');
    }
    for(const {user_id} of (userID?[{user_id:userID}]:this.db.prepare('SELECT DISTINCT user_id FROM jobs').all()) as {user_id:string}[]){const history=this.db.prepare("SELECT * FROM jobs WHERE user_id=? AND status IN ('completed','cancelled','failed') ORDER BY updated DESC LIMIT -1 OFFSET 20").all(user_id) as unknown as JobRow[];for(const row of history){this.db.prepare('DELETE FROM jobs WHERE id=?').run(row.id);await rm(this.directory(row),{recursive:true,force:true});}}
  }
  async download(user:CloudUser,id:string,checkSession:()=>void){
    await this.ready;await this.prune(user);const row=this.row(user.id,id);checkSession();
    if(!this.liveBook(row)||!['completed','failed','paused'].includes(row.status))throw new ServiceError('章节尚未准备好。',409);
    const tasks=this.tasks(id).filter(task=>task.status==='completed');if(!tasks.length)throw new ServiceError('暂无已准备章节。',409);
    if(this.streamCount>=2||(this.streams.get(user.id)??0)>=1)throw new ServiceError('章节保存正忙，请稍后重试。',429);
    this.streamCount++;this.streams.set(user.id,(this.streams.get(user.id)??0)+1);const owner=this;
    const stream=Readable.from((async function*(){
      yield JSON.stringify({type:'manifest',job:owner.dto(row)})+'\n';
      for(const task of tasks){
        if(owner.closed)break;checkSession();const current=owner.row(user.id,id);if(current.generation!==row.generation||!owner.liveBook(current))throw new ServiceError('书籍或任务已变更。',409);
        const bytes=await readFile(owner.path(row,task.ordinal));if(bytes.length!==task.bytes||bytes.length>2*MiB||(task.digest&&createHash('sha256').update(bytes).digest('hex')!==task.digest)){
          owner.db.prepare("UPDATE chapters SET status='pending',bytes=0,digest=NULL WHERE job_id=? AND chapter_id=?").run(row.id,task.chapter_id);owner.db.prepare('UPDATE jobs SET bytes=max(0,bytes-?) WHERE id=?').run(task.bytes,row.id);owner.setStatus(row,'paused','云端章节需要重新准备，请继续任务');throw new ServiceError('云端章节校验失败，请继续准备后重试。',409);
        }
        checkSession();const latest=owner.row(user.id,id);if(latest.generation!==row.generation||!owner.liveBook(latest))throw new ServiceError('书籍或任务已变更。',409);
        const value=JSON.parse(bytes.toString()) as ChapterContent;if(value.chapter?.id!==task.chapter_id||!Array.isArray(value.paragraphs)||value.paragraphs.some(text=>typeof text!=='string'))throw new ServiceError('云端章节校验失败。',409);
        yield JSON.stringify({type:'chapter',content:value})+'\n';
      }
      yield JSON.stringify({type:'complete',chapters:tasks.length})+'\n';
    })());stream.once('close',()=>{this.streamCount--;this.streams.set(user.id,Math.max(0,(this.streams.get(user.id)??1)-1));});return{job:this.dto(row),stream};
  }
  async close(){if(this.closed)return;this.closed=true;if(this.timer)clearInterval(this.timer);for(const finish of this.waits)finish();await this.ready;await this.runner;this.db.close();if(this.options.cleanupOnClose)await rm(this.root,{recursive:true,force:true});}
}

export async function createOfflineJobs(cloud:CloudDatabase){
  const temporary=cloud.storagePath===':memory:',root=temporary?await mkdtemp(join(tmpdir(),'qingread-offline-')):dirname(cloud.storagePath);
  return new OfflineJobs(cloud,root,{cleanupOnClose:temporary});
}

export function registerOfflineJobRoutes(app:FastifyInstance,cloud:CloudDatabase,jobs:OfflineJobs){
  const auth=(header:unknown)=>cloud.authorize(header),idSchema={type:'object',required:['id'],properties:{id:{type:'string',pattern:'^[a-f0-9-]{36}$'}},additionalProperties:false} as const;
  app.get('/api/offline/jobs',async request=>jobs.list(auth(request.headers.authorization)));
  let creating:object|undefined;
  app.post('/api/offline/jobs',{bodyLimit:4*MiB,config:{rateLimit:{max:12,timeWindow:'1 minute'}},onRequest:async(request,reply)=>{
    auth(request.headers.authorization);if(creating)throw new ServiceError('云端准备正忙，请稍后重试。',429);creating=request;const release=()=>{if(creating===request)creating=undefined;};request.raw.once('aborted',release);reply.raw.once('close',release);
  },onResponse:async request=>{if(creating===request)creating=undefined;}},async request=>jobs.create(auth(request.headers.authorization),String(request.headers.authorization),request.body));
  for(const action of ['pause','resume','cancel'] as const)app.post<{Params:{id:string}}>(`/api/offline/jobs/:id/${action}`,{schema:{params:idSchema}},async request=>jobs.action(auth(request.headers.authorization),String(request.headers.authorization),request.params.id,action));
  app.get<{Params:{id:string}}>('/api/offline/jobs/:id/content',{schema:{params:idSchema},config:{rateLimit:{max:12,timeWindow:'1 minute'}}},async(request,reply)=>{
    const result=await jobs.download(auth(request.headers.authorization),request.params.id,()=>{auth(request.headers.authorization);});reply.raw.once('close',()=>result.stream.destroy());return reply.type('application/x-ndjson; charset=utf-8').header('Cache-Control','private, no-store').header('X-Accel-Buffering','no').send(result.stream);
  });
  app.addHook('onReady',()=>jobs.start());app.addHook('onClose',()=>jobs.close());
}
