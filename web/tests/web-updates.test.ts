import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebUpdateCoordinator } from '../src/lib/webUpdates';
function fixture() {
  const scope = 'https://read.example/qingread/';
  const registration = Object.assign(new EventTarget(), { scope, waiting: null as ServiceWorker | null, installing: null as ServiceWorker | null, update: vi.fn(async () => undefined) }) as unknown as ServiceWorkerRegistration;
  const runtime = { supported: () => true, expectedScope: () => scope, getRegistration: vi.fn(async () => registration), reload: vi.fn() };
  const updates = new WebUpdateCoordinator(runtime), activate = vi.fn(async () => {}); updates.setActivation(activate);
  updates.setVersionValidation(async () => 0);
  return { updates, registration, runtime, activate };
}
afterEach(() => vi.useRealTimers());
describe('shared Web update coordination', () => {
  it('actively checks the scoped worker but activates only after the user explicitly requests it', async () => {
    const { updates, registration, activate, runtime } = fixture();
    await updates.check(); expect(registration.update).toHaveBeenCalledTimes(1); expect(activate).not.toHaveBeenCalled(); expect(runtime.reload).not.toHaveBeenCalled();
    await expect(updates.activate()).rejects.toThrow('尚未准备好');
    Object.assign(registration, { waiting: {} }); updates.notifyWaiting(true);
    expect(updates.getSnapshot()).toMatchObject({ waiting: true, promptVisible: true });
    updates.dismissPrompt(); expect(updates.getSnapshot()).toMatchObject({ waiting: true, promptVisible: false });
    await updates.activate(); expect(activate).toHaveBeenCalledTimes(1);
  });
  it('waits for downloading resources instead of promising an update before the worker is installed', async () => {
    vi.useFakeTimers(); const { updates, registration, activate } = fixture();
    const worker = Object.assign(new EventTarget(), { state: 'installing' });
    vi.mocked(registration.update).mockImplementation(async () => {
      Object.assign(registration, { installing: worker }); registration.dispatchEvent(new Event('updatefound'));
      setTimeout(() => { Object.assign(registration, { waiting: worker, installing: null }); worker.state = 'installed'; worker.dispatchEvent(new Event('statechange')); }, 50);
      return registration;
    });
    const check = updates.check(); await vi.advanceTimersByTimeAsync(10); expect(updates.getSnapshot().waiting).toBe(false);
    await vi.advanceTimersByTimeAsync(41); await check;
    expect(updates.getSnapshot().waiting).toBe(true); expect(activate).not.toHaveBeenCalled();
  });
  it('reports failed checks and refuses to update a worker owned by another service', async () => {
    const { updates, registration } = fixture(); vi.mocked(registration.update).mockRejectedValue(new Error('offline'));
    await expect(updates.check()).rejects.toThrow('网页资源检查失败'); expect(updates.getSnapshot()).toMatchObject({ waiting: false, checking: false, error: expect.stringContaining('失败') });
    const other = fixture(); Object.assign(other.registration, { scope: 'https://read.example/another/' });
    await expect(other.updates.check()).rejects.toThrow('不匹配'); expect(other.registration.update).not.toHaveBeenCalled();
  });
  it('offers a user-controlled reload only when service workers are unavailable', async () => {
    const runtime = { supported: () => false, expectedScope: () => '', getRegistration: vi.fn(), reload: vi.fn() };
    const updates = new WebUpdateCoordinator(runtime); await updates.check(); expect(updates.getSnapshot().canReload).toBe(true); expect(runtime.reload).not.toHaveBeenCalled();
    updates.reloadWithoutWorker(); expect(runtime.reload).toHaveBeenCalledTimes(1); expect(runtime.getRegistration).not.toHaveBeenCalled();
  });
  it('cancels or times out an unresponsive worker check without activating it', async () => {
    vi.useFakeTimers(); const { updates, registration, activate } = fixture(); vi.mocked(registration.update).mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController(); const check = expect(updates.check(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(1); controller.abort(); await check;
    const timed = expect(updates.check()).rejects.toThrow('超时'); await vi.advanceTimersByTimeAsync(10_001); await timed;
    expect(activate).not.toHaveBeenCalled(); expect(updates.getSnapshot().checking).toBe(false);
  });
  it('blocks a known downgrade in both the about page and shared activation path', async () => {
    const { updates, registration, activate } = fixture(); Object.assign(registration, { waiting: {} }); updates.attachRegistration(registration);
    updates.setReleaseComparison(-1); expect(updates.getSnapshot()).toMatchObject({ blockedByVersion: true, promptVisible: false });
    await expect(updates.activate()).rejects.toThrow('较旧'); expect(activate).not.toHaveBeenCalled();
    updates.setReleaseComparison(1); await updates.activate(); expect(activate).toHaveBeenCalledTimes(1);
  });
  it('validates even the background prompt activation path and preserves the page on feed failure or downgrade', async () => {
    const { updates, registration, activate, runtime } = fixture(); Object.assign(registration, { waiting: {} }); updates.attachRegistration(registration);
    updates.setVersionValidation(async () => { throw new Error('暂时无法获取版本信息'); });
    await expect(updates.activate()).rejects.toThrow('暂时无法'); expect(activate).not.toHaveBeenCalled(); expect(runtime.reload).not.toHaveBeenCalled();
    updates.setVersionValidation(async () => -1);
    await expect(updates.activate()).rejects.toThrow('较旧'); expect(activate).not.toHaveBeenCalled();
  });
});
