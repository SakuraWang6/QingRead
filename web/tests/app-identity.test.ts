import { afterEach, describe, expect, it, vi } from 'vitest';
import { version } from '../package.json';
import { readClientIdentity, versionDiagnostics } from '../src/lib/appIdentity';
const native = vi.hoisted(() => ({ android: false, getInfo: vi.fn() }));
vi.mock('../src/lib/android', () => ({ isAndroidApp: () => native.android }));
vi.mock('@capacitor/app', () => ({ App: { getInfo: native.getInfo } }));
afterEach(() => { native.android = false; native.getInfo.mockReset(); vi.unstubAllGlobals(); });
describe('installed client identity and explicit diagnostics', () => {
  it('uses the Web package for Web, but real installed version and build for Android', async () => {
    expect(await readClientIdentity()).toEqual({ platform: 'web', version }); expect(native.getInfo).not.toHaveBeenCalled();
    native.android = true; native.getInfo.mockResolvedValue({ version: '0.9.0', build: '42', name: '清读', id: 'app.qingread.android' });
    expect(await readClientIdentity()).toEqual({ platform: 'android', version: '0.9.0', build: '42' });
  });
  it('does not silently substitute the Web bundle version when native identity fails', async () => {
    native.android = true; native.getInfo.mockRejectedValue(new Error('bridge unavailable'));
    await expect(readClientIdentity()).rejects.toThrow('读取已安装版本');
  });
  it('reads Harmony installed metadata without invoking the Android plugin', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://localhost' }, navigator: { userAgent: 'QingReadHarmony/1' }, __QINGREAD_HARMONY__: { bridgeVersion: 1, version: '0.11.0', build: '1' } });
    const identity = await readClientIdentity();
    expect(identity).toEqual({ platform: 'harmony', version: '0.11.0', build: '1' });
    expect(native.getInfo).not.toHaveBeenCalled(); expect(versionDiagnostics(identity)).toBe('清读 0.11.0 (1)\n平台：HarmonyOS');
  });
  it('copies only version/build/platform instead of account, book or server diagnostics', () => {
    const identity = { platform: 'android' as const, version: '0.11.0', build: '11', account: 'private-account', book: 'private-book', server: 'https://private.example/' };
    expect(versionDiagnostics(identity)).toBe('清读 0.11.0 (11)\n平台：Android');
  });
});
