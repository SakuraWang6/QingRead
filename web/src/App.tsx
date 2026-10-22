import { loadCover } from './lib/covers';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpDown, BookOpen, Check, ChevronRight, CircleHelp, CloudOff, Download, FileUp, Grid2X2, Headphones, Library, LoaderCircle, MoreHorizontal, Plus, RefreshCw, Search, Settings2, ShieldCheck, SlidersHorizontal, Trash2, WifiOff, X } from 'lucide-react';
import type { Book, Category, Chapter, DiscoverySection, ReaderSettings, SearchResponse, ShelfEntry, SourceDefinition } from './shared/types';
import { api, apiBase } from './lib/api';
import { cloudSync, useCloudSync } from './lib/cloud';
import { AccountPanel } from './components/AccountPanel';
import { library, useLibrary } from './lib/store';
import { Reader } from './components/Reader';
import { AuthorBooks } from './components/AuthorBooks';
import { OrganizationEditor } from './components/LibraryTools';
import { NotificationSettings, nativeNotificationKey } from './components/NotificationSettings';
import { nativeBackground } from './lib/androidBackground';
import { version as appVersion } from '../package.json';
import { canManageChapters, DownloadManager, DownloadOptions, SourcePicker } from './components/ReadingWorkflows';
import { androidServerIssue, isAndroidApp, useAndroidBack } from './lib/android';
import { authenticationRequiredEvent, normalizeApiAddress, serverConnectionStore } from './lib/connection';

type Tab = 'shelf' | 'discover' | 'categories' | 'search' | 'settings';
const tabs: { id: Tab; label: string; icon: typeof Library }[] = [
  { id: 'shelf', label: '书架', icon: Library }, { id: 'discover', label: '发现', icon: BookOpen },
  { id: 'categories', label: '分类', icon: Grid2X2 }, { id: 'search', label: '搜书', icon: Search },
  { id: 'settings', label: '设置', icon: Settings2 },
];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const formatBytes = (bytes: number) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export default function App() {
  const state = useLibrary();
  const cloud = useCloudSync();
  const [tab, setTab] = useState<Tab>('shelf');
  const [showDownloads, setShowDownloads] = useState(false);
  const [author,setAuthor]=useState<string|null>(null);
  const [selected, setSelected] = useState<Book | null>(null);
  const [reading, setReading] = useState<{ book: Book; chapterID?: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [sourceError, setSourceError] = useState('');
  const [authenticationRequired, setAuthenticationRequired] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [searchSeed, setSearchSeed] = useState('');
  const profile = cloud.session?.user.id || 'guest';
  const lastProfile = useRef(profile);
  const nativeBookSignature=state.shelf.map(e=>[e.book.id,e.book.sourceID,e.book.url,e.position?.chapterID,state.updates[e.book.id]?.checkedAt,state.updates[e.book.id]?.lastKnownChapterID].join('|')).join('\n')+'|'+state.disabledSourceIDs.join(',');
  useEffect(()=>{
    if(!isAndroidApp()||!cloud.initialized)return;
    let stopped=false;const owner=library;
    const setup=async()=>{try{const address=apiBase();await nativeBackground.setProfile({profile:owner.profile,apiBase:address,accessToken:serverConnectionStore().tokenFor(address),authToken:cloud.session?.token});if(stopped||library!==owner)return;await nativeBackground.replaceWatchedBooks({profile:owner.profile,enabled:localStorage.getItem(nativeNotificationKey(owner.profile))==='true',books:state.shelf.filter(e=>canManageChapters(e.book)&&!state.disabledSourceIDs.includes(e.book.sourceID)).slice(0,20).map(e=>({book:e.book,baseline:state.updates[e.book.id],readChapterID:e.position?.chapterID}))});await owner.syncNativeBackground();}catch{/* An unavailable native bridge leaves local reading usable. */}};
    void setup();const timer=setInterval(()=>{if(!document.hidden)void owner.syncNativeBackground();},2000);return()=>{stopped=true;clearInterval(timer);};
  },[cloud.initialized,cloud.session?.token,profile,nativeBookSignature]);

  useEffect(() => { if (lastProfile.current !== profile) { setReading(null); setSelected(null); setShowDownloads(false); lastProfile.current = profile; } }, [profile]);
  const importInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const serverIssue = isAndroidApp() ? androidServerIssue(localStorage.getItem('qingread.apiBase') || import.meta.env.VITE_API_BASE || '') : undefined;
  useAndroidBack(() => {
    if (reading) { setReading(null); return true; }
    if (selected) { setSelected(null); return true; }
    if (tab !== 'shelf') { setTab('shelf'); return true; }
    return false;
  });
  useEffect(() => {
    void cloudSync.initialize();
    const poll = setInterval(() => { if (document.visibilityState === 'visible') {void cloudSync.sync();void library.syncServerDownloads();} }, 20000);
    const syncOnResume = () => { if (document.visibilityState === 'hidden') void library.pauseDownloadsForBackground(); else { void cloudSync.sync(); void library.syncServerDownloads(); void library.checkForUpdates(); } };
    window.addEventListener('online', syncOnResume);
    document.addEventListener('visibilitychange', syncOnResume);
    return () => { clearInterval(poll); window.removeEventListener('online', syncOnResume); document.removeEventListener('visibilitychange', syncOnResume); };
  }, []);
  useEffect(() => {
    const connected = () => setOnline(navigator.onLine);
    const needsAccessCode = () => setAuthenticationRequired(true);
    window.addEventListener(authenticationRequiredEvent, needsAccessCode);
    window.addEventListener('online', connected); window.addEventListener('offline', connected);
    api.sources().then(sources => library.initializeSources(sources)).catch(error => setSourceError(message(error)));
    return () => { window.removeEventListener('online', connected); window.removeEventListener('offline', connected); window.removeEventListener(authenticationRequiredEvent, needsAccessCode); };
  }, []);
  useEffect(() => { if (!notice) return; const id = setTimeout(() => setNotice(''), 4500); return () => clearTimeout(id); }, [notice]);
  useEffect(() => { if (!selected && !reading) return; const previous = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { document.body.style.overflow = previous; }; }, [selected, reading]);
  async function importBook(file?: File) {
    if (!file) return; setImporting(true);
    try { const owner = library; const book = await owner.importFile(file); if (library !== owner) return; setSelected(book); setNotice('已导入书架'); }
    catch (error) { setNotice(message(error)); } finally { setImporting(false); if (importInput.current) importInput.current.value = ''; }
  }
  function openSearch(query: string) { setSearchSeed(query); setTab('search'); }
  async function read(book: Book, chapterID?: string) {
    const owner=library;
    if(book.publicationFormat&&!(await owner.getPublication(book))){
      if(!cloud.files.some(file=>file.bookID===book.id)){setSelected(book);return;}
      setImporting(true);
      try{book=await cloudSync.downloadPublication(book);}catch(error){setNotice(message(error));return;}finally{setImporting(false);}
      if(library!==owner)return;
    }
    setSelected(null);setReading({book,chapterID});
  }
  useEffect(() => { if (state.ready && tab === 'shelf' && !reading && !selected && document.visibilityState === 'visible' && navigator.onLine) void library.checkForUpdates(); }, [state.ready, tab, profile, Boolean(reading), Boolean(selected), state.shelf.length]);
  useEffect(()=>{if(!cloud.initialized||!cloud.session||isAndroidApp())return;void library.syncServerDownloads();const timer=setInterval(()=>{if(!document.hidden)void library.syncServerDownloads();},5000);return()=>clearInterval(timer);},[cloud.initialized,cloud.session?.token,profile]);
  const selectedBook = selected && (state.shelf.find(entry => entry.book.id === selected.id)?.book || selected);
  const readingBook = reading && (state.shelf.find(entry => entry.book.id === reading.book.id)?.book || reading.book);
  if (!cloud.initialized) return <Loading text="正在打开书架" />;
  return <>
    <div className="app-shell">
      <aside className="desktop-rail"><a className="brand" href="#" onClick={event => { event.preventDefault(); setTab('shelf'); }}><span className="brand-mark">清</span><span>清读</span></a><nav>{tabs.map(({ id, label, icon: Icon }) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}><Icon size={19} strokeWidth={1.6} />{label}</button>)}</nav><div className="rail-foot"><span className="status-dot" /> {cloud.session ? cloud.session.user.username : '未登录'}</div></aside>
      <main className={`main-page page-${tab}`}>
        {!online && <div className="offline-banner"><WifiOff size={14} /> 当前离线，已缓存的书籍仍可阅读</div>}
        {serverIssue && <div className="error-banner">{serverIssue} {tab !== 'settings' && <button className="text-button" onClick={() => setTab('settings')}>前往设置</button>}</div>}
        {authenticationRequired && <div className="error-banner">请在「设置 → 服务器连接」填写或更新服务访问码。{tab !== 'settings' && <button className="text-button" onClick={() => setTab('settings')}>前往设置</button>}</div>}
        {state.storageError && <div className="error-banner">{state.storageError}</div>}
        {tab === 'shelf' && <Shelf entries={state.shelf} ready={state.ready} onDetails={setSelected} onRead={read} onSearch={() => setTab('search')} onImport={() => importInput.current?.click()} importing={importing} onNotice={setNotice} onDownloads={() => setShowDownloads(true)} />}
        {tab === 'discover' && <Discover onBook={setSelected} onSearch={openSearch} />}
        {tab === 'categories' && <Categories onBook={setSelected} />}
        {tab === 'search' && <SearchPage sources={state.sources} disabled={state.disabledSourceIDs} initialQuery={searchSeed} onBook={setSelected} />}
        {tab === 'settings' && <SettingsPage settings={state.settings} sources={state.sources} disabled={state.disabledSourceIDs} sourceError={sourceError} onNotice={setNotice} onImport={() => importInput.current?.click()} />}
      </main>
      <nav className="bottom-nav" aria-label="主导航">{tabs.map(({ id, label, icon: Icon }) => <button key={id} aria-current={tab === id ? 'page' : undefined} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}><span><Icon size={21} strokeWidth={tab === id ? 2 : 1.6} /></span><small>{label}</small></button>)}</nav>
    </div>
    <input ref={importInput} type="file" accept=".epub,.pdf,.txt,application/epub+zip,application/pdf,text/plain" hidden onChange={event => void importBook(event.target.files?.[0])} />
    {selectedBook && <BookDetail key={`${profile}:${selectedBook.id}:${selectedBook.sourceID}:${selectedBook.url}`} book={selectedBook} onClose={() => setSelected(null)} onRead={read} onNotice={setNotice} onAuthor={setAuthor} />}
    {reading && readingBook && <Reader key={`${profile}:${readingBook.id}:${readingBook.sourceID}:${readingBook.url}`} book={readingBook} initialChapterID={reading.book.sourceID === readingBook.sourceID && reading.book.url === readingBook.url ? reading.chapterID : undefined} onClose={() => setReading(null)} />}
    {author&&<AuthorBooks author={author} onClose={()=>setAuthor(null)} onBook={book=>{setAuthor(null);setSelected(book);}}/>}
    {showDownloads && <DownloadManager onClose={() => setShowDownloads(false)}/>}
    {notice && <div className="toast" role="status">{notice}</div>}
  </>;
}

