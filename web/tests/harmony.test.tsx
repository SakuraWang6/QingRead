// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost/"}
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { harmonyIdentity, isHarmonyApp } from '../src/lib/harmony';
import { canRememberCredentials, isNativeApp } from '../src/lib/nativePlatform';
import { disableNativeServiceWorkers, initializeAndroid, useAndroidBack } from '../src/lib/android';
import { pushSupport } from '../src/lib/pushNotifications';
const bootstrap = (info: unknown) => Object.defineProperty(window, '__QINGREAD_HARMONY__', { configurable: true, value: info });
afterEach(() => { delete (window as unknown as Record<string, unknown>).__QINGREAD_HARMONY__; delete window.__qingreadHandleNativeBack; delete (navigator as unknown as Record<string, unknown>).serviceWorker; vi.unstubAllGlobals(); });
function BackLayer({ label, priority, handle }: { label: string; priority: number; handle: () => boolean }) { useAndroidBack(handle, priority); return <span>{label}</span>; }
describe('Harmony shell boundary', () => {
  it('requires a shell marker at the bundled HTTPS origin instead of treating every Web page as native', () => {
    expect(isHarmonyApp()).toBe(false); expect(isNativeApp()).toBe(false);
    bootstrap({ bridgeVersion: 1, version: '0.11.0', build: '1' });
    expect(isHarmonyApp()).toBe(true); expect(isNativeApp()).toBe(true); expect(canRememberCredentials()).toBe(false);
    expect(harmonyIdentity()).toEqual({ bridgeVersion: 1, version: '0.11.0', build: '1' });
    bootstrap({ bridgeVersion: 2, version: '1.0.0', build: '2', capabilities: [] }); expect(harmonyIdentity()).toEqual({ bridgeVersion: 2, version: '1.0.0', build: '2' });
    vi.stubGlobal('window', { location: { origin: 'https://untrusted.example' }, navigator: { userAgent: 'QingReadHarmony/1' }, __QINGREAD_HARMONY__: { bridgeVersion: 1, version: '0.11.0', build: '1' } });
    expect(isHarmonyApp()).toBe(false); expect(() => harmonyIdentity()).toThrow('读取已安装版本');
  });
  it('fails closed on missing or corrupt installed identity instead of falling back to the Web version', () => {
    for (const info of [{ bridgeVersion: 3, version: '0.11.0', build: '1' }, { bridgeVersion: 1, version: 11, build: '1' }, { bridgeVersion: 1, version: '0.11.0', build: '' }, { bridgeVersion: 1, version: '999999999999999999', build: '1' }]) {
      bootstrap(info); expect(isHarmonyApp()).toBe(true); expect(() => harmonyIdentity()).toThrow('读取已安装版本');
    }
  });
  it('routes native Back through the existing priority stack and removes unmounted handlers', async () => {
    bootstrap({ bridgeVersion: 1, version: '0.11.0', build: '1' }); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    await initializeAndroid(); const host = document.createElement('div'), root = createRoot(host), calls: string[] = [];
    try {
      await act(async () => root.render(<><BackLayer label="root" priority={0} handle={() => { calls.push('root'); return false; }}/><BackLayer label="reader" priority={300} handle={() => { calls.push('reader'); return true; }}/></>));
      expect(window.__qingreadHandleNativeBack?.()).toBe(true); expect(calls).toEqual(['reader']);
    } finally { await act(async () => root.unmount()); }
    expect(window.__qingreadHandleNativeBack?.()).toBe(false);
  });
  it('unregisters native service workers without deleting reading storage and refuses Web Push', async () => {
    bootstrap({ bridgeVersion: 1, version: '0.11.0', build: '1' });
    const unregister = vi.fn(async () => true);
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistrations: vi.fn(async () => [{ unregister }]) } });
    localStorage.setItem('reading-data', 'preserve');
    await disableNativeServiceWorkers(); expect(unregister).toHaveBeenCalledOnce(); expect(localStorage.getItem('reading-data')).toBe('preserve');
    expect(pushSupport().supported).toBe(false); localStorage.clear();
  });
});
