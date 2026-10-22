// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { cancelPendingPushChanges, disablePush, enablePush, type PushAuth } from '../src/lib/pushNotifications';

const auth = { apiAddress: '/api', session: { token: 'a'.repeat(43), user: { id: 'my-user', username: 'reader' }, expiresAt: '', serverTime: '' } } satisfies PushAuth;
const key = 'B' + 'a'.repeat(86);
const configuration = { enabled: true, publicKey: key, maxBooks: 20, intervalMinutes: 60 };
let worker: { scope: string; active: object; pushManager: { getSubscription: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> }; getNotifications: ReturnType<typeof vi.fn> };
let value: { endpoint: string; options: { applicationServerKey: ArrayBuffer | null }; unsubscribe: ReturnType<typeof vi.fn>; toJSON(): object };
beforeEach(() => {
  cancelPendingPushChanges();
  value = { endpoint: 'https://web.push.apple.com/push/example', options: { applicationServerKey: null }, unsubscribe: vi.fn(async () => true), toJSON() { return { endpoint: this.endpoint, keys: { auth: 'test', p256dh: 'test' } }; } };
  worker = { scope: new URL('/', window.location.href).href, active: {}, pushManager: { getSubscription: vi.fn(async () => null), subscribe: vi.fn(async () => value) }, getNotifications: vi.fn(async () => []) };
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal('Notification', { requestPermission: vi.fn(async () => 'granted') });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  vi.stubGlobal('crypto', webcrypto);
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: vi.fn(async () => worker) } });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...configuration, devices: 1, subscriptionIDs: [], bookIDs: ['book'] }), { status: 200 })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('user-controlled push subscription client', () => {
  it('requests permission in the click stack before syncing, then posts only with the account session', async () => {
    const prepare = vi.fn(async () => { expect(Notification.requestPermission).toHaveBeenCalledTimes(1); });
    await enablePush(auth, configuration, ['book'], prepare);
    expect(prepare).toHaveBeenCalledTimes(1); expect(worker.pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.map(call => call[0])).toEqual(['/api/push/subscribe', '/api/push/books']);
    expect(calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer ' + auth.session.token });
    expect(JSON.parse(calls[1][1]?.body as string)).toEqual({ bookIDs: ['book'] });
  });
  it('always removes the local subscription and notifications when the server cannot be reached', async () => {
    const close = vi.fn(); worker.pushManager.getSubscription.mockResolvedValue(value); worker.getNotifications.mockResolvedValue([{ close }]);
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    await expect(disablePush(auth)).rejects.toThrow('offline');
    expect(value.unsubscribe).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
  });
  it('does not register a subscription after the user switches account during permission UI', async () => {
    let grant!: (value: NotificationPermission) => void;
    vi.mocked(Notification.requestPermission).mockImplementation(() => new Promise(resolve => { grant = resolve; }));
    const pending = enablePush(auth, configuration, ['book']);
    cancelPendingPushChanges(); grant('granted');
    await expect(pending).rejects.toThrow('账号或页面'); expect(fetch).not.toHaveBeenCalled(); expect(worker.pushManager.subscribe).not.toHaveBeenCalled();
  });
  it('refuses a different service-worker scope on the shared host', async () => {
    worker.scope += 'other-project/';
    await expect(enablePush(auth, configuration, ['book'])).rejects.toThrow('通知组件正在更新'); expect(fetch).not.toHaveBeenCalled();
  });
  it('shows a generic notification and opens only its own PWA scope', async () => {
    const handlers = new Map<string, (event: Record<string, unknown>) => void>(), showNotification = vi.fn(async () => {}), focus = vi.fn(async () => {}), openWindow = vi.fn(async () => {});
    const self = { addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) => handlers.set(type, handler), registration: { scope: 'https://read.example.com/qingread/', showNotification }, clients: { matchAll: async () => [{ url: 'https://read.example.com/private/', focus: vi.fn() }, { url: 'https://read.example.com/qingread/', focus }], openWindow } };
    vm.runInNewContext(await readFile(resolve('public/push-worker.js'), 'utf8'), { self, URL });
    let work: Promise<unknown> | undefined;
    handlers.get('push')!({ data: { json: () => ({ title: 'private book', account: 'private account' }) }, waitUntil: (promise: Promise<unknown>) => { work = promise; } }); await work;
    expect(showNotification).toHaveBeenCalledWith('清读', expect.objectContaining({ body: '书架有新章节，打开查看。' }));
    expect(JSON.stringify(showNotification.mock.calls)).not.toContain('private book');
    handlers.get('notificationclick')!({ notification: { close: vi.fn() }, waitUntil: (promise: Promise<unknown>) => { work = promise; } }); await work;
    expect(focus).toHaveBeenCalledTimes(1); expect(openWindow).not.toHaveBeenCalled();
  });
});
