import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, List, RotateCcw, X } from 'lucide-react';
import type { Book } from '../shared/types';
import { library, useLibrary } from '../lib/store';
import { parseRichEpub, type RichEpub } from '../lib/richEpub';
import { useAndroidBack } from '../lib/android';
import './EPUBReader.css';

interface OriginalPosition { path: string; fragment: string; fraction: number }
interface Navigation extends OriginalPosition { serial: number }

export function EPUBReader({ book, onClose, onText }: { book: Book; onClose: () => void; onText: () => void }) {
  const state = useLibrary();
  const owner = useRef(library);
  const storageKey = useRef('qingread.epub-original.v1:' + JSON.stringify([owner.current.profile, book.id]));
  const frame = useRef<HTMLIFrameElement>(null), detach = useRef<() => void>(() => {});
  const lastPosition = useRef<OriginalPosition | undefined>(undefined), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [publication, setPublication] = useState<RichEpub>(), [error, setError] = useState('');
  const [navigation, setNavigation] = useState<Navigation>(), [showOutline, setShowOutline] = useState(false);
  const [history, setHistory] = useState<OriginalPosition[]>([]);
  const lastSpineIndex = useRef(0);
  const openedSaved = useRef(state.shelf.some(entry => entry.book.id === book.id));
  const foundIndex = publication?.chapters.findIndex(chapter => chapter.path === navigation?.path) ?? -1;
  if (foundIndex >= 0) lastSpineIndex.current = foundIndex;
  const currentIndex = lastSpineIndex.current;
  function persist() {
    if (library !== owner.current || !lastPosition.current) return;
    try { localStorage.setItem(storageKey.current, JSON.stringify(lastPosition.current)); } catch { /* Original file and text anchors remain safe if local storage is full. */ }
  }
  function remember(value: OriginalPosition) { lastPosition.current = value; clearTimeout(timer.current); timer.current = setTimeout(persist, 250); }
  function navigate(value: OriginalPosition, record = true) {
    if (!publication?.has(value.path)) return;
    const previous = lastPosition.current;
    if (record && previous) setHistory(values => [...values.slice(-29), previous]);
    setNavigation({ ...value, serial: Date.now() + Math.random() });
    lastPosition.current = value; setShowOutline(false);
  }
  function back() {
    const target = history[history.length - 1]; if (!target) return;
    setHistory(values => values.slice(0, -1)); navigate(target, false);
  }
  useAndroidBack(() => { if (showOutline) setShowOutline(false); else if (history.length) back(); else onClose(); return true; }, 300);
  useEffect(() => {
    let canceled = false, resource: RichEpub | undefined;
    void (async () => {
      const file = await owner.current.getPublication(book);
      if (!file) throw new Error('本机未找到 EPUB，请返回书架重新下载或导入。');
      resource = await parseRichEpub(file);
      if (canceled || owner.current !== library) { resource.dispose(); return; }
      let saved: OriginalPosition | undefined;
      try {
        const value = JSON.parse(localStorage.getItem(storageKey.current) || 'null');
        if (value && resource.has(value.path) && typeof value.fragment === 'string' && typeof value.fraction === 'number' && Number.isFinite(value.fraction)) saved = { path: value.path, fragment: value.fragment, fraction: Math.max(0, Math.min(1, value.fraction)) };
      } catch { /* A missing or old original-view position falls back to the existing text chapter. */ }
      const textPosition = owner.current.getSnapshot().shelf.find(entry => entry.book.id === book.id)?.position;
      const chapter = resource.chapters.find(chapter => chapter.textChapterIndex === (textPosition?.chapterIndex ?? 0)) ?? resource.chapters[0];
      const position = saved ?? { path: chapter.path, fragment: '', fraction: textPosition?.chapterFraction ?? 0 };
      lastPosition.current = position; setPublication(resource); setNavigation({ ...position, serial: 0 });
    })().catch(value => { if (!canceled) setError(value instanceof Error ? value.message : '无法打开原版 EPUB'); });
    return () => { canceled = true; clearTimeout(timer.current); persist(); detach.current(); if (frame.current) frame.current.srcdoc = ''; resource?.dispose(); };
  }, [book.id, book.fileHash]);
  useEffect(() => { if (library !== owner.current || openedSaved.current && !state.shelf.some(entry => entry.book.id === book.id)) onClose(); }, [state, book.id, onClose]);

  function loaded() {
    detach.current();
    const document = frame.current?.contentDocument, window = frame.current?.contentWindow, current = navigation;
    if (!document || !window || !current || !publication) return;
    let interacted = false;
    const restore = () => {
      if (interacted) return;
      if (current.fragment) document.getElementById(current.fragment)?.scrollIntoView();
      else window.scrollTo(0, Math.max(0, document.documentElement.scrollHeight - window.innerHeight) * current.fraction);
    };
    const interact = () => { interacted = true; };
    const scroll = () => {
      if (!interacted) return;
      const maximum = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      remember({ path: current.path, fragment: '', fraction: Math.max(0, Math.min(1, window.scrollY / maximum)) });
    };
    const click = (event: MouseEvent) => {
      const element = event.target as Element | null;
      const target = element?.nodeType === 1 ? element.closest('a') : null;
      if (!target) return;
      event.preventDefault();
      const path = target.getAttribute('data-qingread-path');
      if (path && publication.has(path)) navigate({ path, fragment: target.getAttribute('data-qingread-fragment') || '', fraction: 0 });
    };
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(restore) : undefined;
    observer?.observe(document.body);
    window.addEventListener('scroll', scroll, { passive: true }); document.addEventListener('click', click);
    for (const event of ['touchstart', 'wheel', 'keydown', 'pointerdown']) document.addEventListener(event, interact, { passive: true });
    restore();
    detach.current = () => {
      observer?.disconnect(); window.removeEventListener('scroll', scroll); document.removeEventListener('click', click);
      for (const event of ['touchstart', 'wheel', 'keydown', 'pointerdown']) document.removeEventListener(event, interact);
    };
  }
  return <section className="epub-original" role="dialog" aria-label={`${book.title}原版阅读`}>
    <header className="epub-original-header"><button className="icon-button" onClick={() => { persist(); onClose(); }} aria-label="返回书架"><ArrowLeft size={21}/></button><strong>{book.title}</strong><button className="text-button" onClick={() => { persist(); onText(); }}>文字</button></header>
    {error ? <div className="epub-original-status" role="alert"><p>{error}</p><button className="primary-button" onClick={onText}>使用文字模式</button></div> : publication && navigation ? <iframe key={navigation.serial} ref={frame} className="epub-original-frame" title={publication.chapters[currentIndex]?.title || book.title} sandbox="allow-same-origin" referrerPolicy="no-referrer" srcDoc={publication.document(navigation.path)} onLoad={loaded}/> : <div className="epub-original-status" role="status">正在打开原版…</div>}
    <footer className="epub-original-footer"><button className="icon-button" aria-label="返回脚注前位置" disabled={!history.length} onClick={back}><RotateCcw size={19}/></button><button className="text-button" onClick={() => setShowOutline(true)} disabled={!publication}><List size={17}/>目录</button><span/><button className="icon-button" aria-label="上一节" disabled={!publication || currentIndex === 0} onClick={() => navigate({ path: publication!.chapters[currentIndex - 1].path, fragment: '', fraction: 0 })}><ChevronLeft size={19}/></button><small>{publication ? `${currentIndex + 1} / ${publication.chapters.length}` : '—'}</small><button className="icon-button" aria-label="下一节" disabled={!publication || currentIndex + 1 >= publication.chapters.length} onClick={() => navigate({ path: publication!.chapters[currentIndex + 1].path, fragment: '', fraction: 0 })}><ChevronRight size={19}/></button></footer>
    {showOutline && <aside className="epub-original-outline" role="dialog" aria-label="原版目录"><header><h2>目录</h2><button className="icon-button" aria-label="关闭目录" onClick={() => setShowOutline(false)}><X size={20}/></button></header><nav>{publication?.outline.map(item => <button key={item.id} style={{ paddingLeft: 18 + Math.min(item.depth, 5) * 14 }} onClick={() => navigate({ path: item.path, fragment: item.fragment, fraction: 0 })}>{item.title}</button>)}</nav></aside>}
  </section>;
}
