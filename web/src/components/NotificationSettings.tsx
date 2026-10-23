import { useEffect, useState } from 'react';
import { isAndroidApp } from '../lib/android';
import { isHarmonyApp } from '../lib/harmony';
import { harmonyUpdates, supportsHarmonyDownloads, supportsHarmonyUpdates } from '../lib/harmonyBackground';
import { nativeBackground } from '../lib/androidBackground';
import { apiBase } from '../lib/api';
import { cloudSync, useCloudSync } from '../lib/cloud';
import { library, useLibrary } from '../lib/store';
import { isChapterBook } from '../lib/readingWorkflows';
import { PushNotificationsPanel } from './PushNotificationsPanel';
export const nativeNotificationKey=(profile:string)=>'qingread.native-notifications.'+profile;
export function NotificationSettings(){
  const state=useLibrary(),cloud=useCloudSync();
  const [enabled,setEnabled]=useState(localStorage.getItem(nativeNotificationKey(library.profile))==='true'),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    setEnabled(localStorage.getItem(nativeNotificationKey(library.profile))==='true');
    if(!isHarmonyApp()||!supportsHarmonyUpdates())return;
    let active=true;void harmonyUpdates.snapshot(library.profile).then(value=>{if(active){setEnabled(value.enabled);if(value.enabled&&value.notifications!=='granted')setError('请在系统设置允许清读通知');}}).catch(()=>{});return()=>{active=false;};
  },[cloud.session?.user.id]);
  async function toggle(){
    const owner=library;setBusy(true);setError('');
    try{
      const next=!enabled;
      if(next&&(await (isHarmonyApp()?harmonyUpdates.requestPermission():nativeBackground.requestNotificationPermission())).notifications!=='granted')throw new Error('请在系统设置允许清读通知');
      const books=next?state.shelf.filter(e=>isChapterBook(e.book)&&!state.disabledSourceIDs.includes(e.book.sourceID)).slice(0,20).map(e=>({book:e.book,baseline:state.updates[e.book.id],readChapterID:e.position?.chapterID})):[];
      if(isHarmonyApp())await harmonyUpdates.watch(owner.profile,next,books);else await nativeBackground.replaceWatchedBooks({profile:owner.profile,enabled:next,books});
      if(library!==owner)return;localStorage.setItem(nativeNotificationKey(owner.profile),String(next));setEnabled(next);
    }catch(e){setError(e instanceof Error?e.message:'通知设置失败');}finally{setBusy(false);}
  }
  if(isHarmonyApp()&&!supportsHarmonyUpdates())return <div className="panel-content"><h3>通知与后台</h3><p className="muted">{supportsHarmonyDownloads()?'当前系统暂不支持后台追更通知。云端准备完成后可交给系统下载。':'当前鸿蒙版本暂不支持系统追更通知和本机后台下载。下载请保持应用在前台；云端已备妥的章节需保存到本机后才能离线阅读。'}</p></div>;
  if(isAndroidApp()||isHarmonyApp()&&supportsHarmonyUpdates())return <div className="panel-content"><h3>追更通知</h3><div className="switch-row"><span>书架更新提醒</span><button className={`toggle ${enabled?'on':''}`} role="switch" aria-label="追更通知" aria-checked={enabled} disabled={busy} onClick={()=>void toggle()}><span/></button></div><p className="muted">{isHarmonyApp()?'由系统择机检查，省电或长时间未使用可能延后。':'联网时由系统定期检查，省电模式可能延后。'}</p>{error&&<p role="alert">{error}</p>}</div>;
  return <PushNotificationsPanel auth={cloud.session?{apiAddress:apiBase(),session:cloud.session}:null} books={state.shelf.map(e=>e.book).filter(book=>!state.disabledSourceIDs.includes(book.sourceID))} onSync={()=>cloudSync.sync()}/>;
}
