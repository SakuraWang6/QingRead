import type { ReadingAnnotation, ShelfEntry, ShelfOrganization } from './types';
type LibraryData = Pick<ShelfEntry, 'organization'|'annotations'>;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown,max:number,empty=true):v is string=>typeof v==='string'&&v.length<=max&&(empty||v.length>0)&&!v.includes('\0');
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const date=(v:unknown):v is string=>text(v,64,false)&&Number.isFinite(Date.parse(v));
export function libraryData(value: unknown, clampDates=false): LibraryData {
  if(!object(value))throw new Error('书架数据格式无效');
  const timestamp=(v:string)=>clampDates?new Date(Math.min(Date.parse(v),Date.now())).toISOString():v;
  let organization:ShelfOrganization|undefined,annotations:ReadingAnnotation[]|undefined;
  if(value.organization!=null){
    const v=value.organization;
    if(!object(v)||typeof v.pinned!=='boolean'||!['reading','later','finished'].includes(String(v.status))||!text(v.group,64)||!date(v.updatedAt))throw new Error('书架分组格式无效');
    organization={pinned:v.pinned,status:v.status as ShelfOrganization['status'],group:v.group.trim(),updatedAt:timestamp(v.updatedAt)};
  }
  if(value.annotations!=null){
    if(!Array.isArray(value.annotations)||value.annotations.length>256)throw new Error('每本书最多保存 256 条书签和笔记记录');
    const ids=new Set<string>();
    annotations=value.annotations.map(v=>{
      if(!object(v)||!text(v.id,128,false)||!(/^[\w-]{8,128}$/.test(v.id))||ids.has(v.id)||!['bookmark','note'].includes(String(v.kind))||!text(v.chapterID,8192,false)||!integer(v.chapterIndex)||!text(v.chapterTitle,500)||!integer(v.characterOffset)||!integer(v.characterLength)||!text(v.quote,500)||!text(v.note,1000)||!text(v.sourceID,100,false)||!text(v.sourceURL,4000,false)||!date(v.updatedAt)||(v.deletedAt!=null&&!date(v.deletedAt)))throw new Error('书签或笔记格式无效');
      ids.add(v.id);return{id:v.id,kind:v.kind as ReadingAnnotation['kind'],chapterID:v.chapterID,chapterIndex:v.chapterIndex,chapterTitle:v.chapterTitle,characterOffset:v.characterOffset,characterLength:v.characterLength,quote:v.quote,note:v.note,sourceID:v.sourceID,sourceURL:v.sourceURL,updatedAt:timestamp(v.updatedAt),...(v.deletedAt?{deletedAt:timestamp(v.deletedAt as string)}:{})};
    });
  }
  return{...(organization?{organization}:{}),...(annotations?{annotations}:{})};
}
export function mergeLibraryData(previous:LibraryData,incoming:LibraryData):LibraryData {
  const a=previous.organization,b=incoming.organization;
  const organization=!a?b:!b?a:Date.parse(b.updatedAt)>=Date.parse(a.updatedAt)?b:a;
  const notes=new Map<string,ReadingAnnotation>();
  for(const note of [...previous.annotations??[],...incoming.annotations??[]]){
    const existing=notes.get(note.id);
    if(!existing||Date.parse(note.updatedAt)>Date.parse(existing.updatedAt)||Date.parse(note.updatedAt)===Date.parse(existing.updatedAt)&&Boolean(note.deletedAt))notes.set(note.id,note);
  }
  if(notes.size>256)throw new Error('每本书最多保存 256 条书签和笔记记录');
  return{...(organization?{organization}:{}),...(notes.size?{annotations:[...notes.values()]}:{})};
}
