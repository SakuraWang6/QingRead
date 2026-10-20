import { useRegisterSW } from 'virtual:pwa-register/react';

/** Keep the current reading page until the reader chooses to install an update. */
export default function UpdatePrompt() {
  const { needRefresh: [needsUpdate, setNeedsUpdate], updateServiceWorker } = useRegisterSW({ immediate: true });
  if (!needsUpdate) return null;
  return <aside className="update-prompt" role="status" aria-label="应用更新">
    <span>新版本已准备好</span>
    <button onClick={() => void updateServiceWorker(true)}>更新</button>
    <button onClick={() => setNeedsUpdate(false)}>稍后</button>
  </aside>;
}
