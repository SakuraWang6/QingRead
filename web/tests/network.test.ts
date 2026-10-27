import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import https from 'node:https';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { PassThrough, type Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';

type UpstreamResponse = PassThrough & { statusCode: number; headers: Record<string, string> };
let responses: UpstreamResponse[];
let encoding = '';
let idleTimeouts: { milliseconds: number; fire: () => void }[];
let responsePlans: { statusCode?: number; headers?: Record<string, string>; delay?: number }[];

beforeEach(() => {
  vi.resetModules();
  responses = [];
  encoding = '';
  idleTimeouts = [];
  responsePlans = [];
  vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '1.1.1.1', family: 4 }] as never);
  vi.spyOn(https, 'request').mockImplementation((...args: unknown[]) => {
    const plan = responsePlans.shift() ?? {};
    const response = Object.assign(new PassThrough(), { statusCode: plan.statusCode ?? 200, headers: plan.headers ?? (encoding ? { 'content-encoding': encoding } : {}) }) as UpstreamResponse;
    responses.push(response);
    const callback = args[2] as (response: UpstreamResponse) => void;
    const request = Object.assign(new EventEmitter(), {
      setTimeout(milliseconds: number, fire: () => void) { idleTimeouts.push({ milliseconds, fire }); return request; },
      end() {
        const respond = () => { callback(response); if (response.statusCode === 302) response.end(); };
        if (plan.delay) setTimeout(respond, plan.delay); else queueMicrotask(respond);
        return request;
      },
      destroy(error?: Error) { response.destroy(error); return request; },
    });
    response.once('close', () => request.emit('close'));
    return request as never;
  });
});

