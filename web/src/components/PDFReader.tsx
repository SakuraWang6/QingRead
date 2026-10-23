import { useBodyScrollLock } from '../lib/bodyScrollLock';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Bookmark, ChevronLeft, ChevronRight, List, Minus, Plus, X, LoaderCircle } from 'lucide-react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerURL from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { Book, Chapter } from '../shared/types';
import { library, useLibrary } from '../lib/store';
import { useAndroidBack } from '../lib/android';
import { ReaderDeviceStatus } from './ReaderDeviceStatus';
import { PDFNotes } from './PDFNotes';
import './Reader.css';

GlobalWorkerOptions.workerSrc = workerURL;
interface OutlineItem { title: string; dest: string | unknown[] | null; items: OutlineItem[]; url?: string | null }

export function PDFReader({ book, onClose }: { book: Book; onClose: () => void }) {
  const state = useLibrary();
  const saved = useRef(state.shelf.find(entry => entry.book.id === book.id)?.position);
  const owner = useRef(library);
  const [document, setDocument] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState((saved.current?.chapterIndex ?? 0) + 1);
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [showOutline, setShowOutline] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [width, setWidth] = useState(0);
  const [retry, setRetry] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const chapters = useRef<Chapter[]>([]);
  useAndroidBack(() => { if (showNotes) setShowNotes(false); else if (showOutline) setShowOutline(false); else onClose(); return true; }, 300);

  useEffect(() => {
    let canceled = false;
    let task: ReturnType<typeof getDocument> | undefined;
    setLoading(true); setError('');
    (async () => {
      const file = await owner.current.getPublication(book);
      if (!file) throw new Error('本机未找到 PDF，请返回书架重新下载或导入。');
      const data = new Uint8Array(await file.arrayBuffer());
      if (canceled || owner.current !== library) return;
      task = getDocument({
        data, useSystemFonts: true,
        cMapUrl: new URL(import.meta.env.BASE_URL + 'pdfjs/cmaps/', location.href).href, cMapPacked: true,
        standardFontDataUrl: new URL(import.meta.env.BASE_URL + 'pdfjs/standard_fonts/', location.href).href,
        wasmUrl: new URL(import.meta.env.BASE_URL + 'pdfjs/wasm/', location.href).href,
      });
      task.onPassword = () => { if (!canceled && owner.current === library) { setError('这份 PDF 需要密码，请先导入已解锁的文件。'); setLoading(false); } };
      const pdf = await task.promise;
      if (canceled || owner.current !== library) { void task.destroy(); return; }
      const savedChapters = await owner.current.getChapters(book);
      chapters.current = savedChapters?.length === pdf.numPages ? savedChapters : Array.from({ length: pdf.numPages }, (_, index) => ({ id: `${book.id}|${index}`, title: `第 ${index + 1} 页`, index, url: book.url }));
      const catalog = await pdf.getOutline();
      if (canceled || owner.current !== library) return;
      setDocument(pdf); setPageCount(pdf.numPages); setPage(value => Math.max(1, Math.min(value, pdf.numPages)));
      setOutline((catalog ?? []) as OutlineItem[]);
    })().catch(reason => { if (!canceled && owner.current === library) { setError(reason instanceof Error ? reason.message : '无法打开 PDF'); setLoading(false); } });
    return () => { canceled = true; void task?.destroy(); };
  }, [book.id, retry]);

  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const observer = new ResizeObserver(entries => setWidth(entries[0].contentRect.width));
    observer.observe(element); return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!document || !canvas.current || width <= 0) return;
    let canceled = false;
    let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    setLoading(true); setError('');
    (async () => {
      const pdfPage = await document.getPage(page);
      if (canceled || !canvas.current) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const scale = Math.max(.1, (width - 32) / base.width) * zoom;
      const view = pdfPage.getViewport({ scale });
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const target = canvas.current;
      const context = target.getContext('2d'); if (!context) throw new Error('浏览器无法显示 PDF 页面。');
      target.width = Math.floor(view.width * pixelRatio); target.height = Math.floor(view.height * pixelRatio);
      target.style.width = `${view.width}px`; target.style.height = `${view.height}px`;
      render = pdfPage.render({ canvas: target, canvasContext: context, viewport: view, transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0] });
      await render.promise;
      if (!canceled) { setLoading(false); if (viewport.current) viewport.current.scrollTop = 0; }
    })().catch(reason => {
      if (!canceled && reason?.name !== 'RenderingCancelledException') { setError(reason instanceof Error ? reason.message : '页面暂时无法显示'); setLoading(false); }
    });
    return () => { canceled = true; render?.cancel(); };
  }, [document, page, zoom, width]);

  useEffect(() => {
    if (!document || !chapters.current[page - 1] || owner.current !== library) return;
    void owner.current.savePosition(book, chapters.current[page - 1], 0, 0);
  }, [document, page]);

  useBodyScrollLock();
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).matches('input, textarea, [contenteditable="true"]')) return;
      if (event.key === 'ArrowRight' || event.key === 'PageDown') setPage(value => Math.min(pageCount || 1, value + 1));
      if (event.key === 'ArrowLeft' || event.key === 'PageUp') setPage(value => Math.max(1, value - 1));
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', key); };
  }, [pageCount]);

  async function openDestination(item: OutlineItem) {
    if (!document || !item.dest) return;
    const dest = typeof item.dest === 'string' ? await document.getDestination(item.dest) : item.dest;
    if (!dest?.[0]) return;
    const ref = dest[0];
    const index = typeof ref === 'number' ? ref : await document.getPageIndex(ref as Parameters<PDFDocumentProxy['getPageIndex']>[0]);
    setPage(index + 1); setShowOutline(false);
  }
  const renderOutline = (items: OutlineItem[]) => <ul className="reader-pdf-outline">{items.map((item, index) => <li key={`${item.title}-${index}`}><button disabled={!item.dest} onClick={() => void openDestination(item)}>{item.title}</button>{item.items?.length > 0 && renderOutline(item.items)}</li>)}</ul>;

  return <div className="reader-root reader-theme-gray" role="dialog" aria-modal="true" aria-label={`正在阅读${book.title}`}>
    <header className="reader-toolbar reader-topbar reader-pdf-toolbar"><button aria-label="返回书架" onClick={onClose}><ArrowLeft/></button><span>{book.title}</span><button onClick={() => setShowNotes(true)} aria-label="PDF 书签与搜索" disabled={!document}><Bookmark/></button><button onClick={() => setShowOutline(true)} aria-label="PDF 目录"><List/></button></header>
    <main ref={viewport} className="reader-pdf-viewport"><canvas ref={canvas} className="reader-pdf-canvas" aria-label={`第 ${page} 页`}/>{loading && !error && <div className="reader-status"><LoaderCircle className="reader-spin"/><p>正在显示 PDF</p></div>}{error && <div className="reader-status" role="alert"><p>{error}</p><button onClick={() => setRetry(value => value + 1)}>重试</button><button onClick={onClose}>返回书架</button></div>}</main>
    <footer className="reader-toolbar reader-bottom-controls reader-pdf-toolbar"><div className="reader-progress-label"><span>第 {page} / {pageCount || '—'} 页</span><span>{pageCount ? ((page / pageCount) * 100).toFixed(1) : '0.0'}%</span></div><div className="reader-progress-row"><button aria-label="上一页" disabled={page <= 1} onClick={() => setPage(value => value - 1)}><ChevronLeft/></button><input aria-label="PDF 页码" type="range" min="1" max={pageCount || 1} value={page} onChange={event => setPage(Number(event.target.value))}/><button aria-label="下一页" disabled={page >= pageCount} onClick={() => setPage(value => value + 1)}><ChevronRight/></button></div><div className="reader-pdf-zoom"><button aria-label="缩小" disabled={zoom <= .5} onClick={() => setZoom(value => Math.max(.5, value - .25))}><Minus size={17}/></button><span>{Math.round(zoom * 100)}%</span><button aria-label="放大" disabled={zoom >= 3} onClick={() => setZoom(value => Math.min(3, value + .25))}><Plus size={17}/></button></div></footer>
    <div className="reader-running-foot"><span>{page} / {pageCount || '—'}</span><ReaderDeviceStatus/></div>
    {showOutline && <div className="reader-panel-backdrop" onClick={() => setShowOutline(false)}><section className="reader-panel reader-catalog" onClick={event => event.stopPropagation()}><header className="reader-panel-header"><h2>PDF 目录</h2><button aria-label="关闭目录" onClick={() => setShowOutline(false)}><X/></button></header><div className="reader-catalog-list">{outline.length ? renderOutline(outline) : <p className="reader-empty">这份 PDF 没有内嵌目录，可通过下方页码条定位。</p>}</div></section></div>}
    {showNotes && document && <PDFNotes book={book} document={document} pageIndex={page - 1} onClose={() => setShowNotes(false)} onJump={index => setPage(index + 1)}/>}
  </div>;
}
