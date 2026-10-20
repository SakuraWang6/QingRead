import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import { disableNativeServiceWorkers, initializeAndroid } from './lib/android';
import App from './App';
import UpdatePrompt from './components/UpdatePrompt';
import './styles.css';
if (Capacitor.isNativePlatform()) {
  void disableNativeServiceWorkers();
  void initializeAndroid();
}
createRoot(document.getElementById('root')!).render(<StrictMode><App/>{!Capacitor.isNativePlatform() && <UpdatePrompt/>}</StrictMode>);
