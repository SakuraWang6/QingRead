import { useEffect, useState } from 'react';
import { Battery } from 'lucide-react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { hasHarmonyCapability, harmonyRequest } from '../lib/harmonyNative';
import { harmonyActiveEvent } from '../lib/harmony';

interface BatterySource extends EventTarget { level:number }
const nativeDevice=registerPlugin<{getBattery():Promise<{level:number}>}>('QingReadDevice');
export function ReaderDeviceStatus(){
  const [now,setNow]=useState(()=>new Date());
  const [battery,setBattery]=useState<number>();
  useEffect(()=>{
    let active=true,source:BatterySource|undefined;
    const update=()=>{if(active&&source&&Number.isFinite(source.level))setBattery(Math.round(Math.max(0,Math.min(1,source.level))*100));};
    const refresh=()=>{
      setNow(new Date());
      if(hasHarmonyCapability('battery'))void harmonyRequest<{level:number}>('battery','battery.get').then(value=>{if(active&&Number.isFinite(value?.level)&&value.level>=0&&value.level<=100)setBattery(Math.round(value.level));}).catch(()=>{});
      else if(Capacitor.isNativePlatform())void nativeDevice.getBattery().then(value=>{if(active&&value.level>=0)setBattery(value.level);}).catch(()=>{});
    };
    if(!Capacitor.isNativePlatform()&&!hasHarmonyCapability('battery')){
      const navigatorWithBattery=navigator as Navigator&{getBattery?:()=>Promise<BatterySource>};
      void navigatorWithBattery.getBattery?.().then(value=>{if(!active)return;source=value;update();source.addEventListener('levelchange',update);}).catch(()=>{});
    }
    refresh();const timer=setInterval(refresh,30_000);document.addEventListener('visibilitychange',refresh);window.addEventListener(harmonyActiveEvent,refresh);
    return()=>{active=false;clearInterval(timer);source?.removeEventListener('levelchange',update);document.removeEventListener('visibilitychange',refresh);window.removeEventListener(harmonyActiveEvent,refresh);};
  },[]);
  return <span className="reader-device-status"><time>{now.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hourCycle:'h23'})}</time>{battery!==undefined&&<span aria-label={`电量 ${battery}%`}><Battery size={16} aria-hidden="true"/>{battery}%</span>}</span>;
}
