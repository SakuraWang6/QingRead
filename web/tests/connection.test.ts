import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionStore, normalizeApiAddress, authenticationRequiredEvent } from '../src/lib/connection';
import { api } from '../src/lib/api';

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  get size() { return this.values.size; }
}
function storage() {
  const local = new MemoryStorage(), session = new MemoryStorage();
  return { local, session, store: new ConnectionStore(local, session, 'https://reader.example') };
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('server access-code binding', () => {
  it('does not persist or restore access codes when native secure storage is unavailable', () => {
    const local = new MemoryStorage(), session = new MemoryStorage();
    const remembered = new ConnectionStore(local, session, 'https://localhost', 'https://read.example');
    remembered.save('', 'old-token', true);
    const store = new ConnectionStore(local, new MemoryStorage(), 'https://localhost', 'https://read.example', false);
    expect(store.load()).toMatchObject({ token: '', remember: false });
    store.save('', 'session-only', true);
    expect(store.load()).toMatchObject({ token: 'session-only', remember: false });
    expect(local.getItem('qingread.connection.remembered.v1')).toBeNull();
  });
  it('normalizes equivalent service URLs while keeping different service paths distinct', () => {
    expect(normalizeApiAddress('', 'https://reader.example')).toBe('https://reader.example/api');
    expect(normalizeApiAddress('HTTPS://API.EXAMPLE:443/reader///', 'https://reader.example')).toBe('https://api.example/reader/api');
    expect(normalizeApiAddress('https://api.example/reader/api/', 'https://reader.example')).toBe('https://api.example/reader/api');
    expect(() => normalizeApiAddress('https://user:secret@api.example', 'https://reader.example')).toThrow();
    expect(() => normalizeApiAddress('https://api.example?token=secret', 'https://reader.example')).toThrow();
  });

  it('keeps the default unchecked session credential out of persistent storage', () => {
    const { local, session, store } = storage(); store.save('', ' session-code ', false);
    expect(local.size).toBe(0); expect(store.load().remember).toBe(false);
    expect(store.tokenFor('https://reader.example/api/')).toBe('session-code');
    expect(new ConnectionStore(local, new MemoryStorage(), 'https://reader.example').load().token).toBe('');
    expect(new ConnectionStore(local, session, 'https://reader.example').load().token).toBe('session-code');
  });

  it('restores an explicitly remembered credential only for the same normalized API address', () => {
    const { local, store } = storage(); store.save('https://API.example:443/reader/', 'remembered-code', true);
    const reopened = new ConnectionStore(local, new MemoryStorage(), 'https://reader.example');
    expect(reopened.load().remember).toBe(true);
    expect(reopened.tokenFor('https://api.example/reader/api')).toBe('remembered-code');
    for (const address of ['https://other.example/api', 'https://api.example/other/api', 'http://api.example/reader/api']) expect(reopened.tokenFor(address)).toBe('');
  });

  it('never sends an old credential after the configured address changes', () => {
    const { local, store } = storage(); store.save('https://old.example', 'old-code', true);
    local.setItem('qingread.apiBase', 'https://new.example');
    expect(store.load().token).toBe(''); expect(store.load().remember).toBe(false);
    store.save('https://new.example', 'new-code', false);
    expect(store.tokenFor('https://old.example/api')).toBe('');
    expect(store.tokenFor('https://new.example/api')).toBe('new-code');
    expect(new ConnectionStore(local, new MemoryStorage(), 'https://reader.example').load().token).toBe('');
  });

  it('removes remembered access immediately when unchecked, retaining only the current session', () => {
    const { local, store } = storage(); store.save('', 'remembered-code', true);
    const session = new MemoryStorage(), reopened = new ConnectionStore(local, session, 'https://reader.example');
    expect(reopened.load().token).toBe('remembered-code');
    reopened.forgetRemembered();
    expect(reopened.load()).toMatchObject({ token: 'remembered-code', remember: false });
    expect(new ConnectionStore(local, new MemoryStorage(), 'https://reader.example').load().token).toBe('');
    reopened.save('', 'remembered-code', false);
    expect(new ConnectionStore(local, session, 'https://reader.example').load().remember).toBe(false);
  });

  it('migrates the legacy session token once to the current address and clears all token records on demand', () => {
    const { local, session, store } = storage(); session.setItem('qingread.accessToken', 'legacy-code');
    expect(store.load().token).toBe('legacy-code'); expect(session.getItem('qingread.accessToken')).toBeNull();
    local.setItem('qingread.apiBase', 'https://new.example'); expect(store.load().token).toBe('');
    store.save('https://new.example', 'new-code', true); store.clearToken();
    expect(store.load().token).toBe(''); expect(store.load().remember).toBe(false);
    expect(session.size).toBe(0); expect(local.size).toBe(1);
  });

  it('uses the bound token on real API requests and omits it for a new configured server', async () => {
    const { local, session, store } = storage(); store.save('https://old.example', 'private-code', true);
    vi.stubGlobal('localStorage', local); vi.stubGlobal('sessionStorage', session); vi.stubGlobal('location', { origin: 'https://reader.example' });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('[]', { headers: { 'Content-Type': 'application/json' } })); vi.stubGlobal('fetch', fetcher);
    await api.sources(); expect(fetcher.mock.calls[0][0]).toBe('https://old.example/api/sources');
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({ 'X-QingRead-Token': 'private-code' });
    expect(fetcher.mock.calls[0][1]?.redirect).toBe('error');
    local.setItem('qingread.apiBase', 'https://new.example'); await api.sources();
    expect(fetcher.mock.calls[1][0]).toBe('https://new.example/api/sources');
    expect(fetcher.mock.calls[1][1]?.headers).not.toHaveProperty('X-QingRead-Token');
  });

  it('guides an initial authentication failure to the connection settings', async () => {
    const { local, session } = storage(); const browser = new EventTarget(), listener = vi.fn(); browser.addEventListener(authenticationRequiredEvent, listener);
    vi.stubGlobal('localStorage', local); vi.stubGlobal('sessionStorage', session); vi.stubGlobal('location', { origin: 'https://reader.example' }); vi.stubGlobal('window', browser);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"Unauthorized"}', { status: 401 })));
    await expect(api.sources()).rejects.toThrow('设置 → 服务器连接'); expect(listener).toHaveBeenCalledOnce();
  });
});
