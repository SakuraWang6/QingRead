import { useEffect, useRef } from 'react';
import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core';
import { App as NativeApp } from '@capacitor/app';
import { isHarmonyApp } from './harmony';
import { isNativeApp } from './nativePlatform';

export const isAndroidApp = (): boolean => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

/** The local https://localhost origin hosts bundled assets, never the book API. */
export function androidServerIssue(configured: string): string | undefined {
  if (!configured.trim()) return '请先在「设置 → 服务器连接」填写你的 HTTPS 服务器地址。导入和已缓存的书籍可直接离线阅读。';
  try {
    const url = new URL(configured);
    if (url.protocol !== 'https:') return `${isHarmonyApp() ? '鸿蒙' : '安卓'}版本需要 HTTPS 服务器地址。`;
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost')) return 'localhost 指向手机本机，请填写能从手机访问的 HTTPS 服务器域名。';
    if (url.search || url.hash) return '服务地址不能包含查询参数或片段，请填写 HTTPS 服务地址。';
    if (url.username || url.password) return '服务地址不能包含账号或密码，请在访问口令栏填写口令。';
  } catch { return '服务器地址格式不正确，请在设置中重新填写。'; }
  return undefined;
}

type BackHandler = () => boolean;
export class BackHandlerStack {
  private sequence = 0;
  private entries = new Map<number, { priority: number; handle: BackHandler }>();
  add(handle: BackHandler, priority = 0): () => void {
    const id = ++this.sequence; this.entries.set(id, { priority, handle });
    return () => { this.entries.delete(id); };
  }
  dispatch(): boolean {
    const ordered = [...this.entries].sort((a, b) => b[1].priority - a[1].priority || b[0] - a[0]);
    for (const [, entry] of ordered) if (entry.handle()) return true;
    return false;
  }
}
const backHandlers = new BackHandlerStack();
let initialization: Promise<void> | undefined;

export function initializeAndroid(): Promise<void> {
  if (isHarmonyApp()) {
    window.__qingreadHandleNativeBack = () => backHandlers.dispatch();
    return Promise.resolve();
  }
  if (!isAndroidApp()) return Promise.resolve();
  return initialization ??= (async () => {
    await NativeApp.addListener('backButton', () => {
      if (!backHandlers.dispatch()) void NativeApp.minimizeApp();
    });
    await SystemBars.setStyle({ style: SystemBarsStyle.Light });
  })().catch(() => { /* The bundled UI remains usable if a system UI bridge is unavailable. */ });
}

export function useAndroidBack(handle: BackHandler, priority = 0, enabled = true): void {
  const latest = useRef(handle); latest.current = handle;
  useEffect(() => {
    if (!enabled || !isNativeApp()) return;
    return backHandlers.add(() => latest.current(), priority);
  }, [priority, enabled]);
}

export async function disableNativeServiceWorkers(): Promise<void> {
  if (!isNativeApp() || !('serviceWorker' in navigator)) return;
  // Native assets are already local. A PWA worker could otherwise keep an old JS
  // bundle after an APK upgrade; chapter files remain in IndexedDB untouched.
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map(registration => registration.unregister()));
  } catch { /* Some WebViews omit service-worker support entirely. */ }
}
