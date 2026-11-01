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
  it('displays one two-character indent without deleting source whitespace or moving offsets', () => {
    const text = '  第一段。\n\u3000\u3000第二段👩🏽‍💻。\n\t\t第三段。';
    expect(paragraphSlices(text, 0, text.length)).toEqual([
      { text: '第一段。', start: 2, continuation: false },
      { text: '第二段👩🏽‍💻。', start: text.indexOf('第二'), continuation: false },
      { text: '第三段。', start: text.indexOf('第三'), continuation: false },
    ]);
    for (const part of paragraphSlices(text, 0, text.length)) {
      expect(text.slice(part.start, part.start + part.text.length)).toBe(part.text);
      expect(paragraphAtOffset(text, part.start)?.quote).toBe(text.slice(text.lastIndexOf('\n', part.start - 1) + 1, text.indexOf('\n', part.start) < 0 ? text.length : text.indexOf('\n', part.start)));
    }
    expect(text.startsWith('  ')).toBe(true);
  });
  it('does not re-indent a continuation or display a partial leading-space prefix after a seek', () => {
    const text = '\u3000\u3000首行文字跨页后续读。';
    expect(paragraphSlices(text, 1, text.length)).toEqual([{ text: text.slice(2), start: 2, continuation: false }]);
    expect(paragraphSlices(text, 2, text.length)).toEqual([{ text: text.slice(2), start: 2, continuation: false }]);
    expect(paragraphSlices(text, 5, text.length)).toEqual([{ text: text.slice(5), start: 5, continuation: true }]);
    expect(paragraphSlices(text, 0, 1)).toEqual([]);
  });
  it('collapses interleaved invisible prefixes without losing source indices or interior text', () => {
    const paragraphs = [
      '正文中间\u200b\u3000空白保留。',
      '\u200b\u3000\u3000正文中间\u200b\u3000空白保留。',
      '\u2060 \u200b\u3000正文中间\u200b\u3000空白保留。',
      '\ufeff\t\u200d \u200c正文中间\u200b\u3000空白保留。',
    ];
    const source = paragraphs.join('\n'), slices = paragraphSlices(source, 0, source.length);
    expect(slices.map(part => part.text)).toEqual(Array(4).fill(paragraphs[0]));
    let position = 0;
    for (let index = 0; index < paragraphs.length; index++) {
      const part = slices[index];
      expect(part.start).toBe(position + paragraphs[index].indexOf('正文'));
      expect(source.slice(part.start, part.start + part.text.length)).toBe(part.text);
      expect(paragraphAtOffset(source, part.start)?.quote).toBe(paragraphs[index]);
      position += paragraphs[index].length + 1;
    }
    const start = source.indexOf('正文', paragraphs[0].length + 1);
    expect(paragraphSlices(source, start - 1, start + 2)[0]).toEqual({ text: '正文', start, continuation: false });
    expect(paragraphSlices(source, start + 1, source.indexOf('。', start) + 1)[0].continuation).toBe(true);
  });
  it('retains meaningful joiners, bidi controls and complete emoji sequences', () => {
    const text = '\u200d👩🏽‍💻在阅读。\n\u200cالعربية\n\u200f  اتجاه النص';
    const slices = paragraphSlices(text, 0, text.length);
    expect(slices.map(part => part.text)).toEqual(text.split('\n'));
    expect(paragraphSlices('\u200b👩🏽‍💻甲', 0, 10)[0].text).toBe('👩🏽‍💻甲');
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
