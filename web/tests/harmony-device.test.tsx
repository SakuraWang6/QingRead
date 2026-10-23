// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost/"}
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReaderDeviceStatus } from '../src/components/ReaderDeviceStatus';
let root: Root, host: HTMLDivElement;
function native(capabilities: string[], level: unknown) {
  const request = vi.fn(async(raw: string) => { const value = JSON.parse(raw); return JSON.stringify({ id: value.id, ok: true, result: { level } }); });
  Object.defineProperty(window, '__QINGREAD_HARMONY__', { configurable: true, value: { bridgeVersion: 2, version: '1.0.0', build: '1', capabilities } });
  Object.defineProperty(window, 'QingReadNative', { configurable: true, value: { request } }); return request;
}
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async() => { await act(async()=>root.unmount()); host.remove(); delete (window as unknown as Record<string, unknown>).__QINGREAD_HARMONY__; delete (window as unknown as Record<string, unknown>).QingReadNative; vi.unstubAllGlobals(); });
describe('Harmony reading battery status', () => {
  it('shows the actual native battery percentage when explicitly available', async() => {
    const request = native(['battery'], 76); await act(async()=>root.render(<ReaderDeviceStatus/>));
    expect(host.querySelector('[aria-label="电量 76%"]')).not.toBeNull(); expect(JSON.parse(request.mock.calls[0][0]).method).toBe('battery.get');
  });
  it('hides an invalid native value instead of fabricating battery information', async() => {
    native(['battery'], 140); await act(async()=>root.render(<ReaderDeviceStatus/>)); expect(host.querySelector('[aria-label^="电量"]')).toBeNull(); expect(host.querySelector('time')).not.toBeNull();
  });
  it('keeps time available without calling an unadvertised bridge', async() => {
    const request = native([], 99); await act(async()=>root.render(<ReaderDeviceStatus/>)); expect(request).not.toHaveBeenCalled(); expect(host.querySelector('time')).not.toBeNull();
  });
});
