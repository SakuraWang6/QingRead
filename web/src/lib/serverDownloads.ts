import type { Book, Chapter, ChapterContent, ChapterDownloadJob } from '../shared/types';

export interface ServerDownloadJob extends ChapterDownloadJob { book: Book; engine: 'server'; bytes: number; expiresAt: string }
export interface ServerDownloadConnection { address: string; token: string }
export interface ServerDownloadList { jobs: ServerDownloadJob[]; usedBytes: number; limitBytes: number }
function connection(value:ServerDownloadConnection){
  const url=new URL(value.address);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||!/^[-\w]{43}$/.test(value.token))throw new Error('请先登录云同步账号');
  return{address:url.href.replace(/\/+$/,''),headers:{Authorization:'Bearer '+value.token}};
}
async function checked(response:Response){if(!response.ok){const value=await response.json().catch(()=>({}));throw new Error(typeof value.message==='string'?value.message:`云端准备未完成（${response.status}）`);}return response;}
async function request<T>(credentials:ServerDownloadConnection,path:string,body?:unknown,signal?:AbortSignal):Promise<T>{
  const value=connection(credentials);const response=await checked(await fetch(value.address+'/offline/jobs'+path,{method:body===undefined?'GET':'POST',headers:{...value.headers,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal,redirect:'error'}));return response.json();
}
export const serverDownloads={
  list:(credentials:ServerDownloadConnection,signal?:AbortSignal)=>request<ServerDownloadList>(credentials,'',undefined,signal),
  create:(credentials:ServerDownloadConnection,bookID:string,chapters:Chapter[],signal?:AbortSignal)=>request<ServerDownloadJob>(credentials,'',{bookID,chapters},signal),
  action:(credentials:ServerDownloadConnection,id:string,action:'pause'|'resume'|'cancel',signal?:AbortSignal)=>request<ServerDownloadJob>(credentials,'/'+encodeURIComponent(id)+'/'+action,{},signal),
  /** Each callback must commit its own cache write before the next chapter is read. */
  async save(credentials:ServerDownloadConnection,id:string,onChapter:(content:ChapterContent)=>Promise<void>,signal?:AbortSignal):Promise<{chapters:number;job:ServerDownloadJob}>{
    const value=connection(credentials),response=await checked(await fetch(value.address+'/offline/jobs/'+encodeURIComponent(id)+'/content',{headers:value.headers,signal,redirect:'error'}));
    if(!response.body)throw new Error('当前浏览器不支持流式保存');
    return savePreparedDownloadStream(id,response.body,onChapter,signal);

  },
};

/** The same validator protects network streams and native downloaded NDJSON. */
export async function savePreparedDownloadStream(id:string,stream:ReadableStream<Uint8Array>,onChapter:(content:ChapterContent)=>Promise<void>,signal?:AbortSignal):Promise<{chapters:number;job:ServerDownloadJob}>{
    const reader=stream.getReader(),decoder=new TextDecoder();let pending='',count=0,complete=false,job:ServerDownloadJob|undefined;const seen=new Set<string>();
    const line=async(text:string)=>{
      if(!text.trim())return;if(signal?.aborted)throw new DOMException('已取消','AbortError');let record:Record<string,unknown>;try{record=JSON.parse(text);}catch{throw new Error('云端章节数据无效');}
      if(record.type==='manifest'){
        const candidate=record.job as ServerDownloadJob;if(job||complete||!candidate||candidate.id!==id||candidate.engine!=='server'||!candidate.book||candidate.bookID!==candidate.book.id)throw new Error('云端任务不匹配');job=candidate;
      }else if(record.type==='chapter'){
        const content=record.content as ChapterContent;if(!job||complete||!content?.chapter||typeof content.chapter.id!=='string'||!job.completedChapterIDs.includes(content.chapter.id)||seen.has(content.chapter.id)||!Array.isArray(content.paragraphs)||!content.paragraphs.length||content.paragraphs.some(paragraph=>typeof paragraph!=='string'))throw new Error('云端章节数据无效');
        await onChapter(content);seen.add(content.chapter.id);count++;
      }else if(record.type==='complete'){
        if(!job||complete||record.chapters!==count||count!==job.completedChapterIDs.length)throw new Error('章节保存尚未完成');complete=true;
      }else throw new Error('云端章节数据无效');
    };
    const abort=()=>{void reader.cancel().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
    try{
      for(;;){if(signal?.aborted)throw new DOMException('已取消','AbortError');const {value,done}=await reader.read();pending+=decoder.decode(value,{stream:!done});if(pending.length>8*1024*1024)throw new Error('云端章节数据过大');const lines=pending.split('\n');pending=lines.pop()??'';for(const text of lines)await line(text);if(done)break;}
      if(pending.trim())await line(pending);if(signal?.aborted)throw new DOMException('已取消','AbortError');if(!complete||!job)throw new Error('连接中断，已保存章节会保留');return{chapters:count,job};
    }finally{signal?.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
