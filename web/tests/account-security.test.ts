import { describe,expect,it } from 'vitest';
import { CloudDatabase } from '../server/cloud';
describe('password changes and offline recovery codes',()=>{
  it('requires the current password, rotates sessions, preserves the library and consumes a recovery code once',async()=>{
    const db=new CloudDatabase(':memory:');
    try{
      const first=await db.authenticate({username:'recovery-reader',password:'first-long-password'},true),header='Bearer '+first.token;
      await expect(db.recoveryCode(header,{password:'wrong-password'})).rejects.toThrow('当前密码');expect(db.authorize(header).id).toBe(first.user.id);
      const {recoveryCode}=await db.recoveryCode(header,{password:'first-long-password'});expect(recoveryCode).toHaveLength(32);
      const second=await db.changePassword(header,{currentPassword:'first-long-password',newPassword:'second-long-password'});expect(()=>db.authorize(header)).toThrow();expect(db.authorize('Bearer '+second.token).id).toBe(first.user.id);
      await expect(db.recover({username:'missing-reader',recoveryCode,newPassword:'recovered-long-password'})).rejects.toThrow('恢复码无效');
      const recovered=await db.recover({username:'recovery-reader',recoveryCode,newPassword:'recovered-long-password'});expect(recovered.user.id).toBe(first.user.id);expect(()=>db.authorize('Bearer '+second.token)).toThrow();
      await expect(db.recover({username:'recovery-reader',recoveryCode,newPassword:'another-long-password'})).rejects.toThrow('恢复码无效');
      expect((await db.authenticate({username:'recovery-reader',password:'recovered-long-password'},false)).user.id).toBe(first.user.id);
    }finally{db.close();}
  });
  it('replaces old recovery codes and isolates accounts',async()=>{
    const db=new CloudDatabase(':memory:');try{const a=await db.authenticate({username:'reader-a',password:'test-password-long'},true),b=await db.authenticate({username:'reader-b',password:'test-password-long'},true);const old=await db.recoveryCode('Bearer '+a.token,{password:'test-password-long'}),next=await db.recoveryCode('Bearer '+a.token,{password:'test-password-long'});await expect(db.recover({username:b.user.username,recoveryCode:next.recoveryCode,newPassword:'test-password-new'})).rejects.toThrow();await expect(db.recover({username:a.user.username,recoveryCode:old.recoveryCode,newPassword:'test-password-new'})).rejects.toThrow();expect(db.authorize('Bearer '+b.token).id).toBe(b.user.id);}finally{db.close();}
  });
});
