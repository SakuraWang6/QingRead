import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { isNativeApp } from './lib/nativePlatform';
import { initializeHarmonyConnection } from './lib/harmonyConnection';
import { disableNativeServiceWorkers, initializeAndroid } from './lib/android';
import App from './App';
import UpdatePrompt from './components/UpdatePrompt';
import './styles.css';
if (isNativeApp()) {
  void disableNativeServiceWorkers();
  void initializeAndroid();
}
// Access-code headers are synchronous, so hydrate their secure copy before any API call.
void initializeHarmonyConnection().catch(() => { /* Login and offline reading stay usable if secure storage is unavailable. */ }).then(() => {
  createRoot(document.getElementById('root')!).render(<StrictMode><App/>{!isNativeApp() && <UpdatePrompt/>}</StrictMode>);
});
