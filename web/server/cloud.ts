import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ShelfEntry } from '../src/shared/types.js';
import { anchorFormat, newestPosition, type CloudUser, type CloudSession, type CloudRecord, type CloudSnapshot } from '../src/shared/sync.js';
import { parseMutations } from './cloud-schema.js';
import { ServiceError } from './network.js';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const sessionLife = 30 * 24 * 60 * 60_000;
const hashPassword = (password: string, salt: string): Promise<Buffer> => new Promise((resolve, reject) => {
  scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, hash) => error ? reject(error) : resolve(hash));
});
function credentials(body: unknown) {
  const b = body as Record<string, unknown>;
  if (!b || typeof b !== 'object' || Object.keys(b).some(key => !['username', 'password'].includes(key)) || typeof b.username !== 'string' || typeof b.password !== 'string') throw new ServiceError('请填写用户名和密码。', 400);
  const username = b.username.normalize('NFKC').trim();
  if (!/^[\p{L}\p{N}_-]{2,32}$/u.test(username)) throw new ServiceError('用户名需为 2–32 个字母、汉字、数字、下划线或短横线。', 400);
  if (b.password.length < 10 || b.password.length > 128) throw new ServiceError('密码需为 10–128 个字符。', 400);
  return { username, normalized: username.toLowerCase(), password: b.password };
}
interface StoredRow { entry: string | null; revision: number; changed_at: string; membership_at: string }

