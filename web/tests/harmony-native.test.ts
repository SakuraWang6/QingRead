// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost/"}
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearHarmonyCredential, exportHarmonyBackup, hasHarmonyCapability, harmonyRequest, loadHarmonyCredential, saveHarmonyCredential } from '../src/lib/harmonyNative';
import { canRememberCredentials } from '../src/lib/nativePlatform';
import { ReaderSpeech, observeSpeechVoices } from '../src/lib/speech';
import { initializeHarmonyConnection, harmonyConnectionStorage } from '../src/lib/harmonyConnection';
import { serverConnectionStore } from '../src/lib/connection';
interface Request { id: string; method: string; params: Record<string, unknown> }
let requests: Request[];
let handler: (request: Request) => unknown;
function bootstrap(capabilities: string[] = ['speech', 'battery', 'exportBackup', 'secureStorage']) {
  Object.defineProperty(window, '__QINGREAD_HARMONY__', { configurable: true, value: { bridgeVersion: 2, version: '1.0.0', build: '1', capabilities } });
  Object.defineProperty(window, 'QingReadNative', { configurable: true, value: { request: vi.fn(async (raw: string) => {
    const request: Request = JSON.parse(raw); requests.push(request);
    try { return JSON.stringify({ id: request.id, ok: true, result: await handler(request) }); }
    catch (error) { return JSON.stringify({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }); }
  }) } });
}
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); requests = []; handler = () => ({}); bootstrap(); });
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__QINGREAD_HARMONY__; delete (window as unknown as Record<string, unknown>).QingReadNative;
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear();
});
const emit = (utteranceID: unknown, type: string, extra = {}) => window.dispatchEvent(new CustomEvent('qingread:harmony-speech', { detail: { utteranceID, type, ...extra } }));
const options = () => ({ rate: 1, voiceIdentifier: '', onPosition: vi.fn(), onEnd: vi.fn(), onError: vi.fn() });
const speaks = () => requests.filter(request => request.method === 'speech.speak');