function PageHeader({ title, actions }: { title: string; actions?: React.ReactNode }) {
  return <header className="page-header"><h1>{title}</h1><div className="header-actions">{actions}</div></header>;
}
function Cover({ book, large = false }: { book: Book; large?: boolean }) {
  const anchor=useRef<HTMLDivElement>(null);
  const [visible,setVisible]=useState(large);
  useEffect(()=>{
    if(visible)return;
    if(!('IntersectionObserver' in window)){setVisible(true);return;}
    const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){setVisible(true);observer.disconnect();}},{rootMargin:'160px'});
    if(anchor.current)observer.observe(anchor.current);return()=>observer.disconnect();
  },[visible]);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [url, setURL] = useState<string | undefined>();
  const hash = [...book.title].reduce((total, character) => total + character.charCodeAt(0), 0);
  useEffect(() => {
    setFailed(false); setLoaded(false); setURL(undefined);
    if (book.coverURL?.startsWith('blob:') || book.coverURL?.startsWith('data:')) { setURL(book.coverURL); return; }
    if (book.sourceID === 'local' || book.sourceID.startsWith('local-') || book.url.startsWith('qingread-') || book.sourceID === 'sample') return;
    if(!visible)return;
    let live=true,objectURL='';
    loadCover(book).then(blob=>{if(live&&blob){objectURL=URL.createObjectURL(blob);setURL(objectURL);}}).catch(()=>{if(live)setFailed(true);});
    return()=>{live=false;if(objectURL)URL.revokeObjectURL(objectURL);};
  }, [book.id, book.sourceID, book.url, book.coverURL,visible]);
  return <div ref={anchor} className={`book-cover cover-tone-${hash % 6} ${large ? 'large' : ''} ${loaded ? 'has-image' : ''}`}>
    <span className="cover-rule" /><div className="cover-typography"><span>{book.title}</span><small>{book.author || '佚名'}</small></div><span className="cover-stamp">藏书</span>
    {url && !failed && <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} onLoad={() => setLoaded(true)} />}
  </div>;
}
function BookGrid({ books, onBook }: { books: Book[]; onBook: (book: Book) => void }) {
  return <div className="book-grid">{books.map(book => <button className="book-tile" key={book.id} onClick={() => onBook(book)}><Cover book={book} /><strong>{book.title}</strong><span>{book.author || book.sourceName}</span></button>)}</div>;
}
function Loading({ text = '正在整理书页' }: { text?: string }) { return <div className="loading-state"><LoaderCircle size={21} className="spin" /><span>{text}</span></div>; }
function Empty({ title, text, children }: { title: string; text: string; children?: React.ReactNode }) { return <div className="empty-state"><span className="empty-illustration"><BookOpen size={36} strokeWidth={1} /></span><h3>{title}</h3>{text&&<p>{text}</p>}{children}</div>; }

