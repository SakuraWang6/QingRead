import { useState } from 'react';
import { cloudSync, useCloudSync } from '../lib/cloud';
import { guestLibrary } from '../lib/store';

export function AccountPanel(){
  const cloud=useCloudSync();
  const [register,setRegister]=useState(false),[relogin,setRelogin]=useState(false),[recover,setRecover]=useState(false),[security,setSecurity]=useState(false),[recoveryCode,setRecoveryCode]=useState('');
  const [username,setUsername]=useState(cloud.session?.user.username??''),[password,setPassword]=useState(''),[confirmation,setConfirmation]=useState('');
  const [remember,setRemember]=useState(false),[error,setError]=useState(''),[submitting,setSubmitting]=useState(false);
  async function submit(event:React.FormEvent){
    event.preventDefault();if(submitting||cloud.busy)return;setError('');
    if((register||recover)&&password!==confirmation){setError('两次密码不一致');return;}
    setSubmitting(true);
    try{if(recover)await cloudSync.recover(username,recoveryCode,password,remember);else await cloudSync.login(username,password,register,remember);setRelogin(false);setRecover(false);setRecoveryCode('');}
    catch(e){setError(e instanceof Error?e.message:'登录失败');}
    finally{setSubmitting(false);setPassword('');setConfirmation('');}
  }
  if(cloud.session&&!relogin&&security)return <AccountSecurity onBack={()=>setSecurity(false)}/>;
  if(cloud.session&&!relogin)return <div className="panel-content account-panel">
    <h2>{cloud.session.user.username}</h2>
    <p role="status">{cloud.busy?'正在同步…':cloud.lastSync?'上次同步 '+new Date(cloud.lastSync).toLocaleTimeString():'等待同步'}</p>
    {cloud.error&&<p className="error-banner">{cloud.error}</p>}
    <button className="primary-button" disabled={cloud.busy} onClick={()=>cloud.expired?setRelogin(true):void cloudSync.sync()}>{cloud.expired?'重新登录':'立即同步'}</button>
    {guestLibrary.getSnapshot().shelf.length>0&&<button className="secondary-button" disabled={cloud.busy} onClick={()=>void cloudSync.mergeGuest().catch(e=>setError(e.message))}>合并本机未登录书架（{guestLibrary.getSnapshot().shelf.length} 本）</button>}
    <p className="muted">云文件 {cloud.files.length} · {(cloud.usedBytes/1024**2).toFixed(1)} MB</p>
    {cloud.fileMessage&&<p role="status">{cloud.fileMessage}</p>}
    <button className="secondary-button" disabled={cloud.fileBusy} onClick={()=>void cloudSync.syncFiles()}>{cloud.fileBusy?'文件同步中…':'同步文件'}</button>
    <button className="secondary-button" onClick={()=>setSecurity(true)}>账号安全</button>
    {error&&<p role="alert">{error}</p>}
    <button className="secondary-button" disabled={cloud.busy} onClick={()=>void cloudSync.logout()}>退出账号</button>
  </div>;
  return <form className="panel-content account-panel" onSubmit={event=>void submit(event)}>
    <h2>{recover?'恢复账号':register?'注册':'登录'}</h2>
    <label className="field-label" htmlFor="cloud-username">用户名</label>
    <input id="cloud-username" className="text-input" value={username} onChange={e=>setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" minLength={2} maxLength={32} required/>
    {recover&&<><label className="field-label" htmlFor="cloud-recovery">恢复码</label><input id="cloud-recovery" className="text-input" value={recoveryCode} onChange={e=>setRecoveryCode(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} minLength={32} maxLength={32} required/></>}
    <label className="field-label" htmlFor="cloud-password">{recover?'新密码':'密码'}</label>
    <input id="cloud-password" className="text-input" type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete={register||recover?'new-password':'current-password'} minLength={10} maxLength={128} required/>
    {(register||recover)&&<><label className="field-label" htmlFor="cloud-confirm">确认密码</label><input id="cloud-confirm" className="text-input" type="password" value={confirmation} onChange={e=>setConfirmation(e.target.value)} autoComplete="new-password" minLength={10} maxLength={128} required/></>}
    <label className="field-label"><input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)}/> 在此设备保持登录</label>
    {(error||cloud.error)&&<p className="error-banner" role="alert">{error||cloud.error}</p>}
    <button className="primary-button" disabled={cloud.busy||submitting} type="submit">{cloud.busy||submitting?'请稍候…':recover?'重置密码并登录':register?'注册并登录':'登录'}</button>
    <button className="text-button" type="button" disabled={submitting||cloud.busy} onClick={()=>{setRegister(recover?false:!register);setRecover(false);setError('');}}>{register||recover?'返回登录':'没有账号，创建一个'}</button>
    {!register&&!recover&&<button className="text-button" type="button" disabled={submitting||cloud.busy} onClick={()=>{setRecover(true);setPassword('');setError('');}}>使用恢复码找回</button>}
    {register&&<p className="muted">密码至少 10 位</p>}
  </form>;
}

function AccountSecurity({onBack}:{onBack:()=>void}){
  const [mode,setMode]=useState<'password'|'recovery'>('password'),[password,setPassword]=useState(''),[next,setNext]=useState(''),[confirm,setConfirm]=useState(''),[code,setCode]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  async function submit(event:React.FormEvent){event.preventDefault();setBusy(true);setError('');setNotice('');try{if(mode==='password'){if(next!==confirm)throw new Error('两次新密码不一致');await cloudSync.changePassword(password,next);setNotice('密码已修改，其他设备需重新登录');setNext('');setConfirm('');}else setCode(await cloudSync.createRecoveryCode(password));}catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{setPassword('');setBusy(false);}}
  return <form className="panel-content account-panel" onSubmit={event=>void submit(event)}><button className="text-button" type="button" onClick={onBack}>返回账号</button><div className="segmented"><button type="button" className={mode==='password'?'active':''} onClick={()=>{setMode('password');setCode('');}}>修改密码</button><button type="button" className={mode==='recovery'?'active':''} onClick={()=>setMode('recovery')}>恢复码</button></div>
    {code?<><label className="field-label" htmlFor="saved-recovery-code">仅显示一次，请安全保存</label><textarea className="text-input" id="saved-recovery-code" value={code} readOnly spellCheck={false}/><button type="button" className="secondary-button" onClick={()=>{setCode('');onBack();}}>已保存</button></>:<><label className="field-label" htmlFor="security-password">当前密码</label><input id="security-password" className="text-input" type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password" minLength={10} maxLength={128} required/>
      {mode==='password'?<><label className="field-label" htmlFor="security-new-password">新密码</label><input id="security-new-password" className="text-input" type="password" value={next} onChange={e=>setNext(e.target.value)} autoComplete="new-password" minLength={10} maxLength={128} required/><label className="field-label" htmlFor="security-confirm">确认新密码</label><input id="security-confirm" className="text-input" type="password" value={confirm} onChange={e=>setConfirm(e.target.value)} autoComplete="new-password" minLength={10} maxLength={128} required/></>:<p className="muted">重新生成后，旧恢复码失效。忘记密码时可凭此码重置。</p>}
      <button className="primary-button" disabled={busy} type="submit">{busy?'请稍候…':mode==='password'?'保存新密码':'生成恢复码'}</button></>}{error&&<p role="alert" className="error-banner">{error}</p>}{notice&&<p role="status">{notice}</p>}
  </form>;
}
