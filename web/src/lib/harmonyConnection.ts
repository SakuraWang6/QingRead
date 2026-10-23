import { clearHarmonyCredential, hasHarmonyCapability, loadHarmonyCredential, saveHarmonyCredential } from './harmonyNative';

/** Synchronous request headers read an in-memory copy hydrated before React starts.
 * Persistence uses the system ASSET service, never localStorage. */
const restoreBlockedKey = 'qingread.harmony-connection-restore-disabled';
class HarmonyConnectionStorage {
  private value: string | null = null;
  private revision = 0;
  private writing = Promise.resolve();
  private failure?: unknown;
  getItem(_key: string): string | null { return this.value; }
  setItem(_key: string, value: string): void {
    this.value = value; localStorage.setItem(restoreBlockedKey, 'true');
    const revision = this.revision + 1;
    this.enqueue(async () => { await saveHarmonyCredential('connection', value); if (revision === this.revision) localStorage.removeItem(restoreBlockedKey); });
  }
  removeItem(_key: string): void {
    this.value = null;
    if (!hasHarmonyCapability('secureStorage')) return;
    localStorage.setItem(restoreBlockedKey, 'true'); this.enqueue(() => clearHarmonyCredential('connection'));
  }
  private enqueue(work: () => Promise<void>): void {
    const revision = ++this.revision;
    this.writing = this.writing.then(work).then(() => { if (revision === this.revision) this.failure = undefined; }, error => {
      if (revision === this.revision) { this.value = null; this.failure = error; }
    });
  }
  async hydrate(): Promise<void> {
    await this.writing;
    this.value = null; this.failure = undefined;
    if (hasHarmonyCapability('secureStorage') && localStorage.getItem(restoreBlockedKey) !== 'true') this.value = await loadHarmonyCredential('connection');
  }
  async flush(): Promise<void> { await this.writing; if (this.failure) throw this.failure; }
}
export const harmonyConnectionStorage = new HarmonyConnectionStorage();
export async function initializeHarmonyConnection(): Promise<void> {
  if (hasHarmonyCapability('secureStorage')) await harmonyConnectionStorage.hydrate();
}
