import { describe, expect, it, vi } from 'vitest';
import { AndroidUpdateStore } from '../src/lib/androidUpdateStore';
import type { AndroidAppUpdateState } from '../src/lib/androidAppUpdates';
import type { ReleaseManifest } from '../src/lib/appUpdates';

const idle = (): AndroidAppUpdateState => ({ status: 'idle', receivedBytes: 0, totalBytes: 0, needsPermission: false });
const ready = (permission = false): AndroidAppUpdateState => ({ status: 'ready', receivedBytes: 7_000_000, totalBytes: 7_000_000, version: '0.13.0', build: 15, needsPermission: permission });
function fixture() {
  let now = 2_000_000_000_000, address = 'https://read.example/api', visible = true;
  const records = new Map<string, string>();
  const release = { version: '0.13.0', build: 15, notes: ['更新'], artifact: { url: 'https://read.example/downloads/QingRead-Android-0.13.0.apk', sha256: 'a'.repeat(64), size: 7_000_000 } };
  const manifest: ReleaseManifest = { schemaVersion: 1, publishedAt: '2026-11-01T00:00:00Z', platforms: { web: { version: '0.13.0', notes: [] }, ios: release, android: release } };
  const bridge = { getState: vi.fn(async () => idle()), download: vi.fn(async (): Promise<AndroidAppUpdateState> => ({ ...idle(), status: 'downloading' })), cancel: vi.fn(async () => ({ ...idle(), status: 'cancelled' as const })), install: vi.fn(async () => ({ action: 'installer' as 'permission' | 'installer' })) };
  const fetchManifest = vi.fn(async () => manifest);
  const env = { native: () => true, address: () => address, now: () => now, visible: () => visible, online: () => true,
    identity: vi.fn(async () => ({ platform: 'android' as const, version: '0.12.2', build: '14' })), manifest: fetchManifest, bridge,
    storage: { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); } } };
  const store = new AndroidUpdateStore(env);
  return { store, env, bridge, release, fetchManifest, records, setAddress: (value: string) => { address = value; }, advance: (ms: number) => { now += ms; }, setVisible: (value: boolean) => { visible = value; } };
}

