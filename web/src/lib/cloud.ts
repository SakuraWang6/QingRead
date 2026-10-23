import { useSyncExternalStore } from 'react';
import { registerPlugin } from '@capacitor/core';
import { apiBase } from './api';
import { isAndroidApp } from './android';
import { isHarmonyApp } from './harmony';
import { canRememberCredentials } from './nativePlatform';
import { clearHarmonyCredential, hasHarmonyCapability, loadHarmonyCredential, saveHarmonyCredential } from './harmonyNative';
import { disablePush, cancelPendingPushChanges } from './pushNotifications';
import { guestLibrary, library, switchLibraryProfile } from './store';
import type { Book } from '../shared/types';
import { anchorFormat, type CloudSession, type CloudSnapshot, type CloudFileSnapshot, type CloudFile } from '../shared/sync';

const storageKey='qingread.cloud-session.v1';
const harmonyRestoreBlockedKey='qingread.harmony-session-restore-disabled';
const secureSession=registerPlugin<{load():Promise<{value:string|null}>;save(options:{value:string}):Promise<void>;clear():Promise<void>}>('QingReadSession');
interface SavedSession { address:string; session:CloudSession }
interface CloudState { initialized:boolean; credentialNotice:string; session:CloudSession|null; busy:boolean; error:string; lastSync:string; expired:boolean;files:CloudFile[];fileBusy:boolean;fileMessage:string;usedBytes:number;limitBytes:number }