function Shelf({ entries, ready, onDetails, onRead, onSearch, onImport, importing, onNotice, onDownloads }: { entries: ShelfEntry[]; ready: boolean; onDetails: (book: Book) => void; onRead: (book: Book) => void; onSearch: () => void; onImport: () => void; importing: boolean; onNotice: (text: string) => void; onDownloads: () => void }) {
  const state = useLibrary();
  const [filter,setFilter]=useState('all'),[organizing,setOrganizing]=useState(false);
  const [sort, setSort] = useState<'recent' | 'added' | 'title'>('recent');
  async function checkUpdates() { try { const result = await library.checkForUpdates(undefined, { force: true }); onNotice(result.failures.length ? `${result.failures.length} 本暂未检查成功` : result.updated ? `${result.updated} 本书有更新` : result.checked ? '暂无新章节' : '刚刚已检查'); } catch (error) { onNotice(message(error)); } }
  const [manage, setManage] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const sorted = useMemo(() => entries.filter(e=>filter==='all'||filter.startsWith('group:')?filter==='all'||e.organization?.group===filter.slice(6):(e.organization?.status??'reading')===filter).sort((a, b) => Boolean(b.organization?.pinned)!==Boolean(a.organization?.pinned)?Number(Boolean(b.organization?.pinned))-Number(Boolean(a.organization?.pinned)):sort === 'title' ? a.book.title.localeCompare(b.book.title, 'zh-Hans') : sort === 'added' ? b.addedAt.localeCompare(a.addedAt) : (b.position?.updatedAt || b.addedAt).localeCompare(a.position?.updatedAt || a.addedAt)), [entries, sort, filter]);
  const recent = sorted.find(entry => entry.position);
  async function remove() { if (!window.confirm(`删除所选 ${checked.size} 本书及其云端文件？`)) return; for (const entry of entries.filter(entry => checked.has(entry.book.id))) await library.remove(entry.book); setChecked(new Set()); setManage(false); onNotice('已从书架移除'); }
  return <>
    <PageHeader title="书架" actions={<><button className="icon-button" aria-label="检查更新" disabled={state.checkingUpdates} onClick={() => void checkUpdates()}><RefreshCw size={19} className={state.checkingUpdates ? 'spin' : undefined}/></button><button className="icon-button" aria-label="下载管理" onClick={onDownloads}><Download size={20}/></button><button className="icon-button" aria-label="搜书" onClick={onSearch}><Search size={21} /></button><button className="icon-button" aria-label="导入书籍" disabled={importing} onClick={onImport}>{importing ? <LoaderCircle size={21} className="spin" /> : <Plus size={23} />}</button></>} />
    {recent && !manage && <button className="continue-card" onClick={() => onRead(recent.book)}><div className="continue-lines"><span className="eyebrow">继续阅读</span><strong>{recent.book.title}</strong><small>{recent.book.publicationFormat === 'pdf' ? `第 ${recent.position!.chapterIndex + 1} 页` : `第 ${recent.position!.chapterIndex + 1} 章 · 本章已读 ${Math.round(recent.position!.chapterFraction * 100)}%`}</small></div><span className="continue-arrow"><ArrowRight size={22} strokeWidth={1.5} /></span></button>}
    <div className="section-toolbar"><div className="collection-label">全部书籍 <span>{entries.length}</span></div><div className="toolbar-actions"><label className="sort-control"><ArrowUpDown size={14} /><select aria-label="书架排序" value={sort} onChange={event => setSort(event.target.value as typeof sort)}><option value="recent">最近阅读</option><option value="added">加入时间</option><option value="title">书名排序</option></select></label><button className={manage ? 'text-button accent' : 'text-button'} onClick={() => { setManage(!manage); setChecked(new Set()); }}>{manage ? '完成' : '管理'}</button></div></div>
    <div className="shelf-filters"><select aria-label="书架筛选" value={filter} onChange={event=>{setFilter(event.target.value);setChecked(new Set());}}><option value="all">全部</option><option value="reading">在读</option><option value="later">待读</option><option value="finished">读完</option>{[...new Set(entries.map(e=>e.organization?.group).filter(Boolean))].map(group=><option value={'group:'+group} key={group}>{group}</option>)}</select></div>
    {!ready ? <Loading /> : entries.length === 0 ? <Empty title="书架暂无书籍" text=""><button className="primary-button" onClick={onSearch}>去搜书 <ArrowRight size={16} /></button><button className="text-button" onClick={onImport}>导入本地书籍</button></Empty> : <div className="book-grid shelf-grid">{sorted.map(({ book, position, organization }, index) => <div className="shelf-tile" key={book.id} style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}><button className="book-tile" onClick={() => { if (manage) { const next = new Set(checked); next.has(book.id) ? next.delete(book.id) : next.add(book.id); setChecked(next); } else onRead(book); }}><div className="cover-wrap"><Cover book={book} />{organization?.pinned&&<span className="shelf-pin">置顶</span>}{!manage && !!state.updates[book.id]?.unreadChapterIDs.length && <span className="shelf-update-badge">更新 {state.updates[book.id].unreadChapterIDs.length} 章</span>}{manage && <span className={`selection-check ${checked.has(book.id) ? 'selected' : ''}`}>{checked.has(book.id) && <Check size={15} />}</span>}</div><strong>{book.title}</strong><span>{position ? book.publicationFormat === 'pdf' ? `第 ${position.chapterIndex + 1} 页` : `第 ${position.chapterIndex + 1} 章 · ${Math.round(position.chapterFraction * 100)}%` : '未读'}</span></button>{!manage && <button className="book-more" onClick={() => onDetails(book)} aria-label={`${book.title}详情`}><MoreHorizontal size={17} /></button>}</div>)}</div>}
    {manage && <div className="manage-bar"><button className="text-button" onClick={() => setChecked(checked.size === entries.length ? new Set() : new Set(entries.map(entry => entry.book.id)))}>{checked.size === entries.length ? '取消全选' : '全选'}</button><span>已选 {checked.size} 本</span><button className="text-button" disabled={!checked.size} onClick={()=>setOrganizing(true)}>整理</button><button className="danger-button" disabled={!checked.size} onClick={() => void remove()}><Trash2 size={15} />移除</button></div>}
    {organizing&&<OrganizationEditor bookIDs={[...checked]} onClose={()=>setOrganizing(false)}/>}
    <div className="shelf-import-line"><span /><button onClick={onImport}><FileUp size={15} /> 导入本地书籍</button><span /></div>
  </>;
}

