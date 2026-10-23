// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Reader } from '../src/components/Reader';
import { defaultSettings, type Book, type Chapter, type ChapterContent, type LibraryState } from '../src/shared/types';

const data = vi.hoisted(() => ({ state: undefined as unknown as LibraryState, chapters: [] as Chapter[], contents: [] as ChapterContent[] }));
const store = vi.hoisted(() => ({
  getChapters: vi.fn(async () => data.chapters), cacheChapters: vi.fn(async () => {}),
  loadContent: vi.fn(async (_book: Book, chapter: Chapter) => data.contents.find(item => item.chapter.id === chapter.id)!),
  getContent: vi.fn(async (_book: Book, chapter: Chapter) => data.contents.find(item => item.chapter.id === chapter.id)),
  prefetch: vi.fn(async () => {}), chapterStates: vi.fn(async () => ({})), savePosition: vi.fn(async () => {}),
  annotate: vi.fn(async () => {}), searchCached: vi.fn(async () => []), updateSettings: vi.fn(async () => {}),
}));
vi.mock('../src/lib/store', () => ({ library: store, useLibrary: () => data.state }));
vi.mock('../src/lib/android', () => ({ useAndroidBack: vi.fn() }));
vi.mock('../src/components/EPUBReader', () => ({ EPUBReader: () => null }));
vi.mock('../src/components/ReadingWorkflows', () => ({
  canManageChapters: () => false, DownloadManager: () => null, DownloadOptions: () => null, SourcePicker: () => null,
  WorkflowDialog: ({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) => <section className="workflow-sheet" aria-label={title}><h2>{title}</h2><button onClick={onClose}>关闭</button>{children}</section>,
}));

const book: Book = { id: 'paragraph-book', title: '段落样书', author: '测试', summary: '', sourceID: 'local', sourceName: '本地', url: 'qingread-local:test' };
let host: HTMLDivElement, root: Root;
function pointer(target: Element, type: string, x = 120, y = 130) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerType: { value: 'touch' }, pointerId: { value: 1 }, isPrimary: { value: true } });
  target.dispatchEvent(event);
}
async function flush(ms = 25) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function renderReader() { await act(async () => root.render(<Reader book={book} onClose={() => {}}/>)); await flush(); }
const paragraph = () => host.querySelectorAll<HTMLParagraphElement>('.reader-text:not(.reader-measure) p')[1];
async function writeNote(value: string) {
  await act(async () => {
    const input = host.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => ({ top: 0, bottom: 30, left: 0, right: 300, width: 300, height: 30 }) });
  data.chapters = [{ id: 'chapter-1', title: '第一章', url: 'qingread-local:1', index: 0 }];
  data.contents = [{ chapter: data.chapters[0], paragraphs: ['第一段。', '第二段含有👩🏽‍💻，用于直接写段落笔记。', '第三段。'] }];
  data.state = { ready: true, shelf: [{ book, addedAt: new Date().toISOString() }], settings: { ...defaultSettings, turnMode: 'scroll' }, sources: [], disabledSourceIDs: [], updates: {}, checkingUpdates: false, downloads: [] };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks();
});

