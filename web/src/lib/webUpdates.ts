import { useSyncExternalStore } from 'react';
export interface WebUpdateState { waiting: boolean; promptVisible: boolean; checking: boolean; activating: boolean; canReload: boolean; blockedByVersion: boolean; error: string }
interface UpdateRuntime {
  supported(): boolean;
  expectedScope(): string;
  getRegistration(): Promise<ServiceWorkerRegistration | undefined>;
  reload(): void;
}
const browserRuntime: UpdateRuntime = {
  supported: () => 'serviceWorker' in navigator,
  expectedScope: () => new URL(import.meta.env.BASE_URL, location.href).href,
  getRegistration: () => navigator.serviceWorker.getRegistration(new URL(import.meta.env.BASE_URL, location.href).href),
  reload: () => location.reload(),
};
const cancelled = () => new DOMException('已取消检查', 'AbortError');
function bounded<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, value?: T) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value!); };
    const abort = () => finish(cancelled());
    const timer = setTimeout(() => finish(new Error('网页资源检查超时，请重试')), 10_000);
    signal?.addEventListener('abort', abort, { once: true });
    operation.then(value => finish(undefined, value), error => finish(error));
    if (signal?.aborted) abort();
  });
}
export class WebUpdateCoordinator {
  private state: WebUpdateState = { waiting: false, promptVisible: false, checking: false, activating: false, canReload: false, blockedByVersion: false, error: '' };
  private listeners = new Set<() => void>();
  private registration?: ServiceWorkerRegistration;
  private activateWorker?: () => Promise<void>;
  private validateVersion?: () => Promise<number>;
  private activation?: Promise<void>;
  private detach?: () => void;
  private checkID = 0;
  constructor(private runtime: UpdateRuntime = browserRuntime) {}
  subscribe = (callback: () => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; };
  getSnapshot = () => this.state;
  private publish(patch: Partial<WebUpdateState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(callback => callback()); }
  attachRegistration(registration: ServiceWorkerRegistration | undefined) {
    if (!registration) return;
    if (registration.scope !== this.runtime.expectedScope()) { this.publish({ error: '网页离线组件不匹配，请重新打开后重试' }); return; }
    if (this.registration === registration) { this.refreshWaiting(); return; }
    this.detach?.(); this.registration = registration;
    const workers = new Set<ServiceWorker>();
    const watch = () => {
      const worker = registration.installing;
      if (worker && !workers.has(worker)) { workers.add(worker); worker.addEventListener('statechange', changed); }
      this.refreshWaiting();
    };
    const changed = () => watch();
    registration.addEventListener('updatefound', watch); watch();
    this.detach = () => { registration.removeEventListener('updatefound', watch); workers.forEach(worker => worker.removeEventListener('statechange', changed)); };
  }
  setActivation(activate: () => Promise<void>) { this.activateWorker = activate; }
  setVersionValidation(validate: () => Promise<number>) { this.validateVersion = validate; }
  registrationFailed() { this.publish({ error: '网页离线组件暂时不可用，请重新打开后重试' }); }
  notifyWaiting(needsUpdate: boolean) { this.refreshWaiting(needsUpdate); }
  setReleaseComparison(comparison: number) {
    const blocked = comparison < 0, wasBlocked = this.state.blockedByVersion;
    this.publish({ blockedByVersion: blocked, promptVisible: !blocked && this.state.waiting && (wasBlocked || this.state.promptVisible) });
  }
  private refreshWaiting(hint = false) {
    const waiting = hint || Boolean(this.registration?.waiting);
    this.publish({ waiting, promptVisible: !this.state.blockedByVersion && waiting && (!this.state.waiting || this.state.promptVisible), ...(waiting ? { error: '' } : {}) });
  }
  dismissPrompt = () => { this.publish({ promptVisible: false }); };
  /** Check only. Activation/reload always requires a separate user click. */
  async check(signal?: AbortSignal): Promise<void> {
    const ticket = ++this.checkID;
    this.publish({ checking: true, error: '' });
    try {
      if (signal?.aborted) throw cancelled();
      if (!this.runtime.supported()) { this.publish({ canReload: true }); return; }
      const registration = this.registration ?? await bounded(this.runtime.getRegistration(), signal);
      if (signal?.aborted) throw cancelled();
      if (!registration) throw new Error('网页离线组件尚未就绪，请重新打开后重试');
      if (registration.scope !== this.runtime.expectedScope()) throw new Error('网页离线组件不匹配，请重新打开后重试');
      this.attachRegistration(registration);
      await bounded(registration.update(), signal);
      if (signal?.aborted) throw cancelled();
      if (registration.installing) await this.waitForInstall(registration, signal);
      if (signal?.aborted) throw cancelled();
      this.refreshWaiting();
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      const message = error instanceof Error && /^网页/.test(error.message) ? error.message : '网页资源检查失败，请检查网络后重试';
      if (ticket === this.checkID) this.publish({ error: message });
      throw new Error(message);
    } finally { if (ticket === this.checkID) this.publish({ checking: false }); }
  }
  private waitForInstall(registration: ServiceWorkerRegistration, signal?: AbortSignal): Promise<void> {
    const worker = registration.installing; if (!worker) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); worker.removeEventListener('statechange', changed); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
      const changed = () => { if (registration.waiting || worker.state === 'activated') finish(); else if (worker.state === 'redundant') finish(new Error('网页资源安装失败，请重试')); };
      const abort = () => finish(cancelled());
      const timer = setTimeout(() => finish(new Error('网页资源尚未准备好，请稍后再试')), 10_000);
      worker.addEventListener('statechange', changed); signal?.addEventListener('abort', abort, { once: true }); changed();
      if (signal?.aborted) abort();
    });
  }
  async activate(): Promise<void> {
    if (this.activation) return this.activation;
    if (this.state.blockedByVersion) throw new Error('服务端发布版本较旧，已保留当前版本');
    if (!this.state.waiting || !this.registration?.waiting || !this.activateWorker || !this.validateVersion) throw new Error('网页资源尚未准备好，请先检查更新');
    const activate = this.activateWorker, validate = this.validateVersion;
    this.publish({ activating: true, error: '' });
    this.activation = (async () => {
      try {
        this.setReleaseComparison(await validate());
        if (this.state.blockedByVersion) throw new Error('服务端发布版本较旧，已保留当前版本');
        if (!this.registration?.waiting) throw new Error('网页资源已变化，请重新打开后再试');
        await activate(); this.publish({ promptVisible: false, error: '' });
      } catch (error) {
        const message = error instanceof Error && /^(服务端发布|网页|版本信息|安装包地址|暂时无法|检查更新)/.test(error.message) ? error.message : '网页更新未完成，请重试';
        this.publish({ error: message }); throw new Error(message);
      } finally { this.activation = undefined; this.publish({ activating: false }); }
    })();
    return this.activation;
  }
  reloadWithoutWorker(): void { if (this.state.canReload && !this.state.blockedByVersion && !this.runtime.supported()) this.runtime.reload(); }
}
export const webUpdates = new WebUpdateCoordinator();
export const useWebUpdates = () => useSyncExternalStore(webUpdates.subscribe, webUpdates.getSnapshot);
