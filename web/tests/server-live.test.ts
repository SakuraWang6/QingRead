/** Optional real-source smoke test: QINGREAD_LIVE_TESTS=1 npm test -- tests/server-live.test.ts */
import { describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { searchSource, sourceFor, chapters, content, downloadURL, recommendations, category } from '../server/reading';
import { fetchBuffer, fetchStream } from '../server/network';

describe.skipIf(process.env.QINGREAD_LIVE_TESTS !== '1')('real built-in sources', () => {
  it('reads both requested novels through their real chapter catalogs', async () => {
    for (const query of ['超神机械师', '这游戏也太真实了']) {
      const books = await searchSource(query, sourceFor('biequgei')); expect(books[0].title).toBe(query);
      const catalog = await chapters(books[0]); expect(catalog.length).toBeGreaterThan(100);
      const chapter = await content(books[0], catalog[0]); expect(chapter.paragraphs.join('').length).toBeGreaterThan(500);
    }
  }, 180_000);
  it('downloads a real Gutenberg EPUB through the authenticated HTTP endpoint', async () => {
    const book = (await searchSource('红楼梦', sourceFor('gutenberg')))[0]; expect(book.publicationFormat).toBe('epub');
    const app = await createApp({ token: 'live-smoke', serveWeb: false });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/download', headers: { 'x-qingread-token': 'live-smoke' }, payload: { book } });
      expect(response.statusCode).toBe(200); expect(response.headers['content-type']).toContain('application/epub+zip');
      expect(response.rawPayload.subarray(0, 2).toString()).toBe('PK'); expect(response.rawPayload.length).toBeGreaterThan(100_000);
    } finally { await app.close(); }
  }, 180_000);
  it('uses actual recommendations, category, GBK, static classics and Wikisource', async () => {
    expect((await recommendations()).sections[0].books.length).toBeGreaterThan(0);
    expect((await category('6')).length).toBeGreaterThan(0);
    for (const [id, query] of [['piaotia', '超神机械师'], ['chinese-classics', '红楼梦'], ['zh-wikisource', '桃花源记']]) {
      const book = (await searchSource(query, sourceFor(id)))[0]; expect(book).toBeDefined();
      const catalog = await chapters(book); const chapter = await content(book, catalog[0]); expect(chapter.paragraphs.length).toBeGreaterThan(0);
    }
  }, 180_000);
  it('resolves Standard Ebooks and publisher-verified OpenStax PDFs', async () => {
    const standard = (await searchSource('傲慢与偏见', sourceFor('standard-ebooks')))[0]; const epub = await downloadURL(standard);
    const file = await fetchBuffer(epub.url, epub.source, { maxBytes: 20 * 1024 * 1024 }); expect(file.data.subarray(0, 2).toString()).toBe('PK');
    const books = await searchSource('统计', sourceFor('openstax')); expect(books.length).toBeGreaterThan(0);
    const pdf = await downloadURL({ ...books[0], fileDownloadURL: 'https://127.0.0.1/not-trusted' });
    expect(pdf.url).toContain('https://assets.openstax.org/');
    const response = await fetchStream(pdf.url, pdf.source.id, { maxBytes: 250 * 1024 * 1024 });
    try { const first = await response.stream[Symbol.asyncIterator]().next(); expect(Buffer.from(first.value).subarray(0, 5).toString()).toBe('%PDF-'); } finally { response.stream.destroy(); }
  }, 180_000);
});