describe('Android application update coordination', () => {
  it('checks on startup with a twelve-hour per-server cooldown and never downloads without an update action', async () => {
    const f = fixture(); await f.store.check(); await f.store.check();
    expect(f.fetchManifest).toHaveBeenCalledTimes(1); expect(f.store.snapshot().promptVisible).toBe(true); expect(f.bridge.download).not.toHaveBeenCalled();
    f.advance(12 * 60 * 60 * 1000); await f.store.check(); expect(f.fetchManifest).toHaveBeenCalledTimes(2);
    f.setAddress('https://another.example/api'); await f.store.check(); expect(f.fetchManifest).toHaveBeenCalledTimes(3);
  });
  it('does not check automatically while reading in the background and backs off errors', async () => {
    const f = fixture(); f.setVisible(false); await f.store.check(); expect(f.fetchManifest).not.toHaveBeenCalled();
    f.setVisible(true); f.fetchManifest.mockRejectedValueOnce(Error('offline')); await f.store.check(); await f.store.check(); expect(f.fetchManifest).toHaveBeenCalledTimes(1);
    await f.store.check(true); expect(f.fetchManifest).toHaveBeenCalledTimes(2);
  });
  it('does not apply a response from a server that changed during the request', async () => {
    const f = fixture(); let finish!: (value: ReleaseManifest) => void;
    f.fetchManifest.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.store.check(); await Promise.resolve(); f.setAddress('https://new.example/api');
    finish({ schemaVersion: 1, publishedAt: '2026-11-01T00:00:00Z', platforms: { ios: f.release, web: f.release, android: f.release } }); await pending;
    expect(f.store.snapshot().release).toBeUndefined();
  });
  it('dismisses only that version temporarily; manual checking remains available', async () => {
    const f = fixture(); await f.store.check(); f.store.dismiss(); expect(f.store.snapshot().promptVisible).toBe(false);
    await f.store.check(true); expect(f.store.snapshot().promptVisible).toBe(true);
  });
  it('passes only public release metadata to the bridge and opens installation after a user-requested download is ready', async () => {
    const f = fixture(); await f.store.check(); await f.store.download();
    expect(f.bridge.download).toHaveBeenCalledWith({ apiBase: 'https://read.example/api', artifact: f.release.artifact, version: f.release.version, build: 15 });
    expect(f.bridge.install).not.toHaveBeenCalled(); f.bridge.getState.mockResolvedValue(ready()); await f.store.refresh(); expect(f.bridge.install).toHaveBeenCalledTimes(1);
    await f.store.refresh(); expect(f.bridge.install).toHaveBeenCalledTimes(1);
  });
  it('resumes the installation flow after the user grants the system source permission', async () => {
    const f = fixture(); f.bridge.getState.mockResolvedValue(ready(true)); await f.store.refresh();
    f.bridge.install.mockResolvedValueOnce({ action: 'permission' }); await f.store.install();
    await f.store.refresh(); expect(f.bridge.install).toHaveBeenCalledTimes(1);
    f.bridge.getState.mockResolvedValue(ready(false)); await f.store.refresh(); expect(f.bridge.install).toHaveBeenCalledTimes(2);
  });
  it('recovers a downloaded package after restart without opening installation automatically', async () => {
    const f = fixture(); f.bridge.getState.mockResolvedValue(ready()); await f.store.refresh();
    expect(f.store.snapshot().promptVisible).toBe(true); expect(f.bridge.install).not.toHaveBeenCalled();
  });
  it('cancel prevents an old completed transfer from automatically opening the installer', async () => {
    const f = fixture(); await f.store.check(); await f.store.download(); await f.store.cancel();
    f.bridge.getState.mockResolvedValue(ready()); await f.store.refresh(); expect(f.bridge.install).not.toHaveBeenCalled();
  });
  it('keeps an older release unavailable when an in-flight manual check is cancelled', async () => {
    const f = fixture(); f.release.version = '0.11.0'; await f.store.check(); expect(f.store.snapshot().check).toBe('older');
    f.store.cancelCheck(); expect(f.store.snapshot().check).toBe('older'); await f.store.download(); expect(f.bridge.download).not.toHaveBeenCalled();
  });
  it('clears busy and serializes cancellation when a pending download changes server', async () => {
    const f = fixture(); await f.store.check(); let finish!: (value: AndroidAppUpdateState) => void;
    f.bridge.download.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const download = f.store.download(); await Promise.resolve(); await Promise.resolve();
    expect(f.store.snapshot().busy).toBe(true);
    f.setAddress('https://new.example/api'); await f.store.check(true);
    expect(f.store.snapshot().busy).toBe(false);
    finish({ ...idle(), status: 'downloading', apiBase: 'https://read.example/api' }); await download;
    expect(f.bridge.cancel).toHaveBeenCalledTimes(1); expect(f.store.snapshot().busy).toBe(false);
    expect(f.store.snapshot().transfer?.status).not.toBe('downloading'); expect(f.bridge.install).not.toHaveBeenCalled();
  });
  it('ignores an installation permission response after the server context changes', async () => {
    const f = fixture(); f.bridge.getState.mockResolvedValue(ready()); await f.store.refresh();
    let finish!: (value: { action: 'permission' | 'installer' }) => void;
    f.bridge.install.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const install = f.store.install(); await Promise.resolve(); await Promise.resolve();
    f.setAddress('https://new.example/api'); await f.store.check(true);
    finish({ action: 'permission' }); await install;
    expect(f.store.snapshot().busy).toBe(false); expect(f.store.snapshot().installAction).toBeUndefined();
  });
  it('cancels a recovered package from a different configured server', async () => {
    const f = fixture(); f.bridge.getState.mockResolvedValue({ ...ready(), apiBase: 'https://old.example/api' }); await f.store.refresh();
    expect(f.bridge.cancel).toHaveBeenCalledTimes(1); expect(f.store.snapshot().transfer).toBeUndefined(); expect(f.bridge.install).not.toHaveBeenCalled();
  });
  it('ignores malformed local cooldown records', async () => {
    const f = fixture(); f.records.set('qingread.appUpdate.lastCheck.v1', 'null'); await f.store.check(); expect(f.store.snapshot().check).toBe('available');
  });
});
