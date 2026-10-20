import { useState } from 'react';
import { cloudSync, useCloudSync } from '../lib/cloud';
import { guestLibrary } from '../lib/store';

export function AccountPanel(){
  const cloud=useCloudSync();
  const [register,setRegister]=useState(false),[relogin,setRelogin]=useState(false);
  const [username,setUsername]=useState(cloud.session?.user.username??''),[password,setPassword]=useState(''),[confirmation,setConfirmation]=useState('');
  const [remember,setRemember]=useState(false),[error,setError]=useState('');
  async function submit(event:React.FormEvent){
    event.preventDefault();setError('');
    if(register&&password!==confirmation){setError('两次密码不一致');return;}
    try{await cloudSync.login(username,password,register,remember);setRelogin(false);}
    catch(e){setError(e instanceof Error?e.message:'登录失败');}
    finally{setPassword('');setConfirmation('');}
  }
  if(cloud.session&&!relogin)return <div className="panel-content account-panel">
    <h2>{cloud.session.user.username}</h2>
    <p role="status">{cloud.busy?'正在同步…':cloud.lastSync?'上次同步 '+new Date(cloud.lastSync).toLocaleTimeString():'等待同步'}</p>
    {cloud.error&&<p className="error-banner">{cloud.error}</p>}
    <button className="primary-button" disabled={cloud.busy} onClick={()=>cloud.expired?setRelogin(true):void cloudSync.sync()}>{cloud.expired?'重新登录':'立即同步'}</button>
    {guestLibrary.getSnapshot().shelf.length>0&&<button className="secondary-button" disabled={cloud.busy} onClick={()=>void cloudSync.mergeGuest().catch(e=>setError(e.message))}>合并本机未登录书架（{guestLibrary.getSnapshot().shelf.length} 本）</button>}
    <p className="muted">云文件 {cloud.files.length} · {(cloud.usedBytes/1024**2).toFixed(1)} MB</p>
    {cloud.fileMessage&&<p role="status">{cloud.fileMessage}</p>}
    <button className="secondary-button" disabled={cloud.fileBusy} onClick={()=>void cloudSync.syncFiles()}>{cloud.fileBusy?'文件同步中…':'同步文件'}</button>
    {error&&<p role="alert">{error}</p>}
    <button className="secondary-button" disabled={cloud.busy} onClick={()=>void cloudSync.logout()}>退出账号</button>
  </div>;
  return <form className="panel-content account-panel" onSubmit={event=>void submit(event)}>
    <h2>{register?'注册':'登录'}</h2>
    <label className="field-label" htmlFor="cloud-username">用户名</label>
    <input id="cloud-username" className="text-input" value={username} onChange={e=>setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" minLength={2} maxLength={32} required/>
    <label className="field-label" htmlFor="cloud-password">密码</label>
    <input id="cloud-password" className="text-input" type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete={register?'new-password':'current-password'} minLength={10} maxLength={128} required/>
    {register&&<><label className="field-label" htmlFor="cloud-confirm">确认密码</label><input id="cloud-confirm" className="text-input" type="password" value={confirmation} onChange={e=>setConfirmation(e.target.value)} autoComplete="new-password" minLength={10} maxLength={128} required/></>}
    <label className="field-label"><input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)}/> 在此设备保持登录</label>
    {(error||cloud.error)&&<p className="error-banner" role="alert">{error||cloud.error}</p>}
    <button className="primary-button" disabled={cloud.busy} type="submit">{cloud.busy?'请稍候…':register?'注册并登录':'登录'}</button>
    <button className="text-button" type="button" onClick={()=>{setRegister(!register);setError('');}}>{register?'已有账号，去登录':'没有账号，创建一个'}</button>
    {register&&<p className="muted">密码至少 10 位</p>}
  </form>;
}
