// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost/"}
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountPanel } from '../src/components/AccountPanel';
import { NotificationSettings } from '../src/components/NotificationSettings';
vi.mock('../src/lib/cloud', () => ({ cloudSync: {}, useCloudSync: () => ({ session: null, busy: false, error: '' }) }));
vi.mock('../src/lib/store', () => ({ guestLibrary: { getSnapshot: () => ({ shelf: [] }) }, library: { profile: 'guest' }, useLibrary: () => ({ shelf: [], disabledSourceIDs: [] }) }));
vi.mock('../src/components/PushNotificationsPanel', () => ({ PushNotificationsPanel: () => <div>WebPush controls must not mount</div> }));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(window, '__QINGREAD_HARMONY__', { configurable: true, value: { bridgeVersion: 1, version: '0.11.0', build: '1' } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete (window as unknown as Record<string, unknown>).__QINGREAD_HARMONY__; vi.unstubAllGlobals(); });
describe('Harmony capability disclosure', () => {
  it('keeps login available while omitting unsupported persistent credentials', async () => {
    await act(async () => root.render(<AccountPanel/>));
    expect(host.querySelector('#cloud-username')).not.toBeNull(); expect(host.querySelector('#cloud-password')).not.toBeNull();
    expect(host.querySelector('input[type="checkbox"]')).toBeNull(); expect(host.textContent).toContain('仅保留本次登录');
  });
  it('shows persistent login only after a v2 secure-storage bridge is advertised', async () => {
    Object.defineProperty(window, '__QINGREAD_HARMONY__', { configurable: true, value: { bridgeVersion: 2, version: '1.0.0', build: '1', capabilities: ['secureStorage'] } });
    Object.defineProperty(window, 'QingReadNative', { configurable: true, value: { request: vi.fn() } });
    try { await act(async () => root.render(<AccountPanel/>)); expect(host.querySelector('input[type="checkbox"]')).not.toBeNull(); expect(host.textContent).toContain('保持登录'); expect(host.textContent).not.toContain('仅保留本次登录'); }
    finally { delete (window as unknown as Record<string, unknown>).QingReadNative; }
  });
  it('offers no Web Push or Android notification switches when the shell has no native notification bridge', async () => {
    await act(async () => root.render(<NotificationSettings/>));
    expect(host.textContent).toContain('暂不支持系统追更通知和本机后台下载');
    expect(host.textContent).not.toContain('WebPush controls'); expect(host.querySelector('[role="switch"]')).toBeNull();
  });
});
