import type { FastifyInstance } from 'fastify';
import type { Book, Chapter, ChapterContent } from '../src/shared/types.js';
import { content, validatedBook, userError } from './reading.js';
import { ServiceError, validateSourceURL } from './network.js';

export interface OfflineBatch { contents: ChapterContent[]; failures: { chapterID: string; message: string }[] }
let activeBatches = 0;
const waiting:{start:()=>void;timer:ReturnType<typeof setTimeout>}[]=[];
const MAX_BYTES = 5 * 1024 * 1024 - 64 * 1024;
async function acquireBatch():Promise<()=>void>{
  const release=()=>{const next=waiting.shift();if(next){clearTimeout(next.timer);next.start();}else activeBatches--;};
  if(activeBatches<2){activeBatches++;return release;}
  if(waiting.length>=16)throw new ServiceError('后台下载正忙，请稍后重试。',429);
  await new Promise<void>((resolve,reject)=>{
    const item={start:resolve,timer:setTimeout(()=>{const index=waiting.indexOf(item);if(index>=0)waiting.splice(index,1);reject(new ServiceError('后台下载排队较多，请稍后重试。',429));},60_000)};
    item.timer.unref?.();waiting.push(item);
  });return release;
}

export function parseOfflineBatch(payload: unknown): { book: Book; chapters: Chapter[] } {
  if (typeof payload !== 'string' || payload.length > 12_000 || !/^[A-Za-z0-9_-]+$/.test(payload)) throw new ServiceError('下载批次无效。', 400);
  let value: { book?: unknown; chapters?: unknown };
  try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new ServiceError('下载批次无效。', 400); }
  if (!value || typeof value !== 'object') throw new ServiceError('下载批次无效。',400);
  const { book } = validatedBook(value.book);
  if (!Array.isArray(value.chapters) || !value.chapters.length || value.chapters.length > 10) throw new ServiceError('每批最多下载 10 章。', 400);
  const seen = new Set<string>();
  const chapters = value.chapters.map((raw: unknown) => {
    const c = raw as Chapter;
    if (!c || typeof c.id !== 'string' || !c.id || c.id.length > 8192 || typeof c.title !== 'string' || c.title.length > 500 || !Number.isSafeInteger(c.index) || c.index < 0 || typeof c.url !== 'string' || c.url.length > 4000 || seen.has(c.id)) throw new ServiceError('下载章节无效。', 400);
    validateSourceURL(c.url, book.sourceID); seen.add(c.id);
    return { id: c.id, title: c.title, index: c.index, url: c.url };
  });
  return { book, chapters };
}

export async function offlineBatch(book: Book, chapters: Chapter[], load = content): Promise<OfflineBatch> {
  const release=await acquireBatch();
  const result: OfflineBatch = { contents: [], failures: [] }; let bytes = 0;
  try {
    for (const chapter of chapters) {
      try {
        const value = await load(book, chapter);
        const size = Buffer.byteLength(JSON.stringify(value));
        if (bytes + size > MAX_BYTES) throw new ServiceError('本批正文过大，请缩小下载范围。', 413);
        bytes += size; result.contents.push(value);
      } catch (error) { result.failures.push({ chapterID: chapter.id, message: userError(error) }); }
    }
    return result;
  } finally { release(); }
}

export function registerOfflineRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { payload: string } }>('/api/offline/chapters', {
    config: { rateLimit: { max: 24, timeWindow: '1 minute' } },
    schema: { querystring: { type: 'object', required: ['payload'], properties: { payload: { type: 'string', maxLength: 12_000 } }, additionalProperties: false } },
  }, async (request, reply) => {
    const batch = parseOfflineBatch(request.query.payload);
    reply.header('Cache-Control', 'no-store').header('Content-Type', 'application/json; charset=utf-8');
    try{return await offlineBatch(batch.book, batch.chapters);}catch(error){if(error instanceof ServiceError&&error.statusCode===429)reply.header('Retry-After','60');throw error;}
  });
}
