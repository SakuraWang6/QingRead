import { useEffect, useState } from 'react';
import { Bookmark, Check, Search, Trash2 } from 'lucide-react';
import type { Book, Chapter, ReadingAnnotation, ShelfOrganization } from '../shared/types';
import { library, useLibrary } from '../lib/store';
import { safeOffset } from '../lib/readerLayout';
import { WorkflowDialog } from './ReadingWorkflows';
import './LibraryTools.css';

export function OrganizationEditor({ bookIDs, onClose }: { bookIDs:string[]; onClose:()=>void }) {
  const state=useLibrary(),first=state.shelf.find(e=>bookIDs.includes(e.book.id))?.organization;
  const [group,setGroup]=useState(first?.group??''),[error,setError]=useState('');
  async function apply(patch:Partial<ShelfOrganization>){try{await library.organize(bookIDs,patch);onClose();}catch(e){setError(String(e));}}
  return <WorkflowDialog title="整理书架" onClose={onClose}>
    <div className="library-tool-options"><button onClick={()=>void apply({pinned:true})}>置顶</button><button onClick={()=>void apply({pinned:false})}>取消置顶</button></div>
    <div className="library-tool-options">{(['reading','later','finished'] as const).map((status,i)=><button key={status} onClick={()=>void apply({status})}>{['在读','待读','读完'][i]}</button>)}</div>
    <label className="field-label" htmlFor="shelf-group">分组</label><input id="shelf-group" className="text-input" maxLength={64} value={group} onChange={e=>setGroup(e.target.value)} placeholder="分组名称" list="shelf-groups"/>
    <datalist id="shelf-groups">{[...new Set(state.shelf.map(e=>e.organization?.group).filter(Boolean))].map(name=><option key={name} value={name}/>)}</datalist>
    <button className="primary-button full-width" onClick={()=>void apply({group:group.trim()})}><Check size={16}/>保存分组</button>{error&&<p role="alert">{error}</p>}
  </WorkflowDialog>;
}

