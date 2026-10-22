import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, strToU8 } from 'fflate';
import { epubReference, parseRichEpub } from '../src/lib/richEpub';
import { parsePublication } from '../src/lib/importPublication';

beforeAll(() => {
  const window = new JSDOM('').window;
  globalThis.DOMParser = window.DOMParser; globalThis.XMLSerializer = window.XMLSerializer;
});
const created: Blob[] = [];
beforeEach(() => {
  created.length = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(value => { created.push(value as Blob); return 'blob:https://read.example.com/' + created.length; });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });
function fixture(overrides: Record<string, string> = {}) {
  const values = {
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    'OEBPS/content.opf': '<package><metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">插图与脚注</dc:title></metadata><manifest><item id="one" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/></spine></package>',
    'OEBPS/Text/ch1.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>书</title><link rel="stylesheet" href="../Styles/book.css"/></head><body><h1>第一章</h1><p>正文𠀀🙂。</p><h2 id="sub">小节</h2><img src="../Images/figure.svg"/><a href="notes.xhtml#foot1">[1]</a><img src="https://remote.invalid/a" onerror="alert(1)"/><script>alert(1)</script><iframe src="https://remote.invalid/"/><form action="https://remote.invalid/"><input name="private"/></form></body></html>',
    'OEBPS/Text/notes.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><body><aside id="foot1">脚注内容<a href="ch1.xhtml#sub">返回</a></aside></body></html>',
    'OEBPS/Images/figure.svg': '<svg xmlns="http://www.w3.org/2000/svg"><rect width="40" height="40"/><script>alert(1)</script><image href="https://remote.invalid/a"/></svg>',
    'OEBPS/Styles/book.css': '@import "https://remote.invalid/style.css";h2{font-size:1.3em}body{background:url(https://remote.invalid/a)}',
    'OEBPS/code.js': 'alert(1)',
    ...overrides,
  };
  return new File([new Uint8Array(zipSync(Object.fromEntries(Object.entries(values).map(([path, value]) => [path, strToU8(value)]))))], 'book.epub');
}

describe('safe original EPUB layout', () => {
  it('retains real illustrations, headings, CSS and two-way footnote links without changing text imports', async () => {
    const file = fixture(), original = new Uint8Array(await file.arrayBuffer()), plainBefore = await parsePublication(file);
    const rich = await parseRichEpub(file);
    expect(rich.chapters.map(chapter => chapter.title)).toEqual(['第一章']); expect(rich.chapters[0].textChapterIndex).toBe(0);
    expect(rich.outline.map(item => item.depth)).toEqual([0, 1]);
    const html = rich.document(rich.chapters[0].path);
    expect(html).toContain('<h2 id="sub"'); expect(html).toContain('blob:https://read.example.com/');
    expect(html).toContain('data-qingread-path="OEBPS/Text/notes.xhtml"'); expect(html).toContain('data-qingread-fragment="foot1"');
    expect(html).not.toMatch(/<script|onerror|<iframe|<form|<input|https:\/\/remote\.invalid/);
    expect(html).toContain("script-src 'none'"); expect(html).toContain("connect-src 'none'");
    const notes = rich.document('OEBPS/Text/notes.xhtml'); expect(notes).toContain('data-qingread-path="OEBPS/Text/ch1.xhtml"'); expect(notes).toContain('data-qingread-fragment="sub"');
    const svg = await created.find(blob => blob.type === 'image/svg+xml')!.text(); expect(svg).toContain('<svg'); expect(svg).not.toContain('<script'); expect(svg).not.toContain('https://remote.invalid');
    const css = await created.find(blob => blob.type === 'text/css')!.text(); expect(css).toContain('h2{font-size:1.3em}'); expect(css).not.toContain('https://remote.invalid');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(original); expect((await parsePublication(file)).contents.map(value => value.paragraphs)).toEqual(plainBefore.contents.map(value => value.paragraphs));
    const count = created.length; rich.dispose(); rich.dispose(); expect(URL.revokeObjectURL).toHaveBeenCalledTimes(count); expect(() => rich.document(rich.chapters[0].path)).toThrow('已关闭');
  });
  it('resolves only archive-local paths and rejects schemes or escaped roots', () => {
    for (const value of ['../../../secret', '%2e%2e/%2e%2e/%2e%2e/secret', 'file:///private/file', 'https://example.com/a', '//example.com/a', 'javascript:alert(1)', 'a\\b']) expect(epubReference(value, 'OEBPS/Text/ch1.xhtml')).toBeUndefined();
    expect(epubReference('../Images/a%20b.png', 'OEBPS/Text/ch1.xhtml')).toEqual({ path: 'OEBPS/Images/a b.png', fragment: '' });
    expect(epubReference('#footnote', 'OEBPS/Text/ch1.xhtml')).toEqual({ path: 'OEBPS/Text/ch1.xhtml', fragment: 'footnote' });
  });
  it('revokes already allocated assets when a later EPUB page is malformed', async () => {
    const file = fixture({ 'OEBPS/Text/ch1.xhtml': '<html><body><h1>broken</body></html>' });
    await expect(parseRichEpub(file)).rejects.toThrow('原版页面格式'); expect(created.length).toBeGreaterThan(0); expect(URL.revokeObjectURL).toHaveBeenCalledTimes(created.length);
  });
  it('rejects zip traversal, custom XML entities and oversized resources', async () => {
    await expect(parseRichEpub(fixture({ '../escape.xhtml': '<html/>' }))).rejects.toThrow('不安全');
    await expect(parseRichEpub(fixture({ 'OEBPS/Text/ch1.xhtml': '<!DOCTYPE html [<!ENTITY x "xx">]><html><body>&x;</body></html>' }))).rejects.toThrow('自定义实体');
    await expect(parseRichEpub(fixture({ 'OEBPS/huge.css': 'x'.repeat(25 * 1024 * 1024) }))).rejects.toThrow('过大');
  });
});
