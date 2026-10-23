import { bundleManager } from '@kit.AbilityKit';

interface HarmonyMetadata {
  bridgeVersion: number;
  version: string;
  build: string;
}

export class AppMetadata {
  static async documentScript(): Promise<string> {
    const info: bundleManager.BundleInfo = await bundleManager.getBundleInfoForSelf(
      bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT
    );
    const metadata: HarmonyMetadata = {
      bridgeVersion: 1,
      version: info.versionName,
      build: String(info.versionCode)
    };
    return "(() => { if (window !== window.top || location.origin !== 'https://localhost' || " +
      "!['/', '/index.html'].includes(location.pathname)) return; " +
      "Object.defineProperty(window, '__QINGREAD_HARMONY__', { value: Object.freeze(" +
      JSON.stringify(metadata) + "), writable: false, configurable: false }); })();";
  }
}