export interface TextSelection { offset:number; length:number; quote:string; scope?:'paragraph' }
export function ReadingNotes({book,chapter,offset,selection,onClose,onJump}:{book:Book;chapter:Chapter;offset:number;selection?:TextSelection;onClose:()=>void;onJump:(chapterID:string,offset:number,title?:string,sourceID?:string,sourceURL?:string)=>void}){
  const state=useLibrary(),paragraphMode=selection?.scope==='paragraph';
  const notes=state.shelf.find(e=>e.book.id===book.id)?.annotations?.filter(n=>{
    if(n.deletedAt)return false;
    if(!paragraphMode)return true;
    if(n.kind!=='note'||n.chapterID!==chapter.id||n.sourceID!==book.sourceID||n.sourceURL!==book.url)return false;
    const end=selection.offset+selection.length;
    return n.characterOffset<end&&(n.characterLength===0?n.characterOffset>=selection.offset:n.characterOffset+n.characterLength>selection.offset);
  })??[];
  const [tab,setTab]=useState<'notes'|'search'>('notes'),[note,setNote]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[query,setQuery]=useState('');
  const [results,setResults]=useState<Awaited<ReturnType<typeof library.searchCached>>>([]);
  const [editing,setEditing]=useState<ReadingAnnotation>();
  useEffect(()=>{if(tab!=='search'||!query.trim()){setResults([]);return;}const controller=new AbortController(),owner=library;setBusy(true);const timer=setTimeout(()=>{owner.searchCached(book,query,controller.signal).then(r=>{if(!controller.signal.aborted&&library===owner)setResults(r);}).catch(e=>setError(String(e))).finally(()=>{if(!controller.signal.aborted)setBusy(false);});},250);return()=>{clearTimeout(timer);controller.abort();};},[query,tab,book]);
  async function save(){
    if(paragraphMode&&!note.trim())return;
    setBusy(true);setError('');
    const quote=selection?.quote??'';
    const value:ReadingAnnotation=editing?{...editing,kind:note.trim()?'note':'bookmark',note:note.trim(),updatedAt:new Date().toISOString()}:{id:crypto.randomUUID(),kind:note.trim()?'note':'bookmark',chapterID:chapter.id,chapterIndex:chapter.index,chapterTitle:chapter.title,characterOffset:selection?.offset??offset,characterLength:selection?.length??0,quote:quote.slice(0,safeOffset(quote,500)),note:note.trim(),updatedAt:new Date().toISOString(),sourceID:book.sourceID,sourceURL:book.url};
    try{await library.annotate(book,value);setNote('');setEditing(undefined);if(selection?.scope==='paragraph')onClose();}catch(e){setError(e instanceof Error?e.message:'保存失败');}finally{setBusy(false);}
  }
  async function copyQuote(){try{if(!navigator.clipboard?.writeText)throw new Error();await navigator.clipboard.writeText(editing?.quote??selection?.quote??'');setError('');}catch{setError('未能复制，请长按引用文字复制');}}
  return <WorkflowDialog title={paragraphMode?'段落笔记':'书签与笔记'} onClose={onClose}>
    {!paragraphMode&&<div className="segmented"><button className={tab==='notes'?'active':''} onClick={()=>setTab('notes')}>书签 · 笔记</button><button className={tab==='search'?'active':''} onClick={()=>setTab('search')}><Search size={15}/>正文搜索</button></div>}
    {tab==='notes'?<>
      {(editing?.quote||selection?.quote)&&<><blockquote className="note-quote">{editing?.quote??selection?.quote}</blockquote><button className="text-button" onClick={()=>void copyQuote()}>复制原文</button></>}
      <textarea className="text-input note-input" aria-label="笔记内容" autoFocus={paragraphMode} maxLength={1000} value={note} onChange={e=>setNote(e.target.value)} placeholder={paragraphMode?'写下想法':'写笔记（可留空）'}/>
      <button className="primary-button full-width" disabled={busy||paragraphMode&&!note.trim()} onClick={()=>void save()}><Bookmark size={16}/>{editing?'保存修改':paragraphMode||note.trim()?'保存笔记':'添加书签'}</button>{editing&&<button className="text-button" onClick={()=>{setEditing(undefined);setNote('');}}>取消编辑</button>}
      <div className="reading-notes-list">{[...notes].sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt)).map(item=><article key={item.id}>
        <button className="note-location" onClick={()=>onJump(item.chapterID,item.characterOffset,item.chapterTitle,item.sourceID,item.sourceURL)}><strong>{item.chapterTitle}</strong><span>{item.quote||(item.kind==='note'?'正文笔记':'正文书签')}</span>{item.note&&<p>{item.note}</p>}</button>
        <button className="text-button" aria-label="编辑笔记" onClick={()=>{setEditing(item);setNote(item.note);}}>编辑</button><button className="icon-button" aria-label={`删除${item.kind==='note'?'笔记':'书签'}`} onClick={()=>void library.deleteAnnotation(book,item.id).catch(e=>setError(String(e)))}><Trash2 size={16}/></button>
      </article>)}</div>{!notes.length&&<p className="workflow-empty">{paragraphMode?'暂无段落笔记':'暂无书签和笔记'}</p>}
    </>:<><input className="text-input" aria-label="搜索已缓存正文" value={query} maxLength={100} onChange={e=>setQuery(e.target.value)} placeholder="搜索已缓存正文"/>
      <div className="reading-notes-list">{results.map((r,i)=><button className="cached-search-hit" key={`${r.chapter.id}:${r.offset}:${i}`} onClick={()=>onJump(r.chapter.id,r.offset)}><strong>{r.chapter.title}</strong><span>{r.excerpt}</span></button>)}</div>
      {query&&!results.length&&!busy&&<p className="workflow-empty">未找到已缓存的内容</p>}</>}
    {error&&<p className="workflow-error" role="alert">{error}</p>}
  </WorkflowDialog>;
}
