import { unzipSync } from 'fflate';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Book, BookFormat, ChapterContent, LocalPublication } from '../shared/types';
const MAX_FILE = 250 * 1024 * 1024;
const MAX_EXPANDED = 200 * 1024 * 1024;
export function archivePath(path: string, base = ''): string {
  const value = decodeURIComponent(path.split('#')[0]);
  if (!value || value.startsWith('/') || /[\\\0]/.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) throw new Error('电子书资源路径无效');
  const parts = base.split('/').filter(Boolean);
  for (const piece of value.split('/')) {
    if (piece === '..') { if (!parts.length) throw new Error('电子书资源路径越界'); parts.pop(); }
    else if (piece && piece !== '.') parts.push(piece);
  }
  return parts.join('/');
}
function parseXML(text:string) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('EPUB 清单无法解析');
  return doc;
}
function elements(doc:Document, tag:string): Element[] { return Array.from(doc.getElementsByTagNameNS('*',tag)); }
function bodyParagraphs(html:string) {
  const doc = new DOMParser().parseFromString(html,'text/html');
  doc.querySelectorAll('script,style,nav,noscript,iframe,object,svg').forEach(n=>n.remove());
  doc.querySelectorAll('br').forEach(n=>n.replaceWith('\n'));
  doc.querySelectorAll('p,div,h1,h2,h3,h4,li,blockquote,section,article').forEach(n=>n.append('\n'));
  const paragraphs = (doc.body.textContent || '').split(/\n+/).map(p=>p.trim()).filter(Boolean);
  return {title:doc.querySelector('h1,h2,h3')?.textContent?.trim() || doc.title, paragraphs};
}
export function textChapters(text:string, title:string) {
  const chapters:{title:string;paragraphs:string[]}[]=[];
  let heading=title, paragraphs:string[]=[], length=0;
  const flush=()=>{if(paragraphs.length)chapters.push({title:heading,paragraphs}); paragraphs=[];length=0;};
  for(const line of text.replace(/^\uFEFF/,'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean)) {
    if(/^(第[零〇一二三四五六七八九十百千万两\d]{1,16}[章回节卷部].{0,60}|chapter\s+[\dIVXLC]+.{0,60})$/i.test(line)){flush();heading=line;continue;}
    const chars=Array.from(new Intl.Segmenter('zh',{granularity:'grapheme'}).segment(line),part=>part.segment);
    for(let i=0;i<chars.length;i+=4000){const part=chars.slice(i,i+4000).join('');if(length+part.length>40000){flush();heading=`${title} · ${chapters.length+1}`;}paragraphs.push(part);length+=part.length;}
  }
  flush();
  if(!chapters.length)throw new Error('文件没有可读取的正文');
  return chapters;
}
export async function parsePublication(file:File, metadata?:Book):Promise<LocalPublication> {
  if(!file.size || file.size>MAX_FILE) throw new Error('请选择 250 MB 以内的非空电子书');
  const format=(metadata?.publicationFormat || file.name.split('.').pop()?.toLowerCase()) as BookFormat;
  if(!['epub','pdf','txt'].includes(format)) throw new Error('支持 EPUB、PDF 和 TXT 文件');
  const data=new Uint8Array(await file.arrayBuffer());
  const identity=Array.from(sha256(data),v=>v.toString(16).padStart(2,'0')).join('');
  let title=file.name.replace(/\.[^.]+$/,''), author='';
  let sections:{title:string;paragraphs:string[]}[]=[]; let cover:Blob|undefined;
  if(format==='pdf'){
    if(new TextDecoder().decode(data.slice(0,5))!=='%PDF-')throw new Error('文件不是有效的 PDF');
  } else if(format==='txt') {
    if(file.size>20*1024*1024)throw new Error('TXT 最大支持 20 MB');
    let text:string;
    if(data[0]===0xff&&data[1]===0xfe)text=new TextDecoder('utf-16le').decode(data);
    else if(data[0]===0xfe&&data[1]===0xff)text=new TextDecoder('utf-16be').decode(data);
    else {try{text=new TextDecoder('utf-8',{fatal:true}).decode(data);}catch{text=new TextDecoder('gb18030').decode(data);}}
    sections=textChapters(text,title);
  } else {
    let total=0,count=0;
    const files=unzipSync(data,{filter:entry=>{
      count++;total+=entry.originalSize;
      if(count>10000||entry.originalSize>16*1024*1024||total>MAX_EXPANDED)throw new Error('EPUB 解压内容过大');
      if(entry.name.split('/').includes('..')||entry.name.startsWith('/')||/[\\\0]/.test(entry.name))throw new Error('EPUB 包含不安全路径');
      return /\.(xml|opf|xhtml|html|htm|jpg|jpeg|png|webp)$/i.test(entry.name);
    }});
    const read=(path:string)=>{const d=files[path];if(!d)throw new Error(`EPUB 缺少资源：${path}`);return new TextDecoder().decode(d);};
    const container=parseXML(read('META-INF/container.xml'));
    const opfPath=archivePath(elements(container,'rootfile')[0]?.getAttribute('full-path')||'');
    const opf=parseXML(read(opfPath)), base=opfPath.split('/').slice(0,-1).join('/');
    title=elements(opf,'title')[0]?.textContent?.trim()||title;
    author=elements(opf,'creator')[0]?.textContent?.trim()||'';
    const manifest=new Map(elements(opf,'item').map(item=>[item.getAttribute('id'),item]));
    for(const ref of elements(opf,'itemref')){
      if(ref.getAttribute('linear')==='no')continue;
      const item=manifest.get(ref.getAttribute('idref'));
      if(!item?.getAttribute('media-type')?.includes('html'))continue;
      const section=bodyParagraphs(read(archivePath(item.getAttribute('href')||'',base)));
      if(section.paragraphs.length)sections.push({title:section.title||`第 ${sections.length+1} 节`,paragraphs:section.paragraphs});
    }
    const coverID=elements(opf,'meta').find(e=>e.getAttribute('name')==='cover')?.getAttribute('content');
    const coverItem=Array.from(manifest.values()).find(e=>e.getAttribute('properties')?.split(' ').includes('cover-image'))||manifest.get(coverID||'');
    if(coverItem){const path=archivePath(coverItem.getAttribute('href')||'',base);const bytes=files[path];const mime=coverItem.getAttribute('media-type')||'';if(bytes&&bytes.byteLength<=8*1024*1024&&/^image\/(jpeg|png|webp)$/.test(mime))cover=new Blob([new Uint8Array(bytes)],{type:mime});}
    if(!sections.length)throw new Error('EPUB 无可读取正文，可能加密或仅包含图片');
  }
  const book:Book=metadata||{id:`file|${identity}`,title,author,summary:'',sourceID:'local-file',sourceName:'本地文件',url:`qingread-import://${identity}`,publicationFormat:format};
  const chapters=sections.map((section,index)=>({id:`${book.id}|${index}`,title:section.title,url:`qingread-import://${identity}/${index}`,index}));
  const contents:ChapterContent[]=chapters.map((chapter,index)=>({chapter,paragraphs:sections[index].paragraphs}));
  return {book,chapters,contents,file,cover};
}
