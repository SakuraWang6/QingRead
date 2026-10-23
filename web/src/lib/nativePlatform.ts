import { Capacitor } from '@capacitor/core';
import { isHarmonyApp } from './harmony';

export const isNativeApp = (): boolean => isHarmonyApp() || Capacitor.isNativePlatform();
export const platformLabel = (): string => isHarmonyApp() ? 'HarmonyOS' : Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android' ? 'Android' : 'Web';
/** Harmony v1 has no encrypted credential bridge; keep credentials in this session only. */
export const canRememberCredentials = (): boolean => !isHarmonyApp();
