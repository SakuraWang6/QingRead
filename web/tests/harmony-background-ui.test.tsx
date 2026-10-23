// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost/"}
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadManager } from '../src/components/ReadingWorkflows';
import { NotificationSettings } from '../src/components/NotificationSettings';
import type { ChapterDownloadJob } from '../src/shared/types';
const context=vi.hoisted(()=>({downloads:[] as ChapterDownloadJob[],retry:vi.fn(async()=>{}),pause:vi.fn(async()=>{}),resume:vi.fn(async()=>{}),cancel:vi.fn(async()=>{}),save:vi.fn(async()=>{})}));
vi.mock('../src/lib/store',()=>({useLibrary:()=>({downloads:context.downloads,shelf:[],disabledSourceIDs:[]}),library:{profile:'qingread-web-v1',retryDownload:context.retry,pauseDownload:context.pause,resumeDownload:context.resume,cancelDownload:context.cancel,savePreparedDownload:context.save}}));
vi.mock('../src/lib/cloud',()=>({cloudSync:{},useCloudSync:()=>({session:null})}));
vi.mock('../src/lib/android',()=>({isAndroidApp:()=>false,useAndroidBack:()=>{}}));
vi.mock('../src/components/PushNotificationsPanel',()=>({PushNotificationsPanel:()=>{throw new Error('Web Push must not mount for Harmony');}}));
let root:Root,host:HTMLDivElement,calls:{method:string;params:Record<string,unknown>}[];
function job(id:string,patch:Partial<ChapterDownloadJob>):ChapterDownloadJob{return{id,bookID:id,bookTitle:id,sourceID:'source',sourceURL:'https://source.example/'+id,status:'completed',chapterIDs:[],completedChapterIDs:[],failedChapterIDs:[],total:10,completed:10,createdAt:'2026-10-24T00:00:00Z',updatedAt:'2026-10-24T00:00:00Z',engine:'server',...patch};}
beforeEach(()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);calls=[];localStorage.clear();host=document.createElement('div');document.body.append(host);root=createRoot(host);
  Object.defineProperty(window,'__QINGREAD_HARMONY__',{configurable:true,value:{bridgeVersion:2,version:'1.0.0',build:'1',capabilities:['backgroundDownloads','updateNotifications']}});
  Object.defineProperty(window,'QingReadNative',{configurable:true,value:{request:async(raw:string)=>{
    const value=JSON.parse(raw);calls.push(value);
    const result=value.method==='updates.snapshot'?{enabled:false,notifications:'prompt',updates:{}}:value.method==='updates.requestPermission'?{notifications:'granted'}:{};
    return JSON.stringify({id:value.id,ok:true,result});
  }}});

});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();delete(window as unknown as Record<string,unknown>).__QINGREAD_HARMONY__;delete(window as unknown as Record<string,unknown>).QingReadNative;vi.unstubAllGlobals();vi.clearAllMocks();localStorage.clear();});
describe('Harmony background controls',()=>{
  it('distinguishes preparation, system bytes and locally cached chapters',async()=>{
    context.downloads=[job('云端任务',{status:'running',completed:3}),job('系统任务',{systemTransfer:{status:'running',receivedBytes:524288,totalBytes:1048576}}),job('已保存任务',{storedOnDevice:true}),job('需重试任务',{systemTransfer:{status:'failed',receivedBytes:0,error:'文件校验失败'}})];
    await act(async()=>root.render(<DownloadManager onClose={()=>{}}/>));const dialog=document.querySelector<HTMLElement>('[role=dialog]')!;
    expect(dialog.textContent).toContain('云端准备中');expect(dialog.textContent).toContain('系统传输中');expect(dialog.textContent).toContain('本机已缓存');expect(dialog.textContent).toContain('0.5 / 1.0 MB');
    expect(dialog.querySelector('[aria-label="暂停下载系统任务"]')).not.toBeNull();await act(async()=>dialog.querySelector<HTMLButtonElement>('[aria-label="重试下载需重试任务"]')!.click());expect(context.retry).toHaveBeenCalledWith('需重试任务');
  });
  it('requests local notification consent only after the reader enables the switch',async()=>{
    await act(async()=>root.render(<NotificationSettings/>));expect(calls.some(call=>call.method==='updates.requestPermission')).toBe(false);
    const toggle=host.querySelector<HTMLButtonElement>('[role="switch"]')!;expect(toggle.getAttribute('aria-checked')).toBe('false');await act(async()=>toggle.click());
    expect(calls.some(call=>call.method==='updates.requestPermission')).toBe(true);expect(calls.some(call=>call.method==='updates.watch'&&call.params.enabled===true)).toBe(true);expect(toggle.getAttribute('aria-checked')).toBe('true');
  });
});