describe('paragraph notes directly from the reading page', () => {
  it('long presses the paragraph, quotes it, and saves the original paragraph position', async () => {
    await renderReader();
    await act(async () => pointer(paragraph(), 'pointerdown')); await flush(510);
    await act(async () => pointer(paragraph(), 'pointerup'));
    expect(host.querySelector('[aria-label="段落笔记"]')).toBeTruthy();
    expect(host.querySelector('.note-quote')?.textContent).toBe(data.contents[0].paragraphs[1]);
    expect(host.querySelector('textarea')).toBe(document.activeElement);
    expect(host.querySelector<HTMLButtonElement>('.primary-button')!.disabled).toBe(true);
    await writeNote('记住这一段');
    await act(async () => host.querySelector<HTMLButtonElement>('.primary-button')!.click());
    expect(store.annotate).toHaveBeenCalledWith(book, expect.objectContaining({ kind: 'note', note: '记住这一段', characterOffset: 5, characterLength: data.contents[0].paragraphs[1].length, quote: data.contents[0].paragraphs[1], chapterID: 'chapter-1', sourceID: 'local' }));
    expect(host.querySelector('[aria-label="段落笔记"]')).toBeNull();
  });
  it.each(['pointerup', 'pointercancel', 'movement', 'scroll'])('does not open a note after %s cancels the hold', async reason => {
    await renderReader(); const p = paragraph();
    await act(async () => pointer(p, 'pointerdown')); await flush(100);
    await act(async () => {
      if (reason === 'movement') pointer(p, 'pointermove', 120, 155);
      else if (reason === 'scroll') host.querySelector('.reader-scroll-text')!.dispatchEvent(new Event('scroll', { bubbles: true }));
      else pointer(p, reason);
    });
    await flush(600); expect(host.querySelector('[aria-label="段落笔记"]')).toBeNull();
  });
  it('supports a focused paragraph from the keyboard and preserves selected-text context menus', async () => {
    await renderReader(); const p = paragraph(); p.focus();
    await act(async () => p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(host.querySelector('[aria-label="段落笔记"]')).toBeTruthy();
    await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === '关闭')!.click());
    const range = document.createRange(); range.selectNodeContents(p); window.getSelection()!.addRange(range);
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await act(async () => p.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false); expect(host.querySelector('[aria-label="段落笔记"]')).toBeNull();
  });
  it('shows only this source paragraph’s notes and preserves an older precise quote when editing', async () => {
    const note = { id: 'exact-note', kind: 'note' as const, chapterID: 'chapter-1', chapterIndex: 0, chapterTitle: '第一章', characterOffset: 6, characterLength: 3, quote: '二段含', note: '已有想法', updatedAt: new Date().toISOString(), sourceID: book.sourceID, sourceURL: book.url };
    data.state.shelf[0].annotations = [note, { ...note, id: 'other-paragraph', characterOffset: 0, characterLength: 3, note: '另一段' }, { ...note, id: 'other-source', sourceID: 'another-source', note: '另一书源' }, { ...note, id: 'removed', deletedAt: new Date().toISOString(), note: '已删除' }];
    await renderReader();
    await act(async () => pointer(paragraph(), 'pointerdown')); await flush(510);
    expect(host.querySelectorAll('.reading-notes-list article')).toHaveLength(1);
    expect(host.querySelector('.reading-notes-list')?.textContent).toContain('已有想法');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="编辑笔记"]')!.click());
    await writeNote('修改后想法');
    await act(async () => host.querySelector<HTMLButtonElement>('.primary-button')!.click());
    expect(store.annotate).toHaveBeenCalledWith(book, expect.objectContaining({ id: note.id, characterOffset: 6, characterLength: 3, quote: '二段含', note: '修改后想法' }));
  });
  it('keeps a long paragraph’s full range but never truncates its saved quote inside an emoji', async () => {
    const quote = '甲'.repeat(499) + '🙂乙'; data.contents[0].paragraphs[1] = quote;
    await renderReader(); await act(async () => pointer(paragraph(), 'pointerdown')); await flush(510);
    await writeNote('长段落'); await act(async () => host.querySelector<HTMLButtonElement>('.primary-button')!.click());
    expect(store.annotate).toHaveBeenCalledWith(book, expect.objectContaining({ characterLength: quote.length, quote: '甲'.repeat(499) }));
  });
  it('includes older point notes inside this paragraph while excluding bookmarks and boundary points outside it', async () => {
    const note = { id: 'point-note', kind: 'note' as const, chapterID: 'chapter-1', chapterIndex: 0, chapterTitle: '第一章', characterOffset: 5, characterLength: 0, quote: '', note: '段首旧笔记', updatedAt: new Date().toISOString(), sourceID: book.sourceID, sourceURL: book.url };
    const end = 5 + data.contents[0].paragraphs[1].length;
    data.state.shelf[0].annotations = [
      note, { ...note, id: 'inside-note', characterOffset: end - 1, note: '段尾旧笔记' },
      { ...note, id: 'before-paragraph', characterOffset: 4, note: '段前笔记' },
      { ...note, id: 'after-paragraph', characterOffset: end, note: '下一段笔记' },
      { ...note, id: 'range-bookmark', kind: 'bookmark', characterLength: 3, note: '' },
      { ...note, id: 'point-bookmark', kind: 'bookmark', note: '' },
    ];
    await renderReader(); await act(async () => pointer(paragraph(), 'pointerdown')); await flush(510);
    const list = host.querySelector('.reading-notes-list')!;
    expect(list.querySelectorAll('article')).toHaveLength(2);
    expect(list.textContent).toContain('段首旧笔记'); expect(list.textContent).toContain('段尾旧笔记');
    expect(list.textContent).not.toContain('段前笔记'); expect(list.textContent).not.toContain('下一段笔记');
  });
});
