import { afterEach, describe, expect, it, vi } from 'vitest';
import { serverDownloads, type ServerDownloadJob } from '../src/lib/serverDownloads';
import type { ChapterContent } from '../src/shared/types';
const credentials={address:'https://reading.example/api',token:'A'.repeat(43)};
const book={id:'logical-book',title:'小说',author:'作者',summary:'',sourceID:'source',sourceName:'书源',url:'https://source.example/book'};
const contents:ChapterContent[]=[0,1].map(index=>({chapter:{id:'c'+index,title:'第'+(index+1)+'章',url:book.url+'/'+index,index},paragraphs:['中文正文'+index]}));
const job:ServerDownloadJob={id:'11111111-1111-4111-8111-111111111111',bookID:book.id,bookTitle:book.title,sourceID:book.sourceID,sourceURL:book.url,status:'completed',chapterIDs:['c0','c1'],completedChapterIDs:['c0','c1'],failedChapterIDs:[],total:2,completed:2,createdAt:'2026-10-22T00:00:00.000Z',updatedAt:'2026-10-22T00:00:00.000Z',book,engine:'server',bytes:200,expiresAt:'2026-10-29T00:00:00.000Z'};
const manifest=JSON.stringify({type:'manifest',job})+'\n',complete=JSON.stringify({type:'complete',chapters:2})+'\n';
function response(lines:string,chunk=3){const data=new TextEncoder().encode(lines);let offset=0;return new Response(new ReadableStream<Uint8Array>({pull(controller){if(offset>=data.length){controller.close();return;}controller.enqueue(data.slice(offset,offset+chunk));offset+=chunk;}}),{headers:{'content-type':'application/x-ndjson'}});}
afterEach(()=>vi.unstubAllGlobals());
describe('server download client',()=>{
 it('uses explicit account authorization and requested server path without ambient cloud/store state',async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify(job)));vi.stubGlobal('fetch',fetch);await serverDownloads.create(credentials,book.id,contents.map(content=>content.chapter));expect(fetch.mock.calls[0][0]).toBe('https://reading.example/api/offline/jobs');expect(fetch.mock.calls[0][1]).toMatchObject({method:'POST',redirect:'error',headers:{Authorization:'Bearer '+credentials.token}});
 });
 it('decodes arbitrary UTF-8 chunk boundaries and awaits each local write before the next',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(manifest+contents.map(content=>JSON.stringify({type:'chapter',content})+'\n').join('')+complete,1)));const saved:string[]=[],operations:string[]=[];const result=await serverDownloads.save(credentials,job.id,async content=>{operations.push('start'+content.chapter.id);await new Promise(resolve=>setTimeout(resolve,1));saved.push(content.paragraphs[0]);operations.push('end'+content.chapter.id);});expect(saved).toEqual(['中文正文0','中文正文1']);expect(operations).toEqual(['startc0','endc0','startc1','endc1']);expect(result).toMatchObject({chapters:2,job:{engine:'server'}});
 });
 it('reports truncation while preserving already committed chapter callbacks',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(manifest+JSON.stringify({type:'chapter',content:contents[0]})+'\n')));const saved:ChapterContent[]=[];await expect(serverDownloads.save(credentials,job.id,async content=>{saved.push(content);})).rejects.toThrow('连接中断');expect(saved).toHaveLength(1);
 });
 it('rejects duplicate or out-of-manifest chapters rather than falsely reporting a complete save',async()=>{
  for(const chapter of [contents[0],{...contents[1],chapter:{...contents[1].chapter,id:'foreign'}}]){
   vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(manifest+JSON.stringify({type:'chapter',content:contents[0]})+'\n'+JSON.stringify({type:'chapter',content:chapter})+'\n'+complete)));await expect(serverDownloads.save(credentials,job.id,async()=>{})).rejects.toThrow('云端章节数据无效');
  }
 });
 it('cancels the response reader after an explicit abort and leaves earlier saves intact',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(manifest+contents.map(content=>JSON.stringify({type:'chapter',content})+'\n').join('')+complete)));const controller=new AbortController(),saved:string[]=[];await expect(serverDownloads.save(credentials,job.id,async content=>{saved.push(content.chapter.id);controller.abort();},controller.signal)).rejects.toMatchObject({name:'AbortError'});expect(saved).toEqual(['c0']);
 });
 it('stops when IndexedDB callback rejects instead of marking missing local chapters as saved',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(manifest+contents.map(content=>JSON.stringify({type:'chapter',content})+'\n').join('')+complete)));await expect(serverDownloads.save(credentials,job.id,async()=>{throw new Error('存储空间不足');})).rejects.toThrow('存储空间不足');
 });
});
