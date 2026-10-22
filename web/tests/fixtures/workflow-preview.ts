/**
 * Local interaction fixture only; never include this server in a deployment.
 * It serves an existing web/dist build, uses fictional books and sources, and
 * neither reads account data nor makes upstream requests.
 *
 * From web/: node --import tsx tests/fixtures/workflow-preview.ts
 * Open http://127.0.0.1:8791/ and search for 山间来信 or 顾清.
 * POST /__test/append {} adds chapter 3 to both sources. An optional sourceID
 * limits the update to one source; repeated calls do not add more chapters.
 * POST /__test/fail {"sourceID":"preview-b","chapter":2,"fail":true}
 * makes that 1-based chapter fail; use fail:false to restore it.
 * POST /__test/reset {} restores the initial two chapters and clears failures.
 * GET /__test shows the current fixture state. All changes stay in memory.
 */
import Fastify from 'fastify';
import serveStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { Book, Chapter, ChapterContent, SearchResponse, SourceDefinition } from '../../src/shared/types.js';

const host = '127.0.0.1';
const port = Number(process.env.QINGREAD_PREVIEW_PORT || 8791);
const sourceIDs = ['preview-a', 'preview-b'] as const;
type PreviewSourceID = typeof sourceIDs[number];
const titles = ['第一章 山路初晴', '第二章 林间来信', '第三章 远处灯火'];
const sources: SourceDefinition[] = sourceIDs.map((id, index) => ({
  id, name: `预览书源 ${index ? 'B' : 'A'}`, summary: '仅用于本地交互测试的虚构书源',
  homeURL: `https://${id}.invalid`, kind: 'html',
}));
const books: Book[] = sources.map(source => ({
  id: `${source.id}|${source.homeURL}/book`, title: '山间来信', author: '顾清',
  summary: '一封来自山间的信，让年轻的旅人重新踏上熟悉的小路。本地测试原创占位故事。',
  sourceID: source.id, sourceName: source.name, url: `${source.homeURL}/book`,
}));

function isSourceID(value: unknown): value is PreviewSourceID {
  return sourceIDs.some(id => id === value);
}
function fixtureError(message: string, statusCode = 400): Error {
  return Object.assign(new Error(message), { statusCode });
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fixtureError('请提供 JSON 对象。');
  return value as Record<string, unknown>;
}
function sourceBook(value: unknown): Book {
  const book = object(value);
  const fixture = books.find(candidate => candidate.sourceID === book.sourceID && candidate.url === book.url);
  if (!fixture) throw fixtureError('仅支持本地虚构图书。');
  return fixture;
}

