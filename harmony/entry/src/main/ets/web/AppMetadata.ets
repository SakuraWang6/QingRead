import { bundleManager } from '@kit.AbilityKit';
import { NativeBootstrap } from './NativeBootstrap';

interface HarmonyMetadata {
  bridgeVersion: number;
  version: string;
  build: string;
  capabilities: string[];
}

export class AppMetadata {
  static async documentScript(capabilities: string[], nonce: string): Promise<string> {
    const info: bundleManager.BundleInfo = await bundleManager.getBundleInfoForSelf(
      bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT
    );
    const metadata: HarmonyMetadata = {
      bridgeVersion: 2,
      version: info.versionName,
      build: String(info.versionCode),
      capabilities: capabilities
    };
    return NativeBootstrap.script(JSON.stringify(metadata), nonce);
  }
}
