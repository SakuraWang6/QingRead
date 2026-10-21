import Fastify, { type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import serveStatic from '@fastify/static';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve as filePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchBuffer, fetchStream, MAX_DOWNLOAD, ServiceError, validateSourceURL } from './network.js';
import { sources, categories, sourceFor, search, chapters, content, recommendations, category, coverFor, downloadURL, userError } from './reading.js';
import { registerCloudRoutes, type CloudDatabase } from './cloud.js';
import { registerFileRoutes, type CloudFiles } from './files.js';
import { CoverCache } from './cover-cache.js';
import { join } from 'node:path';

// Fastify decodes static route segments (e.g. /%61pi/sources). Use the
// matched route as the authority, so encoded paths cannot bypass auth/quotas.
function isAPIRequest(request: FastifyRequest): boolean {
  return Boolean(request.routeOptions.url?.startsWith('/api/') || request.url.startsWith('/api/'));
}

function tokenMatches(value: unknown, expected: string): boolean {
  if (typeof value !== 'string') return false;
  const a = Buffer.from(value), b = Buffer.from(expected); return a.length === b.length && timingSafeEqual(a, b);
}
export async function createApp(options: { token?: string; origins?: string[]; serveWeb?: boolean; webRoot?: string; cloud?: CloudDatabase; files?: CloudFiles } = {}) {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, requestTimeout: 660_000, connectionTimeout: 65_000, trustProxy: false });
  // PWA installation fetches hundreds of static assets; only API traffic consumes quota.
  await app.register(rateLimit, { max: 180, timeWindow: '1 minute', allowList: request => !isAPIRequest(request) });
  const token = options.token ?? process.env.QINGREAD_ACCESS_TOKEN ?? '';
  const origins = options.origins ?? (process.env.QINGREAD_ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
    const origin = request.headers.origin;
    const ownOrigin = `${request.protocol}://${request.headers.host}`;
    const allowed = !origin || origin === ownOrigin || origins.includes(origin) || ['capacitor://localhost', 'https://localhost', 'http://localhost'].includes(origin);
    if (isAPIRequest(request) && !allowed) return reply.code(403).send({ message: '这个网页来源未被服务器允许。' });
    if (origin && allowed) reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin');
    if (request.method === 'OPTIONS') return reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS').header('Access-Control-Allow-Headers', 'Content-Type,X-QingRead-Token,Authorization').header('Access-Control-Max-Age', '600').code(204).send();
    const cloudRoute = request.routeOptions.url?.startsWith('/api/auth/') || request.routeOptions.url === '/api/sync' || request.routeOptions.url?.startsWith('/api/files');
    if (cloudRoute) reply.header('Cache-Control', 'no-store');
    if (isAPIRequest(request) && !cloudRoute && request.routeOptions.url !== '/api/health' && token && !tokenMatches(request.headers['x-qingread-token'], token)) {
      // Images cannot carry custom headers: authenticated covers use the fetch endpoint via api.cover().
      return reply.code(401).send({ message: '服务器访问令牌无效，请在设置中更新。' });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode;
    const status = error instanceof ServiceError ? error.statusCode : (statusCode && statusCode < 500 ? statusCode : 502);
    reply.code(status).send({ message: error instanceof ServiceError ? error.message : statusCode === 429 ? '请求太频繁，请稍后再试。' : statusCode === 400 ? '请求参数无效。' : userError(error) });
  });
  const objectSchema = { type: 'object', required: ['book'], properties: { book: { type: 'object' }, chapter: { type: 'object' } }, additionalProperties: false } as const;
  const searchSchema = { type: 'object', required: ['query'], properties: { query: { type: 'string', minLength: 1, maxLength: 100 }, sourceIDs: { type: 'array', maxItems: 10, uniqueItems: true, items: { type: 'string', maxLength: 80 } } }, additionalProperties: false } as const;
  app.get('/api/health', async () => ({ ok: true, version: '0.8.1', sources: sources.length, requiresToken: Boolean(token), syncEnabled: Boolean(options.cloud), filesEnabled: Boolean(options.files) }));
  if (options.cloud) registerCloudRoutes(app, options.cloud);
  if (options.cloud && options.files) registerFileRoutes(app,options.cloud,options.files);
  app.get('/api/sources', async () => sources);
  app.post<{ Body: { query: string; sourceIDs?: string[] } }>('/api/search', { schema: { body: searchSchema } }, async request => {
    if (request.body.sourceIDs?.some(id => !sources.some(s => s.id === id))) throw new ServiceError('请求包含未登记书源。', 400);
    return search(request.body.query.trim(), request.body.sourceIDs);
  });
  app.post<{ Body: { query: string; sourceIDs?: string[] } }>('/api/search/stream', { schema: { body: searchSchema } }, async (request, reply) => {
    if (request.body.sourceIDs?.some(id => !sources.some(s => s.id === id))) throw new ServiceError('请求包含未登记书源。', 400);
    reply.raw.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...(request.headers.origin ? { 'Access-Control-Allow-Origin': request.headers.origin, Vary: 'Origin' } : {}) });
    reply.hijack();
    await search(request.body.query.trim(), request.body.sourceIDs, result => { if (!reply.raw.destroyed) reply.raw.write(JSON.stringify(result) + '\n'); });
    reply.raw.end();
  });
  app.post<{ Body: { book: unknown } }>('/api/chapters', { schema: { body: objectSchema } }, request => chapters(request.body.book));
  app.post<{ Body: { book: unknown; chapter: unknown } }>('/api/content', { schema: { body: { ...objectSchema, required: ['book', 'chapter'] } } }, request => content(request.body.book, request.body.chapter));
  app.get('/api/recommendations', () => recommendations());
  app.get('/api/categories', async () => categories);
  app.get<{ Params: { id: string } }>('/api/categories/:id', request => category(request.params.id));
  const coverCache = new CoverCache(process.env.QINGREAD_DATA_DIR?join(process.env.QINGREAD_DATA_DIR,'covers'):undefined);
  app.get<{ Querystring: { sourceID: string; bookURL: string; url?: string } }>('/api/cover', { schema: { querystring: { type: 'object', required: ['sourceID', 'bookURL'], properties: { sourceID: { type: 'string', maxLength: 80 }, bookURL: { type: 'string', maxLength: 3000 }, url: { type: 'string', maxLength: 3000 } }, additionalProperties: false } } }, async (request, reply) => {
    const source = sourceFor(request.query.sourceID), bookURL = request.query.bookURL;
    validateSourceURL(bookURL, source.id);
    if (request.query.url) validateSourceURL(request.query.url, source.id);
    const key = `${source.id}|${bookURL}|${request.query.url??''}`;
    const started=performance.now();
    const {image:cover,cache}=await coverCache.get(key,async()=>{
      const url = await coverFor({ sourceID: source.id, url: bookURL, title: '', coverURL: request.query.url });
      if (!url) throw new ServiceError('这本书暂时没有可用封面。', 404);
      const result = await fetchBuffer(url, source, { referer: bookURL, maxBytes: 5 * 1024 * 1024 });
      // SVG/HTML never get reflected as active content. Only raster image bytes.
      const bytes = result.data;
      const type = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? 'image/jpeg' : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png' : bytes.subarray(0, 6).toString().startsWith('GIF8') ? 'image/gif' : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : '';
      if (!type) throw new ServiceError('来源封面不是支持的图片格式。', 404);
      return {bytes,type};
    });
    reply.header('X-QingRead-Cover-Cache',cache).header('Server-Timing',`cover;dur=${(performance.now()-started).toFixed(1)}`);
    reply.type(cover.type).header('Cache-Control', token ? 'private, max-age=86400' : 'public, max-age=86400'); return cover.bytes;
  });
  app.post<{ Body: { book: unknown } }>('/api/cover-metadata', { schema: { body: objectSchema } }, async request => ({ url: await coverFor(request.body.book) ?? null }));
  app.post<{ Body: { book: unknown } }>('/api/download', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } }, schema: { body: objectSchema } }, async (request, reply) => {
    const { url, book, source } = await downloadURL(request.body.book);
    const controller = new AbortController();
    const result = await fetchStream(url, source.id, { maxBytes: MAX_DOWNLOAD, referer: book.url, timeout: 30_000, totalTimeout: 600_000, signal: controller.signal });
    const type = book.publicationFormat === 'pdf' ? 'application/pdf' : 'application/epub+zip';
    // Validate magic before sending headers. A source challenge must not become a saved book.
    const iterator = result.stream[Symbol.asyncIterator](); const prefixChunks: Buffer[] = []; let prefixSize = 0;
    while (prefixSize < 8) { const next = await iterator.next(); if (next.done) break; const chunk = Buffer.from(next.value); prefixChunks.push(chunk); prefixSize += chunk.length; }
    const prefix = Buffer.concat(prefixChunks);
    if (book.publicationFormat === 'pdf' ? prefix.subarray(0, 5).toString() !== '%PDF-' : !prefix.subarray(0, 2).equals(Buffer.from('PK'))) { result.stream.destroy(); throw new ServiceError('来源返回的不是有效图书文件。'); }
    const { Readable } = await import('node:stream');
    const stream = Readable.from((async function* () { try { yield prefix; for (;;) { const next = await iterator.next(); if (next.done) break; yield next.value; } } finally { result.stream.destroy(); } })());
    reply.raw.on('close', () => controller.abort());
    reply.type(type).header('Content-Disposition', `attachment; filename="book.${book.publicationFormat ?? 'epub'}"; filename*=UTF-8''${encodeURIComponent(book.title)}.${book.publicationFormat ?? 'epub'}`).header('Cache-Control', 'no-store');
    return reply.send(stream);
  });
  const dist = options.webRoot ?? filePath(fileURLToPath(new URL('../dist', import.meta.url)));
  if (options.serveWeb !== false && existsSync(dist)) {
    await app.register(serveStatic, { root: dist });
    app.setNotFoundHandler((request, reply) => {
      if (isAPIRequest(request)) return reply.code(404).send({ message: '接口不存在。' });
      let pathname: string;
      try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
      catch { return reply.code(404).send({ message: '文件不存在。' }); }
      // Stale PWA/HTML bundles must get a real 404 for missing assets. Returning
      // index.html here disguises a deleted PDF worker as a successful script.
      if (/^\/(?:assets|pdfjs)(?:\/|$)/.test(pathname) || /\.[^/]+$/.test(pathname)) {
        return reply.code(404).send({ message: '文件不存在。' });
      }
      return reply.sendFile('index.html');
    });
  }
  return app;
}
