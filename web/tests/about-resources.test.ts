import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isFileServingAllowed, resolveConfig } from 'vite';

describe('offline public about resources', () => {
  it('permits only the needed public files outside web, without opening private signing or local configuration', async () => {
    const config = await resolveConfig({}, 'serve');
    const rootFile = (path: string) => fileURLToPath(new URL('../../' + path, import.meta.url));
    for (const path of ['LICENSE', 'App/Resources/AppInfo.json', 'App/Resources/ThirdPartyNotices.txt']) expect(isFileServingAllowed(config, rootFile(path))).toBe(true);
    for (const path of ['.private/android-signing/qingread-debug.keystore', 'Config/Local.xcconfig', 'App/ReaderCanvas.swift', 'README.md']) expect(isFileServingAllowed(config, rootFile(path))).toBe(false);
  });
});
