import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudSync } from '../src/lib/cloud';
import type { CloudSession } from '../src/shared/sync';

const context=vi.hoisted(()=>{
  const makeStore=()=>({
    getSnapshot:vi.fn(()=>({sources:[],shelf:[]})),initializeSources:vi.fn(async()=>{}),
    configureServerDownloads:vi.fn(),subscribe:vi.fn(()=>()=>{}),hasPendingSync:vi.fn(()=>false),
    syncRequest:vi.fn(async()=>({cursor:0,mutations:[]} as {cursor:number;mutations:unknown[]})),acceptSync:vi.fn(async()=>{}),
  });
  const guest=makeStore();return{makeStore,guest,library:guest,profiles:new Map<string,ReturnType<typeof makeStore>>(),android:false,native:{load:vi.fn(),save:vi.fn(),clear:vi.fn()}};
});
vi.mock('../src/lib/api',()=>({apiBase:()=> 'https://reader.test/api'}));
vi.mock('../src/lib/android',()=>({isAndroidApp:()=>context.android}));
vi.mock('../src/lib/pushNotifications',()=>({disablePush:vi.fn(async()=>{}),cancelPendingPushChanges:vi.fn()}));
vi.mock('@capacitor/core',()=>({registerPlugin:()=>context.native}));
vi.mock('../src/lib/store',()=>({
  get library(){return context.library;},guestLibrary:context.guest,
  switchLibraryProfile:vi.fn(async(profile:string|null)=>{context.library=profile?context.profiles.get(profile)??context.guest:context.guest;}),
}));
const storage=()=>{const entries=new Map<string,string>();return{getItem:(key:string)=>entries.get(key)??null,setItem:(key:string,value:string)=>{entries.set(key,String(value));},removeItem:(key:string)=>{entries.delete(key);}};};
const session=(id:string):CloudSession=>({token:id.repeat(43).slice(0,43),user:{id,username:'reader-'+id},expiresAt:'2026-12-01T00:00:00Z',serverTime:'2026-10-22T00:00:00Z'});
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return{promise,resolve};};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
let fetcher:ReturnType<typeof vi.fn>;
beforeEach(()=>{
  context.library=context.guest;context.android=false;context.profiles.clear();
  for(const id of ['a','b'])context.profiles.set('https://reader.test/api|'+id,context.makeStore());
  context.native.load.mockResolvedValue({value:null});context.native.save.mockResolvedValue(undefined);context.native.clear.mockResolvedValue(undefined);
  vi.stubGlobal('sessionStorage',storage());vi.stubGlobal('localStorage',storage());vi.stubGlobal('navigator',{onLine:true});
  fetcher=vi.fn(async(url:string,init?:RequestInit)=>{
    if(url.endsWith('/auth/login'))return json(session(JSON.parse(String(init?.body)).username));
    if(url.endsWith('/auth/logout'))return json({ok:true});
    if(url.endsWith('/sync'))return json({cursor:0,records:[],acknowledged:[],rejected:[],hasMore:false,serverTime:'2026-10-22T00:00:00Z'});
    if(url.endsWith('/files'))return json({files:[],usedBytes:0,limitBytes:100,maxFileBytes:100});
    throw new Error('Unexpected request '+url);
  });vi.stubGlobal('fetch',fetcher);
});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();vi.clearAllMocks();});

