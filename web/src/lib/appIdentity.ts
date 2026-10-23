import { App as NativeApp } from '@capacitor/app';
import { version } from '../../package.json';
import { isAndroidApp } from './android';
import { harmonyIdentity, isHarmonyApp } from './harmony';
import type { ClientIdentity } from './appUpdates';

export async function readClientIdentity(): Promise<ClientIdentity> {
  if (isHarmonyApp()) { const installed = harmonyIdentity(); return { platform: 'harmony', version: installed.version, build: installed.build }; }
  if (!isAndroidApp()) return { platform: 'web', version };
  try {
    const installed = await NativeApp.getInfo();
    if (!installed.version || !installed.build) throw new Error();
    return { platform: 'android', version: installed.version, build: installed.build };
  } catch { throw new Error('暂时无法读取已安装版本，请重新打开后重试'); }
}
/** An explicit copy action exposes only app identity, never accounts, books or service URLs. */
export function versionDiagnostics(identity: ClientIdentity): string {
  return `清读 ${identity.version}${identity.build ? ` (${identity.build})` : ''}\n平台：${identity.platform === 'harmony' ? 'HarmonyOS' : identity.platform === 'android' ? 'Android' : 'Web'}`;
}
