import { Capacitor } from '@capacitor/core';
import type { CloudSession } from '../shared/sync';

export interface PushAuth { apiAddress: string; session: CloudSession }
export interface PushConfiguration { enabled: boolean; publicKey: string; maxBooks: number; intervalMinutes: number }
export interface PushStatus extends PushConfiguration { devices: number; subscriptionIDs: string[]; bookIDs: string[] }
let generation = 0;
export function cancelPendingPushChanges() { generation++; }
export function pushSupport(): { supported: boolean; reason: string } {
  if (Capacitor.isNativePlatform()) return { supported: false, reason: '请在网页版开启推送。' };
  const installed = window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  const appleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  if (appleMobile && !installed) return { supported: false, reason: '先将清读添加到主屏幕，再从图标打开。' };
  if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return { supported: false, reason: '当前浏览器暂不支持推送。' };
  return { supported: true, reason: '' };
}
async function request<T>(auth: PushAuth, path: string, body?: unknown): Promise<T> {
  const response = await fetch(auth.apiAddress.replace(/\/+$/, '') + '/push/' + path, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { Authorization: 'Bearer ' + auth.session.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.message || '通知设置未能保存。');
  return value as T;
}
export const pushConfiguration = (auth: PushAuth) => request<PushConfiguration>(auth, 'config');
export const pushStatus = (auth: PushAuth) => request<PushStatus>(auth, 'status');
export const savePushBooks = (auth: PushAuth, bookIDs: string[]) => request<PushStatus>(auth, 'books', { bookIDs });

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!('serviceWorker' in navigator)) return undefined;
  const scope = new URL(import.meta.env.BASE_URL, window.location.href).href;
  const value = await navigator.serviceWorker.getRegistration(scope);
  // A previous root worker or another application on a shared origin must not
  // receive subscriptions for this PWA's path.
  return value?.scope === scope && value.active ? value : undefined;
}
function keyBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}
function keyString(value: ArrayBuffer | null): string {
  return value ? btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : '';
}
export async function currentPushSubscriptionID(): Promise<string | undefined> {
  const value = await (await registration())?.pushManager.getSubscription();
  if (!value) return undefined;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value.endpoint));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Call directly from a user click; config must be loaded before that click. */
export async function enablePush(auth: PushAuth, config: PushConfiguration, bookIDs: string[], prepare?: () => Promise<void>): Promise<PushStatus> {
  const current = generation;
  const check = () => { if (current !== generation) throw new Error('账号或页面已切换，请重新操作。'); };
  const support = pushSupport();
  if (!support.supported) throw new Error(support.reason);
  if (!config.enabled || !config.publicKey) throw new Error('服务器尚未开启推送。');
  // Request immediately, before any fetch/await can consume user activation.
  const permission = await Notification.requestPermission();
  check();
  if (permission !== 'granted') throw new Error('通知权限未开启，可在系统设置中修改。');
  await prepare?.();
  check();
  const worker = await registration();
  check();
  if (!worker) throw new Error('通知组件正在更新，请重新打开后再试。');
  let value = await worker.pushManager.getSubscription();
  check();
  if (value && keyString(value.options.applicationServerKey) !== config.publicKey) { await value.unsubscribe(); value = null; }
  const created = !value;
  value ??= await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(config.publicKey) });
  try {
    check();
    await request(auth, 'subscribe', { subscription: value.toJSON() });
    check();
    return await savePushBooks(auth, bookIDs);
  } catch (error) {
    if (created) {
      try { await request(auth, 'unsubscribe', { endpoint: value.endpoint }); } catch { /* Session expiry is also cleaned server-side. */ }
      if (current === generation) await value.unsubscribe().catch(() => false);
    }
    throw error;
  }
}

/** Also call before revoking the cloud session on logout or account switching. */
export async function disablePush(auth: PushAuth): Promise<void> {
  cancelPendingPushChanges();
  const worker = await registration(), value = await worker?.pushManager.getSubscription();
  let failure: unknown;
  try { if (value) await request(auth, 'unsubscribe', { endpoint: value.endpoint }); }
  catch (error) { failure = error; }
  finally {
    await value?.unsubscribe().catch(() => false);
    for (const notice of await worker?.getNotifications() ?? []) notice.close();
  }
  if (failure) throw failure;
}
