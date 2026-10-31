import { useEffect } from 'react';
import { App as NativeApp } from '@capacitor/app';
import { Download, RefreshCw, X } from 'lucide-react';
import { isAndroidApp } from '../lib/android';
import { androidUpdates, useAndroidUpdates, type AndroidUpdateStore } from '../lib/androidUpdateStore';
import './AndroidAppUpdate.css';

export function AndroidAppUpdateActions({ store = androidUpdates }: { store?: AndroidUpdateStore }) {
  const state = useAndroidUpdates(store), transfer = state.transfer;
  const downloading = transfer?.status === 'downloading';
  const available = state.check === 'available' && state.release?.artifact;
  const ready = transfer?.status === 'ready' && (!available || transfer.version === state.release?.version && transfer.build === state.release?.build);
  const progress = transfer && transfer.totalBytes > 0 ? Math.min(100, Math.floor(transfer.receivedBytes / transfer.totalBytes * 100)) : 0;
  if (!available && !downloading && !ready) return null;
  return <div className="android-update-actions">
    {downloading ? <><div className="android-update-progress"><span>正在下载 {progress}%</span><button className="text-button" disabled={state.busy} onClick={() => void store.cancel()}>取消</button></div><progress aria-label="更新下载进度" max={100} value={progress}/></>
      : ready ? <button className="primary-button full-width" disabled={state.busy} onClick={() => void store.install()}>{transfer.needsPermission ? '允许安装更新' : '安装更新'}</button>
      : state.bridgeAvailable === false ? <a className="primary-button full-width" href={state.release!.artifact!.url} target="_blank" rel="noopener noreferrer"><Download size={16}/>下载更新</a>
      : <button className="primary-button full-width" disabled={state.busy} onClick={() => void store.download()}>{transfer?.status === 'failed' || transfer?.status === 'cancelled' ? <RefreshCw size={16}/> : <Download size={16}/>}更新至 {state.release!.version}</button>}
    {state.installAction === 'permission' && <p className="about-note">允许此来源安装应用后返回，继续系统安装。</p>}
    {!downloading && <p className="about-note">覆盖安装，保留书架和阅读记录。</p>}
    {(state.actionError || transfer?.error) && <p className="about-note about-error" role="status">{state.actionError || transfer?.error}</p>}
  </div>;
}

export function AndroidAppUpdatePrompt({ paused }: { paused: boolean }) {
  const state = useAndroidUpdates();
  useEffect(() => {
    const detach = androidUpdates.attach();
    if (!isAndroidApp()) return detach;
    const listener = NativeApp.addListener('appStateChange', ({ isActive }) => { if (isActive) { void androidUpdates.refresh(); void androidUpdates.check(); } });
    return () => { detach(); void listener.then(handle => handle.remove()); };
  }, []);
  if (!isAndroidApp() || paused || !state.promptVisible || !state.release?.artifact && !['ready', 'downloading'].includes(state.transfer?.status || '')) return null;
  return <aside className="android-update-prompt" aria-label="清读版本更新">
    <header><strong>清读 {state.release?.version || state.transfer?.version}</strong><button className="icon-button" aria-label="稍后更新" onClick={() => androidUpdates.dismiss()}><X size={18}/></button></header>
    <AndroidAppUpdateActions/>
  </aside>;
}
