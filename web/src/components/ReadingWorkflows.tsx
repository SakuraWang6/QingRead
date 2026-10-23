import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, Download, LoaderCircle, Pause, Play, RefreshCw, X } from 'lucide-react';
import type { Book, Chapter, SourceSwitchPlan } from '../shared/types';
import { api } from '../lib/api';
import { cloudSync } from '../lib/cloud';
import { isAndroidApp } from '../lib/android';
import { isHarmonyApp } from '../lib/harmony';
import { library, useLibrary } from '../lib/store';
import { useAndroidBack } from '../lib/android';
import './ReadingWorkflows.css';

const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试';
export const canManageChapters = (book: Book) => !book.publicationFormat && !book.fileDownloadURL && !book.sourceID.startsWith('local') && book.sourceID !== 'sample' && /^https?:/.test(book.url);

export function WorkflowDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const section = useRef<HTMLElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useAndroidBack(() => { onClose(); return true; }, 500);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    section.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); close.current(); }
      if (event.key !== 'Tab') return;
      const controls = [...(section.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, [tabindex="0"]') ?? [])];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, []);
  return createPortal(<div className="workflow-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={section} tabIndex={-1} className="workflow-sheet" role="dialog" aria-modal="true" aria-label={title}>
      <header className="workflow-header"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label={`关闭${title}`}><X size={21}/></button></header>
      {children}
    </section>
  </div>, document.body);
}

export function SourcePicker({ book, onClose, onChanged }: { book: Book; onClose: () => void; onChanged: (book: Book) => void }) {
  const owner = useRef(library).current;
  const [candidates, setCandidates] = useState<Book[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [plan, setPlan] = useState<SourceSwitchPlan>();
  const [chapterID, setChapterID] = useState('');
  const [query, setQuery] = useState('');
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setError('');
    owner.findSourceCandidates(book, controller.signal).then(result => { if (!controller.signal.aborted && library === owner) setCandidates(result); })
      .catch(reason => { if (!controller.signal.aborted) setError(errorMessage(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [owner, book, retry]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); }; }, []);
  async function choose(candidate: Book) {
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    setBusy(true); setError('');
    try {
      const value = await owner.prepareSourceSwitch(book, candidate, controller.signal);
      if (controller.signal.aborted || library !== owner) return;
      setPlan(value); setChapterID(value.matchedChapterID || ''); setQuery('');
    } catch (reason) { if (!controller.signal.aborted) setError(errorMessage(reason)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  async function commit() {
    if (!plan || !chapterID || library !== owner) return;
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    setBusy(true); setError('');
    try { const replacement = await owner.commitSourceSwitch(plan, chapterID, controller.signal); if (!controller.signal.aborted && mounted.current && library === owner) onChanged(replacement); }
    catch (reason) { if (!controller.signal.aborted && mounted.current && library === owner) setError(errorMessage(reason)); }
    finally { if (mounted.current) setBusy(false); }
  }
  const chapters = plan?.chapters.filter(chapter => !query || chapter.title.includes(query) || String(chapter.index + 1) === query).slice(0, 150) || [];
  return <WorkflowDialog title="换源" onClose={onClose}>
    <div className="workflow-book"><strong>{book.title}</strong><span>当前 · {book.sourceName}</span></div>
    {error && <p className="workflow-error" role="alert">{error}</p>}
    {plan ? <>
      <button className="text-button" onClick={() => { setPlan(undefined); setError(''); }} disabled={busy}><ArrowLeft size={15}/>其他书源</button>
      <div className="workflow-target"><strong>{plan.candidate.sourceName}</strong><span>共 {plan.chapters.length} 章</span></div>
      {plan.match === 'manual' ? <>
        <p className="workflow-hint">未能匹配当前章节，请选择接着读的位置。</p>
        <input className="text-input" aria-label="搜索换源章节" placeholder="章节名或序号" value={query} onChange={event => setQuery(event.target.value)}/>
        <div className="workflow-chapters">{chapters.map(chapter => <button className={chapterID === chapter.id ? 'selected' : ''} key={chapter.id} onClick={() => setChapterID(chapter.id)}><span>{chapter.title}</span>{chapterID === chapter.id && <Check size={16}/>}</button>)}</div>
      </> : <p className="workflow-hint">接着读：{plan.chapters.find(chapter => chapter.id === chapterID)?.title}</p>}
      <button className="primary-button full-width" disabled={busy || !chapterID} onClick={() => void commit()}>{busy ? <LoaderCircle size={17} className="spin"/> : <RefreshCw size={17}/>}确认换源</button>
    </> : loading ? <div className="workflow-loading" role="status"><LoaderCircle className="spin" size={20}/>正在查找书源</div> : <>
      <div className="workflow-sources">{candidates.map(candidate => <button key={`${candidate.sourceID}|${candidate.url}`} disabled={busy} onClick={() => void choose(candidate)}><span><strong>{candidate.sourceName}</strong><small>{candidate.author || candidate.title}</small></span>{busy ? <LoaderCircle size={17} className="spin"/> : <RefreshCw size={17}/>}</button>)}</div>
      {!candidates.length && <p className="workflow-empty">暂无可切换的同名书籍</p>}
      <button className="text-button" disabled={busy} onClick={() => setRetry(value => value + 1)}><RefreshCw size={15}/>重新查找</button>
    </>}
  </WorkflowDialog>;
}

export function DownloadOptions({ book, chapters: supplied, onClose, onQueued }: { book: Book; chapters?: Chapter[]; onClose: () => void; onQueued: () => void }) {
  const owner = useRef(library).current;
  const [chapters, setChapters] = useState<Chapter[]>(supplied || []);
  const [kind, setKind] = useState<'50' | '100' | 'all' | 'range'>('50');
  const [from, setFrom] = useState(1), [to, setTo] = useState(Math.min(50, supplied?.length || 50));
  const [loading, setLoading] = useState(!supplied?.length), [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (supplied?.length) return;
    const controller = new AbortController();
    (async () => {
      const values = await owner.getChapters(book) || await api.chapters(book, controller.signal);
      if (controller.signal.aborted || library !== owner) return;
      if (!values.length) throw new Error('暂时没有可下载的章节');
      await owner.cacheChapters(book, values); setChapters(values); setTo(Math.min(50, values.length));
    })().catch(reason => { if (!controller.signal.aborted) setError(errorMessage(reason)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [book, owner, supplied]);
  const validRange = Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 1 && to >= from && to <= chapters.length;
  async function queue() {
    if (library !== owner) return;
    setBusy(true); setError('');
    try {
      await owner.add(book);
      if (library !== owner) return;
      if(!isAndroidApp()&&cloudSync.getSnapshot().session)await cloudSync.sync();
      if(library!==owner)return;
      await owner.enqueueDownload(book, kind === 'range' ? { kind: 'range', from: from - 1, to: to - 1 } : kind === 'all' ? { kind: 'all' } : { kind: 'next', count: Number(kind) as 50 | 100 });
      if (library === owner) onQueued();
    } catch (reason) { if (library === owner) setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }
  return <WorkflowDialog title="下载章节" onClose={onClose}>
    <div className="workflow-book"><strong>{book.title}</strong><span>{chapters.length ? `共 ${chapters.length} 章` : ''}</span></div>
    {loading ? <div className="workflow-loading"><LoaderCircle className="spin" size={20}/>正在获取目录</div> : <>
      <div className="workflow-options">{([['50', '后续 50 章'], ['100', '后续 100 章'], ['all', '整本'], ['range', '自选范围']] as const).map(([value, label]) => <button key={value} className={kind === value ? 'selected' : ''} onClick={() => setKind(value)} aria-pressed={kind === value}>{label}</button>)}</div>
      {kind === 'range' && <div className="workflow-range"><label>从第<input aria-label="下载起始章节" type="number" min={1} max={chapters.length} value={from || ''} onChange={event => setFrom(Number(event.target.value))}/></label><span>至</span><label>第<input aria-label="下载结束章节" type="number" min={from || 1} max={chapters.length} value={to || ''} onChange={event => setTo(Number(event.target.value))}/></label><span>章</span></div>}
      <button className="primary-button full-width" disabled={busy || !chapters.length || kind === 'range' && !validRange} onClick={() => void queue()}>{busy ? <LoaderCircle size={17} className="spin"/> : <Download size={17}/>}加入下载</button>
    </>}
    {error && <p className="workflow-error" role="alert">{error}</p>}
  </WorkflowDialog>;
}

const downloadLabels = { queued: '等待中', running: '下载中', paused: '已暂停', completed: '已完成', failed: '未完成', cancelled: '已取消' };
export function DownloadManager({ onClose }: { onClose: () => void }) {
  const { downloads } = useLibrary();
  const [error, setError] = useState('');
  async function action(run: () => Promise<void>) { try { setError(''); await run(); } catch (reason) { setError(errorMessage(reason)); } }
  return <WorkflowDialog title="下载管理" onClose={onClose}>
    {isHarmonyApp() && <p className="workflow-hint">本机下载请保持前台；云端已备妥的章节需保存到本机才能离线阅读。</p>}
    {error && <p className="workflow-error" role="alert">{error}</p>}
    {!downloads.length ? <p className="workflow-empty">暂无下载任务</p> : <div className="workflow-jobs">{downloads.map(job => <article className="workflow-job" key={job.id}>
      <div className="workflow-job-heading"><strong>{job.bookTitle}</strong><span>{job.engine==='server'&&job.status==='completed'&&!job.storedOnDevice?'云端已备妥':job.engine==='server'&&job.status==='running'?'云端准备中':downloadLabels[job.status]}</span></div>
      <progress aria-label={`${job.bookTitle}下载进度`} max={Math.max(1, job.total)} value={job.completed}/>
      <div className="workflow-job-foot"><span>{job.completed} / {job.total} 章{job.failedChapterIDs.length ? ` · ${job.failedChapterIDs.length} 章失败` : ''}</span><div>
        {job.engine==='server'&&job.completed>0&&!job.storedOnDevice&&<button aria-label={`保存到本机${job.bookTitle}`} onClick={()=>void action(()=>library.savePreparedDownload(job.id))}><Download size={18}/></button>}
        {(job.status === 'running' || job.status === 'queued') && <button aria-label={`暂停下载${job.bookTitle}`} onClick={() => void action(() => library.pauseDownload(job.id))}><Pause size={18}/></button>}
        {job.status === 'paused' && <button aria-label={`继续下载${job.bookTitle}`} onClick={() => void action(() => library.resumeDownload(job.id))}><Play size={18}/></button>}
        {job.status === 'failed' && <button aria-label={`重试下载${job.bookTitle}`} onClick={() => void action(() => library.retryDownload(job.id))}><RefreshCw size={18}/></button>}
        {!['completed', 'cancelled'].includes(job.status) && <button aria-label={`取消下载${job.bookTitle}`} onClick={() => void action(() => library.cancelDownload(job.id))}><X size={18}/></button>}
      </div></div>
      {job.error && <p className="workflow-error">{job.error}</p>}
    </article>)}</div>}
  </WorkflowDialog>;
}
