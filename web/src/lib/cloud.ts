import { useSyncExternalStore } from 'react';
import { registerPlugin } from '@capacitor/core';
import { apiBase } from './api';
import { isAndroidApp } from './android';
import { guestLibrary, library, switchLibraryProfile } from './store';
import { anchorFormat, type CloudSession, type CloudSnapshot } from '../shared/sync';

const storageKey='qingread.cloud-session.v1';
const secureSession=registerPlugin<{load():Promise<{value:string|null}>;save(options:{value:string}):Promise<void>;clear():Promise<void>}>('QingReadSession');
interface SavedSession { address:string; session:CloudSession }
interface CloudState { initialized:boolean; session:CloudSession|null; busy:boolean; error:string; lastSync:string; expired:boolean }

export class CloudSync {
  private state:CloudState={initialized:false,session:null,busy:false,error:'',lastSync:'',expired:false};
  private listeners=new Set<()=>void>();
  private generation=0;
  private address='';
  private starting?:Promise<void>;
  private syncing?:Promise<void>;
  private detach?:()=>void;
  private debounce?:ReturnType<typeof setTimeout>;
  subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
  getSnapshot=()=>this.state;
  private update(patch:Partial<CloudState>){this.state={...this.state,...patch};this.listeners.forEach(fn=>fn());}
  initialize(){
    return this.starting??=this.restore();
  }
  private async restore(){
    try{
      this.address=apiBase();
      const native=isAndroidApp()?(await secureSession.load()).value:null;
      const raw=sessionStorage.getItem(storageKey)||native||localStorage.getItem(storageKey);
      const saved:SavedSession|null=raw?JSON.parse(raw):null;
      if(saved?.address===this.address&&saved.session?.user?.id&&/^[\w-]{43}$/.test(saved.session.token)){
        this.update({session:saved.session});await this.activate(saved.session);
      }
    }catch{this.update({error:'同步登录未能恢复，可在设置中重新登录。'});}
    finally{this.update({initialized:true});}
    if(this.state.session)void this.sync();
  }
  private async request<T>(path:string,body?:unknown,authenticated=true):Promise<T>{
    const address=apiBase();
    if(address!==this.address)throw new Error('服务器地址已更改，请重新登录。');
    const requestToken=this.state.session?.token;
    const response=await fetch(address+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(authenticated&&this.state.session?{Authorization:'Bearer '+this.state.session.token}:{})},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(20_000)});
    const value=await response.json().catch(()=>({}));
    if(!response.ok){if(response.status===401&&authenticated&&this.state.session?.token===requestToken)this.update({expired:true});throw new Error(value.message||'同步服务暂时不可用');}
    return value;
  }
  private async activate(session:CloudSession){
    this.generation++;this.detach?.();
    const sources=library.getSnapshot().sources;
    await switchLibraryProfile(this.address+'|'+session.user.id);
    if(sources.length&&!library.getSnapshot().sources.length)await library.initializeSources(sources);
    const store=library;
    this.detach=store.subscribe(()=>{
      if(!store.hasPendingSync())return;
      clearTimeout(this.debounce);this.debounce=setTimeout(()=>void this.sync(),2500);
    });
  }
  async login(username:string,password:string,register:boolean,remember:boolean){
    await this.initialize();this.address=apiBase();this.update({busy:true,error:'',expired:false});
    try{
      const session=await this.request<CloudSession>(register?'/auth/register':'/auth/login',{username,password},false);
      const saved=JSON.stringify({address:this.address,session});
      sessionStorage.setItem(storageKey,saved);localStorage.removeItem(storageKey);
      if(isAndroidApp()){if(remember)await secureSession.save({value:saved});else await secureSession.clear();}
      else if(remember)localStorage.setItem(storageKey,saved);
      await this.activate(session);this.update({session,lastSync:'',error:'',expired:false});
    }catch(error){this.update({error:error instanceof Error?error.message:'登录失败'});throw error;}
    finally{this.update({busy:false});}
    await this.sync();
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
          const snapshot=await this.request<CloudSnapshot>('/sync',{anchorFormat,...pending});
          if(generation!==this.generation)return;
          await store.acceptSync(snapshot);
          this.update({lastSync:new Date().toISOString()});
          if(!snapshot.hasMore&&!store.hasPendingSync())break;
        }
      }catch(error){if(generation===this.generation)this.update({error:error instanceof Error?error.message:'同步未完成，本地进度已保留'});}
      finally{if(generation===this.generation)this.update({busy:false});}
    };
    const promise=run();this.syncing=promise;
    try{await promise;}finally{if(this.syncing===promise)this.syncing=undefined;}
  }
  async mergeGuest(){if(!this.state.session)throw new Error('请先登录');await library.mergeFrom(guestLibrary);await this.sync();}
  async logout(){
    this.generation++;this.detach?.();clearTimeout(this.debounce);
    // Revocation is best effort offline; local credentials are always removed.
    try{await this.request('/auth/logout',{});}catch{ /* session will expire server-side */ }
    sessionStorage.removeItem(storageKey);localStorage.removeItem(storageKey);
    if(isAndroidApp())await secureSession.clear();
    await switchLibraryProfile(null);this.update({session:null,busy:false,error:'',lastSync:'',expired:false});
  }
}
export const cloudSync=new CloudSync();
export const useCloudSync=()=>useSyncExternalStore(cloudSync.subscribe,cloudSync.getSnapshot,cloudSync.getSnapshot);