describe('cloud client account boundaries',()=>{
  it('keeps Harmony login in session storage even when remember was requested', async()=>{
    vi.stubGlobal('window', { location: { origin: 'https://localhost' }, navigator: { userAgent: 'QingReadHarmony/1' }, __QINGREAD_HARMONY__: { bridgeVersion: 1, version: '0.11.0', build: '1' } });
    localStorage.setItem('qingread.cloud-session.v1', JSON.stringify({address:'https://reader.test/api',session:session('b')}));
    const cloud=new CloudSync(); await cloud.initialize();
    expect(cloud.getSnapshot().session).toBeNull(); expect(localStorage.getItem('qingread.cloud-session.v1')).toBeNull();
    await cloud.login('a','password',false,true);
    expect(cloud.getSnapshot().session?.user.id).toBe('a');
    expect(sessionStorage.getItem('qingread.cloud-session.v1')).toContain('reader-a');
    expect(localStorage.getItem('qingread.cloud-session.v1')).toBeNull(); expect(context.native.save).not.toHaveBeenCalled();
    await cloud.logout();
  });
  it('stores remembered Harmony sessions only in the advertised system credential service', async()=>{
    let secureValue:string|null=null;
    const nativeRequest=vi.fn(async(raw:string)=>{const request=JSON.parse(raw);let result:unknown={};if(request.method==='credentials.load')result={value:secureValue};if(request.method==='credentials.save')secureValue=request.params.value;if(request.method==='credentials.clear')secureValue=null;return JSON.stringify({id:request.id,ok:true,result});});
    vi.stubGlobal('window',{location:{origin:'https://localhost'},__QINGREAD_HARMONY__:{bridgeVersion:2,version:'1.0.0',build:'1',capabilities:['secureStorage']},QingReadNative:{request:nativeRequest}});
    const cloud=new CloudSync();await cloud.login('a','password',false,true);
    expect(secureValue).toContain('reader-a');expect(localStorage.getItem('qingread.cloud-session.v1')).toBeNull();
    sessionStorage.removeItem('qingread.cloud-session.v1');const reopened=new CloudSync();await reopened.initialize();expect(reopened.getSnapshot().session?.user.id).toBe('a');
    await cloud.logout();expect(secureValue).toBeNull();expect(localStorage.getItem('qingread.harmony-session-restore-disabled')).toBe('true');
  });
  it('keeps a usable Harmony session after a secure save error and prevents stale account restoration', async()=>{
    const nativeRequest=vi.fn(async(raw:string)=>{const request=JSON.parse(raw);return JSON.stringify(request.method==='credentials.save'||request.method==='credentials.clear'?{id:request.id,ok:false,error:'系统凭据不可用'}:{id:request.id,ok:true,result:{value:JSON.stringify({address:'https://reader.test/api',session:session('b')})}});});
    vi.stubGlobal('window',{location:{origin:'https://localhost'},__QINGREAD_HARMONY__:{bridgeVersion:2,version:'1.0.0',build:'1',capabilities:['secureStorage']},QingReadNative:{request:nativeRequest}});
    const cloud=new CloudSync();await cloud.login('a','password',false,true);
    expect(cloud.getSnapshot().session?.user.id).toBe('a');expect(cloud.getSnapshot().credentialNotice).toContain('未能安全保存');
    expect(localStorage.getItem('qingread.cloud-session.v1')).toBeNull();expect(localStorage.getItem('qingread.harmony-session-restore-disabled')).toBe('true');
    sessionStorage.removeItem('qingread.cloud-session.v1');nativeRequest.mockClear();const reopened=new CloudSync();await reopened.initialize();
    expect(reopened.getSnapshot().session).toBeNull();expect(nativeRequest).not.toHaveBeenCalled();
  });
  it('does not let a late login replace the account chosen after logout',async()=>{
    const cloud=new CloudSync(),response=deferred<Response>();await cloud.initialize();
    fetcher.mockImplementationOnce(()=>response.promise);const oldLogin=cloud.login('a','password',false,true).catch(error=>error);
    await vi.waitFor(()=>expect(fetcher.mock.calls.some(([url])=>String(url).endsWith('/auth/login'))).toBe(true));
    await cloud.logout();await cloud.login('b','password',false,false);response.resolve(json(session('a')));await oldLogin;
    expect(cloud.getSnapshot().session?.user.id).toBe('b');expect(context.library).toBe(context.profiles.get('https://reader.test/api|b'));
    expect(JSON.parse(sessionStorage.getItem('qingread.cloud-session.v1')!).session.user.id).toBe('b');expect(localStorage.getItem('qingread.cloud-session.v1')).toBeNull();
  });
  it('never sends an old account outbox using a newly logged-in account token',async()=>{
    const cloud=new CloudSync();await cloud.login('a','password',false,false);
    const a=context.profiles.get('https://reader.test/api|a')!,gate=deferred<{cursor:number;mutations:unknown[]}>();
    a.syncRequest.mockReturnValueOnce(gate.promise);const oldSync=cloud.sync();
    await vi.waitFor(()=>expect(a.syncRequest).toHaveBeenCalledTimes(2));
    const newLogin=cloud.login('b','password',false,false);await vi.waitFor(()=>expect(cloud.getSnapshot().session?.user.id).toBe('b'));
    gate.resolve({cursor:0,mutations:[{id:'private-account-a',bookID:'a-private-book'}]});await Promise.all([oldSync,newLogin]);
    const syncRequests=fetcher.mock.calls.filter(([url])=>String(url).endsWith('/sync'));
    expect(syncRequests.some(([,init])=>String(init?.body).includes('a-private-book')&&(init?.headers as Record<string,string>).Authorization==='Bearer '+session('b').token)).toBe(false);
    expect(context.profiles.get('https://reader.test/api|b')!.syncRequest).toHaveBeenCalled();
  });
  it('does not restore a recovered session after the user has logged out',async()=>{
    const cloud=new CloudSync();await cloud.login('a','password',false,false);
    const response=deferred<Response>();fetcher.mockImplementationOnce(()=>response.promise);
    const recovery=cloud.recover('b','recovery-code','new-password',true).catch(error=>error);
    await vi.waitFor(()=>expect(fetcher.mock.calls.some(([url])=>String(url).endsWith('/auth/recover'))).toBe(true));
    await cloud.logout();response.resolve(json(session('b')));await recovery;
    expect(cloud.getSnapshot().session).toBeNull();expect(context.library).toBe(context.guest);
    expect(sessionStorage.getItem('qingread.cloud-session.v1')).toBeNull();expect(localStorage.getItem('qingread.cloud-session.v1')).toBeNull();
  });
  it('does not restore a rotated password session after logout while the response was pending',async()=>{
    const cloud=new CloudSync();await cloud.login('a','password',false,false);
    const response=deferred<Response>();fetcher.mockImplementationOnce(()=>response.promise);
    const rotation=cloud.changePassword('old-password','new-password').catch(error=>error);
    await vi.waitFor(()=>expect(fetcher.mock.calls.some(([url])=>String(url).endsWith('/auth/password'))).toBe(true));
    await cloud.logout();response.resolve(json({...session('a'),token:'c'.repeat(43)}));await rotation;
    expect(cloud.getSnapshot().session).toBeNull();expect(sessionStorage.getItem('qingread.cloud-session.v1')).toBeNull();expect(context.library).toBe(context.guest);
  });
  it('serializes native credential persistence so a pending save cannot outlive logout clearing it',async()=>{
    context.android=true;let secureValue:string|null=null;
    context.native.clear.mockImplementation(async()=>{secureValue=null;});
    const cloud=new CloudSync();await cloud.login('a','password',false,false);const gate=deferred<void>();
    context.native.save.mockImplementation(async({value}:{value:string})=>{await gate.promise;secureValue=value;});
    const login=cloud.login('b','password',false,true).catch(error=>error);await vi.waitFor(()=>expect(context.native.save).toHaveBeenCalled());
    const logout=cloud.logout();await vi.waitFor(()=>expect(fetcher.mock.calls.some(([url])=>String(url).endsWith('/auth/logout'))).toBe(true));
    gate.resolve();await Promise.all([login,logout]);
    expect(secureValue).toBeNull();expect(cloud.getSnapshot().session).toBeNull();expect(context.library).toBe(context.guest);expect(sessionStorage.getItem('qingread.cloud-session.v1')).toBeNull();
  });
  it('ignores native login restoration that finishes after logout',async()=>{
    context.android=true;const response=deferred<{value:string|null}>();context.native.load.mockReturnValue(response.promise);
    const cloud=new CloudSync(),restore=cloud.initialize();await vi.waitFor(()=>expect(context.native.load).toHaveBeenCalled());
    await cloud.logout();response.resolve({value:JSON.stringify({address:'https://reader.test/api',session:session('a')})});await restore;
    expect(cloud.getSnapshot().session).toBeNull();expect(context.library).toBe(context.guest);expect(context.profiles.get('https://reader.test/api|a')!.configureServerDownloads).not.toHaveBeenCalled();
  });
  it('rejects concurrent account replacements while allowing logout to cancel the pending operation',async()=>{
    const cloud=new CloudSync();await cloud.initialize();const response=deferred<Response>();fetcher.mockImplementationOnce(()=>response.promise);
    const recovery=cloud.recover('a','recovery-code','new-password',false).catch(error=>error);
    await vi.waitFor(()=>expect(fetcher.mock.calls.some(([url])=>String(url).endsWith('/auth/recover'))).toBe(true));
    await expect(cloud.login('b','password',false,false)).rejects.toThrow('账号操作进行中');
    await cloud.logout();response.resolve(json(session('a')));await recovery;expect(cloud.getSnapshot().session).toBeNull();
  });
});
