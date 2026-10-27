import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';
// opencc-js publishes a runtime module without TypeScript declarations.
import * as OpenCC from 'opencc-js';
import definitions from '../src/shared/sources.json';
import type { Book, Category, Chapter, ChapterContent, DiscoverySection, SearchResponse, SourceDefinition } from '../src/shared/types.js';
import { fetchBuffer, fetchStream, MAX_DOWNLOAD, ServiceError, validateSourceURL } from './network.js';

export const sources = definitions as SourceDefinition[];
export const categories: Category[] = [
  { id: '1', title: '玄幻奇幻' }, { id: '2', title: '修真武侠' }, { id: '3', title: '都市言情' },
  { id: '4', title: '穿越历史' }, { id: '5', title: '网游竞技' }, { id: '6', title: '科幻灵异' },
  {id:'literature',title:'经典文学'},{id:'textbooks',title:'开放教材'},{id:'completed',title:'完结作品'},
];
const toTraditional: (s: string) => string = OpenCC.Converter({ from: 'cn', to: 'tw' });
const toSimplified: (s: string) => string = OpenCC.Converter({ from: 'tw', to: 'cn' });
const cache = new Map<string, { value: unknown; expires: number; bytes: number }>();
let cacheBytes = 0;
const inFlight = new Map<string, Promise<unknown>>();
async function cached<T>(key: string, ttl: number, loader: () => Promise<T>): Promise<T> {
  const old = cache.get(key); if (old && old.expires > Date.now()) return old.value as T;
  const pending = inFlight.get(key); if (pending) return pending as Promise<T>;
  const work = loader().then(value => {
    const bytes = Buffer.byteLength(JSON.stringify(value) ?? '');
    const previous = cache.get(key); if (previous) { cacheBytes -= previous.bytes; cache.delete(key); }
    while (cache.size >= 350 || cacheBytes + bytes > 32 * 1024 * 1024) { const oldest = cache.keys().next().value; if (!oldest) break; cacheBytes -= cache.get(oldest)!.bytes; cache.delete(oldest); }
    if (bytes <= 8 * 1024 * 1024) { cache.set(key, { value, expires: Date.now() + ttl, bytes }); cacheBytes += bytes; }
    return value;
  });
  inFlight.set(key, work); try { return await work; } finally { inFlight.delete(key); }
}
export const sourceFor = (id: string) => { const source = sources.find(s => s.id === id); if (!source) throw new ServiceError('这个书源尚未在服务器登记。', 400); return source; };
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const normalize = (s: string) => toSimplified(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const resolve = (value: string | undefined, base: string | URL, source: SourceDefinition) => {
  if (!value?.trim()) return undefined;
  try { const url = new URL(value, base); if (url.protocol === 'http:') url.protocol = 'https:'; return validateSourceURL(url, source.id).href; } catch { return undefined; }
};
const unique = <T extends { id: string }>(items: T[]) => [...new Map(items.map(b => [b.id, b])).values()];
export function makeBook(source: SourceDefinition, url: string, title: string, properties: Partial<Book> = {}): Book {
  url = new URL(url).href;
  return { id: `${source.id}|${url}`, title: clean(title), author: '', summary: '', sourceID: source.id, sourceName: source.name, url, ...properties };
}
export function validatedBook(value: unknown): { book: Book; source: SourceDefinition } {
  if (!value || typeof value !== 'object') throw new ServiceError('缺少图书信息。', 400);
  const book = value as Book;
  if (typeof book.sourceID !== 'string' || typeof book.url !== 'string' || book.url.length > 3000 || book.sourceID.length > 80 || typeof book.title !== 'string' || book.title.length > 1000) throw new ServiceError('图书信息无效。', 400);
  const source = sourceFor(book.sourceID); validateSourceURL(book.url, source.id);
  return { source, book: { ...book, sourceName: source.name, id: `${source.id}|${book.url}` } };
}
export function decodePage(data: Buffer, fallback = 'utf8'): string {
  const declaration = data.subarray(0, 8192).toString('ascii').match(/<meta\b[^>]*\bcharset\s*=\s*["']?\s*([\w.-]+)/i)?.[1]?.toLowerCase();
  const encoding = declaration && iconv.encodingExists(declaration) ? declaration : fallback;
  return iconv.decode(data, encoding === 'gbk' ? 'gb18030' : encoding);
}
async function page(url: string | URL, source: SourceDefinition, referer?: string) {
  const response = await fetchBuffer(url, source, { referer });
  const html = decodePage(response.data, source.html?.encoding ?? 'utf8');
  if (/<title[^>]*>\s*(?:just a moment|attention required|access denied|please wait)/i.test(html) || /id=["']cf-chl-widget/i.test(html)) throw new ServiceError('来源要求浏览器验证，服务器暂时无法读取。');
  return { html, url: response.url };
}
function text($: cheerio.CheerioAPI, row: any, selector?: string): string { return selector ? clean($(row).find(selector).first().text()) : ''; }
function image($: cheerio.CheerioAPI, row: any, selector: string, base: string | URL, source: SourceDefinition) {
  const img = $(row).find(selector).first();
  for (const attribute of ['data-original', 'data-src', 'data-lazy-src', 'src']) {
    const value = img.attr(attribute); if (!value || /(?:logo|loading|nocover|no-cover|default|blank|spacer)/i.test(value.split('/').pop() ?? '')) continue;
    const url = resolve(value, base, source); if (url) return url;
  }
  return undefined;
}
export function parseHTMLSearch(html: string, base: URL | string, source: SourceDefinition): Book[] {
  const c = source.html!, $ = cheerio.load(html), rows = $(c.resultSelector).toArray();
  const books = rows.flatMap(row => {
    const link = $(row).is(c.linkSelector) ? $(row) : $(row).find(c.linkSelector).first();
    const title = text($, row, c.titleSelector), url = resolve(link.attr('href'), base, source);
    return title && url ? [makeBook(source, url, title, { author: text($, row, c.authorSelector), summary: text($, row, c.summarySelector), coverURL: c.coverSelector ? image($, row, c.coverSelector, base, source) : undefined })] : [];
  });
  if (rows.length && !books.length) throw new ServiceError('来源搜索结构已变化，暂时无法解析书目。');
  return unique(books);
}
function searchURL(query: string, source: SourceDefinition) {
  const c = source.html!, bytes = iconv.encode(query, c.encoding ?? 'utf8');
  const encoded = [...bytes].map(n => /[A-Za-z0-9._~-]/.test(String.fromCharCode(n)) ? String.fromCharCode(n) : `%${n.toString(16).padStart(2, '0').toUpperCase()}`).join('');
  return new URL(c.searchURL.replace('{query}', encoded), source.homeURL);
}
const textbookAliases: Record<string, string> = { '统计': 'statistics', '统计学': 'statistics', '数学': 'math', '微积分': 'calculus', '物理': 'physics', '化学': 'chemistry', '生物': 'biology', '经济': 'economics', '经济学': 'economics', '心理学': 'psychology', '心理': 'psychology', '金融': 'finance', '会计': 'accounting', '社会学': 'sociology', '计算机': 'computer', '商业': 'business' };
const literatureAliases: Record<string, string> = { '托尔斯泰': 'Tolstoy', '战争与和平': 'War and Peace', '傲慢与偏见': 'Pride and Prejudice', '莎士比亚': 'Shakespeare', '狄更斯': 'Dickens', '福尔摩斯': 'Sherlock Holmes' };
const wikiURL = (title: string, source: SourceDefinition) => new URL('/wiki/' + title.replace(/ /g, '_'), source.homeURL).href;
const wikiTitle = (url: string) => { const parsed = new URL(url); return parsed.pathname.startsWith('/wiki/') ? decodeURIComponent(parsed.pathname.slice(6)).replace(/_/g, ' ') : parsed.searchParams.get('title') ?? ''; };
async function wikiRequest(source: SourceDefinition, params: Record<string, string>) {
  const url = new URL(source.apiURL!); for (const [key, value] of Object.entries({ ...params, format: 'json', formatversion: '2', utf8: '1' })) url.searchParams.set(key, value);
  const response = await fetchBuffer(url, source); const result = JSON.parse(response.data.toString('utf8'));
  if (result.error) throw new ServiceError(result.error.info ?? '维基文库请求失败。'); return result;
}
export async function searchSource(query: string, source: SourceDefinition): Promise<Book[]> {
  return cached(`search|${source.id}|${query}`, 120_000, async () => {
    if (source.kind === 'staticCatalog') return (source.catalogBooks ?? []).filter(b => normalize(b.title + b.author).includes(normalize(query))).map(b => makeBook(source, b.directoryURL, b.title, { author: b.author, summary: b.summary }));
    if (source.kind === 'mediaWiki') {
      const term = query.replace(/[《》〈〉「」『』"\\]/g, '').trim();
      const result = await wikiRequest(source, { action: 'query', list: 'search', srsearch: `intitle:"${toTraditional(term)}"`, srnamespace: '0', srlimit: '20', srprop: 'snippet' });
      if (!result.query?.search) throw new ServiceError('维基文库返回了无效的搜索响应。');
      return unique((result.query.search as any[]).filter(item => normalize(item.title).includes(normalize(term)) && !/[/:]/.test(item.title) && !/消歧[义義]|判[决決]书|裁定书|人民法院|人民[检檢]察院/.test(toSimplified(item.title))).map(item => makeBook(source, wikiURL(item.title, source), item.title, { summary: clean(cheerio.load(item.snippet ?? '').text()) }))).sort((a, b) => (normalize(a.title) === normalize(term) ? -1 : 0) - (normalize(b.title) === normalize(term) ? -1 : 0) || a.title.length - b.title.length);
    }
    if (source.kind === 'html') { const result = await page(searchURL(query, source), source); return parseHTMLSearch(result.html, result.url, source); }
    if (source.kind === 'openStax') {
      const result = await cached('openstax-catalog', 3_600_000, async () => {
        const url = new URL('/apps/cms/api/v2/pages/', source.homeURL);
        for (const [k, v] of Object.entries({ type: 'books.Book', fields: 'title,description,pdf_url,cover_url,book_state,authors,require_login_message_text', limit: '200' })) url.searchParams.set(k, v);
        const response = await fetchBuffer(url, source); return JSON.parse(response.data.toString('utf8'));
      });
      if (!Array.isArray(result.items)) throw new ServiceError('教材书目响应无效。');
      const term = (textbookAliases[query] ?? query).toLowerCase();
      return result.items.flatMap((item: any) => {
        const file = resolve(item.pdf_url, source.homeURL, source), url = resolve(item.meta?.html_url, source.homeURL, source);
        const description = clean(cheerio.load(item.description ?? '').text()); const author = (item.authors ?? []).map((a: any) => a.value?.name).filter(Boolean).join(', ');
        if (item.book_state !== 'live' || item.require_login_message_text || !file || !url || !(item.title + ' ' + description + ' ' + author).toLowerCase().includes(term)) return [];
        return [makeBook(source, url, item.title, { author: author || 'OpenStax', summary: description, coverURL: resolve(item.cover_url, source.homeURL, source), publicationFormat: 'pdf', fileDownloadURL: file })];
      });
    }
    const url = new URL(source.kind === 'gutenberg' ? '/ebooks/search/' : '/ebooks', source.homeURL);
    url.searchParams.set('query', source.kind === 'gutenberg' ? toTraditional(query) : literatureAliases[query] ?? query);
    const result = await page(url, source), $ = cheerio.load(result.html);
    return unique($(source.kind === 'gutenberg' ? 'li.booklink' : "li[typeof='schema:Book']").toArray().flatMap(row => {
      const isGutenberg = source.kind === 'gutenberg', title = text($, row, isGutenberg ? '.title' : "p > a [property='schema:name']");
      const target = resolve($(row).find(isGutenberg ? 'a.link[href]' : "p > a[property='schema:url']").first().attr('href'), result.url, source);
      return title && target ? [makeBook(source, target, title, { author: text($, row, isGutenberg ? '.subtitle' : '.author'), coverURL: image($, row, 'img', result.url, source), publicationFormat: 'epub' })] : [];
    }));
  });
}
export async function search(query: string, sourceIDs?: string[], onUpdate?: (result: SearchResponse) => void): Promise<SearchResponse> {
  const enabled = sources.filter(s => !sourceIDs || sourceIDs.includes(s.id));
  const completed = new Map<string, { books: Book[]; error?: string }>();
  const snapshot = (): SearchResponse => ({ books: unique(enabled.flatMap(s => completed.get(s.id)?.books ?? [])), failures: enabled.flatMap(s => completed.get(s.id)?.error ? [{ sourceID: s.id, sourceName: s.name, message: completed.get(s.id)!.error! }] : []) });
  await Promise.all(enabled.map(async source => { try { completed.set(source.id, { books: await searchSource(query, source) }); } catch (error) { completed.set(source.id, { books: [], error: userError(error) }); } onUpdate?.(snapshot()); }));
  return snapshot();
}
export function userError(error: unknown): string {
  if (error instanceof ServiceError) return error.message;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '无法解析来源地址，请检查网络或稍后重试。';
  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'SELF_SIGNED_CERT_IN_CHAIN') return '来源 TLS 证书校验失败，未继续连接。';
  if ((error as Error)?.name === 'AbortError') return '请求已取消。';
  return '来源请求或解析失败，请稍后重试。';
}

export function parseParagraphs(html: string, selector: string, removing: string[] = []): string[] {
  const $ = cheerio.load(html); $('script,style,noscript,iframe,' + (removing.join(',') || 'qingread-unused')).remove();
  const roots = $(selector).toArray().filter(node => !$(node).parents().toArray().some(parent => $(parent).is(selector)));
  const blocks = new Set(['p', 'div', 'section', 'article', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'tr', 'pre']);
  const render = (node: any): string => { if (node.type === 'text') return node.data; if (node.name === 'br') return '\n'; const children = (node.children ?? []).map(render).join(''); return blocks.has(node.name) ? '\n' + children + '\n' : children; };
  const paragraphs = roots.map(render).join('\n').split(/[\r\n]+/).map(s => s.replace(/\u00a0/g, ' ').trim()).filter(Boolean);
  if (!paragraphs.length) throw new ServiceError('没有读到正文，来源可能暂时不可用或已更改页面。');
  return paragraphs;
}
function parseChapters(html: string, base: URL, source: SourceDefinition): Chapter[] {
  const $ = cheerio.load(html), links = $(source.html!.chapterSelector).toArray();
  const result = unique(links.flatMap(element => {
    const anchor = $(element).is('a') ? $(element) : $(element).find('a[href]').first();
    const url = resolve(anchor.attr('href'), base, source), title = clean(anchor.text());
    return url && title ? [{ id: url, title, url, index: 0 }] : [];
  })).map((item, index) => ({ ...item, index }));
  if (!result.length) throw new ServiceError('没有找到章节目录，来源可能已更改页面。'); return result;
}
async function wikiPage(title: string, source: SourceDefinition) { const result = await wikiRequest(source, { action: 'parse', page: title, prop: 'text', redirects: '1', disableeditsection: '1' }); if (!result.parse?.text) throw new ServiceError('维基页面不存在或没有正文。'); return result.parse as { title: string; text: string }; }
export async function chapters(value: unknown): Promise<Chapter[]> {
  const { book, source } = validatedBook(value);
  return cached(`chapters|${book.id}`, 5 * 60_000, async () => {
    if (['gutenberg', 'standardEbooks', 'openStax'].includes(source.kind)) throw new ServiceError('这本书以整本文件提供，请先下载到本机。', 400);
    if (source.kind === 'staticCatalog') {
      if (!(source.catalogBooks ?? []).some(b => new URL(b.directoryURL).href === new URL(book.url).href)) throw new ServiceError('未登记的静态图书。', 400);
      const response = await fetchBuffer(new URL('info.json', book.url), source), catalog = JSON.parse(response.data.toString('utf8'));
      if (!Array.isArray(catalog.catalogues) || !catalog.catalogues.length) throw new ServiceError('静态目录为空。');
      return catalog.catalogues.map((title: string, index: number) => { const url = new URL(`${index}.html`, book.url).href; return { id: url, title, index, url }; });
    }
    if (source.kind === 'mediaWiki') {
      const result = await wikiPage(wikiTitle(book.url), source), $ = cheerio.load(result.text);
      $('#headerContainer,.ws-header,.noprint,.catlinks,#licenseContainer,.ws-footer').remove();
      const list = unique($('a[href]').toArray().flatMap(anchor => {
        const url = resolve($(anchor).attr('href'), source.homeURL, source), title = clean($(anchor).parent().is('li') ? $(anchor).parent().text() : $(anchor).text());
        return url && wikiTitle(url).startsWith(result.title + '/') && !$(anchor).hasClass('new') && title ? [{ id: url, title, url, index: 0 }] : [];
      })).map((item, index) => ({ ...item, index }));
      return list.length ? list : [{ id: book.url, title: result.title, url: book.url, index: 0 }];
    }
    const result = await page(book.url, source);
    if (source.html!.catalogLinkSelector) {
      const $ = cheerio.load(result.html), url = resolve($(source.html!.catalogLinkSelector).first().attr('href'), result.url, source);
      if (!url) throw new ServiceError('没有找到完整目录链接。');
      if (url !== result.url.href) { const catalog = await page(url, source, book.url); return parseChapters(catalog.html, catalog.url, source); }
    }
    return parseChapters(result.html, result.url, source);
  });
}
export async function content(value: unknown, chapterValue: unknown): Promise<ChapterContent> {
  const { book, source } = validatedBook(value), chapter = chapterValue as Chapter;
  if (!chapter || typeof chapter.url !== 'string' || chapter.url.length > 3000 || typeof chapter.title !== 'string' || chapter.title.length > 2000 || !Number.isInteger(chapter.index) || chapter.index < 0 || chapter.index > 100_000) throw new ServiceError('章节信息无效。', 400);
  validateSourceURL(chapter.url, source.id);
  // Match the known catalog, so clients cannot use the content endpoint to proxy unrelated pages.
  const catalog = await chapters(book); const canonical = catalog.find(item => item.url === chapter.url);
  if (!canonical) throw new ServiceError('该章节不在这本书的目录中。', 400);
  return cached(`content|${source.id}|${canonical.url}`, 30 * 60_000, async () => {
    if (source.kind === 'mediaWiki') {
      const result = await wikiPage(wikiTitle(canonical.url), source);
      return { chapter: canonical, paragraphs: parseParagraphs(result.text, '.mw-parser-output', ['#headerContainer', '#header', '#footer', '.ws-header', '.ws-footer', '.noprint', '.mw-editsection', '.catlinks', '#licenseContainer', '.licensetpl', '.navigation-not-searchable', '.sistersitebox', '.ws-noexport', '.printfooter', '.reference', '.references', '.variant-tooltip']) };
    }
    const result = await page(canonical.url, source, book.url);
    return { chapter: canonical, paragraphs: parseParagraphs(result.html, source.html?.contentSelector ?? 'body', source.html?.removeSelectors) };
  });
}
function discoveryRows(html: string, source: SourceDefinition, recommendedOnly = false): DiscoverySection[] {
  const $ = cheerio.load(html);
  const featured = unique($('.layout-col2 .item').toArray().flatMap(row => { const anchor = $(row).find('dt a[href]').first(), url = resolve(anchor.attr('href'), source.homeURL, source); return url && clean(anchor.text()) ? [makeBook(source, url, anchor.text(), { author: text($, row, 'dt span'), summary: text($, row, 'dd'), coverURL: image($, row, '.image img', source.homeURL, source) })] : []; }));
  const rows = recommendedOnly ? $('.layout-col1').first().find('.txt-list li') : $('.txt-list li');
  const classic = unique(rows.toArray().flatMap(row => { const anchor = $(row).find('.s2 a[href]').first(), url = resolve(anchor.attr('href'), source.homeURL, source); return url && clean(anchor.text()) ? [makeBook(source, url, anchor.text(), { author: text($, row, '.s4') || text($, row, '.s5') })] : []; }));
  return [{ id: 'featured', title: '热门推荐', books: featured }, { id: 'classic', title: '经典推荐', books: classic }].filter(s => s.books.length);
}
/** Completion is taken from an explicit final-chapter label, never a book title. */
export function completedRows(html: string, source: SourceDefinition): Book[] {
  const $ = cheerio.load(html);
  return unique($('.txt-list li').toArray().flatMap(row => {
    const finalChapter = text($, row, '.s3');
    if (!/全书完|完结感言|完结随笔|[（(]完结[）)]/.test(finalChapter)) return [];
    const anchor = $(row).find('.s2 a[href]').first();
    const url = resolve(anchor.attr('href'), source.homeURL, source);
    return url && clean(anchor.text()) ? [makeBook(source, url, anchor.text(), {author:text($, row, '.s4')})] : [];
  }));
}
async function discoveryWithin(load:Promise<Book[]>,ms=3000):Promise<Book[]>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([load.catch(()=>[]),new Promise<Book[]>(resolve=>{timer=setTimeout(()=>resolve([]),ms);timer.unref?.();})]);}finally{clearTimeout(timer);}}
export async function recommendations(): Promise<{ sections: DiscoverySection[] }> {
  return cached('recommendations', 60_000, async () => {
    const classics=await searchSource('',sourceFor('chinese-classics'));
    const [novels,textbooks]=await Promise.all([discoveryWithin((async()=>{const source=sourceFor('biequgei'),result=await page(source.homeURL,source);return discoveryRows(result.html,source,true).flatMap(section=>section.books);})()),discoveryWithin(searchSource('',sourceFor('openstax')))]);
    const sections:DiscoverySection[]=[{id:'literature',title:'古典文学精选',books:classics}];
    if(textbooks.length)sections.push({id:'textbooks',title:'开放大学教材',books:textbooks.slice(0,12)});
    if(novels.length)sections.push({id:'novels',title:'网络小说推荐',books:unique(novels).slice(0,24)});
    return{sections};
  });
}

export async function category(id: string): Promise<Book[]> {
  if(id==='literature')return searchSource('',sourceFor('chinese-classics'));
  if(id==='textbooks')return (await searchSource('',sourceFor('openstax'))).slice(0,100);
  if(id==='completed')return cached('completed-books',60_000,async()=>{
    const classics=await searchSource('',sourceFor('chinese-classics'));
    const novels=await discoveryWithin(cached('completed-novels',60*60_000,async()=>{
      const source=sourceFor('biequgei'),result=await page(new URL('/all.html',source.homeURL),source);
      return completedRows(result.html,source);
    }));
    return unique([...novels,...classics]);
  });
  if (!categories.some(c => c.id === id)) throw new ServiceError('不存在这个分类。', 404);
  return cached(`category|${id}`, 10 * 60_000, async () => {
    const source = sourceFor('biequgei'), result = await page(new URL(`/lists/${id}.html`, source.homeURL), source), books = unique(discoveryRows(result.html, source).flatMap(s => s.books));
    if (!books.length) throw new ServiceError('暂时没有获取到分类书目，请稍后重试。'); return books;
  });
}
export async function coverFor(value: unknown): Promise<string | undefined> {
  const { book, source } = validatedBook(value);
  if (book.coverURL) { const valid = resolve(book.coverURL, book.url, source); if (valid) return valid; }
  return cached(`cover|${book.id}`, 60 * 60_000, async () => {
    const result = await page(book.url, source), $ = cheerio.load(result.html);
    for (const selector of ['meta[property="og:image"]', 'meta[name="og:image"]', 'meta[property="og:novel:image"]', 'meta[name="twitter:image"]']) {
      const url = resolve($(selector).attr('content'), result.url, source); if (url) return url;
    }
    for (const selector of ['#fmimg img', '.book-cover img', '.book-img img', '.book-info .cover img', '.book-info .image img', '.cover img', "img[src*='/files/article/image/']"]) { const url = image($, $.root()[0], selector, result.url, source); if (url) return url; }
    return undefined;
  });
}
export async function downloadURL(value: unknown): Promise<{ url: string; book: Book; source: SourceDefinition }> {
  const { book, source } = validatedBook(value);
  if (!['gutenberg', 'standardEbooks', 'openStax'].includes(source.kind)) throw new ServiceError('这个书源提供分章阅读，不提供整本文件。', 400);
  if (source.kind === 'openStax') {
    // Never trust a caller-provided PDF URL. Confirm it against the publisher catalog.
    const catalog = await searchSource('', source), canonical = catalog.find(item => item.url === book.url);
    if (!canonical?.fileDownloadURL) throw new ServiceError('这本教材没有可公开下载的 PDF。', 404);
    return { url: canonical.fileDownloadURL, book: canonical, source };
  }
  const result = await page(book.url, source), $ = cheerio.load(result.html);
  for (const link of $("a[type='application/epub+zip'],a[href*='.epub']").toArray()) {
    const href = $(link).attr('href'); if (!href || href.includes('advanced')) continue;
    let url = resolve(href, result.url, source); if (!url) continue;
    if (source.kind === 'standardEbooks') {
      const landing = await fetchStream(url, source.id, { maxBytes: MAX_DOWNLOAD });
      const chunks: Buffer[] = []; let size = 0, isEPUB = false;
      try {
        for await (const chunk of landing.stream) {
          const bytes = Buffer.from(chunk); chunks.push(bytes); size += bytes.length;
          if (size >= 2 && Buffer.concat(chunks).subarray(0, 2).equals(Buffer.from('PK'))) { isEPUB = true; break; }
          if (size > 1024 * 1024) throw new ServiceError('来源下载页面过大，无法解析。');
        }
      } finally { landing.stream.destroy(); }
      if (!isEPUB) {
        const doc = cheerio.load(Buffer.concat(chunks).toString('utf8')), refresh = doc('meta[http-equiv="refresh"]').attr('content') ?? '';
        url = resolve(refresh.match(/url\s*=\s*['"]?(.+?)['"]?$/i)?.[1], landing.url, source);
        if (!url || !new URL(url).pathname.endsWith('.epub')) throw new ServiceError('来源没有返回有效的 EPUB 下载地址。');
      }
    }
    return { url, book: { ...book, publicationFormat: 'epub' }, source };
  }
  throw new ServiceError('来源没有返回可以直接下载的 EPUB。');
}

/** An author page lists only works whose returned attribution actually matches. */
export async function authorBooks(name:string):Promise<{author:string;books:Book[]}>{
  name=name.normalize('NFKC').trim();if(!name||name.length>100)throw new ServiceError('作者名无效。',400);
  const local=(await searchSource(name,sourceFor('chinese-classics'))).filter(book=>normalize(book.author).includes(normalize(name)));
  if(local.length)return{author:name,books:local};
  const result=await search(name,['biequgei','gutenberg','standard-ebooks']);
  return{author:name,books:unique([...local,...result.books.filter(book=>normalize(book.author).includes(normalize(name)))])};
}
