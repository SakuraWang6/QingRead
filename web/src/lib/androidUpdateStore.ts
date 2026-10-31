import { useSyncExternalStore } from 'react';
import appInfo from '../../../App/Resources/AppInfo.json';
import { readClientIdentity } from './appIdentity';
import { isAndroidApp } from './android';
import { androidAppUpdates, type AndroidAppUpdateState } from './androidAppUpdates';
import { compareRelease, fetchReleaseManifest, resolveManifestURL, type ClientIdentity, type PlatformRelease } from './appUpdates';
import { serverConnectionStore } from './connection';

export type AndroidUpdateCheck = 'idle' | 'checking' | 'available' | 'current' | 'older' | 'error';
export interface AndroidUpdateState {
  check: AndroidUpdateCheck;
  release?: PlatformRelease;
  identity?: ClientIdentity;
  transfer?: AndroidAppUpdateState;
  error?: string;
  actionError?: string;
  bridgeAvailable?: boolean;
  busy: boolean;
  promptVisible: boolean;
  installAction?: 'permission' | 'installer';
}
interface Environment {
  native(): boolean;
  address(): string;
  now(): number;
  visible(): boolean;
  online(): boolean;
  identity(): Promise<ClientIdentity>;
  manifest: typeof fetchReleaseManifest;
  bridge: typeof androidAppUpdates;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
}
const checkKey = 'qingread.appUpdate.lastCheck.v1', dismissKey = 'qingread.appUpdate.dismissed.v1';
const automaticInterval = 12 * 60 * 60 * 1000, failureInterval = 15 * 60 * 1000;
const message = (error: unknown, fallback: string) => error instanceof Error && error.message.length < 200 ? error.message : fallback;

