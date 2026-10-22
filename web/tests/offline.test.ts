import { describe, expect, it } from 'vitest';
import { offlineBatch, parseOfflineBatch } from '../server/offline';
import type { Book, Chapter } from '../src/shared/types';
const book: Book = { id:'offline-book', title:'测试', author:'', summary:'', sourceID:'biequgei', sourceName:'测试源', url:'https://www.biequgei.com/book/1/' };
const chapters: Chapter[] = [1,2].map(i=>({id:String(i),title:`第${i}章`,index:i-1,url:`https://www.biequgei.com/book/1/${i}.html`}));
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
describe('system background download batches',()=>{
  it('validates bounded public source chapters before downloading',()=>{
    expect(parseOfflineBatch(encode({book,chapters})).chapters).toHaveLength(2);
    expect(()=>parseOfflineBatch(encode({book,chapters:[{...chapters[0],url:'https://127.0.0.1/private'}]}))).toThrow();
    expect(()=>parseOfflineBatch(encode({book,chapters:[chapters[0],chapters[0]]}))).toThrow();
    expect(()=>parseOfflineBatch(encode({book,chapters:Array(11).fill(chapters[0])}))).toThrow();
  });
  it('keeps successful chapters and reports individual failures without reordering',async()=>{
    const result=await offlineBatch(book,chapters,async(_book,chapter)=>{const c=chapter as Chapter;if(c.id==='2')throw Error('unavailable');return{chapter:c,paragraphs:['正文']};});
    expect(result.contents.map(c=>c.chapter.id)).toEqual(['1']);expect(result.failures.map(c=>c.chapterID)).toEqual(['2']);
  });
  it('bounds output and releases concurrency after an error',async()=>{
    const result=await offlineBatch(book,[chapters[0]],async()=>({chapter:chapters[0],paragraphs:['x'.repeat(6*1024*1024)]}));
    expect(result.contents).toEqual([]);expect(result.failures).toHaveLength(1);
    expect((await offlineBatch(book,[chapters[0]],async()=>({chapter:chapters[0],paragraphs:['ok']}))).contents).toHaveLength(1);
  });
});
