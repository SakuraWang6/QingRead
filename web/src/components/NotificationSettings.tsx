import { useEffect, useState } from 'react';
import { isAndroidApp } from '../lib/android';
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
  useEffect(()=>{setEnabled(localStorage.getItem(nativeNotificationKey(library.profile))==='true');},[cloud.session?.user.id]);
  async function toggle(){
    const owner=library;setBusy(true);setError('');
    try{
      const next=!enabled;
      if(next&&(await nativeBackground.requestNotificationPermission()).notifications!=='granted')throw new Error('请在系统设置允许清读通知');
      await nativeBackground.replaceWatchedBooks({profile:owner.profile,enabled:next,books:next?state.shelf.filter(e=>isChapterBook(e.book)&&!state.disabledSourceIDs.includes(e.book.sourceID)).slice(0,20).map(e=>({book:e.book,baseline:state.updates[e.book.id],readChapterID:e.position?.chapterID})):[]});
      if(library!==owner)return;localStorage.setItem(nativeNotificationKey(owner.profile),String(next));setEnabled(next);
    }catch(e){setError(e instanceof Error?e.message:'通知设置失败');}finally{setBusy(false);}
  }
  if(isAndroidApp())return <div className="panel-content"><h3>追更通知</h3><div className="switch-row"><span>书架更新提醒</span><button className={`toggle ${enabled?'on':''}`} role="switch" aria-label="追更通知" aria-checked={enabled} disabled={busy} onClick={()=>void toggle()}><span/></button></div><p className="muted">联网时由系统定期检查，省电模式可能延后。</p>{error&&<p role="alert">{error}</p>}</div>;
  return <PushNotificationsPanel auth={cloud.session?{apiAddress:apiBase(),session:cloud.session}:null} books={state.shelf.map(e=>e.book).filter(book=>!state.disabledSourceIDs.includes(book.sourceID))} onSync={()=>cloudSync.sync()}/>;
}