export class CloudSync {
  private state:CloudState={initialized:false,credentialNotice:'',session:null,busy:false,error:'',lastSync:'',expired:false,files:[],fileBusy:false,fileMessage:'',usedBytes:0,limitBytes:0};
  private listeners=new Set<()=>void>();
  private generation=0;
  private accountRevision=0;
  private accountBusy?:number;
  private sessionWriting=Promise.resolve();
  private requests=new Set<AbortController>();
  private remembered=false;
  private address='';
  private starting?:Promise<void>;
  private syncing?:Promise<void>;
  private fileSyncing?:Promise<void>;
  private transfers=new Set<AbortController>();
  private downloads=new Map<string,Promise<Book>>();
  private detach?:()=>void;
  private debounce?:ReturnType<typeof setTimeout>;
  subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
  getSnapshot=()=>this.state;
  private update(patch:Partial<CloudState>){this.state={...this.state,...patch};this.listeners.forEach(fn=>fn());}
  private beginAccountChange(){if(this.accountBusy!==undefined)throw new Error('账号操作进行中，请稍后重试');const revision=++this.accountRevision;this.accountBusy=revision;return revision;}
  private requireAccount(revision:number){if(revision!==this.accountRevision)throw new Error('账号已切换，请重试');}
  private sessionTransition(work:()=>Promise<void>){const pending=this.sessionWriting.catch(()=>{}).then(work);this.sessionWriting=pending.catch(()=>{});return pending;}
  private invalidate(){
    this.generation++;this.requests.forEach(c=>c.abort());this.transfers.forEach(c=>c.abort());this.downloads.clear();
    this.syncing=undefined;this.fileSyncing=undefined;this.detach?.();this.detach=undefined;clearTimeout(this.debounce);
  }
  initialize(){
    return this.starting??=this.restore();
  }
  private async restore(){
    const revision=this.accountRevision;
    try{
      this.address=apiBase();
      let native:string|null=null;
      if(isAndroidApp())native=(await secureSession.load()).value;
      else if(hasHarmonyCapability('secureStorage')&&localStorage.getItem(harmonyRestoreBlockedKey)!=='true'){
        try{native=await loadHarmonyCredential('cloud');}catch{this.update({credentialNotice:'无法读取已保存的登录信息，可重新登录。'});}
      }
      this.requireAccount(revision);
      if(isHarmonyApp())localStorage.removeItem(storageKey);
      const raw=sessionStorage.getItem(storageKey)||native||localStorage.getItem(storageKey);
      this.remembered=Boolean(native||localStorage.getItem(storageKey));
      const saved:SavedSession|null=raw?JSON.parse(raw):null;
      if(saved?.address===this.address&&saved.session?.user?.id&&/^[\w-]{43}$/.test(saved.session.token)){
        await this.sessionTransition(async()=>{this.requireAccount(revision);await this.activate(saved.session);this.requireAccount(revision);this.update({session:saved.session});});
      }
    }catch{if(revision===this.accountRevision)this.update({error:'同步登录未能恢复，可在设置中重新登录。'});}
    finally{this.update({initialized:true});}
    if(revision===this.accountRevision&&this.state.session)void this.sync();
  }
  private async request<T>(path:string,body?:unknown,authenticated=true,generation=this.generation):Promise<T>{
    if(generation!==this.generation)throw new Error('账号已切换，请重试');
    const address=apiBase();
    if(address!==this.address)throw new Error('服务器地址已更改，请重新登录。');
    const requestToken=this.state.session?.token;
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20_000);this.requests.add(controller);
    try{
      const response=await fetch(address+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(authenticated&&requestToken?{Authorization:'Bearer '+requestToken}:{})},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:controller.signal});
      const value=await response.json().catch(()=>({}));
      if(generation!==this.generation)throw new Error('账号已切换，请重试');
      if(!response.ok){if(response.status===401&&authenticated&&this.state.session?.token===requestToken)this.update({expired:true});throw new Error(value.message||'同步服务暂时不可用');}
      return value;
    }finally{clearTimeout(timeout);this.requests.delete(controller);}
  }
  private async activate(session:CloudSession){
    this.invalidate();
    this.update({files:[],fileBusy:false,fileMessage:'',usedBytes:0,limitBytes:0});
    const sources=library.getSnapshot().sources;
    await switchLibraryProfile(this.address+'|'+session.user.id);
    if(sources.length&&!library.getSnapshot().sources.length)await library.initializeSources(sources);
    const store=library;store.configureServerDownloads({address:this.address,token:session.token});
    this.detach=store.subscribe(()=>{
      if(!store.hasPendingSync())return;
      clearTimeout(this.debounce);this.debounce=setTimeout(()=>void this.sync(),2500);
    });
  }
  async login(username:string,password:string,register:boolean,remember:boolean){
    const revision=this.beginAccountChange();
    try{
      await this.initialize();this.requireAccount(revision);this.address=apiBase();this.update({busy:true,error:'',expired:false});
      const generation=this.generation;
      const previous=this.state.session;if(previous)await disablePush({apiAddress:this.address,session:previous}).catch(()=>{});cancelPendingPushChanges();
      this.requireAccount(revision);const session=await this.request<CloudSession>(register?'/auth/register':'/auth/login',{username,password},false,generation);
      this.requireAccount(revision);await this.renewedSession(session,remember,revision);this.requireAccount(revision);await this.sync();
    }catch(error){if(revision===this.accountRevision)this.update({error:error instanceof Error?error.message:'登录失败'});throw error;}
    finally{if(this.accountBusy===revision)this.accountBusy=undefined;if(revision===this.accountRevision)this.update({busy:false});}
  }
  async sync(){
    if(this.syncing)return this.syncing;
    if(!this.state.session||this.state.expired||typeof navigator!=='undefined'&&!navigator.onLine)return;
    const generation=this.generation,store=library;
    const run=async()=>{
      this.update({busy:true,error:''});
      try{
        for(let round=0;round<40;round++){
          const pending=await store.syncRequest();
          const snapshot=await this.request<CloudSnapshot>('/sync',{anchorFormat,...pending},true,generation);
          if(generation!==this.generation)return;
          await store.acceptSync(snapshot);
          if(generation!==this.generation)return;
          this.update({lastSync:new Date().toISOString()});
          if(!snapshot.hasMore&&!store.hasPendingSync())break;
        }
        if(generation===this.generation)void this.syncFiles();
      }catch(error){if(generation===this.generation)this.update({error:error instanceof Error?error.message:'同步未完成，本地进度已保留'});}
      finally{if(generation===this.generation)this.update({busy:false});}
    };
    const promise=run();this.syncing=promise;
    try{await promise;}finally{if(this.syncing===promise)this.syncing=undefined;}
  }
  private async transfer(path:string,body?:Blob,generation=this.generation):Promise<Response>{
    if(generation!==this.generation)throw new Error('账号已切换');
    const token=this.state.session?.token,address=this.address;
    if(!token||apiBase()!==address)throw new Error('请先登录');
    const controller=new AbortController();this.transfers.add(controller);
    const timeout=setTimeout(()=>controller.abort(),600_000);
    try{
      const response=await fetch(address+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/octet-stream'}:{})},body,redirect:'error',signal:controller.signal});
      if(!response.ok){const value=await response.json().catch(()=>({}));throw new Error(value.message||'文件同步失败');}
      // Read while the timeout and account-switch cancellation remain active.
      const blob=await response.blob();return new Response(blob,{status:200,headers:response.headers});
    }finally{clearTimeout(timeout);this.transfers.delete(controller);}
  }
  private async fileList(generation:number){
    const snapshot=await this.request<CloudFileSnapshot>('/files',undefined,true,generation);
    if(generation===this.generation)this.update({files:snapshot.files,usedBytes:snapshot.usedBytes,limitBytes:snapshot.limitBytes});
    return snapshot;
  }
  async syncFiles(){
    if(this.fileSyncing||!this.state.session||this.state.expired)return this.fileSyncing;
    const generation=this.generation,store=library;
    const run=async()=>{
      this.update({fileBusy:true,fileMessage:''});
      try{
        let snapshot=await this.fileList(generation);
        for(const {book} of store.getSnapshot().shelf){
          if(generation!==this.generation)return;
          if(!book.publicationFormat||!book.fileHash||snapshot.files.some(f=>f.hash===book.fileHash))continue;
          const file=await store.getPublication(book);if(generation!==this.generation)return;if(!file)continue;
          if(file.size>snapshot.maxFileBytes)throw new Error('文件超过云端单本上限');
          this.update({fileMessage:'正在上传 '+book.title});
          await this.transfer('/files/'+book.fileHash+'?'+new URLSearchParams({bookID:book.id,bytes:String(file.size)}),file,generation);
          if(generation!==this.generation)return;
          snapshot=await this.fileList(generation);
        }
        if(generation===this.generation)this.update({fileMessage:''});
      }catch(error){if(generation===this.generation)this.update({fileMessage:error instanceof Error?error.message:'文件同步失败'});}
      finally{if(generation===this.generation)this.update({fileBusy:false});}
    };
    const promise=run();this.fileSyncing=promise;
    try{await promise;}finally{if(this.fileSyncing===promise)this.fileSyncing=undefined;}
  }
  downloadPublication(book:Book):Promise<Book>{
    const existing=this.downloads.get(book.id);if(existing)return existing;
    const generation=this.generation,store=library;
    const run=async()=>{
      if(!book.fileHash||!book.publicationFormat)throw new Error('云端文件尚未同步');
      const file=await(await this.transfer('/files/'+book.fileHash,undefined,generation)).blob();
      if(generation!==this.generation||library!==store)throw new Error('账号已切换');
      return store.importFile(new File([file],book.title+'.'+book.publicationFormat),book);
    };
    const work=run();this.downloads.set(book.id,work);
    void work.finally(()=>{if(this.downloads.get(book.id)===work)this.downloads.delete(book.id);}).catch(()=>{});
    return work;
  }
  async mergeGuest(){if(!this.state.session)throw new Error('请先登录');await library.mergeFrom(guestLibrary);await this.sync();}
  private async renewedSession(session:CloudSession,remember:boolean,revision:number){
    remember=remember&&canRememberCredentials();
    await this.sessionTransition(async()=>{
      this.requireAccount(revision);
      const saved=JSON.stringify({address:this.address,session});sessionStorage.setItem(storageKey,saved);localStorage.removeItem(storageKey);
      if(isAndroidApp()){if(remember)await secureSession.save({value:saved});else await secureSession.clear();}
      else if(isHarmonyApp()){
        // This non-secret marker prevents an old account being restored if the
        // system credential service fails during replacement or logout.
        localStorage.setItem(harmonyRestoreBlockedKey,'true');
        if(hasHarmonyCapability('secureStorage')){
          try{if(remember){await saveHarmonyCredential('cloud',saved);if(revision===this.accountRevision)localStorage.removeItem(harmonyRestoreBlockedKey);}else await clearHarmonyCredential('cloud');this.update({credentialNotice:''});}
          catch{remember=false;await clearHarmonyCredential('cloud').catch(()=>{});this.update({credentialNotice:'本次已登录，未能安全保存登录信息，重新打开后请登录。'});}
        }
      }
      else if(remember)localStorage.setItem(storageKey,saved);
      this.requireAccount(revision);this.remembered=remember;await this.activate(session);this.requireAccount(revision);this.update({session,lastSync:'',expired:false,error:''});
    });
  }
  async changePassword(currentPassword:string,newPassword:string){
    const revision=this.beginAccountChange();
    try{const session=await this.request<CloudSession>('/auth/password',{currentPassword,newPassword});this.requireAccount(revision);await this.renewedSession(session,this.remembered,revision);this.requireAccount(revision);await this.sync();}
    finally{if(this.accountBusy===revision)this.accountBusy=undefined;}
  }
  async createRecoveryCode(password:string){return(await this.request<{recoveryCode:string}>('/auth/recovery-code',{password})).recoveryCode;}
  async recover(username:string,recoveryCode:string,newPassword:string,remember:boolean){
    const revision=this.beginAccountChange();
    try{await this.initialize();this.requireAccount(revision);this.address=apiBase();const session=await this.request<CloudSession>('/auth/recover',{username,recoveryCode,newPassword},false);this.requireAccount(revision);cancelPendingPushChanges();await this.renewedSession(session,remember,revision);this.requireAccount(revision);await this.sync();}
    finally{if(this.accountBusy===revision)this.accountBusy=undefined;}
  }
  async logout(){
    const revision=++this.accountRevision;this.accountBusy=revision;this.invalidate();
    if(isHarmonyApp())localStorage.setItem(harmonyRestoreBlockedKey,'true');
    try{
      cancelPendingPushChanges();if(this.state.session)await disablePush({apiAddress:this.address,session:this.state.session}).catch(()=>{});
      // Revocation is best effort offline; local credentials are always removed.
      try{this.requireAccount(revision);await this.request('/auth/logout',{});}catch{ /* session will expire server-side */ }
      await this.sessionTransition(async()=>{
        this.requireAccount(revision);sessionStorage.removeItem(storageKey);localStorage.removeItem(storageKey);
        if(isAndroidApp())await secureSession.clear();else if(isHarmonyApp()){localStorage.setItem(harmonyRestoreBlockedKey,'true');if(hasHarmonyCapability('secureStorage'))await clearHarmonyCredential('cloud').catch(()=>{});}this.requireAccount(revision);
        await switchLibraryProfile(null);this.requireAccount(revision);this.remembered=false;
        this.update({session:null,credentialNotice:'',busy:false,error:'',lastSync:'',expired:false,files:[],fileBusy:false,fileMessage:'',usedBytes:0,limitBytes:0});
      });
    }finally{if(this.accountBusy===revision)this.accountBusy=undefined;}
  }
}
export const cloudSync=new CloudSync();
export const useCloudSync=()=>useSyncExternalStore(cloudSync.subscribe,cloudSync.getSnapshot,cloudSync.getSnapshot);
