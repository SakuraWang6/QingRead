/** Canonical page text shared with ReadingCore.PDFTextAnchor. Offsets are UTF-16. */
export const normalizePDFText = (value: string) => value.replace(/[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g, ' ').trim();
export const pdfPageID = (index: number) => `pdf-page-${index}`;
export function clipPDFText(value: string, limit: number): string {
  let text = value.slice(0, limit);
  if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
  return text;
}
export interface PDFSearchHit { pageIndex: number; offset: number; length: number; quote: string; excerpt: string }
interface LocalPDFText { numPages: number; getPage(number: number): Promise<{ getTextContent(): Promise<{ items: ({ str: string } | object)[] }> }> }
export async function searchPDFText(document: LocalPDFText, query: string, signal: AbortSignal, progress?: (page: number) => void): Promise<PDFSearchHit[]> {
  const needle = normalizePDFText(query).slice(0, 100);
  if (!needle) return [];
  const expression = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'), results: PDFSearchHit[] = [];
  for (let index = 0; index < document.numPages && results.length < 100; index++) {
    signal.throwIfAborted();
    const page = await document.getPage(index + 1), content = await page.getTextContent();
    signal.throwIfAborted();
    // PDF.js already emits real spaces. Adding a space between drawing runs
    // would split words/CJK phrases when fonts or styling change mid-word.
    const text = normalizePDFText(content.items.map(item => 'str' in item && typeof item.str === 'string' ? item.str + ('hasEOL' in item && item.hasEOL ? '\n' : '') : '').join(''));
    for (const match of text.matchAll(expression)) {
      results.push({ pageIndex: index, offset: match.index!, length: match[0].length, quote: clipPDFText(match[0], 500), excerpt: text.slice(Math.max(0, match.index! - 30), match.index! + match[0].length + 60) });
      if (results.length === 100) break;
    }
    progress?.(index + 1);
    if (index % 8 === 7) await new Promise(resolve => setTimeout(resolve, 0));
  }
  return results;
}
