import { Capacitor, registerPlugin } from '@capacitor/core';
import { isAndroidApp } from './android';
import type { ReleaseArtifact } from './appUpdates';

export interface AndroidAppUpdateState {
  status: 'idle' | 'downloading' | 'ready' | 'failed' | 'cancelled';
  receivedBytes: number;
  totalBytes: number;
  apiBase?: string;
  version?: string;
  build?: number;
  error?: string;
  needsPermission: boolean;
}
export interface AndroidAppUpdateRequest { apiBase: string; artifact: ReleaseArtifact; version: string; build: number }
interface NativeAppUpdates {
  getState(options: { nonce: string }): Promise<AndroidAppUpdateState>;
  download(options: AndroidAppUpdateRequest & { nonce: string }): Promise<AndroidAppUpdateState>;
  cancel(options: { nonce: string }): Promise<AndroidAppUpdateState>;
  install(options: { nonce: string }): Promise<{ action: 'permission' | 'installer' }>;
}
declare global { interface Window { __qingreadAppUpdateNonce?: string } }
const bridge = registerPlugin<NativeAppUpdates>('QingReadAppUpdates');
export const supportsAndroidAppUpdates = (): boolean => isAndroidApp() && Capacitor.isPluginAvailable('QingReadAppUpdates');
async function documentNonce(): Promise<string> {
  if (!supportsAndroidAppUpdates() || typeof window === 'undefined' || window.top !== window) throw new Error('当前安装版本暂不支持应用内更新');
  // Native injects this only into the fixed top-level local document.
  for (let attempt = 0; attempt < 25; attempt++) {
    const value = window.__qingreadAppUpdateNonce;
    if (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('更新功能尚未准备好，请重试');
}
export const androidAppUpdates = {
  async getState(): Promise<AndroidAppUpdateState> { return bridge.getState({ nonce: await documentNonce() }); },
  /** Downloads only after a user action; no account tokens are sent. */
  async download(request: AndroidAppUpdateRequest): Promise<AndroidAppUpdateState> { return bridge.download({ apiBase: request.apiBase, artifact: { url: request.artifact.url, sha256: request.artifact.sha256, size: request.artifact.size }, version: request.version, build: request.build, nonce: await documentNonce() }); },
  async cancel(): Promise<AndroidAppUpdateState> { return bridge.cancel({ nonce: await documentNonce() }); },
  /** Android owns permission and the final installation confirmation. */
  async install(): Promise<{ action: 'permission' | 'installer' }> { return bridge.install({ nonce: await documentNonce() }); },
};
