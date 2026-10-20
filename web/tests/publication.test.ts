import {beforeAll, describe,it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {zipSync,strToU8} from 'fflate';
import {archivePath,parsePublication,textChapters} from '../src/lib/importPublication';
beforeAll(()=>{globalThis.DOMParser=new JSDOM('').window.DOMParser;});
describe('publication imports',()=>{
  it('uses actual EPUB spine order and resolves safe parent references',async()=>{
    const bytes=await readFile(new URL('../../Tests/ReadingCoreTests/Fixtures/import.epub',import.meta.url));
    const imported=await parsePublication(new File([bytes],'fixture.epub'));
    expect(imported.book.title).toBe('测试文学');expect(imported.book.author).toBe('作者');
    expect(imported.chapters.map(c=>c.title)).toEqual(['第一章','第二章']);
    expect(imported.contents[0].paragraphs).toEqual(['第一段正文。','第二段正文。']);
  });
  it('decodes UTF8 BOM and UTF16 text, and deduplicates by file bytes',async()=>{
    const a=await parsePublication(new File(['\uFEFF第一章 开始\n正文。'],'a.txt'));
    const b=await parsePublication(new File(['\uFEFF第一章 开始\n正文。'],'b.txt'));
    expect(a.book.id).toBe(b.book.id);expect(a.chapters[0].title).toBe('第一章 开始');
    const text='第一章 开始\n中文内容';const bytes=new Uint8Array(2+text.length*2);bytes.set([255,254]);for(let i=0;i<text.length;i++){bytes[2+i*2]=text.charCodeAt(i)&255;bytes[3+i*2]=text.charCodeAt(i)>>8;}
    const utf16=await parsePublication(new File([bytes],'unicode.txt'));expect(utf16.contents[0].paragraphs).toEqual(['中文内容']);
  });
  it('rejects escape paths, corrupt or empty files and oversized zip resources',async()=>{
    for(const value of ['../a','a/../../b','/root','https://evil/book','a\\b','a\0b'])expect(()=>archivePath(value)).toThrow();
    await expect(parsePublication(new File([],'empty.txt'))).rejects.toThrow();
    await expect(parsePublication(new File(['not a pdf'],'wrong.pdf'))).rejects.toThrow('PDF');
    const zip=zipSync({'large.xhtml':strToU8('x'.repeat(17*1024*1024))});
    await expect(parsePublication(new File([zip],'large.epub'))).rejects.toThrow('过大');
  });
  it('reattaches the same file to a cloud book and rejects different bytes',async()=>{
    const file=new File(['第一章 开始\n正文。'],'fixture.txt');
    const first=await parsePublication(file);
    const cloud={...first.book,id:'catalog|shared-book',title:'云端书籍'};
    const restored=await parsePublication(file,undefined,[cloud]);
    expect(restored.book.id).toBe(cloud.id);expect(restored.chapters[0].id).toBe(cloud.id+'|0');
    await expect(parsePublication(new File(['其他正文'],'wrong.txt'),cloud)).rejects.toThrow('不一致');
  });
  it('bounds unbroken TXT without dropping composed characters',()=>{
    const text='👩🏽‍🚀中文'.repeat(10000);const chapters=textChapters(text,'书');
    expect(chapters.flatMap(c=>c.paragraphs).join('')).toBe(text);
    expect(chapters.every(c=>c.paragraphs.join('').length<=40000)).toBe(true);
  });
});
