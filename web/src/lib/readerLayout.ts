/** Positions are UTF-16 offsets in paragraphs.join('\n'), matching native QingRead. */
export interface TextPage { start: number; end: number }

export function graphemeBoundaries(text: string): number[] {
  const result = [0];
  if (typeof Intl.Segmenter !== 'undefined') {
    for (const part of new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(text)) {
      result.push(part.index + part.segment.length);
    }
  } else {
    let offset = 0;
    for (const point of text) { offset += point.length; result.push(offset); }
  }
  return result;
}

/** Actual browser measurements supply fits; binary search never splits a grapheme. */
export function paginateText(text: string, fits: (start: number, end: number) => boolean): TextPage[] {
  if (!text.length) return [{ start: 0, end: 0 }];
  const boundaries = graphemeBoundaries(text);
  const pages: TextPage[] = [];
  let begin = 0;
  while (begin < boundaries.length - 1) {
    let low = begin + 1;
    let high = boundaries.length - 1;
    let best = low;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (fits(boundaries[begin], boundaries[mid])) { best = mid; low = mid + 1; }
      else high = mid - 1;
    }
    pages.push({ start: boundaries[begin], end: boundaries[best] });
    begin = best;
  }
  return pages;
}

export function pageForOffset(pages: TextPage[], offset: number): number {
  if (!pages.length) return 0;
  let lo = 0; let hi = pages.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (pages[mid].start <= offset) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export function safeOffset(text: string, offset: number): number {
  const value = Math.max(0, Math.min(text.length, Math.floor(offset)));
  const boundaries = graphemeBoundaries(text);
  let lo = 0; let hi = boundaries.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (boundaries[mid] <= value) lo = mid; else hi = mid - 1;
  }
  return boundaries[lo];
}

export interface ParagraphSlice { text: string; start: number; continuation: boolean }
export function paragraphSlices(text: string, start: number, end: number): ParagraphSlice[] {
  const parts = text.slice(start, end).split('\n');
  let offset = start;
  return parts.map((part, index) => {
    const item = { text: part, start: offset, continuation: index === 0 && start > 0 && text[start - 1] !== '\n' };
    offset += part.length + 1;
    return item;
  });
}