function Discover({ onBook, onSearch }: { onBook: (book: Book) => void; onSearch: (query: string) => void }) {
  const [sections,setSections]=useState<DiscoverySection[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[filter,setFilter]=useState('all');
  const choices=[['all','精选'],['literature','文学'],['textbooks','教材'],['completed','完结']];
  useEffect(()=>{let live=true;const controller=new AbortController();setLoading(true);setError('');const task=filter==='all'?api.recommendations(controller.signal):api.category(filter,controller.signal).then(books=>({sections:[{id:filter,title:choices.find(c=>c[0]===filter)?.[1]??'',books}]}));task.then(value=>{if(live)setSections(value.sections);}).catch(e=>{if(live)setError(message(e));}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;controller.abort();};},[filter]);
  return <><PageHeader title="发现" actions={<button className="icon-button" aria-label="搜书" onClick={()=>onSearch('')}><Search size={21}/></button>}/><div className="discovery-filters">{choices.map(([id,label])=><button key={id} className={filter===id?'active':''} aria-pressed={filter===id} onClick={()=>setFilter(id)}>{label}</button>)}</div>{loading?<Loading text="正在加载书单"/>:error?<Empty title="书单暂时未能加载" text={error}/>:sections.map(section=><section className="book-section" key={section.id}><div className="section-title"><h2>{section.title}</h2><span>{section.books.length} 本</span></div><BookGrid books={section.books} onBook={onBook}/></section>)}</>;
}

function Categories({ onBook }: { onBook: (book: Book) => void }) {
  const [categories, setCategories] = useState<Category[]>([]); const [selected, setSelected] = useState(''); const [books, setBooks] = useState<Book[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  useEffect(() => { api.categories().then(values => { setCategories(values); setSelected(values[0]?.id || ''); if (!values.length) setLoading(false); }).catch(error => { setError(message(error)); setLoading(false); }); }, []);
  useEffect(() => { if (!selected) return; let live = true; setLoading(true); setError(''); api.category(selected).then(values => { if (live) setBooks(values); }).catch(error => { if (live) setError(message(error)); }).finally(() => { if (live) setLoading(false); }); return () => { live = false; }; }, [selected]);
  return <><PageHeader title="分类" /><div className="category-layout"><nav className="category-list" aria-label="书籍分类">{categories.map((category, index) => <button key={category.id} className={selected === category.id ? 'active' : ''} onClick={() => setSelected(category.id)}><span>{String(index + 1).padStart(2, '0')}</span>{category.title}</button>)}</nav><div className="category-content">{loading ? <Loading text="正在加载分类" /> : error ? <Empty title="分类暂时不可用" text={error} /> : books.length ? <><div className="section-title"><h2>{categories.find(category => category.id === selected)?.title}</h2><span>{books.length} 本</span></div><BookGrid books={books} onBook={onBook} /></> : <Empty title="此分类暂无书籍" text="换一个分类，或通过书名搜索。" />}</div></div></>;
}

function SearchPage({ sources, disabled, initialQuery, onBook }: { sources: SourceDefinition[]; disabled: string[]; initialQuery: string; onBook: (book: Book) => void }) {
  const [query, setQuery] = useState(initialQuery); const [result, setResult] = useState<SearchResponse | null>(null); const [loading, setLoading] = useState(false); const [cancelled, setCancelled] = useState(false); const [error, setError] = useState(''); const [filter, setFilter] = useState('all'); const [showSources, setShowSources] = useState(false); const abort = useRef<AbortController | null>(null);
  const enabled = sources.filter(source => !disabled.includes(source.id));
  useEffect(() => { setQuery(initialQuery); }, [initialQuery]);
  useEffect(() => () => { const active = abort.current; abort.current = null; active?.abort(); }, []);
  function cancelSearch() {
    const active = abort.current;
    abort.current = null;
    active?.abort();
    setLoading(false); setCancelled(true);
  }
  async function search(value = query) {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (!enabled.length) { setError('没有启用的书源，请检查服务连接与书源设置。'); return; }
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const isCurrent = () => abort.current === controller && !controller.signal.aborted;
    setQuery(trimmed); setLoading(true); setCancelled(false); setError('');
    setResult({ books: [], failures: [] });
    try {
      const response = await api.search(trimmed, filter === 'all' ? enabled.map(source => source.id) : [filter], controller.signal, update => {
        if (isCurrent()) setResult(update);
      });
      if (isCurrent()) setResult(response);
    } catch (error) { if (isCurrent()) setError(message(error)); }
    finally { if (abort.current === controller) { abort.current = null; setLoading(false); } }
  }
  return <><PageHeader title="搜书" /><form className="search-form" onSubmit={event => { event.preventDefault(); void search(); }}><Search size={20} strokeWidth={1.6} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="书名、作者" aria-label="搜索书名或作者" enterKeyHint="search" />{query && <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label="清空"><X size={16} /></button>}<button type={loading ? "button" : "submit"} className="search-submit" aria-label={loading ? "取消搜索" : "搜索书籍"} onClick={loading ? cancelSearch : undefined} disabled={!loading && !query.trim()}>{loading ? <><LoaderCircle size={14} className="spin" aria-hidden="true" />取消</> : '搜索'}</button></form><div className="search-source-line"><span><span className="status-dot" /> {enabled.length} 个可用书源</span><button className="text-button" onClick={() => setShowSources(!showSources)}><SlidersHorizontal size={14} />{filter === 'all' ? '全部书源' : sources.find(source => source.id === filter)?.name}</button></div>{showSources && <div className="filter-chips"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部书源</button>{enabled.map(source => <button key={source.id} className={filter === source.id ? 'active' : ''} onClick={() => setFilter(source.id)}>{source.name}</button>)}</div>}
    {!result && !error && <div className="search-intro"><p>按书名或作者，搜索已启用的书库。</p><div className="search-suggestions">{['红楼梦', '鲁迅', '唐诗', 'Calculus'].map(value => <button key={value} onClick={() => void search(value)}>{value}<ArrowRight size={13} /></button>)}</div><p className="subtle-note">部分书源连接较慢，结果会陆续显示。</p></div>}
    {result && <><div className="result-heading"><h2>搜索结果 <span>{result.books.length}</span></h2>{loading ? <span className="searching-label" role="status"><LoaderCircle size={13} className="spin" aria-hidden="true" /> 搜索中</span> : cancelled && <span className="searching-label" role="status">已停止搜索</span>}</div>{result.books.length ? <div className="search-results">{result.books.map(book => <button className="search-result" key={book.id} onClick={() => onBook(book)}><Cover book={book} /><div><h3>{book.title}</h3><p className="result-author">{book.author || '佚名'}</p><p className="result-summary">{book.summary || '打开查看目录与书籍详情'}</p><span className="source-tag">{book.sourceName}{book.publicationFormat && ` · ${book.publicationFormat.toUpperCase()}`}</span></div><ChevronRight size={17} /></button>)}</div> : !loading && !error && !cancelled && <Empty title="没有找到这本书" text="换个书名或书源试试" />}{result.failures.length > 0 && <details className="source-failures"><summary>{result.failures.length} 个书源暂时未响应</summary>{result.failures.map(failure => <p key={failure.sourceID}><strong>{failure.sourceName}</strong>{failure.message}</p>)}</details>}</>}{error && <div className="error-banner">{error}</div>}
  </>;
}

function BookDetail({ book, onClose, onRead, onNotice, onAuthor }: { book: Book; onClose: () => void; onRead: (book: Book, chapterID?: string) => void; onNotice: (message: string) => void; onAuthor:(author:string)=>void }) {
  const state = useLibrary(); const [chapters, setChapters] = useState<Chapter[]>([]); const [loading, setLoading] = useState(!book.publicationFormat); const [error, setError] = useState(''); const [working, setWorking] = useState(false); const [cacheProgress, setCacheProgress] = useState(''); const [cachedIDs, setCachedIDs] = useState<Set<string>>(new Set()); const [progress, setProgress] = useState<Record<string, number>>({}); const [confirmRemove, setConfirmRemove] = useState(false); const [publicationCached, setPublicationCached] = useState(false); const abort = useRef<AbortController | null>(null);
  const [workflow, setWorkflow] = useState<'source'|'download'|'manager'|null>(null);
  const cloud=useCloudSync();
  const cloudAvailable=cloud.files.some(file=>file.bookID===book.id);
  const entry = state.shelf.find(entry => entry.book.id === book.id);
  const fileInput = useRef<HTMLInputElement>(null);
  async function attachFile(file: File) {
    const owner=library; setWorking(true); setError('');
    try { const imported=await owner.importFile(file,book); if(library===owner)onRead(imported); }
    catch(error){ if(library===owner)setError(message(error)); } finally{setWorking(false);}
  }
  useAndroidBack(() => { if (confirmRemove) setConfirmRemove(false); else onClose(); return true; }, 200);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    (async () => {
      try {
        const hasPublication = book.publicationFormat ? Boolean(await library.getPublication(book)) : false;
        if (live) setPublicationCached(hasPublication);
        let values = await library.getChapters(book);
        if (!values?.length && !book.publicationFormat) {
          values = await api.chapters(book, controller.signal);
          if (controller.signal.aborted) return;
          await library.cacheChapters(book, values);
        }
        if (!live) return;
        setChapters(values || []); setLoading(false);
        const states = await library.chapterStates(book, values || []);
        if (!live) return;
        const cached = new Set<string>(), read: Record<string, number> = {};
        for (const [id, state] of Object.entries(states)) {
          if (state.cached) cached.add(id);
          read[id] = state.progress || 0;
        }
        setCachedIDs(cached); setProgress(read);
      } catch (error) { if (live) setError(message(error)); }
      finally { if (live) setLoading(false); }
    })();
    return () => { live = false; controller.abort(); abort.current?.abort(); };
  }, [book]);
  async function add() { await library.add(book); onNotice('已加入书架'); }
  async function download() {
    if (!book.publicationFormat) { setWorkflow('download'); return; }
    const owner = library;
    const controller = new AbortController(); abort.current = controller;
    setWorking(true); setError('');
    try {
      if (cloudAvailable) { const imported = await cloudSync.downloadPublication(book); if (library === owner) onRead(imported); return; }
      setCacheProgress('正在下载整本书…');
      const blob = await api.download(book, controller.signal);
      if (controller.signal.aborted || library !== owner) return;
      const imported = await owner.importFile(new File([blob], `${book.title}.${book.publicationFormat}`, { type: blob.type }), book);
      if (library !== owner) return;
      setCacheProgress('整本已缓存'); onNotice('整本书已下载'); onRead(imported);
    } catch (error) { if (!controller.signal.aborted && library === owner) setError(message(error)); }
    finally { setWorking(false); }
  }

  return <><div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><section className="book-detail modal-panel" role="dialog" aria-modal="true" aria-label={`${book.title}详情`}><div className="modal-toolbar"><button className="icon-button" aria-label="关闭书籍详情" onClick={onClose}><ArrowLeft size={21} /></button><span>书籍详情</span><button className="icon-button" aria-label="关闭" onClick={onClose}><X size={20} /></button></div><div className="book-detail-intro"><Cover book={book} large /><div><span className="detail-source">{book.sourceName}</span><h2>{book.title}</h2><button className="text-button" disabled={!book.author} onClick={()=>onAuthor(book.author)}>{book.author || '佚名'}</button><span className="file-label">{book.publicationFormat?.toUpperCase() || `${chapters.length || '—'} 章`}</span></div></div>{book.summary&&<p className="book-description">{book.summary}</p>}<input ref={fileInput} type="file" accept=".epub,.pdf,.txt" hidden onChange={event=>{const file=event.target.files?.[0];if(file)void attachFile(file);event.target.value='';}} /><div className="book-detail-actions"><button className="primary-button" onClick={() => book.publicationFormat && !publicationCached ? book.sourceID==='local-file' && !cloudAvailable ? fileInput.current?.click() : void download() : onRead(book, entry?.position?.chapterID)} disabled={working || loading}>{working ? <LoaderCircle size={17} className="spin" /> : <BookOpen size={17} />}{book.publicationFormat && !publicationCached ? cloudAvailable ? '云端下载并阅读' : book.sourceID==='local-file' ? '导入文件并阅读' : '下载并阅读' : entry?.position ? '继续阅读' : '开始阅读'}</button><button className="secondary-button" onClick={() => entry ? setConfirmRemove(!confirmRemove) : void add()}>{entry ? <><Check size={16} />已在书架</> : <><Plus size={16} />加入书架</>}</button></div>{book.publicationFormat && !publicationCached && book.sourceID!=='local-file' && <button className="text-button" onClick={()=>fileInput.current?.click()}>导入已有的同一份文件</button>}{confirmRemove && <div className="inline-confirm"><span>删除书籍及云文件？</span><button className="text-button danger" onClick={() => { void library.remove(book); setConfirmRemove(false); onNotice('已移除'); }}>确认移除</button><button className="text-button" onClick={() => setConfirmRemove(false)}>取消</button></div>}{book.publicationFormat && <div className="file-explanation"><ArrowDownToLine size={17} /><span>{book.publicationFormat === 'pdf' ? 'PDF · 原始版面' : '下载后可离线阅读'}</span></div>}{error && <div className="error-banner">{error}</div>}{cacheProgress && <div className="cache-progress"><span>{cacheProgress}</span>{working && <button className="text-button" onClick={() => { abort.current?.abort(); setCacheProgress('已停止，已完成的章节会保留'); }}>停止</button>}</div>}{canManageChapters(book) && <div className="book-workflow-actions">{entry && <button className="text-button" onClick={() => setWorkflow('source')}><RefreshCw size={15}/>换源</button>}<button className="text-button" onClick={() => setWorkflow('manager')}><Download size={15}/>下载管理</button></div>}<div className="detail-catalog-heading"><h3>目录 <span>{chapters.length || ''}</span></h3>{!book.publicationFormat && chapters.length > 0 && <button className="text-button" disabled={working} onClick={() => void download()}><Download size={14} />下载章节</button>}</div>{loading ? <Loading text="正在加载目录" /> : chapters.length ? <ol className="detail-chapters">{chapters.map(chapter => <li key={chapter.id}><button onClick={() => onRead(book, chapter.id)}><span>{chapter.title}</span><small>{(progress[chapter.id] || 0) > 0 && <em>{Math.round(progress[chapter.id] * 100)}%</em>}{cachedIDs.has(chapter.id) && <Check size={12} aria-label="已缓存" />}</small><ChevronRight size={14} /></button></li>)}</ol> : <p className="catalog-note">{book.publicationFormat ? publicationCached && book.publicationFormat === 'pdf' ? 'PDF 按原始页码阅读，点击开始阅读打开。' : '整本下载后显示目录。' : '当前未能获取目录，请稍后重试。'}</p>}</section></div>{workflow === 'source' && <SourcePicker book={book} onClose={() => setWorkflow(null)} onChanged={replacement => { setWorkflow(null); onRead(replacement); }}/>}{workflow === 'download' && <DownloadOptions book={book} chapters={chapters} onClose={() => setWorkflow(null)} onQueued={() => setWorkflow('manager')}/>}{workflow === 'manager' && <DownloadManager onClose={() => setWorkflow(null)}/>}</>;
}