describe('Harmony explicit native boundary', () => {
  it('requires a matching origin, advertised capability and a real request bridge', async () => {
    bootstrap([]); expect(hasHarmonyCapability('speech')).toBe(false); expect(canRememberCredentials()).toBe(false);
    await expect(harmonyRequest('speech', 'speech.speak')).rejects.toThrow('暂不支持'); expect(requests).toHaveLength(0);
    bootstrap(); expect(canRememberCredentials()).toBe(true);
    Object.defineProperty(window, '__QINGREAD_HARMONY__', { configurable: true, value: { bridgeVersion: 1, capabilities: ['secureStorage'] } }); expect(canRememberCredentials()).toBe(false); bootstrap();
    vi.stubGlobal('window', { location: { origin: 'https://elsewhere.example' }, __QINGREAD_HARMONY__: { bridgeVersion: 2, capabilities: ['speech'] }, QingReadNative: { request: vi.fn() } });
    expect(hasHarmonyCapability('speech')).toBe(false);
  });
  it('rejects mismatched replies instead of trusting a stale bridge response', async () => {
    Object.defineProperty(window, 'QingReadNative', { configurable: true, value: { request: async () => JSON.stringify({ id: 'other-document', ok: true, result: { value: 'secret' } }) } });
    await expect(loadHarmonyCredential('cloud')).rejects.toThrow('无效数据');
  });
  it('enforces the system ASSET UTF-8 limit before saving secrets', async () => {
    await expect(saveHarmonyCredential('cloud', '😀'.repeat(257))).rejects.toThrow('过长'); expect(requests).toHaveLength(0);
    await saveHarmonyCredential('connection', 'bound-token'); await clearHarmonyCredential('connection');
    expect(requests.map(request => [request.method, request.params.slot])).toEqual([['credentials.save', 'connection'], ['credentials.clear', 'connection']]);
  });
  it('exports a UTF-8 backup in bounded chunks and waits for the user save result', async () => {
    const content = JSON.stringify({ title: '甲'.repeat(8190) + '😀', progress: 42 });
    handler = request => request.method === 'export.begin' ? { exportID: 'test-export' } : request.method === 'export.commit' ? { saved: true } : {};
    expect(await exportHarmonyBackup('清读备份-2026-10-23.json', new NodeBlob([content]) as unknown as Blob)).toBe(true);
    expect(requests[0].params.size).toBe(new TextEncoder().encode(content).length);
    expect(requests.filter(request => request.method === 'export.append').map(request => request.params.content).join('')).toBe(content);
    expect(requests.at(-1)?.method).toBe('export.commit');
  });
  it('transfers a valid large backup without exceeding the native rolling request budget', async () => {
    vi.useFakeTimers();
    const content = JSON.stringify({ format: 'qingread-backup', version: 1, text: 'a'.repeat(5 * 1024 * 1024) });
    const timestamps: number[] = []; let largestWindow = 0, received = 0;
    handler = request => {
      const now = Date.now(); while (timestamps.length && timestamps[0] <= now - 10_000) timestamps.shift(); timestamps.push(now); largestWindow = Math.max(largestWindow, timestamps.length);
      if (timestamps.length > 512) throw new Error('请求过于频繁');
      if (request.method === 'export.begin') return { exportID: 'large-export' };
      if (request.method === 'export.append') received += new TextEncoder().encode(String(request.params.content)).length;
      return request.method === 'export.commit' ? { saved: true } : {};
    };
    const started = Date.now(); const operation = exportHarmonyBackup('清读备份-2026-10-23.json', { size: content.length, text: async () => content } as Blob);
    await vi.runAllTimersAsync(); expect(await operation).toBe(true);
    expect(received).toBe(new TextEncoder().encode(content).length); expect(largestWindow).toBeLessThanOrEqual(256);
    expect(Date.now() - started).toBeGreaterThanOrEqual(20_000); expect(Date.now() - started).toBeLessThan(300_000);
  });
  it('treats picker cancellation as no save and cancels incomplete transfers on error', async () => {
    handler = request => request.method === 'export.begin' ? { exportID: 'cancel-test' } : request.method === 'export.commit' ? { saved: false } : {};
    expect(await exportHarmonyBackup('清读备份-2026-10-23.json', new NodeBlob(['{}']) as unknown as Blob)).toBe(false);
    handler = request => { if (request.method === 'export.begin') return { exportID: 'broken-test' }; if (request.method === 'export.append') throw new Error('写入失败'); return {}; };
    await expect(exportHarmonyBackup('清读备份-2026-10-23.json', new NodeBlob(['{}']) as unknown as Blob)).rejects.toThrow('写入失败');
    expect(requests.at(-1)?.method).toBe('export.cancel');
  });
});

describe('Harmony installed system speech', () => {
  it('changes speed without restarting a sentence, then continues with the new speed', async () => {
    const speech = new ReaderSpeech(), callbacks = options();
    speech.start('第一句。第二句。', 0, callbacks); await vi.waitFor(() => expect(speaks()).toHaveLength(1));
    const first = speaks()[0]; speech.update(1.5, ''); await vi.waitFor(() => expect(requests.some(request => request.method === 'speech.rate')).toBe(true));
    expect(speaks()).toHaveLength(1); emit(first.params.utteranceID, 'end');
    await vi.waitFor(() => expect(speaks()).toHaveLength(2)); expect(speaks()[1].params).toMatchObject({ text: '第二句。', rate: 1.5 });
    emit(first.params.utteranceID, 'end'); expect(speaks()).toHaveLength(2);
    emit(speaks()[1].params.utteranceID, 'end'); expect(callbacks.onEnd).toHaveBeenCalledOnce(); speech.stop();
  });
  it('resumes at a native phrase boundary and ignores completions from before pause', async () => {
    const speech = new ReaderSpeech(), callbacks = options();
    speech.start('甲乙丙丁。', 0, callbacks); await vi.waitFor(() => expect(speaks()).toHaveLength(1));
    const first = speaks()[0]; emit(first.params.utteranceID, 'boundary', { charIndex: 2 }); speech.pause();
    emit(first.params.utteranceID, 'end'); expect(callbacks.onEnd).not.toHaveBeenCalled(); speech.resume();
    await vi.waitFor(() => expect(speaks()).toHaveLength(2)); expect(speaks()[1].params.text).toBe('丙丁。');
    speech.stop(); emit(speaks()[1].params.utteranceID, 'end'); expect(callbacks.onEnd).not.toHaveBeenCalled();
  });
  it('reports native voice failures without advancing the chapter', async () => {
    const speech = new ReaderSpeech(), callbacks = options(); speech.start('设备没有音色。', 0, callbacks);
    await vi.waitFor(() => expect(speaks()).toHaveLength(1)); emit(speaks()[0].params.utteranceID, 'error', { message: '请安装中文离线音色' });
    expect(callbacks.onError).toHaveBeenCalledWith('请安装中文离线音色'); expect(callbacks.onEnd).not.toHaveBeenCalled(); expect(speech.speaking).toBe(false); speech.stop();
  });
  it('lists only actual installed offline voices and ignores a late list after unmount', async () => {
    handler = () => ({ voices: [{ id: 'offline-woman', name: '中文女声', lang: 'zh-CN', localService: true }, { id: 'remote', name: 'Remote', lang: 'zh-CN', localService: false }] });
    const update = vi.fn(), detach = observeSpeechVoices(update);
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith([{ voiceURI: 'offline-woman', name: '中文女声', lang: 'zh-CN', localService: true }])); detach();
    const late = vi.fn(), remove = observeSpeechVoices(late); remove(); await Promise.resolve(); await Promise.resolve(); expect(late).not.toHaveBeenCalled();
  });
});

