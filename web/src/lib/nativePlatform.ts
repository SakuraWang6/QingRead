import { Capacitor } from '@capacitor/core';
import { isHarmonyApp } from './harmony';
import { hasHarmonyCapability } from './harmonyNative';

export const isNativeApp = (): boolean => isHarmonyApp() || Capacitor.isNativePlatform();
export const platformLabel = (): string => isHarmonyApp() ? 'HarmonyOS' : Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android' ? 'Android' : 'Web';
/** Persistent Harmony credentials require the explicitly advertised ASSET bridge. */
export const canRememberCredentials = (): boolean => !isHarmonyApp() || hasHarmonyCapability('secureStorage');
