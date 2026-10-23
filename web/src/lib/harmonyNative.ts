import { isHarmonyApp } from './harmony';

export type HarmonyCapability = 'speech' | 'battery' | 'exportBackup' | 'secureStorage' | 'backgroundDownloads' | 'updateNotifications';
export type HarmonyCredentialSlot = 'cloud' | 'connection';
interface HarmonyNativeBridge { request(value: string): Promise<string> }
declare global { interface Window { readonly QingReadNative?: HarmonyNativeBridge } }
let sequence = 0;

/** A shell marker alone never enables a native operation. */
export function hasHarmonyCapability(capability: HarmonyCapability): boolean {
  return isHarmonyApp() && window.__QINGREAD_HARMONY__?.bridgeVersion === 2 &&
    Array.isArray(window.__QINGREAD_HARMONY__.capabilities) && window.__QINGREAD_HARMONY__.capabilities.includes(capability) &&
    typeof window.QingReadNative?.request === 'function';
}

export async function harmonyRequest<T>(capability: HarmonyCapability, method: string, params: object = {}, timeoutMs = 15_000): Promise<T> {
  if (!hasHarmonyCapability(capability)) throw new Error('当前鸿蒙版本暂不支持此功能，请先更新应用');
  const id = `web-${Date.now().toString(36)}-${++sequence}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      window.QingReadNative!.request(JSON.stringify({ id, method, params })),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('系统操作超时，请重试')), timeoutMs); }),
    ]);
    if (typeof raw !== 'string' || raw.length > 140_000) throw new Error('系统返回了无效数据');
    const reply: unknown = JSON.parse(raw);
    if (!reply || typeof reply !== 'object' || !('id' in reply) || reply.id !== id || !('ok' in reply) || typeof reply.ok !== 'boolean') throw new Error('系统返回了无效数据');
    if (!reply.ok) throw new Error('error' in reply && typeof reply.error === 'string' ? reply.error.slice(0, 300) : '系统操作未完成，请重试');
    return ('result' in reply ? reply.result : undefined) as T;
  } finally { clearTimeout(timer); }
}

export async function loadHarmonyCredential(slot: HarmonyCredentialSlot): Promise<string | null> {
  const value = await harmonyRequest<{ value: unknown }>('secureStorage', 'credentials.load', { slot });
  if (value?.value === null) return null;
  if (typeof value?.value !== 'string' || new TextEncoder().encode(value.value).length > 1024) throw new Error('无法读取安全登录信息，请重新登录');
  return value.value;
}
export function saveHarmonyCredential(slot: HarmonyCredentialSlot, value: string): Promise<void> {
  if (new TextEncoder().encode(value).length > 1024) return Promise.reject(new Error('登录信息过长，无法安全保存'));
  return harmonyRequest('secureStorage', 'credentials.save', { slot, value });
}
export function clearHarmonyCredential(slot: HarmonyCredentialSlot): Promise<void> { return harmonyRequest('secureStorage', 'credentials.clear', { slot }); }
export async function exportHarmonyBackup(name: string, blob: Blob): Promise<boolean> {
  if (blob.size > 16 * 1024 * 1024) throw new Error('备份超过 16 MB，请使用网页版导出');
  const content = await blob.text(), size = new TextEncoder().encode(content).length;
  const begin = await harmonyRequest<{ exportID: unknown }>('exportBackup', 'export.begin', { name, size });
  if (typeof begin?.exportID !== 'string' || !begin.exportID || begin.exportID.length > 100) throw new Error('无法创建备份，请重试');
  const exportID = begin.exportID;
  // Share the native bridge's rolling window with ample room for speech, battery
  // and account work. A valid large backup must not exhaust its 512 / 10 s budget.
  const recentMessages: number[] = [Date.now()];
  async function reserveMessage(): Promise<void> {
    for (;;) {
      const now = Date.now();
      while (recentMessages.length && recentMessages[0] <= now - 10_010) recentMessages.shift();
      if (recentMessages.length < 256) { recentMessages.push(now); return; }
      await new Promise(resolve => setTimeout(resolve, Math.min(10_010, Math.max(1, recentMessages[0] + 10_010 - now))));
    }
  }
  try {
    // Keep each message small; never split a UTF-16 surrogate pair.
    for (let offset = 0; offset < content.length;) {
      let end = Math.min(content.length, offset + 8192);
      if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end--;
      await reserveMessage();
      await harmonyRequest('exportBackup', 'export.append', { exportID, content: content.slice(offset, end) });
      offset = end;
    }
    await reserveMessage();
    const result = await harmonyRequest<{ saved: unknown }>('exportBackup', 'export.commit', { exportID }, 120_000);
    if (typeof result?.saved !== 'boolean') throw new Error('无法确认备份是否保存，请重试');
    return result.saved;
  } catch (error) {
    await harmonyRequest('exportBackup', 'export.cancel', { exportID }).catch(() => {});
    throw error;
  }
}