type SettingPanel = 'notifications' | 'sources' | 'voices' | 'reading' | 'storage' | 'server' | 'account' | null;
function SettingsPage({ settings, sources, disabled, sourceError, onNotice, onImport }: { settings: ReaderSettings; sources: SourceDefinition[]; disabled: string[]; sourceError: string; onNotice: (text: string) => void; onImport: () => void }) {
  const [panel, setPanel] = useState<SettingPanel>(null); const backupInput = useRef<HTMLInputElement>(null);
  useAndroidBack(() => { if (!panel) return false; setPanel(null); return true; }, 100);
  async function exportBackup() { try { const data = await library.exportBackup(); const blob = data instanceof Blob ? data : new Blob([typeof data === 'string' ? data : JSON.stringify(data)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `清读备份-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); onNotice('已导出书架、阅读设置与进度'); } catch (error) { onNotice(message(error)); } }
  async function importBackup(file?: File) { if (!file) return; try { await library.importBackup(file); onNotice('备份已恢复'); } catch (error) { onNotice(message(error)); } finally { if (backupInput.current) backupInput.current.value = ''; } }
  return <><PageHeader title="设置" /><section className="settings-group"><h3>账号</h3><SettingRow icon={ShieldCheck} title="账号与同步" subtitle="书架、阅读进度与独立账号" onClick={() => setPanel('account')} /></section><section className="settings-group"><h3>阅读与内容</h3><SettingRow icon={Library} title="书源管理" subtitle={`${sources.filter(source => !disabled.includes(source.id)).length} 个已启用`} onClick={() => setPanel('sources')} /><SettingRow icon={RefreshCw} title="通知与后台" onClick={()=>setPanel('notifications')} /><SettingRow icon={Headphones} title="听书与音色" subtitle="设备音色与语速" onClick={() => setPanel('voices')} /><SettingRow icon={SlidersHorizontal} title="阅读偏好" subtitle="字号、段距、背景与翻页" onClick={() => setPanel('reading')} /></section><section className="settings-group"><h3>文件与数据</h3><SettingRow icon={FileUp} title="导入书籍" subtitle="EPUB / PDF / TXT" onClick={onImport} /><SettingRow icon={Download} title="导出阅读备份" subtitle="书架、进度与设置" onClick={() => void exportBackup()} /><SettingRow icon={ArrowDownToLine} title="恢复阅读备份" onClick={() => backupInput.current?.click()} /><SettingRow icon={Trash2} title="存储管理" subtitle="已下载章节与本地文件" onClick={() => setPanel('storage')} /></section><section className="settings-group"><h3>连接</h3><SettingRow icon={ShieldCheck} title="服务器连接" subtitle={localStorage.getItem('qingread.apiBase') || import.meta.env.VITE_API_BASE || '当前站点服务'} onClick={() => setPanel('server')} /></section><div className="settings-about"><span className="brand-mark">清</span><strong>清读</strong><small>{isAndroidApp()?'Android':'Web'} {appVersion}</small></div><input hidden type="file" accept=".json,application/json" ref={backupInput} onChange={event => void importBackup(event.target.files?.[0])} />{panel && <div className="modal-backdrop"><section className="settings-panel modal-panel" role="dialog" aria-modal="true"><div className="modal-toolbar"><button className="icon-button" onClick={() => setPanel(null)} aria-label="返回设置"><ArrowLeft size={21} /></button><strong>{{ sources: '书源管理', voices: '听书与音色', reading: '阅读偏好', storage: '存储管理', server: '服务器连接', account: '账号与同步',notifications:'通知与后台' }[panel]}</strong><button className="icon-button" onClick={() => setPanel(null)} aria-label="关闭"><X size={20} /></button></div>{panel === 'notifications' ? <NotificationSettings/> : panel === 'account' ? <AccountPanel /> : panel === 'sources' ? <SourcesPanel sources={sources} disabled={disabled} error={sourceError} onNotice={onNotice} /> : panel === 'voices' ? <VoicesPanel settings={settings} /> : panel === 'reading' ? <ReadingPreferences settings={settings} /> : panel === 'storage' ? <StoragePanel onNotice={onNotice} /> : <ServerPanel onNotice={onNotice} />}</section></div>}</>;
}
function SettingRow({ icon: Icon, title, subtitle, onClick }: { icon: typeof Library; title: string; subtitle?: string; onClick: () => void }) { return <button className="setting-row" onClick={onClick}><span className="setting-icon"><Icon size={19} strokeWidth={1.6} /></span><span><strong>{title}</strong>{subtitle && <small>{subtitle}</small>}</span><ChevronRight size={17} /></button>; }
function SourcesPanel({ sources, disabled, error, onNotice }: { sources: SourceDefinition[]; disabled: string[]; error: string; onNotice: (text: string) => void }) {
  const [importText, setImportText] = useState(''); const [importResult, setImportResult] = useState(''); const [importOpen, setImportOpen] = useState(false);
  function validate() { try { const parsed: unknown = JSON.parse(importText); const list = Array.isArray(parsed) ? parsed : [parsed]; if (!list.length || list.some(value => !value || typeof value !== 'object' || !('id' in value) || !('name' in value) || !('homeURL' in value) || !('kind' in value))) throw new Error('需要包含 id、name、homeURL、kind 的书源对象或数组'); for (const source of list as SourceDefinition[]) { if (typeof source.id !== 'string' || !source.id.trim() || typeof source.name !== 'string' || !source.name.trim() || !['html', 'mediaWiki', 'staticCatalog', 'gutenberg', 'standardEbooks', 'openStax'].includes(source.kind)) throw new Error('书源 id、name 或 kind 无效'); if (source.kind === 'html' && (!source.html?.searchURL || !source.html?.resultSelector || !source.html?.chapterSelector || !source.html?.contentSelector)) throw new Error('HTML 书源缺少搜索、目录或正文规则'); const url = new URL(source.homeURL); if (url.protocol !== 'https:') throw new Error('书源入口必须使用 HTTPS'); } setImportResult(`JSON 格式通过：${list.length} 个书源。Web 版只请求服务器已注册的书源，请让服务器管理员将配置加入书源清单。`); } catch (error) { setImportResult(message(error)); } }
  return <div className="panel-content"><p className="panel-explanation"></p>{error && <div className="error-banner">{error}</div>}<div className="source-list">{sources.map(source => <div className="source-row" key={source.id}><span className="source-initial">{source.name.slice(0, 1)}</span><div><strong>{source.name}</strong><p>{source.summary}</p><a href={source.homeURL} target="_blank" rel="noreferrer">{new URL(source.homeURL).hostname}</a></div><button className={`toggle ${!disabled.includes(source.id) ? 'on' : ''}`} role="switch" aria-label={`启用${source.name}`} aria-checked={!disabled.includes(source.id)} onClick={() => { void library.toggleSource(source.id); }}><span /></button></div>)}</div><button className="secondary-button full-width" onClick={() => setImportOpen(!importOpen)}><Plus size={16} />检查书源配置</button>{importOpen && <div className="source-import"><label htmlFor="source-json">粘贴清读书源 JSON</label><textarea id="source-json" value={importText} onChange={event => setImportText(event.target.value)} placeholder={'{"id": "…", "name": "…", "homeURL": "https://…", "kind": "html"}'} /><button className="primary-button" onClick={validate} disabled={!importText.trim()}>校验配置</button>{importResult && <p role="status">{importResult}</p>}<button className="text-button" onClick={() => { if (!navigator.clipboard) { onNotice('浏览器不允许复制，请手动选择文本'); return; } void navigator.clipboard.writeText(importText).then(() => onNotice('已复制配置')).catch(() => onNotice('浏览器不允许复制，请手动选择文本')); }}>复制配置</button></div>}<div className="info-note"><CircleHelp size={17} /><p>仅校验配置，不会启用新书源。</p></div></div>;
}
function VoicesPanel({ settings }: { settings: ReaderSettings }) {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]); const [speaking, setSpeaking] = useState(false); const [previewError, setPreviewError] = useState('');
  const supported = 'speechSynthesis' in window;
  useEffect(() => { if (!supported) return; const load = () => setVoices(speechSynthesis.getVoices()); load(); speechSynthesis.addEventListener('voiceschanged', load); return () => { speechSynthesis.removeEventListener('voiceschanged', load); speechSynthesis.cancel(); }; }, [supported]);
  const sortedVoices = [...voices].sort((a, b) => Number(b.lang.startsWith('zh')) - Number(a.lang.startsWith('zh')) || a.name.localeCompare(b.name));
  function preview() { if (!supported) return; if (speaking) { speechSynthesis.cancel(); setSpeaking(false); return; } setPreviewError(''); const utterance = new SpeechSynthesisUtterance('晋太元中，武陵人捕鱼为业。缘溪行，忘路之远近。'); utterance.lang = 'zh-CN'; utterance.voice = voices.find(voice => voice.voiceURI === settings.speechVoiceIdentifier) || null; utterance.rate = settings.speechRate; utterance.onend = () => setSpeaking(false); utterance.onerror = event => { setSpeaking(false); if (event.error !== 'canceled') setPreviewError(`语音未能播放：${event.error}`); }; speechSynthesis.cancel(); speechSynthesis.speak(utterance); setSpeaking(true); }
  return <div className="panel-content"><div className="audio-identity"><Headphones size={28} strokeWidth={1.3} /><div><h3>系统语音</h3><p>使用此设备与浏览器提供的音色</p></div><span className="small-badge">免费</span></div>{!supported ? <div className="error-banner">此浏览器尚不支持听书，请使用 Safari、Chrome 或安卓 App。</div> : <><label className="field-label" htmlFor="voice-select">选择音色</label><select className="text-input" id="voice-select" value={settings.speechVoiceIdentifier} onChange={event => void library.updateSettings({ speechVoiceIdentifier: event.target.value, speechEngine: 'system' })}><option value="">设备默认中文音色</option>{sortedVoices.map(voice => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} · {voice.lang}{voice.localService ? ' · 本地' : ' · 可能联网'}</option>)}</select><RangeSetting label="语速" value={settings.speechRate} min={0.6} max={1.8} step={0.1} unit="×" onChange={speechRate => void library.updateSettings({ speechRate })} /><button className="primary-button full-width" onClick={preview}><Headphones size={17} />{speaking ? '停止试听' : '试听此音色'}</button>{previewError && <div className="error-banner">{previewError}</div>}</>}<section className="model-card"><div><h3>Kokoro 离线 AI</h3><span className="model-status">原生版可用</span></div><p>当前使用系统音色。</p><small>此页面不会下载无法在浏览器中运行的声库。</small></section><div className="info-note"><CloudOff size={17} /><p>本地音色可离线使用。</p></div></div>;
}
function ReadingPreferences({ settings }: { settings: ReaderSettings }) {
  const themes: { id: ReaderSettings['theme']; name: string; color: string }[] = [{ id: 'paper', name: '纸白', color: '#f5f0e7' }, { id: 'dusk', name: '暖黄', color: '#e9d8b5' }, { id: 'mint', name: '豆绿', color: '#dbe7d7' }, { id: 'gray', name: '素灰', color: '#e3e4e4' }, { id: 'rose', name: '浅粉', color: '#f1dfe0' }, { id: 'night', name: '夜间', color: '#222320' }];
  return <div className="panel-content"><div className="reading-sample" style={{ fontSize: settings.fontSize, lineHeight: `${settings.fontSize + settings.lineSpacing}px`, background: themes.find(theme => theme.id === settings.theme)?.color, color: settings.theme === 'night' ? '#b9b7ac' : '#39372f', fontFamily: settings.font === 'song' ? 'var(--serif)' : 'var(--sans)', fontWeight: settings.isBold ? 600 : 400 }}><p style={{ marginBottom: settings.paragraphSpacing }}>忽逢桃花林，夹岸数百步，中无杂树，芳草鲜美，落英缤纷。</p><p>渔人甚异之，复前行，欲穷其林。</p></div><RangeSetting label="字号" value={settings.fontSize} min={16} max={34} step={1} unit="" onChange={fontSize => void library.updateSettings({ fontSize })} /><RangeSetting label="行距" value={settings.lineSpacing} min={4} max={22} step={1} unit="" onChange={lineSpacing => void library.updateSettings({ lineSpacing })} /><RangeSetting label="段距" value={settings.paragraphSpacing} min={0} max={28} step={1} unit="" onChange={paragraphSpacing => void library.updateSettings({ paragraphSpacing })} /><RangeSetting label="页边距" value={settings.horizontalMargin} min={16} max={40} step={2} unit="" onChange={horizontalMargin => void library.updateSettings({ horizontalMargin })} /><label className="field-label">阅读背景</label><div className="theme-options">{themes.map(theme => <button key={theme.id} className={settings.theme === theme.id ? 'selected' : ''} onClick={() => void library.updateSettings({ theme: theme.id, isNightMode: theme.id === 'night' })}><span style={{ background: theme.color }}>{settings.theme === theme.id && <Check size={15} color={theme.id === 'night' ? '#ddd' : '#554'} />}</span><small>{theme.name}</small></button>)}</div><label className="field-label">翻页方式</label><div className="segmented">{([{ id: 'slide', name: '滑动' }, { id: 'cover', name: '覆盖' }, { id: 'scroll', name: '上下滚动' }] as const).map(mode => <button key={mode.id} className={settings.turnMode === mode.id ? 'active' : ''} onClick={() => void library.updateSettings({ turnMode: mode.id })}>{mode.name}</button>)}</div><label className="field-label">字体</label><div className="segmented">{([{ id: 'song', name: '宋体' }, { id: 'system', name: '系统' }, { id: 'rounded', name: '圆体' }] as const).map(font => <button key={font.id} className={settings.font === font.id ? 'active' : ''} onClick={() => void library.updateSettings({ font: font.id })}>{font.name}</button>)}</div><div className="switch-row"><span>加粗文字</span><button className={`toggle ${settings.isBold ? 'on' : ''}`} role="switch" aria-checked={settings.isBold} aria-label="加粗文字" onClick={() => void library.updateSettings({ isBold: !settings.isBold })}><span /></button></div></div>;
}
function RangeSetting({ label, value, min, max, step, unit, onChange }: { label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (value: number) => void }) { return <label className="range-setting"><span>{label}<strong>{Number(value.toFixed(1))}{unit}</strong></span><input aria-label={label} type="range" min={min} max={max} step={step} value={value} onChange={event => onChange(Number(event.target.value))} /></label>; }
function StoragePanel({ onNotice }: { onNotice: (text: string) => void }) {
  const [stats, setStats] = useState<unknown>(null); const [estimate, setEstimate] = useState<StorageEstimate | null>(null); const [confirm, setConfirm] = useState(false); const [busy, setBusy] = useState(false); const [persistent, setPersistent] = useState<boolean | null>(null);
  const load = () => { void library.cacheStats().then(setStats); void navigator.storage?.estimate().then(setEstimate); void navigator.storage?.persisted().then(setPersistent); };
  useEffect(load, []);
  async function clear() { setBusy(true); try { await library.clearCache(); setConfirm(false); load(); onNotice('章节缓存已清理，书架与阅读进度保留'); } catch (error) { onNotice(message(error)); } finally { setBusy(false); } }
  async function persist() { if (!navigator.storage?.persist) return onNotice('此浏览器不支持申请持久存储'); const granted = await navigator.storage.persist(); setPersistent(granted); onNotice(granted ? '已获得持久存储' : '浏览器暂未授予，请将清读添加到主屏幕后重试'); }
  return <div className="panel-content"><div className="storage-meter"><span>此站点占用</span><strong>{estimate?.usage != null ? formatBytes(estimate.usage) : '读取中…'}</strong>{estimate?.quota != null && <small>可用配额约 {formatBytes(estimate.quota)}</small>}</div>{stats !== null && <div className="storage-breakdown">{Object.entries(stats as Record<string, unknown>).filter(([, value]) => typeof value === 'number').map(([key, value]) => <span key={key}>{({ chapters: '章节', books: '书籍', bytes: '缓存大小', files: '本地文件', contents: '已缓存章节', publications: '导入书籍', cachedChapters: '已缓存章节' } as Record<string, string>)[key] || key}<strong>{key.toLowerCase().includes('byte') ? formatBytes(Number(value)) : String(value)}</strong></span>)}</div>}<div className="info-note"><ShieldCheck size={17} /><p>建议保留电子书原文件。</p></div><button className="secondary-button full-width" onClick={() => void persist()} disabled={persistent === true}><ShieldCheck size={16} />{persistent ? '已启用持久存储' : '申请持久存储'}</button><button className="danger-outline full-width" onClick={() => setConfirm(!confirm)}><Trash2 size={16} />清理章节缓存</button>{confirm && <div className="confirm-box"><p>清理后，联网书籍需要重新下载章节。书架、设置与进度会保留。</p><button className="danger-button" disabled={busy} onClick={() => void clear()}>{busy ? '清理中…' : '确认清理'}</button><button className="text-button" onClick={() => setConfirm(false)}>取消</button></div>}</div>;
}
function ServerPanel({ onNotice }: { onNotice: (text: string) => void }) {
  const [initial] = useState(() => serverConnectionStore().load());
  const [base, setBase] = useState(initial.base);
  const [token, setToken] = useState(initial.token);
  const [remember, setRemember] = useState(initial.remember);
  const [boundAddress, setBoundAddress] = useState(initial.address);
  const [error, setError] = useState('');
  function changeBase(value: string) {
    setBase(value);
    let address = '';
    try { address = normalizeApiAddress(value.trim() || import.meta.env.VITE_API_BASE || '', location.origin); } catch { /* A partial address is not a credential destination. */ }
    if (address !== boundAddress) { setToken(''); setRemember(false); }
    setBoundAddress(address);
  }
  function save() {
    try {
      if (isAndroidApp()) { const issue = androidServerIssue(base.trim() || import.meta.env.VITE_API_BASE || ''); if (issue) throw new Error(issue); }
      if (base.trim()) {
        const url = new URL(base.trim());
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('请输入 HTTP 或 HTTPS 服务地址');
        if (location.protocol === 'https:' && url.protocol !== 'https:') throw new Error('HTTPS 网页需要连接 HTTPS 服务');
      }
      serverConnectionStore().save(base, token, remember);
      onNotice('连接设置已保存'); location.reload();
    } catch (error) { setError(message(error)); }
  }
  function clearToken() {
    serverConnectionStore().clearToken(); setToken(''); setRemember(false); onNotice('此设备保存的访问码已清除');
  }
  return <div className="panel-content">
    <p className="panel-explanation">{isAndroidApp() ? '连接你的 HTTPS 书源服务；留空使用此版本预设的服务器。' : '留空使用当前站点的书源服务，也可填写其他服务器地址。'}</p>
    <label className="field-label" htmlFor="server-base">服务地址</label>
    <input id="server-base" className="text-input" type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" value={base} onChange={event => changeBase(event.target.value)} placeholder={import.meta.env.VITE_API_BASE || (isAndroidApp() ? 'https://你的服务器域名' : '留空使用当前站点 /api')} />
    <label className="field-label" htmlFor="server-token">服务访问码（若服务器启用）</label>
    <input id="server-token" className="text-input" type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} placeholder="可留空" />
    <label className="field-label"><input type="checkbox" checked={remember} onChange={event => { setRemember(event.target.checked); if (!event.target.checked) serverConnectionStore().forgetRemembered(); }} /> 在此设备记住访问码</label>
    <p className="field-help"></p>
    {error && <div className="error-banner">{error}</div>}
    <button className="primary-button full-width" onClick={save}>保存并重新连接 <ArrowRight size={16} /></button>
    <button className="text-button" onClick={clearToken}>清除已保存的访问码</button>

  </div>;
}
