import { useEffect,useState } from 'react';
import type { Book } from '../shared/types';
import { api } from '../lib/api';
import { library } from '../lib/store';
import { WorkflowDialog } from './ReadingWorkflows';
export function AuthorBooks({author,onClose,onBook}:{author:string;onClose:()=>void;onBook:(book:Book)=>void}){
  const [books,setBooks]=useState<Book[]>(library.getSnapshot().shelf.map(e=>e.book).filter(b=>b.author===author)),[busy,setBusy]=useState(true),[error,setError]=useState('');
  useEffect(()=>{const controller=new AbortController();api.author(author,controller.signal).then(result=>{if(!controller.signal.aborted)setBooks(old=>[...new Map([...old,...result.books].map(b=>[b.id,b])).values()]);}).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:'暂未加载作品');}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});return()=>controller.abort();},[author]);
  return <WorkflowDialog title={author} onClose={onClose}><div className="reading-notes-list">{books.map(book=><button className="cached-search-hit" key={book.id} onClick={()=>onBook(book)}><strong>{book.title}</strong><span>{book.sourceName}</span></button>)}</div>{busy&&<p className="workflow-empty">正在查找作品…</p>}{!busy&&!books.length&&<p className="workflow-empty">暂未找到可用作品</p>}{error&&<p className="workflow-error">{error}</p>}</WorkflowDialog>;
}
