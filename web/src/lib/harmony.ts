/** The native shell injects identity before the bundled application starts. */
export interface HarmonyBootstrap { bridgeVersion: 1; version: string; build: string }
declare global {
  interface Window {
    readonly __QINGREAD_HARMONY__?: HarmonyBootstrap;
    __qingreadHandleNativeBack?: () => boolean;
  }
}
export function isHarmonyApp(): boolean {
  if (typeof window === 'undefined' || window.location?.origin !== 'https://localhost') return false;
  return Boolean(window.__QINGREAD_HARMONY__) || /(?:^|\s)QingReadHarmony\/1(?:\s|$)/.test(window.navigator?.userAgent ?? '');
}
export function harmonyIdentity(): HarmonyBootstrap {
  const info = typeof window === 'undefined' ? undefined : window.__QINGREAD_HARMONY__;
  if (!isHarmonyApp() || info?.bridgeVersion !== 1 || typeof info.version !== 'string' || typeof info.build !== 'string' || !/^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)){0,3}$/.test(info.version) || info.version.length > 40 || !/^\d{1,15}$/.test(info.build)) {
    throw new Error('暂时无法读取已安装版本，请重新打开后重试');
  }
  if (info.version.split('.').some(part => !Number.isSafeInteger(Number(part)))) throw new Error('暂时无法读取已安装版本，请重新打开后重试');
  return { bridgeVersion: 1, version: info.version, build: info.build };
}

export const harmonyActiveEvent = 'qingread:harmony-active';
export const harmonyBackgroundEvent = 'qingread:harmony-background';
