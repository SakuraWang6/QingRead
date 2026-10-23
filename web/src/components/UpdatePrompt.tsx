import { useEffect } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useWebUpdates, webUpdates } from '../lib/webUpdates';
import { readClientIdentity } from '../lib/appIdentity';
import { compareRelease, fetchReleaseManifest, resolveManifestURL } from '../lib/appUpdates';

/** The about page and background prompt share one pending worker and activation path. */
export default function UpdatePrompt() {
  const { needRefresh: [needsUpdate], updateServiceWorker } = useRegisterSW({
    immediate: true,
    onRegisteredSW: (_url, registration) => webUpdates.attachRegistration(registration),
    onRegisterError: () => webUpdates.registrationFailed(),
  });
  useEffect(() => {
    webUpdates.setActivation(() => updateServiceWorker(true));
    webUpdates.setVersionValidation(async () => {
      const current = await readClientIdentity();
      const url = resolveManifestURL('web', import.meta.env.BASE_URL, location.href, '', '');
      return compareRelease(current, (await fetchReleaseManifest(url)).platforms.web);
    });
  }, [updateServiceWorker]);
  useEffect(() => { webUpdates.notifyWaiting(needsUpdate); }, [needsUpdate]);
  const state = useWebUpdates();
  if (!state.waiting || !state.promptVisible) return null;
  return <aside className="update-prompt" role="status" aria-label="应用更新">
    <span>{state.error || (state.activating ? '正在准备更新' : '新版本已准备好')}</span>
    <button disabled={state.activating} onClick={() => void webUpdates.activate().catch(() => {})}>更新</button>
    <button disabled={state.activating} onClick={webUpdates.dismissPrompt}>稍后</button>
  </aside>;
}
