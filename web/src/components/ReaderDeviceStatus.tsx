import { useEffect, useState } from 'react';
import { Battery } from 'lucide-react';
import { Capacitor, registerPlugin } from '@capacitor/core';

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
      if(Capacitor.isNativePlatform())void nativeDevice.getBattery().then(value=>{if(active&&value.level>=0)setBattery(value.level);}).catch(()=>{});
    };
    if(!Capacitor.isNativePlatform()){
      const navigatorWithBattery=navigator as Navigator&{getBattery?:()=>Promise<BatterySource>};
      void navigatorWithBattery.getBattery?.().then(value=>{if(!active)return;source=value;update();source.addEventListener('levelchange',update);}).catch(()=>{});
    }
    refresh();const timer=setInterval(refresh,30_000);document.addEventListener('visibilitychange',refresh);
    return()=>{active=false;clearInterval(timer);source?.removeEventListener('levelchange',update);document.removeEventListener('visibilitychange',refresh);};
  },[]);
  return <span className="reader-device-status"><time>{now.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hourCycle:'h23'})}</time>{battery!==undefined&&<span aria-label={`电量 ${battery}%`}><Battery size={16} aria-hidden="true"/>{battery}%</span>}</span>;
}
