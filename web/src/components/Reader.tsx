import { Component, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, List, Settings2, Headphones, Play, Pause, X, Moon, Sun, LoaderCircle, Download, Search, RefreshCw } from 'lucide-react';
import type { Book, Chapter, ChapterContent, ReaderSettings, ReadingTheme } from '../shared/types';
import { api } from '../lib/api';
import { library, useLibrary } from '../lib/store';
import { locationForBookFraction, pageForOffset, paginateText, paragraphSlices, safeOffset, wholeBookFraction, type TextPage } from '../lib/readerLayout';
import { ReaderSpeech } from '../lib/speech';
import { useAndroidBack } from '../lib/android';
import './Reader.css';

const LazyPDFReader = lazy(() => import('./PDFReader').then(module => ({ default: module.PDFReader })));

interface ReaderProps { book: Book; onClose: () => void; initialChapterID?: string }
type Panel = 'catalog' | 'settings' | 'speech' | null;
const themes: { value: ReadingTheme; name: string; color: string }[] = [
  { value: 'paper', name: '米白', color: '#f4eddf' }, { value: 'dusk', name: '暖黄', color: '#e8d8b5' },
  { value: 'mint', name: '青绿', color: '#dce7db' }, { value: 'gray', name: '浅灰', color: '#e5e5e3' },
  { value: 'rose', name: '浅粉', color: '#eddfdc' },
];

export function Reader(props: ReaderProps) {
  if (props.book.publicationFormat === 'pdf') return <PDFLoadBoundary key={props.book.id} onClose={props.onClose}><Suspense fallback={<div className="reader-root reader-theme-gray"><div className="reader-status"><LoaderCircle className="reader-spin"/><p>正在打开 PDF 阅读器</p><button onClick={props.onClose}>返回书架</button></div></div>}><LazyPDFReader book={props.book} onClose={props.onClose}/></Suspense></PDFLoadBoundary>;
  return <TextReader {...props} />;
}

class PDFLoadBoundary extends Component<{ onClose: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div className="reader-root reader-theme-gray" role="dialog" aria-label="PDF 暂时无法打开"><div className="reader-status" role="alert"><p>这个浏览器暂时无法打开 PDF。请更新浏览器或 Android System WebView 后重试；EPUB 和 TXT 仍可阅读。</p><button onClick={this.props.onClose}>返回书架</button></div></div>;
    return this.props.children;
  }
}

