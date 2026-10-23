import { common } from '@kit.AbilityKit';
import { fileIo } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { UpdatePolicy, UpdateState, StoredWatch } from './UpdatePolicy';

/** Fresh reads plus an OS file lock coordinate UI and the separate Extension process. */
export class UpdateStore {
  private path: string;
  private lockPath: string;
  private encoder: util.TextEncoder = new util.TextEncoder();

  constructor(context: common.Context) {
    this.path = context.filesDir + '/qingread-updates-v1.json';
    this.lockPath = context.filesDir + '/qingread-updates-v1.lock';
  }

  private read(): UpdateState {
    if (!fileIo.accessSync(this.path)) return { version: 1, epoch: util.generateRandomUUID(), profile: '', apiBase: '', credentialFingerprint: '',
      enabled: false, permissionAsked: false, watches: [] };
    if (fileIo.statSync(this.path).size > UpdatePolicy.STATE_LIMIT) throw new Error('追更记录过大');
    const state: UpdateState = JSON.parse(fileIo.readTextSync(this.path)) as UpdateState;
    if (state === null || state.version !== 1 || typeof state.epoch !== 'string' || typeof state.profile !== 'string' ||
      typeof state.apiBase !== 'string' || typeof state.credentialFingerprint !== 'string' || !/^(?:[0-9a-f]{64})?$/.test(state.credentialFingerprint) ||
      typeof state.enabled !== 'boolean' || typeof state.permissionAsked !== 'boolean' ||
      !Array.isArray(state.watches) || state.watches.length > 20) throw new Error('追更记录暂不可用');
    if (state.profile) { UpdatePolicy.profile(state.profile); UpdatePolicy.apiBase(state.apiBase); }
    state.watches.forEach((watch: StoredWatch): void => {
      UpdatePolicy.book(watch.book); UpdatePolicy.baseline(watch.baseline);
      if (typeof watch.readChapterID !== 'string' || !Number.isFinite(watch.attemptedAt)) throw new Error('追更记录暂不可用');
    });
    return state;
  }

  save(state: UpdateState): void {
    const bytes: Uint8Array = this.encoder.encodeInto(JSON.stringify(state));
    if (bytes.byteLength > UpdatePolicy.STATE_LIMIT) throw new Error('追更记录过大');
    const temporary: string = this.path + '-' + util.generateRandomUUID() + '.part';
    const file: fileIo.File = fileIo.openSync(temporary, fileIo.OpenMode.CREATE | fileIo.OpenMode.WRITE_ONLY);
    try {
      let written: number = 0;
      while (written < bytes.byteLength) {
        const count: number = fileIo.writeSync(file.fd, bytes.slice(written).buffer);
        if (count < 1) throw new Error('无法保存追更设置');
        written += count;
      }
      fileIo.fsyncSync(file.fd); fileIo.closeSync(file);
      fileIo.renameSync(temporary, this.path);
    } catch (_) {
      try { fileIo.closeSync(file); } catch (_) {}
      try { fileIo.unlinkSync(temporary); } catch (_) {}
      throw new Error('无法保存追更设置');
    }
  }

  async locked(action: (state: UpdateState) => Promise<boolean>): Promise<void> {
    const file: fileIo.File = fileIo.openSync(this.lockPath, fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE);
    let acquired: boolean = false;
    try {
      const deadline: number = Date.now() + 2000;
      while (!acquired) {
        try { file.tryLock(true); acquired = true; } catch (_) {
          if (Date.now() >= deadline) throw new Error('追更设置正在更新，请重试');
          await new Promise<void>((resolve): void => { setTimeout(resolve, 25); });
        }
      }
      // A fresh disk read inside the lock is required even in a warm Extension process.
      const state: UpdateState = this.read();
      if (await action(state)) this.save(state);
    } finally {
      if (acquired) file.unlock();
      fileIo.closeSync(file);
    }
  }
}
