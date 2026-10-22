import { describe, expect, it, vi } from 'vitest';
import { clipPDFText, normalizePDFText, pdfPageID, searchPDFText } from '../src/lib/pdfText';

describe('local PDF text anchors', () => {
  it('uses canonical whitespace and page IDs with UTF-16 match positions', async () => {
    expect(normalizePDFText(' 𠀀🙂\n\t中文\u00a0\u0085书 ')).toBe('𠀀🙂 中文 书');
    expect(pdfPageID(0)).toBe('pdf-page-0');
    const document = { numPages: 1, getPage: vi.fn(async () => ({ getTextContent: async () => ({ items: [{ str: '𠀀🙂', hasEOL: true }, { str: '中' }, { str: '文 书' }] }) })) };
    const values = await searchPDFText(document, '中文', new AbortController().signal);
    expect(values[0]).toMatchObject({ pageIndex: 0, offset: 5, length: 2, quote: '中文' });
  });
  it('bounds output, treats regex symbols literally and never requests OCR for image-only pages', async () => {
    const document = { numPages: 2, getPage: vi.fn(async (index: number) => ({ getTextContent: async () => ({ items: index === 1 ? [] : [{ str: 'a+b '.repeat(150) }] }) })) };
    const values = await searchPDFText(document, 'a+b', new AbortController().signal);
    expect(values).toHaveLength(100); expect(values[0].pageIndex).toBe(1); expect(values[0].quote).toBe('a+b');
  });
  it('cancels before reading another page and clips quotes without splitting surrogate pairs', async () => {
    const controller = new AbortController(), getPage = vi.fn(async () => { controller.abort(); return { getTextContent: async () => ({ items: [{ str: 'private text' }] }) }; });
    await expect(searchPDFText({ numPages: 100, getPage }, 'text', controller.signal)).rejects.toThrow(); expect(getPage).toHaveBeenCalledTimes(1);
    expect(clipPDFText('a𠀀🙂', 2)).toBe('a'); expect(clipPDFText('a𠀀🙂', 3)).toBe('a𠀀');
  });
});
