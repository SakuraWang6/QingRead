import { useEffect, useRef, useState } from 'react';
import { Bookmark, Search, Trash2 } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Book, ReadingAnnotation } from '../shared/types';
import { library, useLibrary } from '../lib/store';
import { pdfPageID, searchPDFText, type PDFSearchHit } from '../lib/pdfText';
import { WorkflowDialog } from './ReadingWorkflows';
import './LibraryTools.css';

export function PDFNotes({ book, document, pageIndex, onClose, onJump }: { book: Book; document: PDFDocumentProxy; pageIndex: number; onClose(): void; onJump(index: number): void }) {
  const state = useLibrary(), owner = useRef(library), controller = useRef<AbortController | undefined>(undefined);
  const [tab, setTab] = useState<'notes'|'search'>('notes'), [note, setNote] = useState(''), [query, setQuery] = useState('');
  const [results, setResults] = useState<PDFSearchHit[]>([]), [selected, setSelected] = useState<PDFSearchHit>();
  const [busy, setBusy] = useState(false), [scanned, setScanned] = useState(0), [error, setError] = useState('');
  const notes = state.shelf.find(entry => entry.book.id === book.id)?.annotations?.filter(value => !value.deletedAt) ?? [];
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { if (owner.current !== library) { controller.current?.abort(); onClose(); } }, [state, onClose]);
  async function save() {
    if (owner.current !== library) return;
    const index = selected?.pageIndex ?? pageIndex;
    const value: ReadingAnnotation = { id: crypto.randomUUID(), kind: note.trim() || selected ? 'note' : 'bookmark', chapterID: pdfPageID(index), chapterIndex: index, chapterTitle: `第 ${index + 1} 页`, characterOffset: selected?.offset ?? 0, characterLength: selected?.length ?? 0, quote: selected?.quote ?? '', note: note.trim(), updatedAt: new Date().toISOString(), sourceID: book.sourceID, sourceURL: book.url };
    setBusy(true); setError('');
    try { await owner.current.annotate(book, value); if (owner.current === library) { setNote(''); setSelected(undefined); } }
    catch (value) { setError(value instanceof Error ? value.message : '保存失败'); }
    finally { setBusy(false); }
  }
  async function search() {
    controller.current?.abort(); const request = new AbortController(); controller.current = request;
    setBusy(true); setError(''); setResults([]); setScanned(0);
    try { const values = await searchPDFText(document, query, request.signal, value => { if (!request.signal.aborted) setScanned(value); }); if (!request.signal.aborted && library === owner.current) setResults(values); }
    catch (value) { if (!request.signal.aborted) setError(value instanceof Error ? value.message : '本地搜索未完成'); }
    finally { if (!request.signal.aborted) setBusy(false); }
  }
  function jump(index: number) { if (index >= 0 && index < document.numPages && owner.current === library) { onJump(index); onClose(); } }
  return <WorkflowDialog title="书签与搜索" onClose={onClose}>
    <div className="segmented"><button className={tab === 'notes' ? 'active' : ''} onClick={() => setTab('notes')}>书签 · 笔记</button><button className={tab === 'search' ? 'active' : ''} onClick={() => setTab('search')}><Search size={15}/>正文搜索</button></div>
    {tab === 'notes' ? <>
      {selected && <blockquote className="note-quote">第 {selected.pageIndex + 1} 页 · {selected.quote}<button className="text-button" onClick={() => setSelected(undefined)}>取消引用</button></blockquote>}
      <textarea className="text-input note-input" aria-label="PDF 笔记内容" maxLength={1000} placeholder={`第 ${(selected?.pageIndex ?? pageIndex) + 1} 页 · 写笔记（可留空）`} value={note} onChange={event => setNote(event.target.value)}/>
      <button className="primary-button full-width" disabled={busy} onClick={() => void save()}><Bookmark size={16}/>{note.trim() || selected ? '保存笔记' : '添加当前页书签'}</button>
      <div className="reading-notes-list">{notes.map(value => <article key={value.id}><button className="note-location" onClick={() => value.sourceID === book.sourceID && value.sourceURL === book.url ? jump(value.chapterIndex) : setError('这条笔记来自另一版本')}><strong>{value.chapterTitle}</strong>{value.quote && <span>{value.quote}</span>}{value.note && <p>{value.note}</p>}</button><button className="icon-button" aria-label="删除标注" onClick={() => void owner.current.deleteAnnotation(book, value.id).catch(value => setError(String(value)))}><Trash2 size={16}/></button></article>)}</div>
    </> : <>
      <form className="library-tool-options" onSubmit={event => { event.preventDefault(); void search(); }}><input className="text-input" aria-label="搜索 PDF 正文" maxLength={100} placeholder="搜索 PDF 正文" value={query} onChange={event => setQuery(event.target.value)}/>{busy ? <button type="button" className="text-button" onClick={() => { controller.current?.abort(); setBusy(false); }}>停止</button> : <button className="text-button" disabled={!query.trim()} type="submit">搜索</button>}</form>
      {busy && <p role="status">正在搜索 · {scanned}/{document.numPages}</p>}
      <div className="reading-notes-list">{results.map((value, index) => <article key={`${value.pageIndex}:${value.offset}:${index}`}><button className="note-location" onClick={() => jump(value.pageIndex)}><strong>第 {value.pageIndex + 1} 页</strong><span>{value.excerpt}</span></button><button className="icon-button" aria-label="引用搜索结果记笔记" onClick={() => { setSelected(value); setTab('notes'); }}><Bookmark size={16}/></button></article>)}</div>
      {!busy && query && !results.length && scanned > 0 && <p className="workflow-empty">未找到可搜索文字；图片型 PDF 暂不支持 OCR。</p>}
    </>}
    {error && <p className="workflow-error" role="alert">{error}</p>}
  </WorkflowDialog>;
}
