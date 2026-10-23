// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AboutQingRead } from '../src/components/AboutQingRead';
const native = vi.hoisted(() => ({ android: true, getInfo: vi.fn() }));
vi.mock('@capacitor/app', () => ({ App: { getInfo: native.getInfo } }));
vi.mock('../src/lib/android', () => ({ isAndroidApp: () => native.android, useAndroidBack: vi.fn() }));
let host: HTMLDivElement, root: Root;
const feed = () => ({ schemaVersion: 1, publishedAt: '2026-10-23T12:00:00Z', platforms: { ios: { version: '0.11.0', build: 16, notes: [] }, web: { version: '0.11.0', notes: [] }, android: { version: '0.10.1', build: 501, notes: ['新功能'] } } });
const button = (label: string) => [...host.querySelectorAll('button')].find(item => item.textContent === label)!;
async function click(label: string) { await act(async () => { button(label).click(); await new Promise(resolve => setTimeout(resolve, 0)); }); }
beforeEach(async () => {
  native.android = true;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.setItem('qingread.apiBase', 'https://read.example/api');
  native.getInfo.mockResolvedValue({ version: '0.10.1', build: '500' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(feed()))));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => {}) } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<AboutQingRead/>));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); localStorage.clear(); delete (navigator as unknown as Record<string, unknown>).serviceWorker; vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('offline about page and Android update entry', () => {
  it('shows the actual installed build and leaves checking behind a user action', async () => {
    expect(host.textContent).toContain('Android 0.10.1 (500)'); expect(fetch).not.toHaveBeenCalled();
    await click('检查'); expect(host.textContent).toContain('发现新版本 0.10.1 (501)');
    expect(host.textContent).toContain('安装包尚未发布'); expect(host.querySelector('a[href$=".apk"]')).toBeNull();
    expect(fetch).toHaveBeenCalledWith('https://read.example/qingread/releases.json', expect.objectContaining({ credentials: 'omit', redirect: 'error' }));
  });
  it('shows a safe APK link only for a newer release with size and digest', async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ ...feed(), platforms: { ...feed().platforms, android: { ...feed().platforms.android, artifact: { url: '/downloads/QingRead-Android-0.11.0.apk', sha256: 'a'.repeat(64), size: 7_000_000 } } } })));
    await click('检查'); const link = host.querySelector<HTMLAnchorElement>('a[href$=".apk"]')!;
    expect(link.href).toBe('https://read.example/downloads/QingRead-Android-0.11.0.apk'); expect(link.target).toBe('_blank');
    expect(host.textContent).toContain('签名一致'); expect(host.textContent).toContain('a'.repeat(64));
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
    await act(async () => root.render(<AboutQingRead key="web"/>));
    await click('检查');
    expect(registration.update).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('网页资源检查失败'); expect(host.textContent).not.toContain('当前已是最新版本');
  });
});
