import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, Copy, ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react';
import appInfo from '../../../App/Resources/AppInfo.json';
import licenseText from '../../../LICENSE?raw';
import thirdPartyText from '../../../App/Resources/ThirdPartyNotices.txt?raw';
import { readClientIdentity, versionDiagnostics } from '../lib/appIdentity';
import { compareRelease, fetchReleaseManifest, resolveManifestURL, type ClientIdentity, type PlatformRelease } from '../lib/appUpdates';
import { serverConnectionStore } from '../lib/connection';
import { isAndroidApp, useAndroidBack } from '../lib/android';
import { isHarmonyApp } from '../lib/harmony';
import { useWebUpdates, webUpdates } from '../lib/webUpdates';
import './AboutQingRead.css';

type View = 'main' | 'log' | 'help' | 'feedback' | 'license';
type Check = { kind: 'idle' | 'checking' | 'current' | 'older' | 'available' | 'error'; message?: string; release?: PlatformRelease };
const viewNames = { main: '关于清读', log: '更新日志', help: '使用说明', feedback: '问题反馈', license: '许可与致谢' };
const sizeLabel = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;
export function AboutQingRead() {
  const [view, setView] = useState<View>('main');
  const [identity, setIdentity] = useState<ClientIdentity>();
  const [identityError, setIdentityError] = useState('');
  const [check, setCheck] = useState<Check>({ kind: 'idle' });
  const [copied, setCopied] = useState('');
  const pending = useRef<AbortController | null>(null);
  const worker = useWebUpdates();
  const android = isAndroidApp(), harmony = isHarmonyApp(), web = !android && !harmony;
  useAndroidBack(() => { if (view === 'main') return false; setView('main'); return true; }, 150);
  useEffect(() => {
    let live = true;
    void readClientIdentity().then(value => { if (live) setIdentity(value); }).catch(error => { if (live) setIdentityError(error.message); });
    return () => { live = false; pending.current?.abort(); };
  }, []);
  async function checkUpdates() {
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    setCheck({ kind: 'checking' }); setIdentityError('');
    try {
      const installed = identity ?? await readClientIdentity();
      if (controller.signal.aborted) return;
      setIdentity(installed);
      const url = resolveManifestURL(installed.platform, import.meta.env.BASE_URL, location.href, installed.platform !== 'web' ? serverConnectionStore().apiAddress() : '', appInfo.update.manifestPath);
      const [manifest] = await Promise.all([fetchReleaseManifest(url, { signal: controller.signal }), installed.platform === 'web' ? webUpdates.check(controller.signal) : Promise.resolve()]);
      if (controller.signal.aborted) return;
      const release = manifest.platforms[installed.platform];
      if (!release) throw new Error('当前服务尚未发布鸿蒙版本信息');
      const comparison = compareRelease(installed, release);
      if (installed.platform === 'web') webUpdates.setReleaseComparison(comparison);
      setCheck({ kind: comparison > 0 ? 'available' : comparison < 0 ? 'older' : 'current', release });
    } catch (error) {
      if (controller.signal.aborted) return;
      controller.abort();
      const message = error instanceof Error && /^(版本信息|安装包地址|暂时无法|检查更新|网页|当前服务)/.test(error.message) ? error.message : '检查更新失败，请重试';
      if (!identity) setIdentityError('版本信息暂不可用');
      setCheck({ kind: 'error', message });
    } finally { if (pending.current === controller) pending.current = null; }
  }
  function cancelCheck() { pending.current?.abort(); pending.current = null; setCheck({ kind: 'idle' }); }
  async function copyDiagnostics() {
    if (!identity) return;
    try { await navigator.clipboard.writeText(versionDiagnostics(identity)); setCopied('已复制版本与平台信息'); }
    catch { setCopied('复制失败，可手动复制下方信息'); }
  }
  const updateStatus = check.kind === 'checking' ? '正在检查' : check.kind === 'error' ? check.message : check.kind === 'older' ? '当前版本高于服务端发布版本' : web && worker.waiting && !worker.blockedByVersion ? '网页资源已准备好' : check.kind === 'available' ? `发现新版本 ${check.release!.version}${!web ? ` (${check.release!.build})` : ''}` : check.kind === 'current' ? '当前已是最新版本' : '';
  const apk = android && check.kind === 'available' ? check.release?.artifact : undefined;
  if (view !== 'main') return <div className="panel-content about-content">
    <button className="text-button about-back" onClick={() => setView('main')}><ArrowLeft size={16}/>关于清读</button><h3 className="about-page-title">{viewNames[view]}</h3>
    {view === 'log' && appInfo.releases.map(release => <article className="about-release" key={release.version}><h4>{release.version}<time>{release.date}</time></h4><ul>{release.changes.map(change => <li key={change}>{change}</li>)}</ul></article>)}
    {view === 'help' && appInfo.help.map(item => <article className="about-help" key={item.id}><h4>{item.title}</h4><p>{harmony && item.id === 'updates' ? '检查当前服务发布的鸿蒙版本。使用同一签名的 HAP 通过 DevEco Studio 或系统支持的安装方式覆盖安装，请勿先卸载。' : harmony && item.id === 'audio' ? '听书仅在当前设备提供可用系统音色时使用。暂不支持原生 AI 音色、锁屏控制和后台播放。' : harmony && item.id === 'offline' ? '章节下载请保持应用在前台；云端准备完成后需保存到本机才能离线阅读。当前版本暂不支持本机后台下载和系统追更通知。' : item.body}</p></article>)}
    {view === 'feedback' && <><p className="about-note">提交时写下操作步骤和遇到的问题，可附截图。</p><a className="primary-button full-width" href={appInfo.feedbackURL} target="_blank" rel="noopener noreferrer">打开问题反馈<ExternalLink size={16}/></a><button className="secondary-button full-width" disabled={!identity} onClick={() => void copyDiagnostics()}><Copy size={16}/>复制版本信息</button>{identity && <pre className="about-diagnostics">{versionDiagnostics(identity)}</pre>}{copied && <p className="about-note" role="status">{copied}</p>}</>}
    {view === 'license' && <><h4>{appInfo.license.name}</h4><pre className="about-license">{licenseText}</pre><h4>第三方许可</h4><pre className="about-license">{thirdPartyText}</pre></>}
  </div>;
  return <div className="panel-content about-content">
    <div className="about-identity"><span className="brand-mark">清</span><h3>{appInfo.name}</h3><p>{identity ? `${identity.platform === 'harmony' ? 'HarmonyOS' : identity.platform === 'android' ? 'Android' : 'Web'} ${identity.version}${identity.build ? ` (${identity.build})` : ''}` : identityError || '正在读取版本'}</p></div>
    <section className="about-update" aria-label="软件更新">
      <div className="about-update-row"><strong>检查更新</strong><button className="text-button" disabled={check.kind === 'checking'} onClick={() => void checkUpdates()}>{check.kind === 'checking' ? <LoaderCircle className="spin" size={16}/> : <RefreshCw size={16}/>}检查</button></div>
      {updateStatus && <p className={`about-note ${check.kind === 'error' ? 'about-error' : ''}`} role="status">{updateStatus}</p>}
      {check.kind === 'checking' && <button className="text-button" onClick={cancelCheck}>取消</button>}
      {check.kind === 'available' && <ul className="about-update-notes">{check.release!.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
      {web && worker.waiting && !worker.blockedByVersion && <button className="primary-button full-width" disabled={worker.activating} onClick={() => void webUpdates.activate().catch(error => setCheck({ kind: 'error', message: error.message }))}>{worker.activating ? '正在准备更新' : '更新网页'}</button>}
      {web && !worker.waiting && worker.canReload && check.kind === 'available' && <button className="primary-button full-width" onClick={() => webUpdates.reloadWithoutWorker()}>重新加载网页</button>}
      {web && !worker.waiting && !worker.canReload && check.kind === 'available' && <p className="about-note">新版本已发布，网页资源尚未准备好，请稍后再试。</p>}
      {apk && <><a className="primary-button full-width" href={apk.url} target="_blank" rel="noopener noreferrer">下载 APK · {sizeLabel(apk.size)}<ExternalLink size={16}/></a><p className="about-note">按系统提示覆盖安装；新包须与现有 App 签名一致，请勿先卸载。</p><details className="about-apk-details"><summary>安装包校验信息</summary><code>SHA-256 {apk.sha256}</code></details></>}
      {harmony && check.kind === 'available' && <p className="about-note">请使用同一签名的新 HAP，通过 DevEco Studio 或系统支持的安装方式覆盖安装；请勿先卸载。</p>}
      {android && check.kind === 'available' && !apk && <p className="about-note">新版本安装包尚未发布，请稍后再试。</p>}
    </section>
    <nav className="about-links" aria-label="关于清读功能">{(['log', 'help', 'feedback', 'license'] as const).map(value => <button key={value} onClick={() => { setCopied(''); setView(value); }}><span>{viewNames[value]}</span><ChevronRight size={17}/></button>)}</nav>
  </div>;
}
