import { describe, expect, it } from 'vitest';
import { graphemeBoundaries, pageForOffset, paginateText, paragraphAtOffset, paragraphSlices, safeOffset } from '../src/lib/readerLayout';

describe('reader measured pagination and native position compatibility', () => {
  it('partitions every UTF-16 unit exactly once, using the provided measured fit', () => {
    const text = '第一段。\n第二段含有👩🏽‍💻和组合音节é。\n终章。';
    const boundaries = new Set(graphemeBoundaries(text));
    const pages = paginateText(text, (start, end) => end - start <= 12);
    expect(pages.map(page => text.slice(page.start, page.end)).join('')).toBe(text);
    for (const page of pages) { expect(boundaries.has(page.start)).toBe(true); expect(boundaries.has(page.end)).toBe(true); }
    expect(pages[0].start).toBe(0); expect(pages.at(-1)!.end).toBe(text.length);
  });
  it('makes progress if a single grapheme is taller than the available page', () => {
    const pages = paginateText('👨‍👩‍👧‍👦甲', () => false);
    expect(pages).toEqual([{ start: 0, end: 11 }, { start: 11, end: 12 }]);
  });
  it('restores the same anchor after viewport/font changes', () => {
    const text = '春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少。';
    const original = paginateText(text, (a, b) => b - a <= 8);
    const saved = original[2].start;
    const reflow = paginateText(text, (a, b) => b - a <= 5);
    const selected = reflow[pageForOffset(reflow, saved)];
    expect(selected.start).toBeLessThanOrEqual(saved); expect(selected.end).toBeGreaterThan(saved);
    expect(pageForOffset(reflow, text.length)).toBe(reflow.length - 1);
  });
  it('uses body-only UTF-16 offsets and marks a paragraph continued across pages', () => {
    const text = ['第一段👋', '第二段'].join('\n');
    expect(paragraphSlices(text, 3, text.length)).toEqual([
      { text: '👋', start: 3, continuation: true }, { text: '第二段', start: 6, continuation: false },
    ]);
    expect(safeOffset(text, 4)).toBe(3);
    expect(safeOffset('é中', 1)).toBe(0);
  });
  it('does not turn a separator at either page edge into a blank line', () => {
    const text = '第一段\n第二段';
    expect(paragraphSlices(text, 0, 4)).toEqual([{ text: '第一段', start: 0, continuation: false }]);
    expect(paragraphSlices(text, 3, text.length)).toEqual([{ text: '第二段', start: 4, continuation: false }]);
    expect(paragraphSlices('甲\n\n乙', 0, 4)).toEqual([
      { text: '甲', start: 0, continuation: false }, { text: '', start: 2, continuation: false }, { text: '乙', start: 3, continuation: false },
    ]);
  });
  it('selects the complete source paragraph when long pressing a continued page fragment', () => {
    const text = '开头。\n跨页的👩🏽‍💻段落，仍应引用整段。\n尾声。';
    const offset = text.indexOf('仍');
    expect(paragraphAtOffset(text, offset)).toEqual({ offset: 4, length: text.indexOf('\n', 4) - 4, quote: '跨页的👩🏽‍💻段落，仍应引用整段。' });
    expect(paragraphAtOffset(text, 0)).toEqual({ offset: 0, length: 3, quote: '开头。' });
    expect(paragraphAtOffset('\n\n', 0)).toBeUndefined();
    expect(paragraphAtOffset('', 0)).toBeUndefined();
  });
});
