import { asset } from '@kit.AssetStoreKit';
import { util } from '@kit.ArkTS';
import { NativePolicy } from './NativePolicy';

export class NativeCredentials {
  private encoder: util.TextEncoder = new util.TextEncoder();

  private queryFor(slot: string): asset.AssetMap {
    const query: asset.AssetMap = new Map();
    query.set(asset.Tag.ALIAS, this.encoder.encodeInto('qingread.' + NativePolicy.slot(slot)));
    return query;
  }

  async available(): Promise<boolean> {
    try {
      await this.load('connection');
      return true;
    } catch (_) {
      return false;
    }
  }

  async load(slot: string): Promise<string | null> {
    const query: asset.AssetMap = this.queryFor(slot);
    query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
    try {
      const results: asset.AssetMap[] = await asset.query(query);
      if (results.length === 0) return null;
      const secret: Uint8Array = results[0].get(asset.Tag.SECRET) as Uint8Array;
      return util.TextDecoder.create('utf-8', { fatal: true }).decodeToString(secret);
    } catch (error) {
      if ((error as ErrorWithCode).code === 24000002) return null;
      throw new Error('系统安全存储暂不可用，请使用本次登录');
    }
  }

  async save(slot: string, value: string, trusted: () => boolean = (): boolean => true): Promise<void> {
    if (typeof value !== 'string') throw new Error('凭据格式不正确');
    const secret: Uint8Array = this.encoder.encodeInto(value);
    if (secret.byteLength < 1 || secret.byteLength > 1024) {
      throw new Error('登录信息超过系统安全存储限制，请使用本次登录');
    }
    const query: asset.AssetMap = this.queryFor(slot);
    const attributes: asset.AssetMap = new Map();
    attributes.set(asset.Tag.SECRET, secret);
    attributes.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_UNLOCKED);
    // Omit IS_PERSISTENT entirely: even setting it to false requires the system
    // STORE_PERSISTENT_DATA permission. The default removes secrets on uninstall.
    // A failed account replacement must not revive the previous user's login at restart.
    await this.clear(slot);
    if (!trusted()) throw new Error('页面已关闭，登录信息未保存');
    query.forEach((value: asset.Value, key: asset.Tag): void => { attributes.set(key, value); });
    await asset.add(attributes);
    if (!trusted()) {
      // ASSET operations already sent to the OS cannot be cancelled. The bridge keeps
      // all credential writes serialized until this stale write is removed.
      await this.clear(slot);
      throw new Error('页面已关闭，登录信息未保存');
    }
  }

  async clear(slot: string): Promise<void> {
    try {
      await asset.remove(this.queryFor(slot));
    } catch (error) {
      if ((error as ErrorWithCode).code !== 24000002) {
        throw new Error('无法清除系统保存的登录信息');
      }
    }
  }
}

interface ErrorWithCode { code: number }