export async function createWorkflowPreview() {
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });
  const chapterCounts: Record<PreviewSourceID, number> = { 'preview-a': 2, 'preview-b': 2 };
  const failures = new Set<string>();
  const chaptersFor = (book: Book): Chapter[] => titles.slice(0, chapterCounts[book.sourceID as PreviewSourceID]).map((title, index) => ({
    id: `${book.url}/chapter/${index + 1}`, title, url: `${book.url}/chapter/${index + 1}`, index,
  }));
  const snapshot = () => ({ localFixture: true, chapterCounts: { ...chapterCounts }, failures: [...failures].sort() });

  app.addHook('onRequest', async (request, reply) => {
    // Binding is fixed below; Host/Origin checks also reject DNS rebinding and
    // unrelated websites attempting to alter the local fixture controls.
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip)
      || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host || '')
      || (request.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(request.headers.origin))) {
      return reply.code(403).send({ message: '此预览服务仅允许本机访问。' });
    }
    reply.header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store')
      .header('Content-Security-Policy', "connect-src 'self'");
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = (error as { statusCode?: number }).statusCode;
    reply.code(status && status >= 400 && status <= 599 ? status : 500)
      .send({ message: error instanceof Error ? error.message : '本地测试失败。' });
  });

  app.get('/api/health', async () => ({
    ok: true, version: '0.9.0-preview', sources: sources.length,
    requiresToken: false, syncEnabled: false, filesEnabled: false, localFixture: true,
  }));
  app.get('/api/sources', async () => sources);
  const search = (value: unknown): SearchResponse => {
    const body = object(value);
    if (typeof body.query !== 'string' || !body.query.trim()) throw fixtureError('请输入书名或作者。');
    if (body.sourceIDs !== undefined && (!Array.isArray(body.sourceIDs) || !body.sourceIDs.every(isSourceID))) throw fixtureError('书源不存在。');
    const selected = Array.isArray(body.sourceIDs) ? body.sourceIDs : sourceIDs;
    const query = body.query.trim();
    return {
      books: books.filter(book => selected.includes(book.sourceID as PreviewSourceID) && `${book.title} ${book.author}`.includes(query)),
      failures: [],
    };
  };
  app.post('/api/search', async request => search(request.body));
  app.post('/api/search/stream', async (request, reply) => {
    const result = search(request.body);
    return reply.type('application/x-ndjson; charset=utf-8').send(JSON.stringify(result) + '\n');
  });
  app.post('/api/chapters', async request => chaptersFor(sourceBook(object(request.body).book)));
  app.post('/api/content', async request => {
    const body = object(request.body), book = sourceBook(body.book), supplied = object(body.chapter);
    const chapter = chaptersFor(book).find(candidate => candidate.id === supplied.id && candidate.url === supplied.url);
    if (!chapter) throw fixtureError('测试章节不存在。', 404);
    await delay(500);
    if (failures.has(`${book.sourceID}:${chapter.index + 1}`)) throw fixtureError('测试：此章节暂时无法下载。', 503);
    const paragraphs = Array.from({ length: 72 }, (_, index) => {
      const scenes = [
        '晨雾散开时，山路边的草叶还挂着细小的水珠。顾清把信放进口袋，沿着石阶慢慢向前走。远处有人打开木窗，屋檐下的风铃轻轻响了一声。',
        '小溪绕过村口的老树，带走了昨夜落下的几片叶子。她想起信中写到的那座桥，也想起多年前和朋友一起在桥边等雨停的午后。那些普通的日子，此刻忽然有了清晰的轮廓。',
        '路旁的茶铺升起薄薄的热气，老人把一杯温茶推到桌边。两个人都没有急着说话，只听见水壶里细密的声音。等风吹散门前的雾，山那边的田野便一点点显露出来。',
        '太阳照到信纸折痕的时候，她终于读懂了最后一句话。所谓远方，有时只是需要再次出发的一个理由。她收好行囊，向身后的人挥了挥手，继续走向下一段路。',
      ];
      return `（${chapter.index + 1}－${index + 1}）${scenes[index % scenes.length]}`;
    });
    return { chapter, paragraphs } satisfies ChapterContent;
  });

  // Supporting discovery/cover routes keep the real UI entirely self-contained.
  app.get('/api/recommendations', async () => ({ sections: [{ id: 'preview', title: '本地预览', books: [books[0]] }] }));
  app.get('/api/categories', async () => [{ id: 'preview', title: '文学' }]);
  app.get('/api/categories/:id', async () => [books[0]]);
  app.get('/api/cover', async (_request, reply) => reply.code(404).send({ message: '测试图书使用本地默认封面。' }));
  app.post('/api/cover-metadata', async () => ({ url: null }));

  app.get('/__test', async () => snapshot());
  app.post('/__test/append', async request => {
    const body = request.body === undefined ? {} : object(request.body);
    if (body.sourceID !== undefined && !isSourceID(body.sourceID)) throw fixtureError('测试书源不存在。');
    for (const id of body.sourceID ? [body.sourceID as PreviewSourceID] : sourceIDs) chapterCounts[id] = 3;
    return snapshot();
  });
  app.post('/__test/fail', async request => {
    const body = object(request.body);
    if (!isSourceID(body.sourceID) || !Number.isInteger(body.chapter) || Number(body.chapter) < 1 || Number(body.chapter) > titles.length
      || (body.fail !== undefined && typeof body.fail !== 'boolean')) throw fixtureError('请提供 sourceID、chapter（1–3）和可选的 fail 布尔值。');
    const key = `${body.sourceID}:${body.chapter}`;
    if (body.fail === false) failures.delete(key); else failures.add(key);
    return snapshot();
  });
  app.post('/__test/reset', async () => {
    sourceIDs.forEach(id => { chapterCounts[id] = 2; });
    failures.clear();
    return snapshot();
  });

  const dist = fileURLToPath(new URL('../../dist', import.meta.url));
  if (!existsSync(resolve(dist, 'index.html'))) throw new Error('请先在 web/ 执行 npm run build（默认根路径构建）。');
  await app.register(serveStatic, { root: dist });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await createWorkflowPreview();
  await app.listen({ host, port });
  console.log(`QingRead fictional workflow preview: http://${host}:${port}/`);
  const stop = async () => { await app.close(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
