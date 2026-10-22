import { DatabaseSync } from 'node:sqlite';
import { createHash, createECDH, ECDH } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import dns from 'node:dns/promises';
import https from 'node:https';
import webPush from 'web-push';
import type { FastifyInstance } from 'fastify';
import type { Book, Chapter } from '../src/shared/types.js';
import type { CloudUser } from '../src/shared/sync.js';
import type { CloudDatabase } from './cloud.js';
import { chapters as sourceChapters } from './reading.js';
import { isPublicIP, ServiceError } from './network.js';

const hour = 3_600_000;
const limits = { books: 20, devices: 5, subscriptions: 200, tickMs: 60_000, checkMs: hour, notifyMs: hour };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const sourceKey = (book: Book) => digest(book.sourceID + '\0' + book.url);
const chapterBook = (book: Book) => !book.publicationFormat && !book.fileDownloadURL && !book.sourceID.startsWith('local') && !book.sourceID.startsWith('sample');
const normalized = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const message = JSON.stringify({ title: '清读', body: '书架有新章节，打开查看。', tag: 'qingread-updates' });

interface SubscriptionRow { endpoint_hash: string; user_id: string; session_hash: string; value: string; expires: number; next_send: number; failures: number }
interface WatchRow { user_id: string; book_id: string; source_key: string; last_id: string; last_title: string; initialized: number; next_check: number; failures: number; pending: number }
export interface VapidConfiguration { subject: string; publicKey: string; privateKey: string }
export interface PushAccountAccess {
  books(user: CloudUser): Book[];
  validSession(userID: string, sessionHash: string): boolean;
  close?(): void;
}
interface PushOptions {
  vapid: VapidConfiguration;
  accounts: PushAccountAccess;
  loadChapters?: (book: Book) => Promise<Chapter[]>;
  send?: (subscription: webPush.PushSubscription, payload: string) => Promise<number>;
  now?: () => number;
}

/** Restrict user-provided endpoints before any DNS lookup or outbound request. */
export function pushEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length > 3000) throw new ServiceError('通知订阅地址无效。', 400);
  let url: URL; try { url = new URL(value); } catch { throw new ServiceError('通知订阅地址无效。', 400); }
  const host = url.hostname.toLowerCase();
  const allowed = ['fcm.googleapis.com', 'updates.push.services.mozilla.com'].includes(host)
    || host === 'web.push.apple.com' || host.endsWith('.push.apple.com') || host.endsWith('.notify.windows.com');
  if (!allowed || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.pathname === '/') throw new ServiceError('不支持这个通知服务。', 400);
  return url.href;
}
function subscription(value: unknown): webPush.PushSubscription & { expirationTime?: number | null } {
  if (!value || typeof value !== 'object') throw new ServiceError('通知订阅数据无效。', 400);
  const raw = value as Record<string, unknown>, keys = raw.keys as Record<string, unknown> | undefined;
  if (!keys || typeof keys.p256dh !== 'string' || !/^[\w-]{87}$/.test(keys.p256dh)
    || typeof keys.auth !== 'string' || !/^[\w-]{22}$/.test(keys.auth)) throw new ServiceError('通知订阅密钥无效。', 400);
  const publicKey = Buffer.from(keys.p256dh, 'base64url');
  try { ECDH.convertKey(publicKey, 'prime256v1'); }
  catch { throw new ServiceError('通知订阅密钥无效。', 400); }
  const expiration = raw.expirationTime;
  if (expiration !== undefined && expiration !== null && (typeof expiration !== 'number' || !Number.isSafeInteger(expiration) || expiration <= Date.now())) throw new ServiceError('通知订阅已过期。', 400);
  return { endpoint: pushEndpoint(raw.endpoint), keys: { p256dh: keys.p256dh, auth: keys.auth }, expirationTime: expiration as number | null | undefined };
}

