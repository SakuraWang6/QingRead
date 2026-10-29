import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createDownloadServer, loadManifest, parseRange } from './server.mjs';
import { readDownloadStats } from './stats.mjs';

async function fixture(t, limits = {}, size = 256 * 1024, trustedProxyIPs = ['127.0.0.1']) {
  const root = await mkdtemp(join(tmpdir(), 'qingread-download-test-'));
  let app;
  t.after(async () => { await app?.close(); await rm(root, { recursive: true, force: true }); });
  const data = Buffer.alloc(size, 0x51), name = 'QingRead-Android-1.0.0.apk';
  await writeFile(join(root, name), data);
  const manifest = { version: 1, artifacts: [{ id: 'android-1.0.0', file: name, size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'), names: [name, 'QingRead-Android-latest.apk'] }] };
  const options = { root, manifest, statsPath: join(root, 'private', 'downloads.sqlite'), trustedProxyIPs,
    limits: { requestsPerIP: 100, requestsGlobal: 200, globalBytesPerSecond: 100 * 1024 ** 2, ipBytesPerSecond: 100 * 1024 ** 2, ...limits } };
  app = await createDownloadServer(options);
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const port = app.server.address().port;
  const request = (path = `/downloads/${name}`, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method,
      headers: { 'x-qingread-client-ip': '203.0.113.10', ...headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    }); req.on('error', reject); req.end();
  });
  return { app, root, data, name, manifest, options, port, request, stats: () => { app.stats.flushRejections(); return readDownloadStats(options.statsPath); } };
}

test('fixed manifest, GET, alias, HEAD, ETag and a private read-only daily summary', async t => {
  const f = await fixture(t), path = `/downloads/${f.name}`;
  const first = await f.request(); assert.equal(first.status, 200); assert.deepEqual(first.body, f.data);
  assert.equal((await f.request('/downloads/QingRead-Android-latest.apk')).status, 200);
  const head = await f.request(path, {}, 'HEAD'); assert.equal(head.status, 200); assert.equal(head.body.length, 0); assert.equal(Number(head.headers['content-length']), f.data.length);
  assert.equal((await f.request(path, { 'if-none-match': `W/${first.headers.etag}` })).status, 304);
  for (const forbidden of ['/stats', '/downloads/../private/downloads.sqlite', '/downloads/%51ingRead-Android-1.0.0.apk', `${path}?x=1`, '/downloads/other.apk']) assert.equal((await f.request(forbidden)).status, 404);
  assert.equal((await f.request(path, {}, 'POST')).status, 405);
  await delay(10);
  const snapshot = f.stats(), row = snapshot.daily.find(row => row.artifact === 'android-1.0.0');
  assert.equal(snapshot.retentionDays, 365); assert.ok(snapshot.enabledAt);
  assert.equal(row.full_downloads, 2); assert.equal(row.bytes_sent, f.data.length * 2);
  assert.equal(JSON.stringify(snapshot).includes('203.0.113.10'), false);
});

test('single byte ranges and If-Range preserve resumability without inflating full downloads', async t => {
  const f = await fixture(t), path = `/downloads/${f.name}`, etag = `"sha256-${f.manifest.artifacts[0].sha256}"`;
  for (const [range, expected] of [['bytes=0-9', f.data.subarray(0, 10)], ['bytes=-7', f.data.subarray(-7)], ['bytes=17-', f.data.subarray(17)]]) {
    const r = await f.request(path, { range }); assert.equal(r.status, 206); assert.deepEqual(r.body, expected);
  }
  for (const range of ['bytes=0-1,5-6', 'bytes=-0', 'bytes=9-2', `bytes=${f.data.length}-`, 'items=0-1', 'bytes=9007199254740993-']) {
    const r = await f.request(path, { range }); assert.equal(r.status, 416); assert.equal(r.headers['content-range'], `bytes */${f.data.length}`);
  }
  assert.equal((await f.request(path, { range: 'bytes=0-0', 'if-range': etag })).status, 206);
  assert.equal((await f.request(path, { range: 'bytes=0-0', 'if-range': 'W/' + etag })).status, 200);
  const head = await f.request(path, { range: 'bytes=0-0' }, 'HEAD');
  assert.equal(head.status, 200); assert.equal(Number(head.headers['content-length']), f.data.length);
  await delay(10);
  const row = f.stats().daily.find(row => row.artifact === 'android-1.0.0');
  assert.equal(row.full_downloads, 1); assert.equal(row.range_requests, 4);
  assert.deepEqual(parseRange('bytes=1-999', 4), { start: 1, end: 3 });
});

test('proxy identity is mandatory and client XFF cannot change the quota key', async t => {
  const f = await fixture(t, { requestsPerIP: 2 }), path = `/downloads/${f.name}`;
  assert.equal((await f.request(path, { 'x-qingread-client-ip': '' })).status, 403);
  assert.equal((await f.request(path, { 'x-qingread-client-ip': '203.0.113.5, 203.0.113.6' })).status, 403);
  assert.equal((await f.request(path, { 'x-forwarded-for': '203.0.113.21' }, 'HEAD')).status, 200);
  assert.equal((await f.request(path, { 'x-forwarded-for': '203.0.113.22' }, 'HEAD')).status, 200);
  assert.equal((await f.request(path, { 'x-forwarded-for': '203.0.113.23' }, 'HEAD')).status, 429);
  assert.equal((await f.request(path, { 'x-qingread-client-ip': '203.0.113.11' }, 'HEAD')).status, 200);
});

test('global quotas and bounded client tables reject additional identities', async t => {
  const f = await fixture(t, { requestsGlobal: 2, maxClients: 1 }), path = `/downloads/${f.name}`;
  assert.equal((await f.request(path, {}, 'HEAD')).status, 200);
  assert.equal((await f.request(path, { 'x-qingread-client-ip': '203.0.113.11' }, 'HEAD')).status, 429);
  assert.equal((await f.request(path, {}, 'HEAD')).status, 429);
});

test('only the configured proxy socket can supply the client IP', async t => {
  const f = await fixture(t, {}, 100, ['127.0.0.2']);
  assert.equal((await f.request()).status, 403);
  assert.equal((await f.request('/health')).status, 200);
});

test('expired quota and identity slots are reusable after the bounded TTL', async t => {
  const f = await fixture(t, { requestsPerIP: 1, windowMs: 500, maxClients: 1 });
  assert.equal((await f.request(undefined, {}, 'HEAD')).status, 200);
  assert.equal((await f.request(undefined, {}, 'HEAD')).status, 429);
  assert.equal((await f.request(undefined, { 'x-qingread-client-ip': '203.0.113.11' }, 'HEAD')).status, 429);
  await delay(550);
  assert.equal((await f.request(undefined, { 'x-qingread-client-ip': '203.0.113.11' }, 'HEAD')).status, 200);
});

test('global and per-IP byte limits throttle the body instead of buffering whole files', async t => {
  for (const limits of [{ globalBytesPerSecond: 262144 }, { ipBytesPerSecond: 262144 }]) {
    const f = await fixture(t, limits, 128 * 1024);
    const start = performance.now(), response = await f.request(), elapsed = performance.now() - start;
    assert.equal(response.status, 200); assert.deepEqual(response.body, f.data);
    // A single 64KiB initial burst is permitted; the next chunk waits at least 250ms.
    assert.ok(elapsed >= 200, `throttling completed too quickly: ${elapsed}ms`);
  }
});

test('startup rejects symlinks, altered bytes and unsafe manifest paths', async t => {
  const f = await fixture(t);
  const wrong = structuredClone(f.manifest); wrong.artifacts[0].sha256 = '0'.repeat(64);
  await assert.rejects(loadManifest(f.root, wrong), /checksum/);
  const unsafe = structuredClone(f.manifest); unsafe.artifacts[0].file = '../secret';
  await assert.rejects(loadManifest(f.root, unsafe), /Invalid artifact/);
  await symlink(f.name, join(f.root, 'alias.apk'));
  const linked = structuredClone(f.manifest); linked.artifacts[0].file = 'alias.apk';
  await assert.rejects(loadManifest(f.root, linked));
  await writeFile(join(f.root, f.name), Buffer.alloc(f.data.length, 0x52));
  assert.equal((await f.request()).status, 503);
  await delay(10);
  assert.equal(f.stats().daily[0].full_downloads, 0);
});

test('slow transfers are bounded; interruption and duration expiry release concurrency', async t => {
  const f = await fixture(t, { concurrentPerIP: 1, concurrentGlobal: 1, globalBytesPerSecond: 1024 * 1024,
    ipBytesPerSecond: 1024 * 1024, maxDurationMs: 250 }, 1024 * 1024);
  const opened = new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: f.port, path: `/downloads/${f.name}`, headers: { 'x-qingread-client-ip': '203.0.113.10' } }, res => {
      res.once('data', () => resolve({ req, res })); res.on('error', () => {});
    }); req.on('error', reject);
  });
  const first = await opened;
  assert.equal((await f.request()).status, 429);
  assert.equal((await f.request(undefined, { 'x-qingread-client-ip': '203.0.113.11' })).status, 429);
  await delay(400); first.req.destroy(); first.res.destroy(); await delay(20);
  const row = f.stats().daily.find(row => row.artifact === 'android-1.0.0');
  assert.equal(row.full_downloads, 0); assert.equal(row.interrupted, 1); assert.ok(row.bytes_sent > 0 && row.bytes_sent < f.data.length);
  assert.equal((await f.request(`/downloads/${f.name}`, { range: 'bytes=0-0' })).status, 206);
});

