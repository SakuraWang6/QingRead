import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { isNativeApp } from './lib/nativePlatform';
import { disableNativeServiceWorkers, initializeAndroid } from './lib/android';
import App from './App';
import UpdatePrompt from './components/UpdatePrompt';
import './styles.css';
if (isNativeApp()) {
  void disableNativeServiceWorkers();
  void initializeAndroid();
}
createRoot(document.getElementById('root')!).render(<StrictMode><App/>{!isNativeApp() && <UpdatePrompt/>}</StrictMode>);
