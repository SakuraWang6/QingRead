import {describe,it,expect} from 'vitest';
import {completedRows,sourceFor} from '../server/reading';
describe('completed catalog',()=>{
 it('requires explicit final-chapter labels and keeps source URL validation',()=>{
  const html=`<ul class="txt-list">
   <li><span class="s2"><a href="/novel/1.html">已完结</a></span><span class="s3">完结感言</span><span class="s4">甲</span></li>
   <li><span class="s2"><a href="/novel/2.html">完结之旅</a></span><span class="s3">第十章 继续</span></li>
   <li><span class="s2"><a href="https://evil.invalid/novel">外站</a></span><span class="s3">全书完</span></li>
   <li><span class="s2"><a href="/novel/3.html">归途</a></span><span class="s3">终点（完结）</span></li></ul>`;
  const result=completedRows(html,sourceFor('biequgei'));
  expect(result.map(book=>book.title)).toEqual(['已完结','归途']);
  expect(result[0].author).toBe('甲');
 });
});
