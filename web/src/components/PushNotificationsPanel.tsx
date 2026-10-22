import { useEffect, useMemo, useState } from 'react';
import type { Book } from '../shared/types';
import { cancelPendingPushChanges, currentPushSubscriptionID, disablePush, enablePush, pushConfiguration, pushStatus, pushSupport, savePushBooks, type PushAuth, type PushConfiguration } from '../lib/pushNotifications';

export function PushNotificationsPanel({ auth, books, onSync }: { auth: PushAuth | null; books: Book[]; onSync?: () => Promise<void> }) {
  const support = useMemo(pushSupport, []);
  const [config, setConfig] = useState<PushConfiguration>();
  const [selected, setSelected] = useState<string[]>([]);
  const [enabled, setEnabled] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const available = books.filter(book => !book.publicationFormat && !book.fileDownloadURL && !book.sourceID.startsWith('local') && !book.sourceID.startsWith('sample'));
  useEffect(() => {
    let alive = true;
    setConfig(undefined); setSelected([]); setEnabled(false); setError('');
    if (!auth || !support.supported) return;
    void (async () => {
      try {
        const configuration = await pushConfiguration(auth);
        if (!alive) return;
        setConfig(configuration);
        if (!configuration.enabled) return;
        const [status, deviceID] = await Promise.all([pushStatus(auth), currentPushSubscriptionID()]);
        if (!alive) return;
        setEnabled(Boolean(deviceID && status.subscriptionIDs.includes(deviceID)));
        setSelected(status.bookIDs);
      } catch (value) { if (alive) setError(value instanceof Error ? value.message : '通知状态未能加载。'); }
    })();
    return () => { alive = false; cancelPendingPushChanges(); };
  }, [auth?.apiAddress, auth?.session.user.id, auth?.session.token, support.supported]);
  async function enable() {
    if (!auth || !config) return;
    setBusy(true); setError('');
    try { const state = await enablePush(auth, config, selected, onSync); setEnabled(true); setSelected(state.bookIDs); }
    catch (value) { setError(value instanceof Error ? value.message : '通知未能开启。'); }
    finally { setBusy(false); }
  }
  async function disable() {
    if (!auth) return;
    setBusy(true); setError('');
    try { await disablePush(auth); }
    catch (value) { setError(value instanceof Error ? value.message : '服务器暂时无法连接。'); }
    finally { setEnabled(false); setBusy(false); }
  }
  async function save() {
    if (!auth) return;
    setBusy(true); setError('');
    try { await onSync?.(); await savePushBooks(auth, selected); }
    catch (value) { setError(value instanceof Error ? value.message : '追更图书未能保存。'); }
    finally { setBusy(false); }
  }
  return <section className="panel-content push-notifications-panel" aria-label="追更通知">
    <h2>追更通知</h2>
    {!auth ? <p className="muted">登录后开启</p> : !support.supported ? <p className="muted">{support.reason}</p> : config && !config.enabled ? <p className="muted">服务器尚未开启推送</p> : <>
      <p className="muted">通知隐藏书名，定期检查。</p>
      <fieldset disabled={busy || !config}><legend>追更图书 · {selected.length}/{config?.maxBooks ?? 20}</legend>
        {available.map(book => <label key={book.id} className="field-label"><input type="checkbox" checked={selected.includes(book.id)} disabled={!selected.includes(book.id) && selected.length >= (config?.maxBooks ?? 20)} onChange={event => setSelected(values => event.target.checked ? [...values, book.id] : values.filter(id => id !== book.id))}/>{book.title}</label>)}
        {!available.length && <p className="muted">先添加网络小说到书架</p>}
      </fieldset>
      {enabled ? <><button className="primary-button" disabled={busy} onClick={() => void save()}>保存追更图书</button><button className="secondary-button" disabled={busy} onClick={() => void disable()}>关闭此设备通知</button></> : <button className="primary-button" disabled={busy || !config || !selected.length} onClick={() => void enable()}>开启此设备通知</button>}
    </>}
    {error && <p className="error-banner" role="alert">{error}</p>}
  </section>;
}