test('a client disconnect promptly releases its download slot', async t => {
  const f = await fixture(t, { concurrentPerIP: 1, concurrentGlobal: 1, globalBytesPerSecond: 1024 * 1024,
    ipBytesPerSecond: 1024 * 1024 }, 1024 * 1024);
  await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: f.port, path: `/downloads/${f.name}`, headers: { 'x-qingread-client-ip': '203.0.113.10' } }, res => {
      res.once('data', () => { res.destroy(); req.destroy(); resolve(); }); res.on('error', () => {});
    }); req.on('error', reject);
  });
  await delay(30);
  assert.equal((await f.request(undefined, { range: 'bytes=0-0' })).status, 206);
  assert.equal(f.stats().daily[0].interrupted, 1); assert.equal(f.stats().daily[0].full_downloads, 0);
});

test('a failed statistics store closes downloads without crashing health checks', async t => {
  const f = await fixture(t); f.app.stats.close();
  assert.equal((await f.request()).status, 503);
  assert.equal((await f.request('/health')).status, 503);
  // Cleanup should remain harmless when the test deliberately closed SQLite.
  f.app.stats.close = () => {};
});

test('statistics survive service restart and prune rows older than 365 UTC dates', async t => {
  const f = await fixture(t);
  await f.request(); await delay(10); await f.app.close();
  const next = await createDownloadServer(f.options); f.app = next;
  // fixture cleanup closes its original object, so explicitly close this replacement.
  t.after(async () => { await next.close(); });
  assert.equal(readDownloadStats(f.options.statsPath).daily[0].full_downloads, 1);
  next.stats.db.prepare('INSERT INTO daily(day,artifact) VALUES(?,?)').run('2000-01-01', 'old');
  next.stats.prune(); assert.equal(readDownloadStats(f.options.statsPath).daily.some(row => row.artifact === 'old'), false);
});
