import http from 'node:http';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { isIP } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const DAY = 86_400_000;
const defaults = Object.freeze({ requestsPerIP: 60, requestsGlobal: 600, windowMs: 600_000,
  concurrentPerIP: 2, concurrentGlobal: 4, globalBytesPerSecond: 524_288,
  ipBytesPerSecond: 262_144, maxDurationMs: 120_000, maxClients: 4096 });
const safeName = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.includes('..');
const dayFor = now => new Date(now).toISOString().slice(0, 10);
function ip(value) {
  if (typeof value !== 'string' || !isIP(value)) return null;
  if (value.startsWith('::ffff:') && isIP(value.slice(7)) === 4) return value.slice(7);
  return isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value;
}

/** A separate database: no account, session, IP or user-agent data is stored. */
export class DownloadStats {
  constructor(path, now = Date.now) { this.path = path; this.now = now; this.failed = false; this.rejections = new Map(); }
  async initialize() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const parent = await lstat(dirname(this.path));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw Error('Invalid statistics directory');
    const existing = await lstat(this.path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw Error('Invalid statistics file');
    this.db = new DatabaseSync(this.path);
    await chmod(this.path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=100;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS daily(day TEXT NOT NULL,artifact TEXT NOT NULL,requests INTEGER NOT NULL DEFAULT 0,
        full_downloads INTEGER NOT NULL DEFAULT 0,range_requests INTEGER NOT NULL DEFAULT 0,
        bytes_sent INTEGER NOT NULL DEFAULT 0,interrupted INTEGER NOT NULL DEFAULT 0,rejected INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(day,artifact));`);
    this.db.prepare('INSERT OR IGNORE INTO metadata VALUES(?,?)').run('enabled_at', new Date(this.now()).toISOString());
    this.update = this.db.prepare(`INSERT INTO daily VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(day,artifact) DO UPDATE SET
      requests=requests+excluded.requests,full_downloads=full_downloads+excluded.full_downloads,
      range_requests=range_requests+excluded.range_requests,bytes_sent=bytes_sent+excluded.bytes_sent,
      interrupted=interrupted+excluded.interrupted,rejected=rejected+excluded.rejected`);
    this.prune();
    this.flushTimer = setInterval(() => { try { this.flushRejections(); } catch { /* healthy() closes access after storage failures. */ } }, 1000);
    this.flushTimer.unref();
  }
  prune() { this.db.prepare('DELETE FROM daily WHERE day < ?').run(dayFor(this.now() - 364 * DAY)); this.prunedDay = dayFor(this.now()); }
  healthy() {
    if (this.failed) return false;
    try { this.db.prepare('SELECT 1').get(); return true; } catch { this.failed = true; return false; }
  }
  record(artifact, counts = {}) {
    if (!this.healthy()) throw Error('Statistics unavailable');
    try {
      if (this.prunedDay !== dayFor(this.now())) this.prune();
      if (counts.rejected && !counts.bytes && !counts.full && !counts.interrupted) {
        const key = `${dayFor(this.now())}|${artifact}`, entry = this.rejections.get(key) ?? { day: dayFor(this.now()), artifact, requests: 0, rejected: 0 };
        entry.requests += counts.requests ?? 0; entry.rejected += counts.rejected;
        this.rejections.set(key, entry); return;
      }
      this.update.run(dayFor(this.now()), artifact, counts.requests ?? 0, counts.full ?? 0,
        counts.range ?? 0, counts.bytes ?? 0, counts.interrupted ?? 0, counts.rejected ?? 0);
    } catch { this.failed = true; throw Error('Statistics unavailable'); }
  }
  flushRejections() {
    if (!this.rejections.size || this.failed || this.closed) return;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      for (const entry of this.rejections.values()) this.update.run(entry.day, entry.artifact, entry.requests, 0, 0, 0, 0, entry.rejected);
      this.db.exec('COMMIT'); this.rejections.clear();
    } catch { try { this.db.exec('ROLLBACK'); } catch {} this.failed = true; throw Error('Statistics unavailable'); }
  }
  close() {
    if (!this.closed) {
      clearInterval(this.flushTimer); try { this.flushRejections(); } finally { this.db?.close(); this.closed = true; }
    }
  }
}

export async function loadManifest(root, manifest) {
  root = resolve(root);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw Error('Artifact root must be a real directory');
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.artifacts) || !manifest.artifacts.length || manifest.artifacts.length > 100) throw Error('Invalid artifact manifest');
  const files = new Map(), ids = new Set();
  for (const item of manifest.artifacts) {
    if (!safeName(item.id) || ids.has(item.id) || !safeName(item.file) || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > 512 * 1024 ** 2 || !/^[a-f0-9]{64}$/.test(item.sha256) || !Array.isArray(item.names) || !item.names.length || item.names.length > 4) throw Error('Invalid artifact entry');
    ids.add(item.id);
    const path = join(root, item.file), handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isFile() || info.size !== BigInt(item.size)) throw Error('Artifact size or type mismatch');
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) hash.update(chunk);
      if (hash.digest('hex') !== item.sha256) throw Error('Artifact checksum mismatch');
      const artifact = { ...item, path, info, etag: `"sha256-${item.sha256}"` };
      for (const name of item.names) {
        if (!safeName(name) || files.has(`/downloads/${name}`)) throw Error('Invalid or duplicate public artifact name');
        files.set(`/downloads/${name}`, artifact);
      }
    } finally { await handle.close(); }
  }
  return files;
}

export function parseRange(value, size) {
  if (typeof value !== 'string' || !/^bytes=\d*-\d*$/.test(value)) return null;
  const [first, last] = value.slice(6).split('-');
  if (!first && !last) return null;
  let start = first ? Number(first) : Math.max(0, size - Number(last));
  let end = first && last ? Number(last) : size - 1;
  if (![start, end, Number(first || 0), Number(last || 0)].every(Number.isSafeInteger) || !first && Number(last) <= 0 || start < 0 || start >= size || end < start) return null;
  end = Math.min(end, size - 1);
  return { start, end };
}

class Gates {
  constructor(limits) { this.limits = limits; this.clients = new Map(); this.active = 0; this.nextGlobal = 0; this.windowStart = 0; this.requests = 0; this.prunedAt = 0; }
  request(key) {
    const now = Date.now(), l = this.limits;
    if (now - this.prunedAt > Math.min(l.windowMs, 30_000)) {
      for (const [name, entry] of this.clients) if (!entry.active && now - entry.start >= l.windowMs) this.clients.delete(name);
      this.prunedAt = now;
    }
    if (now - this.windowStart >= l.windowMs) { this.windowStart = now; this.requests = 0; }
    if (++this.requests > l.requestsGlobal) return null;
    let entry = this.clients.get(key);
    if (!entry) {
      if (this.clients.size >= l.maxClients) return null;
      entry = { start: now, requests: 0, active: 0, nextByteAt: 0 }; this.clients.set(key, entry);
    }
    if (now - entry.start >= l.windowMs) { entry.start = now; entry.requests = 0; }
    return ++entry.requests <= l.requestsPerIP ? entry : null;
  }
  acquire(entry) {
    if (entry.active >= this.limits.concurrentPerIP || this.active >= this.limits.concurrentGlobal) return null;
    entry.active++; this.active++;
    return () => { entry.active--; this.active--; };
  }
  async throttle(bytes, entry, signal) {
    signal.throwIfAborted();
    const now = performance.now(), due = Math.max(now, this.nextGlobal, entry.nextByteAt);
    this.nextGlobal = due + bytes * 1000 / this.limits.globalBytesPerSecond;
    entry.nextByteAt = due + bytes * 1000 / this.limits.ipBytesPerSecond;
    if (due > now) await delay(due - now, undefined, { signal });
    signal.throwIfAborted();
  }
}

export async function createDownloadServer({ root, manifest, statsPath, trustedProxyIPs, limits = {}, now = Date.now }) {
  const files = await loadManifest(root, manifest), config = { ...defaults, ...limits };
  for (const value of Object.values(config)) if (!Number.isSafeInteger(value) || value <= 0) throw Error('Invalid download limit');
  const proxies = new Set((trustedProxyIPs ?? []).map(value => { const result = ip(value); if (!result) throw Error('Invalid proxy IP'); return result; }));
  const stats = new DownloadStats(statsPath, now); await stats.initialize();
  const gates = new Gates(config);
  const tasks = new Set();
  const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
    const task = handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(503, { 'Retry-After': '60' }); res.end(); });
    tasks.add(task); void task.finally(() => tasks.delete(task));
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5000; server.maxRequestsPerSocket = 100;
  server.maxConnections = 128;
  async function handle(req, res) {
    req.on('error', () => {}); res.on('error', () => {});
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store');
    const peer = ip(req.socket.remoteAddress);
    if (req.url === '/health' && (peer === '127.0.0.1' || peer === '::1')) {
      res.writeHead(stats.healthy() ? 200 : 503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: stats.healthy() })); return;
    }
    const artifact = files.get(req.url), id = artifact?.id ?? 'unknown';
    const reject = (status, extra = {}) => {
      try { stats.record(id, { requests: 1, rejected: 1 }); } catch { status = 503; }
      res.writeHead(status, { 'Retry-After': '60', ...extra }); res.end();
    };
    const client = proxies.has(peer) ? ip(req.headers['x-qingread-client-ip']) : null;
    if (!client) { reject(403); return; }
    const entry = gates.request(client);
    if (!entry) { reject(429); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { reject(405, { Allow: 'GET, HEAD' }); return; }
    if (!artifact) { reject(404); return; }
    if (!stats.healthy()) { res.writeHead(503, { 'Retry-After': '60' }); res.end(); return; }
    res.setHeader('ETag', artifact.etag); res.setHeader('Accept-Ranges', 'bytes');
    if (req.headers['if-none-match']?.split(',').map(value => value.trim()).some(value => value === '*' || value.replace(/^W\//, '') === artifact.etag)) {
      try { stats.record(id, { requests: 1 }); } catch { res.writeHead(503); res.end(); return; }
      res.writeHead(304); res.end(); return;
    }
    let range;
    if (req.method === 'GET' && req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === artifact.etag)) {
      range = parseRange(req.headers.range, artifact.size);
      if (!range) { reject(416, { 'Content-Range': `bytes */${artifact.size}` }); return; }
    }
    const status = range ? 206 : 200, start = range?.start ?? 0, end = range?.end ?? artifact.size - 1;
    res.setHeader('Content-Type', artifact.file.endsWith('.apk') ? 'application/vnd.android.package-archive' : 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${artifact.file}"`);
    if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${artifact.size}`);
    if (req.method === 'HEAD') {
      try { stats.record(id, { requests: 1 }); } catch { res.writeHead(503); res.end(); return; }
      res.setHeader('Content-Length', end - start + 1); res.writeHead(status); res.end(); return;
    }
    const release = gates.acquire(entry);
    if (!release) { reject(429); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.maxDurationMs); timer.unref();
    const aborted = () => controller.abort(), closed = () => { if (!res.writableFinished) controller.abort(); };
    req.once('aborted', aborted); req.once('error', aborted); res.once('close', closed); res.once('error', aborted);
    let handle, input, bytes = 0, complete = false, started = false, recorded = false;
    const stop = () => { input?.destroy(); if (res.headersSent) res.destroy(); };
    controller.signal.addEventListener('abort', stop, { once: true });
    try {
      handle = await open(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat({ bigint: true }), old = artifact.info;
      if (!info.isFile() || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => info[key] !== old[key])) throw Error('Artifact changed; reload manifest');
      controller.signal.throwIfAborted();
      stats.record(id, { requests: 1, range: range ? 1 : 0 });
      recorded = true;
      controller.signal.throwIfAborted();
      res.setHeader('Content-Length', end - start + 1); res.writeHead(status); started = true;
      input = handle.createReadStream({ start, end, highWaterMark: 64 * 1024, autoClose: false });
      for await (const chunk of input) {
        await gates.throttle(chunk.length, entry, controller.signal);
        bytes += chunk.length;
        if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
      }
      const finished = once(res, 'finish', { signal: controller.signal }); res.end(); await finished; complete = true;
    } catch {
      if (started) res.destroy(); else if (!res.destroyed) { res.removeHeader('Content-Length'); res.removeHeader('Content-Range'); res.writeHead(503, { 'Retry-After': '60' }); res.end(); }
    } finally {
      clearTimeout(timer); req.removeListener('aborted', aborted); req.removeListener('error', aborted); res.removeListener('close', closed); res.removeListener('error', aborted);
      controller.signal.removeEventListener('abort', stop); input?.destroy(); await handle?.close().catch(() => {}); release();
      try { stats.record(id, { requests: recorded ? 0 : 1, full: complete && !range ? 1 : 0, bytes, interrupted: started && !complete ? 1 : 0, rejected: started ? 0 : 1 }); } catch { /* Stop subsequent requests until statistics storage is repaired. */ }
    }
  }
  let closing;
  return { server, stats, limits: config, close() {
    return closing ??= (async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await Promise.allSettled([...tasks]); stats.close(); })();
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { readFile } = await import('node:fs/promises');
  const app = await createDownloadServer({ root: process.env.QINGREAD_DOWNLOAD_ROOT ?? '/artifacts',
    manifest: JSON.parse(await readFile(process.env.QINGREAD_DOWNLOAD_MANIFEST ?? '/config/manifest.json', 'utf8')),
    statsPath: process.env.QINGREAD_DOWNLOAD_STATS ?? '/stats/downloads.sqlite',
    trustedProxyIPs: (process.env.QINGREAD_DOWNLOAD_PROXIES ?? '').split(',').filter(Boolean) });
  app.server.listen(Number(process.env.PORT ?? 8790), process.env.HOST ?? '0.0.0.0');
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
}
