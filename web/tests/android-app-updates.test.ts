// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  android: true, available: true,
  bridge: { getState: vi.fn(), download: vi.fn(), cancel: vi.fn(), install: vi.fn() },
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isPluginAvailable: () => mocks.available }, registerPlugin: () => mocks.bridge }));
vi.mock('../src/lib/android', () => ({ isAndroidApp: () => mocks.android }));
import { androidAppUpdates, supportsAndroidAppUpdates } from '../src/lib/androidAppUpdates';

beforeEach(() => {
  vi.clearAllMocks(); mocks.android = true; mocks.available = true;
  Object.defineProperty(window, '__qingreadAppUpdateNonce', { value: 'a'.repeat(64), configurable: true });
  mocks.bridge.getState.mockResolvedValue({ status: 'idle', receivedBytes: 0, totalBytes: 0, needsPermission: false });
});
afterEach(() => { vi.useRealTimers(); delete window.__qingreadAppUpdateNonce; });
describe('document-bound Android app update bridge', () => {
  it('attaches only the native top-document nonce to state, cancel and install calls', async () => {
    await androidAppUpdates.getState(); await androidAppUpdates.cancel(); await androidAppUpdates.install();
    for (const method of ['getState', 'cancel', 'install'] as const) expect(mocks.bridge[method]).toHaveBeenCalledWith({ nonce: 'a'.repeat(64) });
  });
  it('passes just update metadata, without forwarding accidental account fields', async () => {
    const request = { apiBase: 'https://read.example/api', version: '0.12.2', build: 14,
      artifact: { url: 'https://read.example/downloads/QingRead-Android-0.12.2.apk', sha256: 'b'.repeat(64), size: 7000000 }, authToken: 'must-not-cross' };
    await androidAppUpdates.download(request);
    expect(mocks.bridge.download).toHaveBeenCalledWith({ apiBase: request.apiBase, version: request.version, build: request.build, artifact: request.artifact, nonce: 'a'.repeat(64) });
  });
  it('does not call native code on the Web or an older APK without the plugin', async () => {
    mocks.android = false; expect(supportsAndroidAppUpdates()).toBe(false);
    await expect(androidAppUpdates.getState()).rejects.toThrow('当前安装版本');
    mocks.android = true; mocks.available = false;
    await expect(androidAppUpdates.cancel()).rejects.toThrow('当前安装版本');
    expect(mocks.bridge.getState).not.toHaveBeenCalled(); expect(mocks.bridge.cancel).not.toHaveBeenCalled();
  });
  it('fails safely when the top-document token was not injected', async () => {
    vi.useFakeTimers(); delete window.__qingreadAppUpdateNonce;
    const result = expect(androidAppUpdates.getState()).rejects.toThrow('尚未准备好');
    await vi.advanceTimersByTimeAsync(2500); await result;
    expect(mocks.bridge.getState).not.toHaveBeenCalled();
  });
});