afterEach(() => {
  for (const response of responses) response.destroy();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const target = 'https://www.biequgei.com/novel/test.html';

function mockDoH(answer: unknown, statusCode = 200, raw = false) {
  return vi.spyOn(https, 'get').mockImplementation((...args: unknown[]) => {
    const response = Object.assign(new PassThrough(), { statusCode, headers: {} }) as UpstreamResponse;
    const callback = args[1] as (response: UpstreamResponse) => void;
    const request = Object.assign(new EventEmitter(), {
      setTimeout() { return request; },
      destroy(error?: Error) { request.emit('error', error); return request; },
    });
    queueMicrotask(() => { callback(response); response.end(raw ? String(answer) : JSON.stringify(answer)); });
    return request as never;
  });
}

describe('public source DNS resolution', () => {
  it.each([
    '2001:2::e', '2001:0002:0000:0000:0000:0000:0000:000e',
    '2001:2:0:ffff:ffff:ffff:ffff:ffff', '2001:0db8:0000:0000:0000:0000:0000:0001',
    '2001:0000:0001:0000:0000:0000:0000:0001', '::ffff:1.1.1.1',
  ])('rejects special IPv6 address %s regardless of spelling', async address => {
    const { isPublicIP } = await import('../server/network');
    expect(isPublicIP(address)).toBe(false);
  });

  it.each([
    [{ address: '198.18.0.12', family: 4 }],
    [{ address: '198.19.255.254', family: 4 }, { address: '2001:2::e', family: 6 }],
    [{ address: '2001:0002:0000:0000:0000:0000:0000:000e', family: 6 }],
  ])('resolves synthetic-only DNS answers through fixed-IP authenticated DoH: %j', async (...addresses) => {
    vi.mocked(dns.lookup).mockResolvedValue(addresses as never);
    const doh = mockDoH({ Answer: [{ type: 1, data: '93.184.215.14' }] });
    const { fetchStream } = await import('../server/network');
    const result = await fetchStream(target, 'biequgei');
    expect(doh).toHaveBeenCalledOnce();
    expect(doh.mock.calls[0][0]).toMatchObject({ hostname: '1.1.1.1', servername: 'cloudflare-dns.com', path: '/dns-query?name=www.biequgei.com&type=A' });
    expect(doh.mock.calls[0][0]).not.toHaveProperty('rejectUnauthorized', false);
    const [url, options] = vi.mocked(https.request).mock.calls[0] as unknown as [URL, { lookup: (hostname: string, options: { all: boolean }, callback: (...args: unknown[]) => void) => void }];
    expect(url.hostname).toBe('www.biequgei.com');
    expect(options).not.toHaveProperty('rejectUnauthorized', false);
    const resolved = vi.fn();
    options.lookup(url.hostname, { all: true }, resolved);
    expect(resolved).toHaveBeenCalledWith(null, [{ address: '93.184.215.14', family: 4 }]);
    result.stream.destroy();
    const again = await fetchStream(target, 'biequgei');
    again.stream.destroy();
    expect(doh).toHaveBeenCalledOnce();
    expect(dns.lookup).toHaveBeenCalledOnce();
  });

  it.each([
    [{ address: '198.18.0.12', family: 4 }, { address: '127.0.0.1', family: 4 }],
    [{ address: '2001:2::e', family: 6 }, { address: '192.168.1.1', family: 4 }],
    [{ address: '198.18.0.12', family: 4 }, { address: '1.1.1.1', family: 4 }],
    [{ address: '198.18.0.12', family: 4 }, { address: '2001:db8::1', family: 6 }],
    [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }],
    [{ address: '2606:4700:4700::1111', family: 6 }, { address: '::1', family: 6 }],
  ])('rejects other mixed DNS answers without opening DoH or a source connection: %j', async (...addresses) => {
    vi.mocked(dns.lookup).mockResolvedValue(addresses as never);
    const doh = mockDoH({ Answer: [{ type: 1, data: '1.1.1.1' }] });
    const { fetchStream } = await import('../server/network');
    await expect(fetchStream(target, 'biequgei')).rejects.toMatchObject({ statusCode: 400 });
    expect(doh).not.toHaveBeenCalled();
    expect(https.request).not.toHaveBeenCalled();
  });

  it.each([
    [], [{ type: 1, data: '127.0.0.1' }], [{ type: 1, data: '198.18.0.12' }],
    [{ type: 1, data: '1.1.1.1' }, { type: 1, data: '192.168.1.1' }],
    [{ type: 1, data: 'not-an-address' }], [{ type: 28, data: '2001:2::e' }],
  ])('rejects unsafe or missing DoH A records without connecting: %j', async (...Answer) => {
    vi.mocked(dns.lookup).mockResolvedValue([{ address: '198.18.0.12', family: 4 }, { address: '2001:2::e', family: 6 }] as never);
    const doh = mockDoH({ Answer });
    const { fetchStream } = await import('../server/network');
    await expect(fetchStream(target, 'biequgei')).rejects.toMatchObject({ statusCode: 400 });
    expect(doh).toHaveBeenCalledOnce();
    expect(https.request).not.toHaveBeenCalled();
  });

  it.each([[503, false], [200, true]])('does not connect after a failed DoH response (HTTP %s, malformed %s)', async (status, malformed) => {
    vi.mocked(dns.lookup).mockResolvedValue([{ address: '2001:2::e', family: 6 }] as never);
    mockDoH(malformed ? '{invalid' : { Answer: [{ type: 1, data: '1.1.1.1' }] }, status, malformed);
    const { fetchStream } = await import('../server/network');
    await expect(fetchStream(target, 'biequgei')).rejects.toThrow('无法安全解析来源地址');
    expect(https.request).not.toHaveBeenCalled();
  });

  it.each(['2001:4860:4860::8888', '2001:4860:4860:0:0:0:0:8888', '2606:4700:4700::1111'])('connects to ordinary public IPv6 %s without DoH', async address => {
    vi.mocked(dns.lookup).mockResolvedValue([{ address, family: 6 }] as never);
    const doh = mockDoH({ Answer: [] });
    const { fetchStream, isPublicIP } = await import('../server/network');
    expect(isPublicIP(address)).toBe(true);
    const result = await fetchStream(target, 'biequgei');
    const options = vi.mocked(https.request).mock.calls[0][1] as unknown as { lookup: (host: string, options: { all: boolean }, callback: (...args: unknown[]) => void) => void };
    const resolved = vi.fn();
    options.lookup('www.biequgei.com', { all: true }, resolved);
    expect(resolved).toHaveBeenCalledWith(null, [{ address, family: 6 }]);
    expect(doh).not.toHaveBeenCalled();
    result.stream.destroy();
  });
});

describe('bounded upstream work', () => {
  it.each([
    [undefined, 4], ['0', 1], ['99', 8], ['invalid', 4], ['3.8', 3],
  ])('uses a safe parallelism limit for configuration %s', async (configured, expected) => {
    vi.stubEnv('QINGREAD_UPSTREAM_CONCURRENCY', configured);
    const { fetchStream } = await import('../server/network');
    const streams: Readable[] = [];
    let completed = 0;
    const jobs = Array.from({ length: 10 }, () => fetchStream(target, 'biequgei').then(result => {
      streams.push(result.stream); completed += 1;
    }));
    await settle();
    expect(completed).toBe(expected);
    expect(responses).toHaveLength(expected);
    // Releasing one held response grants exactly one waiting request.
    streams[0].destroy();
    await settle();
    expect(completed).toBe(expected + 1);
    for (let released = 1; completed < jobs.length; released += 1) {
      streams[released].destroy();
      await settle();
    }
    for (const stream of streams) stream.destroy();
    await Promise.all(jobs);
  });

  it('rejects work beyond 32 queued requests without opening another connection', async () => {
    vi.stubEnv('QINGREAD_UPSTREAM_CONCURRENCY', '1');
    const { fetchStream } = await import('../server/network');
    const active = await fetchStream(target, 'biequgei');
    const queued = Array.from({ length: 32 }, () => fetchStream(target, 'biequgei').then(result => { result.stream.destroy(); }));
    await expect(fetchStream(target, 'biequgei')).rejects.toMatchObject({ statusCode: 503 });
    expect(responses).toHaveLength(1);
    active.stream.destroy();
    await Promise.all(queued);
    expect(responses).toHaveLength(33);
  });
});

describe('compressed response cleanup', () => {
  it.each(['gzip', 'br', 'deflate'])('closes the original %s response when the client cancels', async format => {
    encoding = format;
    const { fetchStream } = await import('../server/network');
    const result = await fetchStream(target, 'biequgei');
    const response = responses[0];
    const closed = new Promise<void>(resolve => response.once('close', resolve));
    result.stream.destroy();
    await closed;
    expect(response.destroyed).toBe(true);
  });

  it('closes a gzip response when decoded bytes exceed the limit', async () => {
    encoding = 'gzip';
    const { fetchStream } = await import('../server/network');
    const result = await fetchStream(target, 'biequgei', { maxBytes: 8 });
    const response = responses[0];
    const closed = new Promise<void>(resolve => response.once('close', resolve));
    const consume = async () => { for await (const _chunk of result.stream) { /* consume */ } };
    const rejected = expect(consume()).rejects.toMatchObject({ statusCode: 413 });
    response.write(gzipSync(Buffer.alloc(64)));
    await rejected;
    await closed;
    expect(response.destroyed).toBe(true);
  });
});

describe('download and page deadlines', () => {
  it('allows an active large download beyond three minutes but closes at ten minutes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { fetchStream } = await import('../server/network');
    const result = await fetchStream(target, 'biequgei', { timeout: 30_000, totalTimeout: 600_000 });
    result.stream.on('error', () => { /* expected deadline */ });
    expect(idleTimeouts[0].milliseconds).toBe(30_000);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(responses[0].destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(419_999);
    expect(responses[0].destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(responses[0].destroyed).toBe(true);
  });

  it('keeps the ordinary page deadline at 25 seconds and its idle limit at 18 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { fetchStream } = await import('../server/network');
    const result = await fetchStream(target, 'biequgei');
    result.stream.on('error', () => { /* expected deadline */ });
    expect(idleTimeouts[0].milliseconds).toBe(18_000);
    await vi.advanceTimersByTimeAsync(24_999);
    expect(responses[0].destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(responses[0].destroyed).toBe(true);
  });

  it('still terminates a stalled download through its separate 30 second idle timeout', async () => {
    const { fetchStream } = await import('../server/network');
    const result = await fetchStream(target, 'biequgei', { timeout: 30_000, totalTimeout: 600_000 });
    result.stream.on('error', () => { /* expected idle timeout */ });
    const closed = new Promise<void>(resolve => responses[0].once('close', resolve));
    idleTimeouts[0].fire();
    await closed;
    expect(responses[0].destroyed).toBe(true);
  });

  it('does not reset the total deadline after a redirect', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    responsePlans = [{ statusCode: 302, headers: { location: '/novel/redirected.html' }, delay: 20_000 }];
    const { fetchStream } = await import('../server/network');
    const pending = fetchStream(target, 'biequgei', { timeout: 30_000 });
    await settle();
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await pending;
    result.stream.on('error', () => { /* expected original deadline */ });
    expect(responses).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(responses[1].destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(responses[1].destroyed).toBe(true);
  });
});
