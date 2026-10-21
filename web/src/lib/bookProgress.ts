export function estimateBookPages(chapterCount:number,lengths:Record<number,number>,measured:Record<number,number>,unitsPerPage:number):number[]{
  const capacity=Number.isFinite(unitsPerPage)?Math.max(1,unitsPerPage):350;
  const samples=Object.values(lengths).filter(n=>Number.isFinite(n)&&n>0).sort((a,b)=>a-b);
  const typical=samples.length?samples[Math.floor(samples.length/2)]:capacity;
  const known=Array.from({length:chapterCount},(_,i)=>measured[i]??(lengths[i]!==undefined?Math.max(1,Math.ceil(lengths[i]/capacity)):undefined));
  const pageSamples=known.filter((n):n is number=>n!==undefined).sort((a,b)=>a-b);
  const typicalPages=pageSamples.length?pageSamples[Math.floor(pageSamples.length/2)]:Math.max(1,Math.ceil(typical/capacity));
  return known.map(count=>Math.max(1,count??typicalPages));
}
export function bookPageNumber(chapterIndex:number,pageIndex:number,counts:number[]):number{
  if(!counts.length)return 1;
  const index=Math.max(0,Math.min(counts.length-1,chapterIndex));
  return counts.slice(0,index).reduce((a,b)=>a+b,0)+Math.max(0,Math.min(counts[index]-1,pageIndex))+1;
}
const bounded=(n:number)=>Number.isFinite(n)?Math.max(0,Math.min(1,n)):0;
export const pageFraction=(page:number,total:number)=>total>1?bounded((page-1)/(total-1)):0;
export const pageAtFraction=(fraction:number,total:number)=>Math.round(bounded(fraction)*Math.max(0,total-1))+1;
export function pageLocation(fraction:number,counts:number[]):{index:number;pageIndex:number;fraction:number}{
  let page=pageAtFraction(fraction,counts.reduce((a,b)=>a+b,0))-1;
  for(let i=0;i<counts.length;i++){
    if(page<counts[i])return{index:i,pageIndex:page,fraction:page/counts[i]};
    page-=counts[i];
  }
  return{index:0,pageIndex:0,fraction:0};
}
/** Identical acceptance for an ordinary page and its chapter boundary. */
export function swipeTurn(dx:number,dy:number,elapsed:number,width:number):number{
  if(Math.abs(dx)<=Math.abs(dy)*1.5)return 0;
  const distance=Math.abs(dx),speed=distance/Math.max(1,elapsed)*1000;
  return distance>=Math.min(48,Math.max(24,width*.14))||(distance>=12&&speed>=450)?dx<0?1:-1:0;
}