function TextReader({ book, onClose, initialChapterID }: ReaderProps) {
  const state = useLibrary();
  const settings = state.settings;
  const position = useRef(state.shelf.find(entry => entry.book.id === book.id)?.position);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [index, setIndex] = useState(0);
  const [content, setContent] = useState<ChapterContent>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [catalogRetry, setCatalogRetry] = useState(0);
  const [controls, setControls] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [pages, setPages] = useState<TextPage[]>([]);
  const pagesRef = useRef(pages); pagesRef.current = pages;
  const [page, setPage] = useState(0);
  const [anchor, setAnchor] = useState(0);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [transition, setTransition] = useState('');
  const [laidOutSignature, setLaidOutSignature] = useState('');
  const [query, setQuery] = useState('');
  const [chapterStates, setChapterStates] = useState<Record<string, { cached: boolean; progress?: number }>>({});
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [speechState, setSpeechState] = useState({ speaking: false, paused: false });
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheNotice, setCacheNotice] = useState('');
  const [sliderValue, setSliderValue] = useState<number | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef(0);
  const targetRef = useRef<{ chapterID?: string; offset?: number; fraction?: number; lastPage?: boolean }>({});
  const pointer = useRef<{ x: number; y: number; time: number; edge: boolean } | null>(null);
  const speech = useRef(new ReaderSpeech());
  const continueSpeech = useRef(false);
  const cacheController = useRef<AbortController | null>(null);
  const layoutFrame = useRef<number | null>(null);
  const layoutEpoch = useRef(0);
  const text = content?.paragraphs.join('\n') ?? '';
  const textRef = useRef(text); textRef.current = text;
  const currentChapter = chapters[index];
  const layoutSignature = [currentChapter?.id, text, viewport.width, viewport.height, settings.fontSize, settings.lineSpacing, settings.paragraphSpacing, settings.horizontalMargin, settings.font, settings.isBold, settings.turnMode].join('\u0001');
  const layoutPending = settings.turnMode !== 'scroll' && Boolean(text) && laidOutSignature !== layoutSignature;
  const layoutPendingRef = useRef(layoutPending); layoutPendingRef.current = layoutPending;
  const turnModeRef = useRef(settings.turnMode); turnModeRef.current = settings.turnMode;
  const fraction = text.length ? Math.min(1, anchor / text.length) : 0;
  const totalFraction = wholeBookFraction(index, fraction, chapters.length);
  const isScroll = settings.turnMode === 'scroll';
  const setOffset = useCallback((value: number) => {
    const offset = safeOffset(textRef.current, value);
    anchorRef.current = offset; setAnchor(offset);
  }, []);
  useAndroidBack(() => { if (panel) setPanel(null); else close(); return true; }, 300);

  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = original; speech.current.stop(); cacheController.current?.abort(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    (async () => {
      const items = await library.getChapters(book) ?? await api.chapters(book, controller.signal);
      if (controller.signal.aborted) return;
      if (!items.length) throw new Error('这本书暂时没有可阅读的章节。');
      await library.cacheChapters(book, items);
      const wantedID = initialChapterID ?? position.current?.chapterID;
      const found = wantedID ? items.findIndex(item => item.id === wantedID) : -1;
      const selected = found >= 0 ? found : Math.min(position.current?.chapterIndex ?? 0, items.length - 1);
      targetRef.current = { chapterID: items[selected].id, offset: initialChapterID ? 0 : position.current?.characterOffset ?? 0 };
      setChapters(items); setIndex(selected);
    })().catch(reason => { if (!controller.signal.aborted) { setError(message(reason)); setLoading(false); } });
    return () => controller.abort();
  }, [book.id, initialChapterID, catalogRetry]);

  useEffect(() => {
    if (!currentChapter) return;
    const controller = new AbortController();
    setLoading(true); setError(''); setContent(undefined); setPages([]);
    speech.current.stop();
    (async () => {
      const result = await library.loadContent(book, currentChapter, controller.signal);
      if (controller.signal.aborted) return;
      if (!result.paragraphs.length || !result.paragraphs.some(item => item.trim())) throw new Error('这一章暂时没有正文，可以重试或换一章。');
      if (controller.signal.aborted) return;
      const chapterText = result.paragraphs.join('\n');
      const target = targetRef.current;
      const offset = target.lastPage ? chapterText.length : target.fraction !== undefined ? target.fraction * chapterText.length : target.offset ?? 0;
      const safe = safeOffset(chapterText, offset);
      anchorRef.current = safe; setAnchor(safe);
      setContent(result); setLoading(false);
    })().catch(reason => { if (!controller.signal.aborted) { continueSpeech.current = false; setError(message(reason)); setLoading(false); } });
    return () => controller.abort();
  }, [book.id, currentChapter?.id, retry]);

  useEffect(() => {
    if (!content || !currentChapter || content.chapter.id !== currentChapter.id) return;
    const controller = new AbortController();
    void library.prefetch(book, chapters, index, controller.signal).then(() => refreshChapterStates()).catch(() => {});
    void refreshChapterStates();
    return () => controller.abort();
  }, [content?.chapter.id]);

  async function refreshChapterStates() {
    setChapterStates(await library.chapterStates(book, chapters));
  }

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => {
      const bounds = entries[0].contentRect;
      setViewport(previous => previous.width === bounds.width && previous.height === bounds.height ? previous : { width: bounds.width, height: bounds.height });
    });
    observer.observe(element); return () => observer.disconnect();
  }, []);

  const repaginate = useCallback(() => {
    const element = measureRef.current;
    const container = viewportRef.current;
    if (!text || !element || !container || container.clientHeight <= 0 || container.clientWidth <= 0 || isScroll) return;
    // A fixed-height page gives the measurement block exactly the same formatting
    // context as the visible page. Auto-height hidden blocks can be laid out before
    // mobile text sizing and inherited typography have settled.
    element.style.height = `${container.clientHeight}px`;
    const result = paginateText(text, (start, end) => {
      element.replaceChildren(...paragraphSlices(text, start, end).map(part => {
        const p = document.createElement('p'); p.textContent = part.text || '\u200b';
        if (part.continuation) p.className = 'reader-continuation';
        return p;
      }));
      return element.scrollHeight <= element.clientHeight;
    });
    const selected = pageForOffset(result, anchorRef.current);
    setPages(previous => previous.length === result.length && previous.every((value, i) => value.start === result[i].start && value.end === result[i].end) ? previous : result);
    setPage(selected);
    setLaidOutSignature(layoutSignature);
  }, [text, isScroll, layoutSignature]);

  useLayoutEffect(() => {
    if (isScroll || !text) return;
    const epoch = ++layoutEpoch.current;
    // Publish only after the browser's rendering update, including mobile text
    // sizing. Rendering checks the signature immediately, so an old page is never
    // exposed in new typography or used by a fast key/swipe during this interval.
    const afterPaint = () => { if (epoch === layoutEpoch.current) repaginate(); };
    layoutFrame.current = requestAnimationFrame(afterPaint);
    const fontsChanged = () => { if (epoch === layoutEpoch.current) { setLaidOutSignature(''); if (layoutFrame.current !== null) cancelAnimationFrame(layoutFrame.current); layoutFrame.current = requestAnimationFrame(afterPaint); } };
    void document.fonts?.ready.then(fontsChanged);
    document.fonts?.addEventListener('loadingdone', fontsChanged);
    return () => { layoutEpoch.current++; if (layoutFrame.current !== null) cancelAnimationFrame(layoutFrame.current); document.fonts?.removeEventListener('loadingdone', fontsChanged); };
  }, [repaginate, viewport, isScroll, text]);

  useLayoutEffect(() => {
    if (isScroll || loading || layoutPending || !text || !pages.length) return;
    const element = scrollRef.current;
    if (!element || element.scrollHeight <= element.clientHeight) return;
    setLaidOutSignature('');
    // The actual rendered page is the final authority; a font/viewport update may
    // settle after React's first layout effect on mobile browsers.
    layoutFrame.current = requestAnimationFrame(repaginate);
  }, [pages, page, repaginate, isScroll, loading, text, layoutPending]);

  useLayoutEffect(() => {
    if (!text || !isScroll || !scrollRef.current) return;
    const handle = requestAnimationFrame(() => scrollToOffset(anchorRef.current));
    return () => cancelAnimationFrame(handle);
  }, [text, isScroll, viewport, settings.fontSize, settings.lineSpacing, settings.paragraphSpacing, settings.horizontalMargin, settings.font]);

  useEffect(() => {
    if (!content || !currentChapter || content.chapter.id !== currentChapter.id) return;
    const handle = window.setTimeout(() => {
      void library.savePosition(book, currentChapter, fraction, anchor);
    }, 220);
    return () => clearTimeout(handle);
  }, [content?.chapter.id, anchor]);

  useEffect(() => {
    const save = () => { if (currentChapter && content?.chapter.id === currentChapter.id) void library.savePosition(book, currentChapter, text.length ? anchorRef.current / text.length : 0, anchorRef.current); };
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', save);
    return () => { save(); window.removeEventListener('pagehide', save); document.removeEventListener('visibilitychange', save); };
  }, [currentChapter?.id, content]);

  useEffect(() => {
    if (panel === 'catalog') void refreshChapterStates();
  }, [panel]);

  useEffect(() => {
    if (!ReaderSpeech.supported) return;
    const update = () => setVoices(window.speechSynthesis.getVoices());
    update(); window.speechSynthesis.addEventListener('voiceschanged', update);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', update);
  }, []);

  useEffect(() => { speech.current.update(settings.speechRate, settings.speechVoiceIdentifier); }, [settings.speechRate, settings.speechVoiceIdentifier]);

  function changeChapter(next: number, target: { offset?: number; fraction?: number; lastPage?: boolean } = {}, keepSpeech = false) {
    if (next < 0 || next >= chapters.length) return;
    continueSpeech.current = keepSpeech;
    targetRef.current = { chapterID: chapters[next].id, ...target };
    if (next === index && content) {
      const offset = target.fraction !== undefined ? target.fraction * text.length : target.offset ?? 0;
      moveToOffset(offset);
    } else setIndex(next);
    setPanel(null);
  }

  function moveToOffset(offset: number) {
    const value = safeOffset(textRef.current, offset); setOffset(value);
    if (turnModeRef.current === 'scroll') scrollToOffset(value); else if (!layoutPendingRef.current) setPage(pageForOffset(pagesRef.current, value));
  }

  function turn(direction: number) {
    if (loading || layoutPendingRef.current || !content || panel) return;
    if (isScroll) {
      const scroll = scrollRef.current;
      if (!scroll) return;
      if (direction > 0 && scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 4) changeChapter(index + 1);
      else if (direction < 0 && scroll.scrollTop <= 1) changeChapter(index - 1, { lastPage: true });
      else scroll.scrollBy({ top: direction * viewport.height * .88, behavior: 'smooth' });
      return;
    }
    const next = page + direction;
    if (next < 0) { if (index > 0) changeChapter(index - 1, { lastPage: true }); return; }
    if (next >= pages.length) {
      setOffset(text.length);
      if (index < chapters.length - 1) changeChapter(index + 1); else { setControls(true); setCacheNotice('已经读到全书末尾'); }
      return;
    }
    setTransition(`${settings.turnMode}-${direction > 0 ? 'next' : 'previous'}`);
    setPage(next); setOffset(pages[next].start);
  }

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).matches('input,select,textarea')) return;
      if (event.key === 'Escape') { if (panel) setPanel(null); else close(); }
      if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); turn(1); }
      if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); turn(-1); }
      if (event.key === ' ') { event.preventDefault(); setControls(value => !value); }
    };
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown);
  });

  function close() {
    if (content && currentChapter && content.chapter.id === currentChapter.id) void library.savePosition(book, currentChapter, text.length ? anchorRef.current / text.length : 0, anchorRef.current);
    speech.current.stop(); onClose();
  }

  function handlePointerDown(event: PointerEvent) {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button,input,select,a')) return;
    pointer.current = { x: event.clientX, y: event.clientY, time: performance.now(), edge: event.clientX < 24 };
  }
  function handlePointerUp(event: PointerEvent) {
    const start = pointer.current; pointer.current = null;
    if (!start || panel) return;
    const dx = event.clientX - start.x; const dy = event.clientY - start.y;
    if (Math.abs(dx) > 65 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      // Only an intentional gesture starting at the left edge dismisses the reader.
      if (start.edge && dx > 90) close(); else if (!isScroll) turn(dx < 0 ? 1 : -1);
      return;
    }
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10 || performance.now() - start.time > 500) return;
    const rect = viewportRef.current?.getBoundingClientRect(); if (!rect) return;
    const horizontal = (event.clientX - rect.left) / rect.width;
    if (horizontal > .27 && horizontal < .73) setControls(value => !value);
    else if (!isScroll) turn(horizontal <= .27 ? -1 : 1);
    else setControls(value => !value);
  }

  function scrollToOffset(offset: number) {
    const container = scrollRef.current; if (!container) return;
    const paragraphs = Array.from(container.querySelectorAll<HTMLElement>('[data-start]'));
    const p = paragraphs.findLast(item => Number(item.dataset.start) <= offset) ?? paragraphs[0]; if (!p) return;
    const node = p.firstChild;
    if (node?.nodeType === Node.TEXT_NODE && node.textContent?.length) {
      const range = document.createRange(); const local = Math.min(node.textContent.length - 1, Math.max(0, offset - Number(p.dataset.start)));
      range.setStart(node, local); range.setEnd(node, Math.min(node.textContent.length, local + 1));
      const bounds = range.getBoundingClientRect();
      container.scrollTop += bounds.top - container.getBoundingClientRect().top;
    } else container.scrollTop = p.offsetTop;
  }

  function handleScroll() {
    const container = scrollRef.current; if (!container || !content) return;
    if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) { setOffset(text.length); return; }
    const bounds = container.getBoundingClientRect();
    const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null; caretRangeFromPoint?: (x: number, y: number) => Range | null };
    const x = bounds.left + settings.horizontalMargin + 8; const y = bounds.top + 10;
    const caret = doc.caretPositionFromPoint?.(x, y);
    const range = !caret ? doc.caretRangeFromPoint?.(x, y) : null;
    const node = caret?.offsetNode ?? range?.startContainer;
    const p = node?.parentElement?.closest<HTMLElement>('[data-start]');
    if (p && container.contains(p)) setOffset(Number(p.dataset.start) + (caret?.offset ?? range?.startOffset ?? 0));
  }

  function startSpeech() {
    if (!text) return;
    speech.current.start(text, anchorRef.current >= text.length ? 0 : anchorRef.current, {
      rate: settings.speechRate, voiceIdentifier: settings.speechVoiceIdentifier,
      onPosition: value => { setSpeechState({ speaking: value.speaking, paused: value.paused }); if (value.speaking) moveToOffset(value.offset); },
      onEnd: () => {
        if (index < chapters.length - 1) changeChapter(index + 1, {}, true);
        else setCacheNotice('全书听完了');
      },
      onError: setCacheNotice,
    });
  }
  useEffect(() => {
    if (content && continueSpeech.current && !loading) { continueSpeech.current = false; startSpeech(); }
  }, [content, loading]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    if (typeof MediaMetadata !== 'undefined') session.metadata = new MediaMetadata({ title: currentChapter?.title || book.title, artist: book.author, album: book.title });
    const actions: [MediaSessionAction, () => void][] = [
      ['play', () => speech.current.resume()], ['pause', () => speech.current.pause()], ['stop', () => speech.current.stop()],
      ['nexttrack', () => changeChapter(index + 1, {}, speech.current.speaking)], ['previoustrack', () => changeChapter(index - 1, {}, speech.current.speaking)],
    ];
    for (const [action, handler] of actions) { try { session.setActionHandler(action, handler); } catch { /* Device-dependent media action. */ } }
    return () => { for (const [action] of actions) { try { session.setActionHandler(action, null); } catch {} } };
  }, [currentChapter?.id]);
  useEffect(() => { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = speechState.speaking ? speechState.paused ? 'paused' : 'playing' : 'none'; }, [speechState]);

  async function cacheWholeBook() {
    if (cacheBusy) { cacheController.current?.abort(); return; }
    const controller = new AbortController(); cacheController.current = controller;
    setCacheBusy(true); setCacheNotice('');
    let successes = 0; let failures = 0;
    try {
      for (const chapter of chapters) {
        if (controller.signal.aborted) return;
        if (await library.hasContent(book, chapter)) { successes++; continue; }
        try { await library.loadContent(book, chapter, controller.signal); successes++; }
        catch { if (controller.signal.aborted) return; failures++; }
        setCacheNotice(`缓存中 ${successes + failures}/${chapters.length}`);
      }
      await refreshChapterStates(); setCacheNotice(`已缓存 ${successes} 章${failures ? `，${failures} 章未成功，可稍后重试` : '，断网也能读'}`);
    } catch (reason) { if (!controller.signal.aborted) setCacheNotice(message(reason)); }
    finally { setCacheBusy(false); cacheController.current = null; }
  }

  const style: CSSProperties = {
    '--reader-font-size': `${settings.fontSize}px`, '--reader-line-height': `${settings.fontSize + settings.lineSpacing}px`,
    '--reader-paragraph-gap': `${settings.paragraphSpacing}px`, '--reader-margin': `${settings.horizontalMargin}px`,
    '--reader-font-weight': settings.isBold ? '600' : '400',
    '--reader-font-family': settings.font === 'song' ? '"Noto Serif SC", "Songti SC", "STSong", serif' : settings.font === 'rounded' ? 'ui-rounded, "PingFang SC", sans-serif' : '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',
  } as CSSProperties;
  const visiblePage = pages[page] ?? { start: 0, end: text.length };
  const visibleText = isScroll ? paragraphSlices(text, 0, text.length) : paragraphSlices(text, visiblePage.start, visiblePage.end);
  const visibleChapters = chapters.filter(chapter => !query || chapter.title.toLowerCase().includes(query.toLowerCase()));

  return <div className={`reader-root reader-theme-${settings.isNightMode ? 'night' : settings.theme}`} style={style} role="dialog" aria-modal="true" aria-label={`正在阅读${book.title}`}>
    <div className="reader-running-head"><span>{currentChapter?.title || book.title}</span><span>{book.title}</span></div>
    <main ref={viewportRef} className={`reader-viewport ${isScroll ? 'reader-scrolling' : ''}`} onPointerDown={handlePointerDown} onPointerUp={handlePointerUp} onPointerCancel={() => { pointer.current = null; }}>
      {loading || layoutPending ? <div className="reader-status"><LoaderCircle className="reader-spin"/><p>{loading ? '正在打开章节' : '正在排版'}</p><button onClick={close}>返回书架</button></div>
        : error ? <div className="reader-status" role="alert"><p>{error}</p><button onClick={() => { if (!chapters.length) setCatalogRetry(value => value + 1); else setRetry(value => value + 1); }}><RefreshCw size={16}/>重试</button><button onClick={close}>返回书架</button></div>
        : <div ref={scrollRef} className={`reader-text ${isScroll ? 'reader-scroll-text' : `reader-page reader-${transition}`}`} key={isScroll ? 'scroll' : `${currentChapter?.id}-${page}`} onAnimationEnd={() => setTransition('')} onScroll={isScroll ? handleScroll : undefined}>
          {visibleText.map(part => <p key={part.start} data-start={part.start} className={part.continuation ? 'reader-continuation' : undefined}>{part.text || '\u200b'}</p>)}
          {isScroll && <div className="reader-chapter-actions"><button disabled={index === 0} onClick={() => changeChapter(index - 1)}>上一章</button><button disabled={index === chapters.length - 1} onClick={() => changeChapter(index + 1)}>下一章</button></div>}
        </div>}
      <div ref={measureRef} className="reader-text reader-measure" aria-hidden="true" />
    </main>
    <footer className="reader-running-foot"><span>{speechState.speaking ? speechState.paused ? '听书已暂停' : '听书中' : '清读'}</span><span aria-label="全书阅读进度">{(totalFraction * 100).toFixed(1)}%</span></footer>

    {controls && !panel && <>
      <header className="reader-toolbar reader-topbar"><button onClick={close} aria-label="返回书架"><ArrowLeft/></button><span>{book.title}</span><button onClick={() => { void cacheWholeBook(); }} aria-label={cacheBusy ? '停止缓存' : '缓存整本书'}>{cacheBusy ? <X/> : <Download/>}</button></header>
      <div className="reader-toolbar reader-bottom-controls">
        <div className="reader-progress-label"><span>{currentChapter?.title}</span><span>{((sliderValue ?? totalFraction) * 100).toFixed(1)}%</span></div>
        <div className="reader-progress-row"><button onClick={() => changeChapter(index - 1)} disabled={layoutPending || index === 0} aria-label="上一章"><ChevronLeft size={20}/></button><input aria-label="全书进度" type="range" min="0" max="1" step="0.0001" disabled={layoutPending} value={sliderValue ?? totalFraction} onChange={event => setSliderValue(Number(event.target.value))} onPointerUp={event => { if (layoutPendingRef.current) { setSliderValue(null); return; } const value = Number(event.currentTarget.value); const location = locationForBookFraction(value, chapters.length); changeChapter(location.index, { fraction: location.fraction }); setSliderValue(null); }} onKeyUp={event => { if (!layoutPendingRef.current && (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End')) { const location = locationForBookFraction(Number(event.currentTarget.value), chapters.length); changeChapter(location.index, { fraction: location.fraction }); setSliderValue(null); } }}/><button onClick={() => changeChapter(index + 1)} disabled={layoutPending || index === chapters.length - 1} aria-label="下一章"><ChevronRight size={20}/></button></div>
        <nav className="reader-tools"><button onClick={() => setPanel('catalog')}><List/><span>目录</span></button><button onClick={() => setPanel('speech')}><Headphones/><span>听书</span></button><button onClick={() => void library.updateSettings({ isNightMode: !settings.isNightMode })}>{settings.isNightMode ? <Sun/> : <Moon/>}<span>{settings.isNightMode ? '日间' : '夜间'}</span></button><button onClick={() => setPanel('settings')}><Settings2/><span>设置</span></button></nav>
      </div>
    </>}

    {panel && <div className="reader-panel-backdrop" onClick={() => setPanel(null)}>
      <section className={`reader-panel ${panel === 'catalog' ? 'reader-catalog' : 'reader-sheet'}`} onClick={event => event.stopPropagation()} aria-label={panel === 'catalog' ? '目录' : panel === 'speech' ? '听书设置' : '阅读设置'}>
        <header className="reader-panel-header"><h2>{panel === 'catalog' ? '目录' : panel === 'speech' ? '听书' : '阅读设置'}</h2><button onClick={() => setPanel(null)} aria-label="关闭面板"><X size={20}/></button></header>
        {panel === 'catalog' ? <>
          <div className="reader-catalog-summary"><strong>{book.title}</strong><span>共 {chapters.length} 章 · 已缓存 {Object.values(chapterStates).filter(item => item.cached).length} 章</span></div>
          <label className="reader-catalog-search"><Search size={17}/><input placeholder="搜索章节" value={query} onChange={event => setQuery(event.target.value)}/></label>
          <div className="reader-catalog-list">{visibleChapters.map(chapter => { const status = chapterStates[chapter.id]; const selected = chapter.id === currentChapter?.id; return <button key={chapter.id} className={selected ? 'reader-current-chapter' : ''} onClick={() => changeChapter(chapters.findIndex(item => item.id === chapter.id))}><span>{chapter.title}</span><small>{selected ? `读至 ${Math.round(fraction * 100)}%` : status?.progress !== undefined ? `读过 ${Math.round(status.progress * 100)}%` : '未读'}<i>·</i>{status?.cached ? '已缓存' : '未缓存'}</small></button>; })}{!visibleChapters.length && <p className="reader-empty">没有找到章节</p>}</div>
          <button className="reader-cache-all" onClick={() => void cacheWholeBook()}>{cacheBusy ? <X size={17}/> : <Download size={17}/>} {cacheBusy ? '停止缓存' : '缓存整本书'}</button>
        </> : panel === 'settings' ? <ReaderSettingsControls settings={settings}/> : <div className="reader-speech-controls">
          <p className="reader-muted">使用浏览器系统音色。可用音色和离线能力由设备决定；锁屏与后台播放受浏览器限制。</p>
          <label>音色<select value={settings.speechVoiceIdentifier} onChange={event => void library.updateSettings({ speechVoiceIdentifier: event.target.value })}><option value="">系统默认中文</option>{voices.map(voice => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} · {voice.lang}{voice.localService ? ' · 本机' : ''}</option>)}</select></label>
          <label>语速 <span>{settings.speechRate.toFixed(1)}×</span><input aria-label="听书语速" type="range" min="0.5" max="2" step="0.1" value={settings.speechRate} onChange={event => void library.updateSettings({ speechRate: Number(event.target.value) })}/></label>
          <div className="reader-playback"><button onClick={() => { const previous = Math.max(0, text.lastIndexOf('\n', Math.max(0, anchorRef.current - 2))); moveToOffset(previous); if (speech.current.speaking) { speech.current.stop(); startSpeech(); } }} aria-label="上一段"><ChevronLeft/></button><button className="reader-play-button" disabled={!ReaderSpeech.supported || !content} onClick={() => { if (!speechState.speaking) startSpeech(); else if (speechState.paused) speech.current.resume(); else speech.current.pause(); }}>{speechState.speaking && !speechState.paused ? <Pause/> : <Play/>}<span>{speechState.speaking && !speechState.paused ? '暂停' : speechState.paused ? '继续' : '开始听书'}</span></button><button onClick={() => { const next = text.indexOf('\n', anchorRef.current + 1); moveToOffset(next < 0 ? text.length : next + 1); if (speech.current.speaking) { speech.current.stop(); startSpeech(); } }} aria-label="下一段"><ChevronRight/></button></div>
          {speechState.speaking && <button className="reader-stop-speech" onClick={() => speech.current.stop()}>结束听书</button>}
          {!ReaderSpeech.supported && <p role="status" className="reader-muted">这个浏览器暂不支持听书，请换用 Safari 或 Chrome。</p>}
        </div>}
      </section>
    </div>}
    {cacheNotice && <div className="reader-toast" role="status" onClick={() => setCacheNotice('')}>{cacheNotice}<button aria-label="关闭提示"><X size={14}/></button></div>}
  </div>;
}

function ReaderSettingsControls({ settings }: { settings: ReaderSettings }) {
  const update = (partial: Partial<ReaderSettings>) => void library.updateSettings(partial);
  return <div className="reader-setting-controls">
    <div className="reader-setting-row"><span>翻页</span><div className="reader-segmented">{([['slide', '滑动'], ['cover', '覆盖'], ['scroll', '滚动']] as const).map(([value, label]) => <button key={value} className={settings.turnMode === value ? 'reader-selected' : ''} onClick={() => update({ turnMode: value })}>{label}</button>)}</div></div>
    <div className="reader-setting-row"><span>字体</span><div className="reader-segmented">{([['song', '宋体'], ['system', '黑体'], ['rounded', '圆体']] as const).map(([value, label]) => <button key={value} className={settings.font === value ? 'reader-selected' : ''} onClick={() => update({ font: value })}>{label}</button>)}</div></div>
    <SettingSlider name="字号" value={settings.fontSize} min={16} max={34} onChange={value => update({ fontSize: value })}/>
    <SettingSlider name="行距" value={settings.lineSpacing} min={4} max={22} onChange={value => update({ lineSpacing: value })}/>
    <SettingSlider name="段距" value={settings.paragraphSpacing} min={0} max={28} onChange={value => update({ paragraphSpacing: value })}/>
    <SettingSlider name="页边距" value={settings.horizontalMargin} min={16} max={40} onChange={value => update({ horizontalMargin: value })}/>
    <div className="reader-setting-row"><label htmlFor="reader-bold">加粗文字</label><input id="reader-bold" type="checkbox" checked={settings.isBold} onChange={event => update({ isBold: event.target.checked })}/></div>
    <div className="reader-theme-options">{themes.map(theme => <button key={theme.value} aria-label={theme.name} title={theme.name} style={{ background: theme.color }} className={settings.theme === theme.value && !settings.isNightMode ? 'reader-theme-selected' : ''} onClick={() => update({ theme: theme.value, isNightMode: false })}/>) }<button className={settings.isNightMode ? 'reader-theme-selected reader-dark-swatch' : 'reader-dark-swatch'} aria-label="夜间" onClick={() => update({ isNightMode: true })}><Moon size={19}/></button></div>
  </div>;
}

function SettingSlider({ name, value, min, max, onChange }: { name: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return <label className="reader-setting-slider"><span>{name}</span><input aria-label={name} type="range" min={min} max={max} value={value} onChange={event => onChange(Number(event.target.value))}/><output>{value}</output></label>;
}
function message(reason: unknown): string { return reason instanceof Error ? reason.message : '暂时无法打开，请检查网络后重试。'; }