// Kept separate so the transport never follows redirects and has an absolute
// deadline as well as a socket deadline. No telemetry or third-party SDK runs.
export async function sendWebPush(value: webPush.PushSubscription, payload: string, vapid: VapidConfiguration): Promise<number> {
  const url = new URL(pushEndpoint(value.endpoint));
  const signal = AbortSignal.timeout(12_000);
  const records = await Promise.race([
    dns.lookup(url.hostname, { all: true }),
    new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Push DNS timeout')), { once: true })),
  ]);
  if (!records.length || records.some(record => !isPublicIP(record.address))) throw new ServiceError('通知地址解析到了不允许访问的网络。', 400);
  const address = records.find(record => record.family === 4) ?? records[0];
  const details = webPush.generateRequestDetails(value, payload, { vapidDetails: vapid, TTL: 3600, urgency: 'low', topic: 'qingread-updates' });
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: details.method, headers: details.headers, signal,
      lookup: ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => options.all
        ? callback(null, [address]) : callback(null, address.address, address.family)) as never,
    }, response => {
      let bytes = 0;
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 8192) response.destroy(new Error('Push response too large')); });
      response.once('error', reject);
      response.once('end', () => resolve(response.statusCode ?? 502));
    });
    request.setTimeout(8000, () => request.destroy(new Error('Push timeout')));
    request.once('error', reject); request.end(details.body);
  });
}