export class CloudDatabase {
  private db: DatabaseSync;
  private hashing = false;
  constructor(path: string, private maxUsers = 100) {
    if (path !== ':memory:') { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); }
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT NOT NULL, normalized TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_owner ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS shelf(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, book_id TEXT NOT NULL, entry TEXT, revision INTEGER NOT NULL, changed_at TEXT NOT NULL, membership_at TEXT NOT NULL, PRIMARY KEY(user_id,book_id));
      CREATE INDEX IF NOT EXISTS shelf_changes ON shelf(user_id,revision);
      CREATE TABLE IF NOT EXISTS receipts(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, operation_id TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(user_id,operation_id));
      CREATE INDEX IF NOT EXISTS receipt_age ON receipts(user_id,created);`);
  }
  close() { this.db.close(); }
  private session(user: CloudUser): CloudSession {
    const token = randomBytes(32).toString('base64url'), now = Date.now();
    this.db.prepare('DELETE FROM sessions WHERE expires<?').run(now);
    this.db.prepare('DELETE FROM sessions WHERE user_id=? AND hash NOT IN (SELECT hash FROM sessions WHERE user_id=? ORDER BY created DESC LIMIT 9)').run(user.id, user.id);
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(digest(token), user.id, now + sessionLife, now);
    return { user, token, expiresAt: new Date(now + sessionLife).toISOString(), serverTime: new Date(now).toISOString() };
  }
  async authenticate(body: unknown, register: boolean): Promise<CloudSession> {
    const c = credentials(body);
    if (this.hashing) throw new ServiceError('登录服务正忙，请稍后重试。', 429);
    this.hashing = true;
    try {
      const row = this.db.prepare('SELECT id,username,salt,password_hash FROM users WHERE normalized=?').get(c.normalized) as { id: string; username: string; salt: string; password_hash: string } | undefined;
      const salt = row?.salt ?? randomBytes(16).toString('hex');
      const hash = await hashPassword(c.password, salt);
      if (register) {
        if (row) throw new ServiceError('这个用户名已被使用。', 409);
        if (Number((this.db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n) >= this.maxUsers) throw new ServiceError('这个服务器暂时停止注册，请联系维护者。', 403);
        const user = { id: randomUUID(), username: c.username };
        this.db.prepare('INSERT INTO users(id,username,normalized,salt,password_hash) VALUES(?,?,?,?,?)').run(user.id, user.username, c.normalized, salt, hash.toString('hex'));
        return this.session(user);
      }
      if (!row || !timingSafeEqual(hash, Buffer.from(row.password_hash, 'hex'))) throw new ServiceError('用户名或密码不正确。', 401);
      return this.session({ id: row.id, username: row.username });
    } finally { this.hashing = false; }
  }
  authorize(header: unknown): CloudUser {
    if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) throw new ServiceError('请先登录自己的同步账号。', 401);
    const row = this.db.prepare('SELECT users.id,users.username FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.hash=? AND sessions.expires>?').get(digest(header.slice(7)), Date.now()) as unknown as CloudUser | undefined;
    if (!row) throw new ServiceError('登录已过期，请重新登录。', 401);
    return { id: row.id, username: row.username };
  }
  logout(header: unknown) { this.authorize(header); this.db.prepare('DELETE FROM sessions WHERE hash=?').run(digest((header as string).slice(7))); }
  sync(user: CloudUser, body: unknown): CloudSnapshot {
    const b = body as Record<string, unknown>;
    if (!b || b.anchorFormat !== anchorFormat || Object.keys(b).some(key => !['anchorFormat', 'cursor', 'mutations'].includes(key)) || !Number.isSafeInteger(b.cursor) || Number(b.cursor) < 0) throw new ServiceError('同步协议不兼容，请更新客户端。', 400);
    const mutations = parseMutations(b.mutations);
    const acknowledged: string[] = [], rejected: CloudSnapshot['rejected'] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const m of mutations) {
        acknowledged.push(m.id);
        if (this.db.prepare('SELECT 1 FROM receipts WHERE user_id=? AND operation_id=?').get(user.id, m.id)) continue;
        const old = this.db.prepare('SELECT entry,revision,changed_at,membership_at FROM shelf WHERE user_id=? AND book_id=?').get(user.id, m.bookID) as StoredRow | undefined;
        const previous = old?.entry ? JSON.parse(old.entry) as ShelfEntry : undefined;
        let entry: ShelfEntry | null = m.entry ?? null;
        let membershipAt = old?.membership_at ?? m.changedAt;
        let reason = '';
        if (m.action === 'progress' && !previous) reason = 'removed-elsewhere';
        if (m.action === 'add' && old && !previous && m.baseRevision < old.revision) reason = 'removed-elsewhere';
        if (m.action === 'remove' && old && m.baseRevision < old.revision && Date.parse(m.changedAt) < Date.parse(old.membership_at)) reason = 'newer-library-change';
        if (!reason && m.action !== 'remove' && entry) {
          if (previous) entry = { ...previous, book: { ...previous.book, ...entry.book }, position: newestPosition(previous.position, entry.position) };
          else membershipAt = m.changedAt;
          if (!previous && Number((this.db.prepare('SELECT count(*) AS n FROM shelf WHERE user_id=? AND entry IS NOT NULL').get(user.id) as { n: number }).n) >= 1000) throw new ServiceError('云端书架最多保存 1000 本书。', 413);
        }
        if (!reason && !old && Number((this.db.prepare('SELECT count(*) AS n FROM shelf WHERE user_id=?').get(user.id) as { n: number }).n) >= 5000) throw new ServiceError('同步记录已达到上限，请联系维护者。', 413);
        if (reason) rejected.push({ id: m.id, reason });
        else if (!old || old.entry !== (entry ? JSON.stringify(entry) : null)) {
          this.db.prepare('UPDATE users SET revision=revision+1 WHERE id=?').run(user.id);
          const revision = Number((this.db.prepare('SELECT revision FROM users WHERE id=?').get(user.id) as { revision: number }).revision);
          this.db.prepare('INSERT INTO shelf VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,book_id) DO UPDATE SET entry=excluded.entry,revision=excluded.revision,changed_at=excluded.changed_at,membership_at=excluded.membership_at').run(user.id, m.bookID, entry ? JSON.stringify(entry) : null, revision, new Date().toISOString(), membershipAt);
        }
        this.db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(user.id, m.id, Date.now());
      }
      this.db.prepare('DELETE FROM receipts WHERE user_id=? AND operation_id NOT IN (SELECT operation_id FROM receipts WHERE user_id=? ORDER BY created DESC LIMIT 20000)').run(user.id, user.id);
      const rows = this.db.prepare('SELECT book_id,entry,revision,changed_at FROM shelf WHERE user_id=? AND revision>? ORDER BY revision LIMIT 501').all(user.id, Number(b.cursor)) as unknown as { book_id: string; entry: string | null; revision: number; changed_at: string }[];
      const hasMore = rows.length > 500;
      const records: CloudRecord[] = rows.slice(0, 500).map(row => ({ bookID: row.book_id, entry: row.entry ? JSON.parse(row.entry) : null, revision: row.revision, changedAt: row.changed_at }));
      // Return authoritative values for acknowledged operations too, including
      // rejected stale progress and retried mutations that changed no row.
      for (const bookID of new Set(mutations.map(m => m.bookID))) {
        if (records.some(record => record.bookID === bookID)) continue;
        const row = this.db.prepare('SELECT entry,revision,changed_at FROM shelf WHERE user_id=? AND book_id=?').get(user.id, bookID) as StoredRow | undefined;
        if (row) records.push({ bookID, entry: row.entry ? JSON.parse(row.entry) : null, revision: row.revision, changedAt: row.changed_at });
      }
      const cursor = hasMore ? rows[499].revision : Number((this.db.prepare('SELECT revision FROM users WHERE id=?').get(user.id) as { revision: number }).revision);
      this.db.exec('COMMIT');
      return { anchorFormat, cursor, records, acknowledged, rejected, hasMore, serverTime: new Date().toISOString() };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}

export function registerCloudRoutes(app: FastifyInstance, cloud: CloudDatabase) {
  const authConfig = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  const auth = (request: FastifyRequest) => cloud.authorize(request.headers.authorization);
  app.post('/api/auth/register', authConfig, async request => cloud.authenticate(request.body, true));
  app.post('/api/auth/login', authConfig, async request => cloud.authenticate(request.body, false));
  app.get('/api/auth/me', async request => ({ user: auth(request), serverTime: new Date().toISOString() }));
  app.post('/api/auth/logout', async request => { cloud.logout(request.headers.authorization); return { ok: true }; });
  app.post('/api/sync', { bodyLimit: 1024 * 1024 }, async request => cloud.sync(auth(request), request.body));
  app.addHook('onClose', async () => cloud.close());
}
