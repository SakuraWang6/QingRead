import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareRelease, fetchReleaseManifest, parseReleaseManifest, resolveManifestURL } from '../src/lib/appUpdates';
const address = 'https://read.example/qingread/releases.json';
const feed = () => ({ schemaVersion: 1, publishedAt: '2026-10-23T12:00:00Z', platforms: { ios: { version: '0.11.0', build: 16, notes: ['更新'] }, web: { version: '0.11.0', notes: ['更新'] }, android: { version: '0.11.0', build: 11, notes: ['更新'] } } });
afterEach(() => vi.useRealTimers());
describe('client release manifests', () => {
  it('compares numeric versions then installed native builds without allowing version downgrades', () => {
    expect(compareRelease({ version: '0.9.0' }, { version: '0.11.0', notes: [] })).toBe(1);
    expect(compareRelease({ version: '0.11.0', build: '10' }, { version: '0.11.0', build: 11, notes: [] })).toBe(1);
    expect(compareRelease({ version: '0.11.0', build: '12' }, { version: '0.11.0', build: 11, notes: [] })).toBe(-1);
    expect(compareRelease({ version: '1.0.0', build: '2' }, { version: '0.99.0', build: 999, notes: [] })).toBe(-1);
    expect(compareRelease({ version: '1.0' }, { version: '1.0.0', notes: [] })).toBe(0);
    expect(() => compareRelease({ version: '1.0beta' }, { version: '1.0.0', notes: [] })).toThrow();
  });
  it('uses the Web scope or configured Android HTTPS service origin, never a bundled manifest', () => {
    expect(resolveManifestURL('web', '/qingread/', 'https://read.example/other/', '', '/ignore.json')).toBe(address);
    expect(resolveManifestURL('android', '/', 'https://localhost/', 'https://read.example/api', '/qingread/releases.json')).toBe(address);
    expect(() => resolveManifestURL('android', '/', 'https://localhost/', 'http://read.example/api', '/qingread/releases.json')).toThrow();
    expect(() => resolveManifestURL('android', '/', 'https://localhost/', 'https://user:pass@read.example/api', '/qingread/releases.json')).toThrow();
  });
  it('allows a complete same-origin download artifact and permits releases without an APK', () => {
    expect(parseReleaseManifest(feed(), address).platforms.android.artifact).toBeUndefined();
    const value = { ...feed(), platforms: { ...feed().platforms, android: { ...feed().platforms.android, artifact: { url: '/downloads/QingRead-Android-0.11.0.apk', sha256: 'a'.repeat(64), size: 7_000_000 } } } };
    expect(parseReleaseManifest(value, address).platforms.android.artifact?.url).toBe('https://read.example/downloads/QingRead-Android-0.11.0.apk');
    for (const url of ['https://evil.example/downloads/app.apk', 'http://read.example/downloads/app.apk', '//evil.example/downloads/app.apk', '/api/file.apk', '/downloads/app.apk?token=secret', '/downloads/%2e%2e/app.apk', 'javascript:alert(1)']) {
      const bad = structuredClone(value); bad.platforms.android.artifact.url = url;
      expect(() => parseReleaseManifest(bad, address)).toThrow();
    }
    value.platforms.android.artifact.sha256 = 'bad'; expect(() => parseReleaseManifest(value, address)).toThrow();
  });
  it('rejects malformed/incomplete feeds instead of claiming the client is current', () => {
    for (const value of [null, {}, { ...feed(), schemaVersion: 2 }, { ...feed(), publishedAt: 'bad-date' }, { ...feed(), platforms: { web: feed().platforms.web } }, { ...feed(), platforms: { ...feed().platforms, android: { version: '0.11.0', notes: [] } } }]) expect(() => parseReleaseManifest(value, address)).toThrow();
  });
  it('fetches without credentials, redirects, cache reuse or custom preflight headers', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(feed())));
    await expect(fetchReleaseManifest(address, { fetcher: fetcher as typeof fetch })).resolves.toMatchObject({ schemaVersion: 1 });
    expect(fetcher).toHaveBeenCalledWith(address, { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: expect.any(AbortSignal) });
  });
  it('enforces the 64 KiB limit even when no content-length header is present', async () => {
    await expect(fetchReleaseManifest(address, { fetcher: vi.fn(async () => new Response(' '.repeat(65_537))) as typeof fetch })).rejects.toThrow('版本信息');
    await expect(fetchReleaseManifest(address, { fetcher: vi.fn(async () => new Response('{}', { headers: { 'content-length': '65537' } })) as typeof fetch })).rejects.toThrow('版本信息');
  });
  it('times out and honors cancellation without turning a network error into latest', async () => {
    vi.useFakeTimers();
    const fetcher: typeof fetch = vi.fn((_url, options) => new Promise<Response>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('', 'AbortError')), { once: true })));
    const timeout = expect(fetchReleaseManifest(address, { fetcher, timeoutMs: 100 })).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(101); await timeout;
    const controller = new AbortController(); const aborted = expect(fetchReleaseManifest(address, { fetcher, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' }); controller.abort(); await aborted;
    await expect(fetchReleaseManifest(address, { fetcher: vi.fn(async () => { throw new TypeError('offline'); }) as typeof fetch })).rejects.toThrow('暂时无法');
  });
});