describe('Harmony secure server connection', () => {
  it('hydrates an address-bound access code without putting it into localStorage', async () => {
    const address = 'https://reader.example/api'; localStorage.setItem('qingread.apiBase', 'https://reader.example');
    handler = request => request.method === 'credentials.load' ? { value: JSON.stringify({ address, token: 'encrypted-native-token' }) } : {};
    await initializeHarmonyConnection(); expect(serverConnectionStore().load()).toMatchObject({ address, token: 'encrypted-native-token', remember: true });
    expect(serverConnectionStore().tokenFor('https://other.example/api')).toBe(''); expect(localStorage.getItem('qingread.connection.remembered.v1')).toBeNull();
    serverConnectionStore().clearToken(); await harmonyConnectionStorage.flush();
    expect(localStorage.getItem('qingread.harmony-connection-restore-disabled')).toBe('true');
  });
  it('does not let an older pending save re-enable restoration after a later clear fails', async () => {
    localStorage.setItem('qingread.apiBase', 'https://reader.example'); handler = () => ({ value: null }); await initializeHarmonyConnection();
    let resolve!: () => void; const saved = new Promise<void>(done => { resolve = done; });
    handler = async request => { if (request.method === 'credentials.save') await saved; if (request.method === 'credentials.clear') throw new Error('清除失败'); return {}; };
    harmonyConnectionStorage.setItem('credential', JSON.stringify({ address: 'https://reader.example/api', token: 'pending-token' }));
    await vi.waitFor(() => expect(requests.some(request => request.method === 'credentials.save')).toBe(true));
    harmonyConnectionStorage.removeItem('credential'); resolve(); await expect(harmonyConnectionStorage.flush()).rejects.toThrow('清除失败');
    expect(localStorage.getItem('qingread.harmony-connection-restore-disabled')).toBe('true');
    sessionStorage.clear(); await initializeHarmonyConnection(); expect(serverConnectionStore().load().token).toBe('');
  });
  it('keeps only the active session on secure save failure and blocks stale credentials on restart', async () => {
    localStorage.setItem('qingread.apiBase', 'https://reader.example'); handler = () => ({ value: null }); await initializeHarmonyConnection();
    handler = request => { if (request.method === 'credentials.save') throw new Error('安全存储不可用'); return {}; };
    serverConnectionStore().save('https://reader.example', 'session-token', true);
    await expect(harmonyConnectionStorage.flush()).rejects.toThrow('安全存储不可用');
    expect(serverConnectionStore().load()).toMatchObject({ token: 'session-token', remember: false });
    sessionStorage.clear(); await initializeHarmonyConnection(); expect(serverConnectionStore().load().token).toBe('');
    expect(localStorage.getItem('qingread.connection.remembered.v1')).toBeNull();
  });
});
