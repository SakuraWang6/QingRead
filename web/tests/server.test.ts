import { afterAll, describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app';
import { isPublicIP, validateSourceURL, limitStream } from '../server/network';
import { decodePage, parseHTMLSearch, parseParagraphs, sources, searchSource, sourceFor } from '../server/reading';

const app = await createApp({ serveWeb: false, token: '' });
const secured = await createApp({ serveWeb: false, token: 'test-secret' });
afterAll(async () => { await app.close(); await secured.close(); });

describe('known-source network boundary', () => {
  it('blocks private, reserved, mapped and documentation IPs', () => {
    for (const address of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','198.18.0.1','100.64.0.2','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1']) expect(isPublicIP(address), address).toBe(false);
    expect(isPublicIP('1.1.1.1')).toBe(true); expect(isPublicIP('2606:4700:4700::1111')).toBe(true);
  });
  it('restricts HTTPS hosts, credentials, ports and static repository paths', () => {
    for (const url of ['http://www.biequgei.com/','https://127.0.0.1/','https://evil.example/','https://www.biequgei.com.evil.example/','https://user:pass@www.biequgei.com/','https://www.biequgei.com:8080/']) expect(() => validateSourceURL(url, 'biequgei')).toThrow();
    expect(() => validateSourceURL('https://raw.githubusercontent.com/another/repo/file','chinese-classics')).toThrow();
    expect(validateSourceURL('https://www.biequgei.com/book/123/#x','biequgei').hash).toBe('');
  });
  it('enforces streamed size limits before forwarding an oversized chunk', async () => {
    const limited = limitStream(Readable.from([Buffer.alloc(8), Buffer.alloc(8)]), 10);
    const consume = async () => { for await (const _chunk of limited) { /* consume */ } };
    await expect(consume()).rejects.toThrow('超出允许大小');
  });
  it('excludes PWA static requests from the API quota while still limiting APIs', async () => {
    const isolated = await createApp({ serveWeb: false, token: '' });
    isolated.get('/assets/precache-test.bin', async () => 'static');
    try {
      for (let index = 0; index < 220; index += 1) {
        expect((await isolated.inject('/assets/precache-test.bin')).statusCode).toBe(200);
      }
      for (let index = 0; index < 180; index += 1) {
        expect((await isolated.inject(index % 2 ? '/%61pi/health' : '/api/health')).statusCode).toBe(200);
      }
      expect((await isolated.inject('/api/health')).statusCode).toBe(429);
    } finally { await isolated.close(); }
  });
  it('checks access tokens and explicit CORS origins', async () => {
    expect((await secured.inject('/api/sources')).statusCode).toBe(401);
    expect((await secured.inject({url:'/api/sources',headers:{'x-qingread-token':'test-secret'}})).statusCode).toBe(200);
    expect((await app.inject({url:'/api/sources',headers:{origin:'https://evil.example'}})).statusCode).toBe(403);
    const android = await app.inject({url:'/api/sources',headers:{origin:'https://localhost'}});
    expect(android.headers['access-control-allow-origin']).toBe('https://localhost');
    expect((await app.inject('/api/health')).json().ok).toBe(true);
  });
  it('uses the matched API route for encoded-path authentication and CORS', async () => {
    expect((await secured.inject('/%61pi/sources')).statusCode).toBe(401);
    expect((await secured.inject({url:'/%61pi/sources',headers:{'x-qingread-token':'test-secret'}})).statusCode).toBe(200);
    expect((await app.inject({url:'/%61pi/sources',headers:{origin:'https://evil.example'}})).statusCode).toBe(403);
  });
  it('rejects arbitrary book URLs, unknown sources and search abuse before network', async () => {
    for (const book of [{sourceID:'biequgei',url:'https://127.0.0.1/',title:'x'},{sourceID:'unknown',url:'https://www.biequgei.com/',title:'x'}]) {
      const result = await app.inject({method:'POST',url:'/api/chapters',payload:{book}}); expect(result.statusCode).toBe(400);
    }
    expect((await app.inject({method:'POST',url:'/api/search',payload:{query:'x',sourceIDs:['unknown']}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:'/api/search',payload:{query:'x'.repeat(101)}})).statusCode).toBe(400);
  });
  it('accepts the full registered source list as the catalog grows', async () => {
    const isolated = await createApp({ serveWeb: false, token: '' });
    // Stop after request validation so this schema regression never contacts sources.
    isolated.addHook('preHandler', async (_request, reply) => reply.send({ validated: true }));
    try {
      for (const url of ['/api/search', '/api/search/stream']) {
        const accepted = await isolated.inject({ method: 'POST', url, payload: { query: '示例', sourceIDs: sources.map(source => source.id) } });
        expect(accepted.statusCode).toBe(200);
        expect(accepted.json()).toEqual({ validated: true });
        const rejected = await isolated.inject({ method: 'POST', url, payload: { query: '示例', sourceIDs: Array.from({ length: sources.length + 1 }, (_, index) => `source-${index}`) } });
        expect(rejected.statusCode).toBe(400);
      }
    } finally { await isolated.close(); }
  });
});
describe('source parsing', () => {
  it('returns real 404s for stale PWA/PDF assets while retaining SPA routes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qingread-static-test-'));
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'index.html'), '<main>reader-app</main>');
    await writeFile(join(root, 'assets', 'current.mjs'), 'export const ready=true;');
    const staticApp = await createApp({ token: '', serveWeb: true, webRoot: root });
    try {
      for (const path of ['/assets/deleted-worker.mjs', '/pdfjs/cmaps/missing.bcmap', '/sw.js', '/missing.js', '/manifest.webmanifest']) {
        const response = await staticApp.inject(path);
        expect(response.statusCode, path).toBe(404);
        expect(response.body).not.toContain('reader-app');
      }
      expect((await staticApp.inject('/assets/current.mjs')).statusCode).toBe(200);
      const page = await staticApp.inject('/reader/book');
      expect(page.statusCode).toBe(200); expect(page.body).toContain('reader-app');
      expect((await staticApp.inject('/api/not-found')).statusCode).toBe(404);
    } finally { await staticApp.close(); await rm(root, {recursive:true, force:true}); }
  });
  it('includes foreign literature and supports classical simplified/traditional lookup', async () => {
    expect(sources).toHaveLength(11);
    const result = await searchSource('紅樓夢',sourceFor('chinese-classics'));
    expect(result[0].title).toBe('红楼梦'); expect(result[0].id).toContain('chinese-classics|');
  });
  it('parses a book link that is itself the search result without inventing metadata', () => {
    const source = sourceFor('bailushuyuan');
    const html = '<main><a class="col-6" title="示例文学" href="/sample-book"><div class="text-truncate">示例文学</div></a><a href="/novel/traditional/authors/1">作者分类</a></main>';
    const books = parseHTMLSearch(html, source.homeURL, source);
    expect(books).toHaveLength(1);
    expect(books[0]).toMatchObject({ title: '示例文学', author: '', url: 'https://bailushuyuan.org/sample-book', sourceID: 'bailushuyuan' });
    expect(books[0].coverURL).toBeUndefined();
    expect(() => parseHTMLSearch(html.replace('/sample-book', 'https://evil.example/book'), source.homeURL, source)).toThrow();
    expect(() => validateSourceURL('https://bailushuyuan.org.evil.example/book', source.id)).toThrow();
  });
  it('decodes declared GB18030 and searches using canonical links', () => {
    const html='<meta charset="gb2312"><ul class="txt-list"><li><span class="s2"><a href="/book/9/">超神机械师</a></span><span class="s4">齐佩甲</span></li></ul>';
    const decoded=decodePage(iconv.encode(html,'gb18030')); const books=parseHTMLSearch(decoded,'https://www.biequgei.com/',sourceFor('biequgei'));
    expect(books[0].title).toBe('超神机械师'); expect(books[0].author).toBe('齐佩甲'); expect(books[0].url).toBe('https://www.biequgei.com/book/9/');
  });
  it('does not reflect off-source search links or image placeholders', () => {
    const html='<div class="result-card"><a class="book-title" href="https://evil.example/book">恶意</a></div>';
    expect(()=>parseHTMLSearch(html,'https://www.biquge.tw/',sourceFor('biquge-tw'))).toThrow();
  });
  it('preserves paragraph boundaries while removing scripts and reader chrome', () => {
    expect(parseParagraphs('<div class="read-content">第一行<br>第二行<p>第三段</p><script>alert(1)</script><div class="ad">广告</div></div>','.read-content',['.ad'])).toEqual(['第一行','第二行','第三段']);
    expect(parseParagraphs('<body><div>导航</div>第一段<br>第二段<script>bad</script></body>','body',['body > :not(br)'])).toEqual(['第一段','第二段']);
  });
  it('refuses file download for a chapter source and arbitrary cover targets', async () => {
    const download = await app.inject({method:'POST',url:'/api/download',payload:{book:{sourceID:'biequgei',url:'https://www.biequgei.com/novel/53.html',title:'book',fileDownloadURL:'https://127.0.0.1/private'}}});
    expect(download.statusCode).toBe(400);
    expect((await app.inject('/api/cover?sourceID=biequgei&bookURL=https%3A%2F%2F127.0.0.1%2F')).statusCode).toBe(400);
    expect((await app.inject('/api/cover?sourceID=biequgei&bookURL=https%3A%2F%2Fwww.biequgei.com%2Fnovel%2F53.html&url=https%3A%2F%2F127.0.0.1%2Fsecret')).statusCode).toBe(400);
  });
  it('returns NDJSON cumulative search results for local catalogs', async () => {
    const result=await app.inject({method:'POST',url:'/api/search/stream',payload:{query:'西游记',sourceIDs:['chinese-classics']}});
    expect(result.statusCode).toBe(200); expect(result.headers['content-type']).toContain('application/x-ndjson');
    const rows=result.body.trim().split('\n').map(row=>JSON.parse(row)); expect(rows.at(-1).books[0].title).toBe('西游记');
  });
  it('rejects chapter browsing for file books and unregistered static works', async () => {
    const result=await app.inject({method:'POST',url:'/api/chapters',payload:{book:{sourceID:'gutenberg',url:'https://www.gutenberg.org/ebooks/1',title:'Book'}}});
    expect(result.statusCode).toBe(400); expect(result.json().message).toContain('整本');
    const other=await app.inject({method:'POST',url:'/api/chapters',payload:{book:{sourceID:'chinese-classics',url:'https://raw.githubusercontent.com/luoxuhai/chinese-novel/master/resources/not-a-book/',title:'x'}}});
    expect(other.statusCode).toBe(400);
  });
});
