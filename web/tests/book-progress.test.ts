import { describe,it,expect } from 'vitest';
import { estimateBookPages,bookPageNumber,pageFraction,pageAtFraction,pageLocation,swipeTurn } from '../src/lib/bookProgress';

describe('page weighted book progress',()=>{
 it('weights unequal chapters by measured pages and round trips every page',()=>{
  const counts=[2,8,1],total=11;
  for(let chapter=0;chapter<counts.length;chapter++)for(let page=0;page<counts[chapter];page++){
   const number=bookPageNumber(chapter,page,counts),fraction=pageFraction(number,total);
   expect(pageAtFraction(fraction,total)).toBe(number);
   expect(pageLocation(fraction,counts)).toEqual({index:chapter,pageIndex:page,fraction:page/counts[chapter]});
  }
  expect(pageFraction(bookPageNumber(1,0,counts),total)).toBe(.2);
 });
 it('uses cached lengths for unknown layouts and measured counts for visited chapters',()=>{
  expect(estimateBookPages(3,{0:100,1:900},{0:1},300)).toEqual([1,3,3]);
  expect(estimateBookPages(3,{0:100,1:900},{0:1},150)).toEqual([1,6,6]);
  expect(estimateBookPages(0,{}, {},350)).toEqual([]);
  expect(estimateBookPages(2,{}, {},350)).toEqual([1,1]);
 });
 it('weights unloaded chapters by the median known page count',()=>{
  expect(estimateBookPages(3,{}, {0:2,1:10},300)).toEqual([2,10,10]);
 });
 it('clamps endpoints without marking an empty book or one page as completed',()=>{
  expect(pageLocation(1,[2,8])).toEqual({index:1,pageIndex:7,fraction:7/8});
  expect(pageLocation(NaN,[2,8])).toEqual({index:0,pageIndex:0,fraction:0});
  expect(pageFraction(1,1)).toBe(0);
  expect(bookPageNumber(0,0,[])).toBe(1);
 });
});
describe('uniform page and chapter swipe threshold',()=>{
 it('accepts a normal short drag or a quick flick with the same threshold',()=>{
  expect(swipeTurn(-50,2,350,393)).toBe(1);
  expect(swipeTurn(50,2,350,393)).toBe(-1);
  expect(swipeTurn(-15,1,25,393)).toBe(1);
 });
 it('rejects taps, slow small motions and predominantly vertical scrolling',()=>{
  expect(swipeTurn(-8,0,5,393)).toBe(0);
  expect(swipeTurn(-25,2,500,393)).toBe(0);
  expect(swipeTurn(-70,90,100,393)).toBe(0);
 });
});
