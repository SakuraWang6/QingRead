import { afterEach, describe, expect, it, vi } from 'vitest';
import { createECDH, createHash, randomBytes } from 'node:crypto';
import webPush from 'web-push';
import { WebPushService, pushEndpoint, registerWebPushRoutes } from '../server/push';
import { CloudDatabase } from '../server/cloud';
import { createApp } from '../server/app';
import type { Book, Chapter } from '../src/shared/types';

const hour = 3_600_000;
const user = { id: 'reader-a', username: 'reader_a' }, friend = { id: 'reader-b', username: 'reader_b' };
const token = 'a'.repeat(43), authorization = 'Bearer ' + token;
const book: Book = { id: 'logical-book', title: '不能出现在通知中的书名', author: '作者', summary: '', sourceID: 'biequgei', sourceName: '来源', url: 'https://www.biequgei.com/book/' };
const services: WebPushService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); });
function browserSubscription(id = 'a') {
  const key = createECDH('prime256v1'); key.generateKeys();
  return { endpoint: 'https://web.push.apple.com/push/' + id, keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}
function fixture() {
  let now = Date.now(), count = 2, valid = true;
  const shelf = new Map<string, Book[]>([[user.id, [book]], [friend.id, []]]);
  const loadChapters = vi.fn(async (value: Book): Promise<Chapter[]> => Array.from({ length: count }, (_, index) => ({ id: value.url + index, title: `第${index + 1}章`, url: value.url + index, index })));
  const send = vi.fn(async (_subscription: webPush.PushSubscription, _payload: string) => 201);
  const service = new WebPushService(':memory:', {
    vapid: { ...webPush.generateVAPIDKeys(), subject: 'mailto:maintainer@example.com' },
    accounts: { books: value => shelf.get(value.id) ?? [], validSession: (_userID, hash) => valid && hash === createHash('sha256').update(token).digest('hex') },
    loadChapters, send, now: () => now,
  });
  services.push(service);
  return { service, loadChapters, send, shelf, advance: (milliseconds: number) => { now += milliseconds; }, count: (value: number) => { count = value; }, revoke: () => { valid = false; } };
}

describe('opt-in web push update worker', () => {
  it('does no upstream work until a user explicitly subscribes and selects owned books', async () => {
    const f = fixture(); await f.service.tick(); expect(f.loadChapters).not.toHaveBeenCalled();
    expect(() => f.service.watch(user, [book.id])).toThrow('先在此设备');
    f.service.subscribe(user, authorization, browserSubscription());
    f.advance(60_000); await f.service.tick(); expect(f.loadChapters).not.toHaveBeenCalled();
    expect(() => f.service.watch(friend, [book.id])).toThrow();
    expect(() => f.service.watch(user, ['not-on-my-shelf'])).toThrow('自己的书架');
    f.service.watch(user, [book.id]); f.advance(60_000); await f.service.tick();
    expect(f.loadChapters).toHaveBeenCalledTimes(1); expect(f.send).not.toHaveBeenCalled();
  });
  it('establishes a silent baseline and sends a generic, deduplicated reminder after append', async () => {
    const f = fixture(); f.service.subscribe(user, authorization, browserSubscription()); f.service.watch(user, [book.id]);
    await f.service.tick(); f.count(3); f.advance(hour); await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(f.send.mock.calls[0][1]);
    expect(payload.title).toBe('清读'); expect(payload.body).toBe('书架有新章节，打开查看。');
    expect(JSON.stringify(payload)).not.toContain(book.title); expect(JSON.stringify(payload)).not.toContain(user.id); expect(JSON.stringify(payload)).not.toContain(book.url);
    f.advance(hour); await f.service.tick(); expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('processes only one catalog per global minute and delays failed catalogs exponentially', async () => {
    const f = fixture(), second = { ...book, id: 'second-book', url: book.url + 'second/' };
    f.shelf.set(user.id, [book, second]); f.service.subscribe(user, authorization, browserSubscription()); f.service.watch(user, [book.id, second.id]);
    f.loadChapters.mockRejectedValueOnce(new Error('offline'));
    await f.service.tick(); await f.service.tick(); expect(f.loadChapters).toHaveBeenCalledTimes(1);
    f.advance(60_000); await f.service.tick(); expect(f.loadChapters).toHaveBeenCalledTimes(2);
    f.advance(60_000); await f.service.tick(); expect(f.loadChapters).toHaveBeenCalledTimes(2);
    f.loadChapters.mockRejectedValueOnce(new Error('still offline')); f.advance(hour); await f.service.tick();
    expect(f.loadChapters).toHaveBeenCalledTimes(3);
    f.advance(hour); await f.service.tick(); expect(f.loadChapters).toHaveBeenCalledTimes(4); // only the successful second book is due
  });
  it('prevents endpoint theft and cross-account unsubscription, and enforces small limits', () => {
    const f = fixture(), value = browserSubscription(); f.service.subscribe(user, authorization, value);
    expect(() => f.service.subscribe(friend, authorization, value)).toThrow('其他账号');
    f.service.unsubscribe(friend, value.endpoint); expect(f.service.status(user).devices).toBe(1);
    for (let index = 1; index < 5; index++) f.service.subscribe(user, authorization, browserSubscription(String(index)));
    expect(() => f.service.subscribe(user, authorization, browserSubscription('too-many'))).toThrow('上限');
    expect(() => f.service.watch(user, Array.from({ length: 21 }, (_, index) => 'book-' + index))).toThrow('20');
    expect(f.service.status(friend).subscriptionIDs).toEqual([]);
  });
  it('removes invalid sessions and expired push endpoints without fetching other accounts', async () => {
    const f = fixture(); f.service.subscribe(user, authorization, browserSubscription()); f.service.watch(user, [book.id]);
    await f.service.tick(); f.count(3); f.send.mockResolvedValueOnce(410); f.advance(hour); await f.service.tick();
    expect(f.service.status(user).devices).toBe(0); expect(f.service.status(user).bookIDs).toEqual([]);
    f.service.subscribe(user, authorization, browserSubscription('replacement')); f.service.watch(user, [book.id]); f.revoke();
    f.advance(hour); await f.service.tick(); expect(f.service.status(user).devices).toBe(0); expect(f.loadChapters).toHaveBeenCalledTimes(2);
  });
  it('preserves pending delivery during cooldown but clears it when the book is removed', async () => {
    const f = fixture(); f.service.subscribe(user, authorization, browserSubscription()); f.service.watch(user, [book.id]); await f.service.tick();
    f.count(3); f.send.mockResolvedValueOnce(503); f.advance(hour); await f.service.tick(); expect(f.send).toHaveBeenCalledTimes(1);
    f.advance(60_000); await f.service.tick(); expect(f.send).toHaveBeenCalledTimes(1);
    f.shelf.set(user.id, []); f.advance(15 * 60_000); await f.service.tick(); expect(f.send).toHaveBeenCalledTimes(1); expect(f.service.status(user).bookIDs).toEqual([]);
  });
  it('treats source changes and unmatched catalog reorderings as new silent baselines', async () => {
    const f = fixture(); f.service.subscribe(user, authorization, browserSubscription()); f.service.watch(user, [book.id]); await f.service.tick();
    f.shelf.set(user.id, [{ ...book, sourceID: 'other-source', url: 'https://other.example/new/' }]); f.count(6); f.advance(hour); await f.service.tick();
    expect(f.send).not.toHaveBeenCalled();
    f.loadChapters.mockResolvedValueOnce([{ id: 'unknown', title: '全新章节名', url: 'https://other.example/unknown', index: 0 }]); f.advance(hour); await f.service.tick();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('rejects private, arbitrary or malformed subscription endpoints before making a request', () => {
    for (const url of ['http://web.push.apple.com/push/a', 'https://127.0.0.1/push', 'https://metadata.google.internal/push', 'https://web.push.apple.com.evil.invalid/a', 'https://web.push.apple.com:8443/a', 'https://user:pass@web.push.apple.com/a']) expect(() => pushEndpoint(url)).toThrow();
    const f = fixture(); expect(() => f.service.subscribe(user, authorization, { ...browserSubscription(), keys: { p256dh: 'a'.repeat(87), auth: 'a'.repeat(22) } })).toThrow('密钥');
  });
  it('requires account authentication for subscription routes and permits a disabled configuration', async () => {
    const cloud = new CloudDatabase(':memory:');
    const app = await createApp({ serveWeb: false, cloud });
    try {
      expect((await app.inject({ method: 'GET', url: '/api/push/config' })).json().enabled).toBe(false);
      const enabled = fixture(), separate = (await import('fastify')).default({ logger: false });
      registerWebPushRoutes(separate, cloud, enabled.service);
      services.splice(services.indexOf(enabled.service), 1);
      try { const response = await separate.inject({ method: 'POST', url: '/api/push/subscribe', payload: { subscription: browserSubscription() } }); expect(response.statusCode).toBe(401); }
      finally { await separate.close(); }
    } finally { await app.close(); }
  });
});
