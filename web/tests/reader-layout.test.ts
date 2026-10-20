import { describe, expect, it } from 'vitest';
import { graphemeBoundaries, locationForBookFraction, pageForOffset, paginateText, paragraphSlices, safeOffset, wholeBookFraction } from '../src/lib/readerLayout';

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
  it('maps whole-book progress to chapters and treats the endpoint as the end of the final chapter', () => {
    expect(wholeBookFraction(2, .5, 10)).toBe(.25);
    expect(locationForBookFraction(.25, 10)).toEqual({ index: 2, fraction: .5 });
    expect(locationForBookFraction(1, 10)).toEqual({ index: 9, fraction: 1 });
    expect(locationForBookFraction(0, 0)).toEqual({ index: 0, fraction: 0 });
  });
});