export class WebPushService {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly loadChapters: (book: Book) => Promise<Chapter[]>;
  private readonly send: (value: webPush.PushSubscription, payload: string) => Promise<number>;
  private timer?: ReturnType<typeof setInterval>;
  private work?: Promise<void>;
  private nextTick = 0;
  private closed = false;
  readonly publicKey: string;
  constructor(path: string, private readonly options: PushOptions) {
    // Validate the configured pair before creating a worker or subscriptions.
    webPush.getVapidHeaders('https://web.push.apple.com', options.vapid.subject, options.vapid.publicKey, options.vapid.privateKey, 'aes128gcm');
    const keyPair = createECDH('prime256v1'); keyPair.setPrivateKey(Buffer.from(options.vapid.privateKey, 'base64url'));
    if (keyPair.getPublicKey().toString('base64url') !== options.vapid.publicKey) throw new Error('VAPID keys do not form a pair.');
    this.publicKey = options.vapid.publicKey;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS push_subscriptions(endpoint_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,session_hash TEXT NOT NULL,value TEXT NOT NULL,expires INTEGER NOT NULL,next_send INTEGER NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS push_subscription_owner ON push_subscriptions(user_id);
      CREATE TABLE IF NOT EXISTS push_watches(user_id TEXT NOT NULL,book_id TEXT NOT NULL,source_key TEXT NOT NULL,last_id TEXT NOT NULL DEFAULT '',last_title TEXT NOT NULL DEFAULT '',initialized INTEGER NOT NULL DEFAULT 0,next_check INTEGER NOT NULL,failures INTEGER NOT NULL DEFAULT 0,pending INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(user_id,book_id));
      CREATE INDEX IF NOT EXISTS push_watch_due ON push_watches(next_check);
      CREATE TABLE IF NOT EXISTS push_delivery(user_id TEXT PRIMARY KEY,last_sent INTEGER NOT NULL DEFAULT 0);`);
    this.now = options.now ?? Date.now;
    this.loadChapters = options.loadChapters ?? sourceChapters;
    this.send = options.send ?? ((value, payload) => sendWebPush(value, payload, options.vapid));
  }
  configuration() { return { enabled: true, publicKey: this.publicKey, maxBooks: limits.books, intervalMinutes: 60 }; }
  status(user: CloudUser) {
    this.prune();
    return { ...this.configuration(), devices: Number(this.db.prepare('SELECT count(*) AS n FROM push_subscriptions WHERE user_id=?').get(user.id)?.n ?? 0),
      subscriptionIDs: (this.db.prepare('SELECT endpoint_hash FROM push_subscriptions WHERE user_id=?').all(user.id) as { endpoint_hash: string }[]).map(row => row.endpoint_hash),
      bookIDs: (this.db.prepare('SELECT book_id FROM push_watches WHERE user_id=? ORDER BY book_id').all(user.id) as { book_id: string }[]).map(row => row.book_id) };
  }
  subscribe(user: CloudUser, authorization: string, value: unknown) {
    this.prune();
    const parsed = subscription(value), key = digest(parsed.endpoint);
    const existing = this.db.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint_hash=?').get(key);
    if (existing && existing.user_id !== user.id) throw new ServiceError('此浏览器通知已关联其他账号，请先关闭原订阅。', 409);
    if (!existing && (Number(this.db.prepare('SELECT count(*) AS n FROM push_subscriptions WHERE user_id=?').get(user.id)?.n) >= limits.devices
      || Number(this.db.prepare('SELECT count(*) AS n FROM push_subscriptions').get()?.n) >= limits.subscriptions)) throw new ServiceError('通知订阅数量已达到上限。', 413);
    this.db.prepare('INSERT INTO push_subscriptions(endpoint_hash,user_id,session_hash,value,expires) VALUES(?,?,?,?,?) ON CONFLICT(endpoint_hash) DO UPDATE SET session_hash=excluded.session_hash,value=excluded.value,expires=excluded.expires,failures=0,next_send=0')
      .run(key, user.id, digest(authorization.slice(7)), JSON.stringify(parsed), parsed.expirationTime ?? this.now() + 30 * 24 * hour);
    return this.status(user);
  }
  unsubscribe(user: CloudUser, endpoint: unknown) {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint_hash=? AND user_id=?').run(digest(pushEndpoint(endpoint)), user.id);
    this.prune(); return this.status(user);
  }
  watch(user: CloudUser, bookIDs: unknown) {
    if (!Array.isArray(bookIDs) || bookIDs.length > limits.books || bookIDs.some(id => typeof id !== 'string' || !id || id.length > 8192) || new Set(bookIDs).size !== bookIDs.length) throw new ServiceError('最多选择 20 本追更图书。', 400);
    this.prune();
    if (!this.db.prepare('SELECT 1 FROM push_subscriptions WHERE user_id=? LIMIT 1').get(user.id)) throw new ServiceError('请先在此设备开启通知。', 409);
    const owned = this.options.accounts.books(user);
    const selected = bookIDs.map(id => owned.find(book => book.id === id && chapterBook(book)));
    if (selected.some(book => !book)) throw new ServiceError('请先同步所选图书到自己的书架。', 400);
    this.db.exec('BEGIN');
    try {
      for (const row of this.db.prepare('SELECT book_id FROM push_watches WHERE user_id=?').all(user.id) as { book_id: string }[]) if (!bookIDs.includes(row.book_id)) this.db.prepare('DELETE FROM push_watches WHERE user_id=? AND book_id=?').run(user.id, row.book_id);
      selected.forEach(book => {
        const source = sourceKey(book!);
        const previous = this.db.prepare('SELECT source_key FROM push_watches WHERE user_id=? AND book_id=?').get(user.id, book!.id);
        if (previous?.source_key === source) return;
        this.db.prepare('INSERT OR REPLACE INTO push_watches(user_id,book_id,source_key,next_check) VALUES(?,?,?,?)').run(user.id, book!.id, source, this.now());
      });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.status(user);
  }
  private prune() {
    for (const row of this.db.prepare('SELECT * FROM push_subscriptions').all() as unknown as SubscriptionRow[]) if (row.expires <= this.now() || !this.options.accounts.validSession(row.user_id, row.session_hash)) this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint_hash=?').run(row.endpoint_hash);
    this.db.exec('DELETE FROM push_watches WHERE user_id NOT IN (SELECT user_id FROM push_subscriptions); DELETE FROM push_delivery WHERE user_id NOT IN (SELECT user_id FROM push_subscriptions);');
  }
  start() { if (!this.timer && !this.closed) { this.timer = setInterval(() => { void this.tick(); }, limits.tickMs); this.timer.unref(); } }
  tick(): Promise<void> {
    if (this.closed || this.work || this.now() < this.nextTick) return this.work ?? Promise.resolve();
    this.nextTick = this.now() + limits.tickMs;
    this.work = this.run().catch(() => { /* Transient worker failures never interrupt reading requests. */ }).finally(() => { this.work = undefined; });
    return this.work;
  }
  private async run() {
    this.prune();
    const row = this.db.prepare('SELECT * FROM push_watches WHERE next_check<=? ORDER BY next_check LIMIT 1').get(this.now()) as unknown as WatchRow | undefined;
    if (row) {
      const user = { id: row.user_id, username: '' }, book = this.options.accounts.books(user).find(book => book.id === row.book_id && chapterBook(book));
      if (!book) this.db.prepare('DELETE FROM push_watches WHERE user_id=? AND book_id=?').run(row.user_id, row.book_id);
      else {
        try {
          const chapters = await this.loadChapters(book);
          if (!chapters.length) throw new Error('Empty catalog');
          this.prune();
          const current = this.db.prepare('SELECT source_key FROM push_watches WHERE user_id=? AND book_id=?').get(row.user_id, row.book_id);
          const latest = this.options.accounts.books(user).find(value => value.id === row.book_id);
          if (!current || !latest || sourceKey(latest) !== sourceKey(book)) return;
          const ids = chapters.flatMap((chapter, index) => chapter.id === row.last_id ? [index] : []);
          const titles = chapters.flatMap((chapter, index) => normalized(chapter.title) === row.last_title ? [index] : []);
          const anchor = ids.length === 1 ? ids[0] : row.last_title && titles.length === 1 ? titles[0] : -1;
          const changed = row.initialized && row.source_key === sourceKey(book) && anchor >= 0 && anchor < chapters.length - 1;
          const tail = chapters[chapters.length - 1];
          this.db.prepare('UPDATE push_watches SET source_key=?,last_id=?,last_title=?,initialized=1,next_check=?,failures=0,pending=? WHERE user_id=? AND book_id=?')
            .run(sourceKey(book), tail.id, normalized(tail.title), this.now() + limits.checkMs, changed || row.source_key === sourceKey(book) && row.pending ? 1 : 0, row.user_id, row.book_id);
        } catch {
          this.db.prepare('UPDATE push_watches SET failures=failures+1,next_check=? WHERE user_id=? AND book_id=?')
            .run(this.now() + Math.min(24 * hour, hour * 2 ** Math.min(row.failures, 5)), row.user_id, row.book_id);
        }
      }
    }
    const pending = this.db.prepare('SELECT user_id FROM push_watches WHERE pending=1 AND user_id NOT IN (SELECT user_id FROM push_delivery WHERE last_sent>?) LIMIT 1').get(this.now() - limits.notifyMs) as { user_id: string } | undefined;
    if (!pending) return;
    // The reader may remove a book or switch sources between a failed delivery
    // and its retry. Do not send a reminder for that superseded shelf state.
    const currentBooks = this.options.accounts.books({ id: pending.user_id, username: '' });
    for (const watch of this.db.prepare('SELECT * FROM push_watches WHERE user_id=? AND pending=1').all(pending.user_id) as unknown as WatchRow[]) {
      const book = currentBooks.find(value => value.id === watch.book_id && chapterBook(value));
      if (!book) this.db.prepare('DELETE FROM push_watches WHERE user_id=? AND book_id=?').run(watch.user_id, watch.book_id);
      else if (watch.source_key !== sourceKey(book)) this.db.prepare('UPDATE push_watches SET pending=0,initialized=0,source_key=?,next_check=? WHERE user_id=? AND book_id=?').run(sourceKey(book), this.now(), watch.user_id, watch.book_id);
    }
    if (!this.db.prepare('SELECT 1 FROM push_watches WHERE user_id=? AND pending=1 LIMIT 1').get(pending.user_id)) return;
    const endpoints = this.db.prepare('SELECT * FROM push_subscriptions WHERE user_id=? AND next_send<=? LIMIT ?').all(pending.user_id, this.now(), limits.devices) as unknown as SubscriptionRow[];
    let delivered = false;
    for (const row of endpoints) {
      if (this.closed || !this.options.accounts.validSession(row.user_id, row.session_hash)) { this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint_hash=?').run(row.endpoint_hash); continue; }
      try {
        const status = await this.send(JSON.parse(row.value), message);
        if (status === 404 || status === 410) this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint_hash=?').run(row.endpoint_hash);
        else if (status >= 200 && status < 300) { delivered = true; this.db.prepare('UPDATE push_subscriptions SET failures=0,next_send=? WHERE endpoint_hash=?').run(this.now() + limits.notifyMs, row.endpoint_hash); }
        else throw new Error('Push delivery failed');
      } catch {
        this.db.prepare('UPDATE push_subscriptions SET failures=failures+1,next_send=? WHERE endpoint_hash=?')
          .run(this.now() + Math.min(24 * hour, 15 * 60_000 * 2 ** Math.min(row.failures, 7)), row.endpoint_hash);
      }
    }
    if (delivered) {
      this.db.prepare('INSERT INTO push_delivery VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET last_sent=excluded.last_sent').run(pending.user_id, this.now());
      this.db.prepare('UPDATE push_watches SET pending=0 WHERE user_id=?').run(pending.user_id);
    }
    this.prune();
  }
  async close() { this.closed = true; if (this.timer) clearInterval(this.timer); await this.work; this.db.close(); this.options.accounts.close?.(); }
}

export function createWebPushFromEnvironment(): WebPushService | undefined {
  if (process.env.QINGREAD_WEB_PUSH_ENABLED !== 'true') return undefined;
  const publicKey = process.env.QINGREAD_VAPID_PUBLIC_KEY, privateKey = process.env.QINGREAD_VAPID_PRIVATE_KEY, subject = process.env.QINGREAD_VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) throw new Error('Web Push requires private VAPID configuration.');
  const root = process.env.QINGREAD_DATA_DIR ?? '.data';
  const accounts = new DatabaseSync(join(root, 'accounts.sqlite'), { readOnly: true });
  try {
    return new WebPushService(join(root, 'notifications.sqlite'), { vapid: { publicKey, privateKey, subject }, accounts: {
      books: user => (accounts.prepare('SELECT entry FROM shelf WHERE user_id=? AND entry IS NOT NULL').all(user.id) as { entry: string }[]).map(row => (JSON.parse(row.entry) as { book: Book }).book),
      validSession: (userID, hash) => Boolean(accounts.prepare('SELECT 1 FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.hash=? AND users.id=? AND sessions.expires>?').get(hash, userID, Date.now())),
      close: () => accounts.close(),
    } });
  } catch (error) { accounts.close(); throw error; }
}

export function registerWebPushRoutes(app: FastifyInstance, cloud: CloudDatabase, push?: WebPushService) {
  const enabled = () => { if (!push) throw new ServiceError('服务器尚未开启推送。', 503); return push; };
  const config = { bodyLimit: 16 * 1024, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
  app.get('/api/push/config', async () => push?.configuration() ?? { enabled: false, publicKey: '', maxBooks: limits.books, intervalMinutes: 60 });
  app.get('/api/push/status', async request => enabled().status(cloud.authorize(request.headers.authorization)));
  app.post<{ Body: { subscription?: unknown } }>('/api/push/subscribe', config, async request => enabled().subscribe(cloud.authorize(request.headers.authorization), String(request.headers.authorization), request.body?.subscription));
  app.post<{ Body: { endpoint?: unknown } }>('/api/push/unsubscribe', config, async request => enabled().unsubscribe(cloud.authorize(request.headers.authorization), request.body?.endpoint));
  app.post<{ Body: { bookIDs?: unknown } }>('/api/push/books', config, async request => enabled().watch(cloud.authorize(request.headers.authorization), request.body?.bookIDs));
  app.addHook('onReady', async () => { push?.start(); });
  app.addHook('onClose', async () => { await push?.close(); });
}
