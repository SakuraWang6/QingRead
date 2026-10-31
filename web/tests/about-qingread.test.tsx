// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost/"}
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AboutQingRead } from '../src/components/AboutQingRead';
import { AndroidUpdateStore } from '../src/lib/androidUpdateStore';
import { readClientIdentity } from '../src/lib/appIdentity';
import { fetchReleaseManifest } from '../src/lib/appUpdates';
import { serverConnectionStore } from '../src/lib/connection';
const native = vi.hoisted(() => ({ android: true, getInfo: vi.fn() }));
vi.mock('@capacitor/app', () => ({ App: { getInfo: native.getInfo } }));
vi.mock('../src/lib/android', () => ({ isAndroidApp: () => native.android, useAndroidBack: vi.fn() }));
let host: HTMLDivElement, root: Root, updates: AndroidUpdateStore;
const bridge = { getState: vi.fn(), download: vi.fn(), cancel: vi.fn(), install: vi.fn() };
const feed = () => ({ schemaVersion: 1, publishedAt: '2026-10-23T12:00:00Z', platforms: { ios: { version: '0.11.0', build: 16, notes: [] }, web: { version: '0.11.0', notes: [] }, android: { version: '0.10.1', build: 501, notes: ['新功能'] } } });
const button = (label: string) => [...host.querySelectorAll('button')].find(item => item.textContent === label)!;
async function click(label: string) { await act(async () => { button(label).click(); await new Promise(resolve => setTimeout(resolve, 0)); }); }
beforeEach(async () => {
  native.android = true;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.setItem('qingread.apiBase', 'https://read.example/api');
  native.getInfo.mockResolvedValue({ version: '0.10.1', build: '500' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(feed()))));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => {}) } });
  bridge.getState.mockResolvedValue({ status: 'idle', receivedBytes: 0, totalBytes: 0, needsPermission: false });
  bridge.download.mockResolvedValue({ status: 'downloading', receivedBytes: 0, totalBytes: 7_000_000, needsPermission: false });
  updates = new AndroidUpdateStore({ native: () => native.android, address: () => serverConnectionStore().apiAddress(), now: Date.now, visible: () => true, online: () => true, identity: readClientIdentity, manifest: fetchReleaseManifest, bridge, storage: localStorage });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<AboutQingRead updates={updates}/>));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); localStorage.clear(); delete (window as unknown as Record<string, unknown>).__QINGREAD_HARMONY__; delete (navigator as unknown as Record<string, unknown>).serviceWorker; vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('offline about page and Android update entry', () => {
  it('shows Harmony identity and never substitutes another platform when its release is missing', async () => {
    native.android = false;
    Object.defineProperty(window, '__QINGREAD_HARMONY__', { configurable: true, value: { bridgeVersion: 1, version: '0.11.0', build: '1' } });
    await act(async () => root.render(<AboutQingRead key="harmony" updates={updates}/>));
    expect(host.textContent).toContain('HarmonyOS 0.11.0 (1)');
    await click('检查'); expect(host.textContent).toContain('当前服务尚未发布鸿蒙版本信息');
    expect(host.textContent).not.toContain('当前已是最新版本'); expect(host.textContent).not.toContain('更新网页'); expect(host.querySelector('a[href$=".apk"]')).toBeNull();
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ ...feed(), platforms: { ...feed().platforms, harmony: { version: '0.11.0', build: 2, notes: ['鸿蒙更新'] } } })));
    await click('检查'); expect(host.textContent).toContain('发现新版本 0.11.0 (2)'); expect(host.textContent).toContain('同一签名的新 HAP');
    expect(host.querySelector('a[href$=".hap"]')).toBeNull();
    await click('使用说明'); expect(host.textContent).not.toContain('APK'); expect(host.textContent).not.toContain('iPhone 自签版');
  });
  it('shows the actual installed build and leaves checking behind a user action', async () => {
    expect(host.textContent).toContain('Android 0.10.1 (500)'); expect(fetch).not.toHaveBeenCalled();
    await click('检查'); expect(host.textContent).toContain('发现新版本 0.10.1 (501)');
    expect(host.textContent).toContain('安装包尚未发布'); expect(host.querySelector('a[href$=".apk"]')).toBeNull();
    expect(fetch).toHaveBeenCalledWith('https://read.example/qingread/releases.json', expect.objectContaining({ credentials: 'omit', redirect: 'error' }));
  });
  it('downloads a newer APK through the native verifier with its exact size and digest', async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ ...feed(), platforms: { ...feed().platforms, android: { ...feed().platforms.android, artifact: { url: '/downloads/QingRead-Android-0.11.0.apk', sha256: 'a'.repeat(64), size: 7_000_000 } } } })));
    await click('检查'); expect(host.querySelector('a[href$=".apk"]')).toBeNull();
    await click('更新至 0.10.1');
    expect(bridge.download).toHaveBeenCalledWith({ apiBase: 'https://read.example/api', artifact: { url: 'https://read.example/downloads/QingRead-Android-0.11.0.apk', sha256: 'a'.repeat(64), size: 7_000_000 }, version: '0.10.1', build: 501 });
    expect(host.textContent).toContain('覆盖安装');
  });
  it('never offers an older Android version even when it carries a larger build and valid APK', async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ ...feed(), platforms: { ...feed().platforms, android: { version: '0.9.0', build: 9999, notes: [], artifact: { url: '/downloads/older.apk', sha256: 'a'.repeat(64), size: 7_000_000 } } } })));
    await click('检查'); expect(host.textContent).toContain('当前版本高于服务端发布版本'); expect(host.querySelector('a[href$=".apk"]')).toBeNull();
  });
  it('keeps help, history and licenses readable offline and copies only explicit identity information', async () => {
    await click('更新日志'); expect(host.textContent).toContain('0.11.0'); await click('关于清读');
    await click('使用说明'); expect(host.textContent).toContain('阅读与笔记'); await click('关于清读');
    await click('许可与致谢'); expect(host.textContent).toContain('PolyForm Strict'); expect(host.textContent).toContain('第三方许可'); await click('关于清读');
    expect(fetch).not.toHaveBeenCalled(); await click('问题反馈'); await click('复制版本信息');
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('清读 0.10.1 (500)\n平台：Android');
    expect(host.querySelector<HTMLAnchorElement>('a')!.href).toBe('https://github.com/SakuraWang6/QingRead/issues/new');
  });
  it('does not say latest when a Web resource check fails despite a valid remote manifest', async () => {
    native.android = false;
    const registration = Object.assign(new EventTarget(), { scope: new URL(import.meta.env.BASE_URL, location.href).href, waiting: null, installing: null, update: vi.fn(async () => { throw new Error('offline'); }) });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: vi.fn(async () => registration) } });
    await act(async () => root.render(<AboutQingRead key="web" updates={updates}/>));
    await click('检查');
    expect(registration.update).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('网页资源检查失败'); expect(host.textContent).not.toContain('当前已是最新版本');
  });
});
