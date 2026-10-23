import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { LocalOrigin } from './LocalOrigin';

interface PackagedAsset {
  path: string;
  mime: string;
}

interface PackagedIndex {
  schemaVersion: number;
  assets: PackagedAsset[];
}

export class ResourceIndex {
  private mimeByPath: Map<string, string> = new Map<string, string>();

  load(context: common.UIAbilityContext): void {
    let bytes: Uint8Array;
    try {
      bytes = context.resourceManager.getRawFileContentSync('qingread-assets.json');
    } catch (_) {
      // Normalize platform-specific failures; the page displays a single recoverable startup error.
      throw new Error('Packaged resource index could not be read');
    }
    if (bytes.byteLength > 2 * 1024 * 1024) {
      throw new Error('Asset index is too large');
    }
    const text: string = util.TextDecoder.create('utf-8', { fatal: true }).decodeToString(bytes);
    const index: PackagedIndex = JSON.parse(text) as PackagedIndex;
    if (index.schemaVersion !== 1 || !Array.isArray(index.assets) || index.assets.length > 20000) {
      throw new Error('Invalid asset index');
    }
    const entries: Map<string, string> = new Map<string, string>();
    for (const asset of index.assets) {
      if (typeof asset.path !== 'string' || typeof asset.mime !== 'string' ||
        !LocalOrigin.isSafePath(asset.path) || asset.path === '/' ||
        !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(asset.mime) || entries.has(asset.path)) {
        throw new Error('Invalid packaged asset');
      }
      entries.set(asset.path, asset.mime);
    }
    if (entries.get('/index.html') !== 'text/html') {
      throw new Error('Missing entry page');
    }
    this.mimeByPath = entries;
  }

  mimeFor(path: string): string | undefined {
    return this.mimeByPath.get(path);
  }
}