/** App updates never read or write the reading databases or account credentials. */
export class AndroidUpdateStore {
  private state: AndroidUpdateState = { check: 'idle', busy: false, promptVisible: false };
  private listeners = new Set<() => void>();
  private pending?: AbortController;
  private address = '';
  private generation = 0;
  private retryAfter = 0;
  private automaticInstall = false;
  private awaitingPermission = false;
  private refreshing = false;
  private mutations: Promise<unknown> = Promise.resolve();
  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.mutations.then(action, action); this.mutations = pending.catch(() => {}); return pending;
  }
  private selectAddress(address: string) {
    if (address === this.address) return;
    const cancelOld = Boolean(this.address) && (this.state.busy || this.state.transfer?.status === 'downloading' || this.state.transfer?.status === 'ready');
    this.pending?.abort(); this.generation++; this.address = address; this.retryAfter = 0;
    this.automaticInstall = false; this.awaitingPermission = false;
    this.update({ check: 'idle', release: undefined, transfer: undefined, error: undefined, actionError: undefined, installAction: undefined, busy: false, promptVisible: false });
    if (cancelOld) void this.mutate(() => this.env.bridge.cancel()).catch(() => {});
  }
  constructor(private env: Environment) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(value: Partial<AndroidUpdateState>) { this.state = { ...this.state, ...value }; for (const listener of this.listeners) listener(); }
  private saved(key: string): Record<string, unknown> {
    try { const value: unknown = JSON.parse(this.env.storage.getItem(key) || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; } catch { return {}; }
  }
  private save(key: string, value: Record<string, unknown>) { try { this.env.storage.setItem(key, JSON.stringify(value)); } catch { /* Checking remains usable without persistent preferences. */ } }
  async check(force = false): Promise<void> {
    if (!this.env.native() || !force && (!this.env.visible() || !this.env.online())) return;
    let address: string;
    try { address = this.env.address(); } catch { if (force) this.update({ check: 'error', error: '请先配置 HTTPS 服务器' }); return; }
    this.selectAddress(address);
    if (this.pending && !force) return;
    const previous = this.saved(checkKey), now = this.env.now();
    if (!force && (now < this.retryAfter || previous.address === address && typeof previous.at === 'number' && now >= previous.at && now - previous.at < automaticInterval)) return;
    this.pending?.abort(); const controller = new AbortController(); this.pending = controller;
    const generation = this.generation;
    this.update({ check: 'checking', error: undefined });
    try {
      const identity = await this.env.identity();
      if (identity.platform !== 'android') throw Error('暂时无法读取安卓版本');
      const url = resolveManifestURL('android', '/', 'https://localhost/', address, appInfo.update.manifestPath);
      const manifest = await this.env.manifest(url, { signal: controller.signal });
      if (controller.signal.aborted || generation !== this.generation || address !== this.env.address()) return;
      const release = manifest.platforms.android, comparison = compareRelease(identity, release);
      const dismissed = this.saved(dismissKey);
      const hidden = dismissed.address === address && dismissed.version === release.version && dismissed.build === release.build && typeof dismissed.until === 'number' && dismissed.until > now;
      this.save(checkKey, { address, at: now }); this.retryAfter = 0;
      this.update({ identity, release, check: comparison > 0 ? 'available' : comparison < 0 ? 'older' : 'current', promptVisible: comparison > 0 && Boolean(release.artifact) && (force || !hidden) });
    } catch (error) {
      if (controller.signal.aborted || generation !== this.generation) return;
      this.retryAfter = now + failureInterval;
      this.update({ check: 'error', error: message(error, '检查更新失败，请重试') });
    } finally { if (this.pending === controller) this.pending = undefined; }
  }
  cancelCheck() {
    this.pending?.abort(); this.pending = undefined;
    const comparison = this.state.identity && this.state.release ? compareRelease(this.state.identity, this.state.release) : undefined;
    this.update({ check: comparison === undefined ? 'idle' : comparison > 0 ? 'available' : comparison < 0 ? 'older' : 'current' });
  }
  dismiss() {
    const release = this.state.release;
    if (release) this.save(dismissKey, { address: this.address, version: release.version, build: release.build, until: this.env.now() + 24 * 60 * 60 * 1000 });
    this.update({ promptVisible: false });
  }
  async refresh(): Promise<void> {
    if (!this.env.native() || this.refreshing || !this.env.visible()) return;
    let address: string;
    try { address = this.env.address(); } catch { return; }
    this.selectAddress(address);
    this.refreshing = true; const generation = this.generation;
    try {
      await this.mutations;
      const transfer = await this.env.bridge.getState();
      if (generation !== this.generation || address !== this.env.address()) return;
      if (transfer.apiBase && transfer.apiBase !== address) {
        this.automaticInstall = false; this.awaitingPermission = false;
        await this.mutate(() => this.env.bridge.cancel());
        if (generation === this.generation) this.update({ transfer: undefined, busy: false, promptVisible: false, installAction: undefined });
        return;
      }
      const recovered = !this.state.transfer && (transfer.status === 'ready' || transfer.status === 'downloading');
      this.update({ transfer, bridgeAvailable: true, ...(recovered ? { promptVisible: true } : {}) });
      if (transfer.status === 'ready' && (this.automaticInstall || this.awaitingPermission && !transfer.needsPermission)) {
        this.automaticInstall = false; this.awaitingPermission = false; await this.install();
      }
    } catch { if (generation === this.generation) this.update({ bridgeAvailable: false }); }
    finally { this.refreshing = false; }
  }
  async download(): Promise<void> {
    const release = this.state.release, artifact = release?.artifact;
    if (this.state.busy || this.state.check !== 'available' || !release || !artifact || !release.build) return;
    if (this.env.address() !== this.address) { await this.check(true); return; }
    this.update({ busy: true, actionError: undefined, installAction: undefined, promptVisible: true });
    const generation = ++this.generation; this.automaticInstall = true;
    try {
      const address = this.address;
      const transfer = await this.mutate(async () => {
        if (generation !== this.generation || address !== this.env.address()) throw new DOMException('已取消更新', 'AbortError');
        return this.env.bridge.download({ apiBase: address, artifact, version: release.version, build: release.build! });
      });
      if (generation !== this.generation) return;
      this.update({ transfer, bridgeAvailable: true });
    } catch (error) { if (generation === this.generation) { this.automaticInstall = false; this.update({ actionError: message(error, '更新下载失败，请重试') }); } }
    finally { if (generation === this.generation) this.update({ busy: false }); }
    await this.refresh();
  }
  async cancel(): Promise<void> {
    ++this.generation; this.automaticInstall = false; this.awaitingPermission = false;
    this.update({ busy: true, actionError: undefined, installAction: undefined });
    const generation = this.generation;
    try { const transfer = await this.mutate(() => this.env.bridge.cancel()); if (generation === this.generation) this.update({ transfer }); }
    catch (error) { if (generation === this.generation) this.update({ actionError: message(error, '取消失败，请重试') }); }
    finally { if (generation === this.generation) this.update({ busy: false }); }
  }
  async install(): Promise<void> {
    if (this.state.busy || this.state.transfer?.status !== 'ready') return;
    if (this.env.address() !== this.address) { await this.check(true); return; }
    this.automaticInstall = false;
    const generation = this.generation, address = this.address;
    this.update({ busy: true, actionError: undefined });
    try {
      const result = await this.mutate(async () => {
        if (generation !== this.generation || address !== this.env.address()) throw new DOMException('已取消更新', 'AbortError');
        return this.env.bridge.install();
      });
      if (generation !== this.generation || address !== this.env.address()) return;
      this.awaitingPermission = result.action === 'permission'; this.update({ installAction: result.action });
    } catch (error) { if (generation === this.generation) this.update({ actionError: message(error, '暂时无法打开安装程序') }); }
    finally { if (generation === this.generation) this.update({ busy: false }); }
  }
  attach(): () => void {
    if (!this.env.native()) return () => {};
    const resume = () => { if (this.env.visible()) { void this.refresh(); void this.check(); } };
    resume(); let tick = 0;
    const timer = setInterval(() => {
      if (!this.env.visible()) return;
      if (this.state.transfer?.status === 'downloading') void this.refresh();
      if (++tick % 60 === 0) resume();
    }, 1000);
    document.addEventListener('visibilitychange', resume); window.addEventListener('online', resume);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', resume); window.removeEventListener('online', resume); };
  }
}
const browserStorage = { getItem: (key: string) => localStorage.getItem(key), setItem: (key: string, value: string) => localStorage.setItem(key, value) };
export const androidUpdates = new AndroidUpdateStore({ native: isAndroidApp, address: () => serverConnectionStore().apiAddress(), now: Date.now,
  visible: () => !document.hidden, online: () => navigator.onLine, identity: readClientIdentity, manifest: fetchReleaseManifest, bridge: androidAppUpdates, storage: browserStorage });
export const useAndroidUpdates = (store: AndroidUpdateStore = androidUpdates) => useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
