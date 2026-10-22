import { unzipSync } from 'fflate';
import { archivePath } from './importPublication';

export interface RichEpubChapter { path: string; title: string; textChapterIndex?: number }
export interface RichEpubOutline { id: string; path: string; fragment: string; title: string; depth: number }
export interface RichEpub {
  title: string; chapters: RichEpubChapter[]; outline: RichEpubOutline[];
  document(path: string): string; has(path: string): boolean; dispose(): void;
}
const htmlTypes = /\.(?:xhtml|html|htm)$/i;
const allowedFiles = /\.(?:xml|opf|xhtml|html|htm|css|svg|png|jpg|jpeg|gif|webp|woff|woff2|ttf|otf)$/i;
const unsafeElements = 'script,noscript,iframe,frame,frameset,object,embed,form,input,button,textarea,select,audio,video,source,track,base,foreignObject,animate,animateTransform,animateMotion,set';
const rasterData = (value: string) => /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(value) && value.length <= 4 * 1024 * 1024;
function xml(value: string): Document {
  const document = new DOMParser().parseFromString(value, 'application/xml');
  if (document.getElementsByTagName('parsererror').length) throw new Error('EPUB 清单无法解析');
  return document;
}
function xhtml(value: string): Document {
  // Parse as inert XML before touching HTML. DOMParser's text/html mode may
  // fetch images/frames even in a detached document; EPUB XHTML must not.
  if (/<!ENTITY\b/i.test(value)) throw new Error('不支持含自定义实体的 EPUB 页面');
  const normalized = value.replace(/&([a-z][a-z0-9]+);/gi, (entity: string, name: string) => {
    if (['amp', 'lt', 'gt', 'quot', 'apos'].includes(name)) return entity;
    const text = new DOMParser().parseFromString('<span>' + entity + '</span>', 'text/html').body.textContent || entity;
    return Array.from(text, character => `&#${character.codePointAt(0)};`).join('');
  });
  const document = new DOMParser().parseFromString(normalized, 'application/xhtml+xml');
  if (document.querySelector('parsererror')) throw new Error('EPUB 原版页面格式无效，可使用文字模式');
  return document;
}
const elements = (document: Document, name: string) => Array.from(document.getElementsByTagNameNS('*', name));

/** A reference is useful only if it resolves to an actual archive entry. */
export function epubReference(value: string, from: string): { path: string; fragment: string } | undefined {
  const reference = value.trim();
  if (!reference || reference.startsWith('/') || /[\\\0?]/.test(reference)) return undefined;
  const split = reference.indexOf('#'), relative = split < 0 ? reference : reference.slice(0, split);
  try {
    const path = relative ? archivePath(relative, from.split('/').slice(0, -1).join('/')) : from;
    const fragment = split < 0 ? '' : decodeURIComponent(reference.slice(split + 1));
    return { path, fragment };
  } catch { return undefined; }
}

export async function parseRichEpub(file: Blob): Promise<RichEpub> {
  if (!file.size || file.size > 250 * 1024 * 1024) throw new Error('请选择 250 MB 以内的 EPUB');
  let count = 0, total = 0;
  const names = new Set<string>();
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: entry => {
    count++; total += entry.originalSize;
    if (count > 10_000 || entry.originalSize > 24 * 1024 * 1024 || total > 200 * 1024 * 1024) throw new Error('EPUB 解压内容过大');
    if (entry.name.startsWith('/') || entry.name.split('/').includes('..') || /[\\\0]/.test(entry.name)) throw new Error('EPUB 包含不安全路径');
    const canonical = entry.name.split('/').filter(part => part && part !== '.').join('/');
    if (canonical !== entry.name.replace(/\/$/, '') || names.has(canonical)) throw new Error('EPUB 资源路径重复或无效');
    names.add(canonical);
    return allowedFiles.test(entry.name);
  } });
  const read = (path: string) => {
    if (!files[path] || files[path].length > 4 * 1024 * 1024) throw new Error('EPUB 页面不存在或超过读取上限');
    return new TextDecoder().decode(files[path]);
  };
  const container = xml(read('META-INF/container.xml'));
  const opfPath = archivePath(elements(container, 'rootfile')[0]?.getAttribute('full-path') || '');
  const opf = xml(read(opfPath));
  const manifest = new Map(elements(opf, 'item').map(item => [item.getAttribute('id'), item]));
  const urls = new Map<string, string>(), allocated: string[] = [], documents = new Map<string, string>();
  let disposed = false;
  const dispose = () => { if (disposed) return; disposed = true; allocated.forEach(url => URL.revokeObjectURL(url)); allocated.length = 0; urls.clear(); documents.clear(); Object.keys(files).forEach(key => delete files[key]); };
  const blob = (path: string, value: BlobPart, type: string) => { const url = URL.createObjectURL(new Blob([value], { type })); allocated.push(url); urls.set(path, url); return url; };
  const asset = (value: string, path: string): string | undefined => {
    if (rasterData(value)) return value;
    const reference = epubReference(value, path), url = reference && urls.get(reference.path);
    return url ? url + (reference!.fragment ? '#' + encodeURIComponent(reference!.fragment) : '') : undefined;
  };
  const css = (value: string, path: string) => value
    .replace(/@import\b[^;{}]*(?:;|$)/gi, '')
    .replace(/(?:expression\s*\(|-moz-binding\s*:|behavior\s*:)[^;}]*[;}]?/gi, '')
    .replace(/url\(\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\)\r\n]*))\s*\)/gi, (_all, double: string, single: string, bare: string) => {
      const url = asset((double ?? single ?? bare ?? '').trim(), path);
      return url ? `url("${url}")` : 'url("")';
    });
  function sanitize(document: Document, path: string, isSVG = false): string {
    document.querySelectorAll(unsafeElements + ',meta[http-equiv]').forEach(element => element.remove());
    for (const element of document.querySelectorAll('*')) {
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase(), value = attribute.value;
        if (name.startsWith('on') || ['srcdoc', 'srcset', 'action', 'formaction', 'target', 'download', 'ping', 'autofocus', 'contenteditable'].includes(name)) { element.removeAttribute(attribute.name); continue; }
        if (name === 'style') { element.setAttribute(attribute.name, css(value, path)); continue; }
        if (!['src', 'href', 'xlink:href', 'poster'].includes(name)) continue;
        if (element.localName === 'a' && name === 'href') {
          const reference = epubReference(value, path);
          if (reference && (files[reference.path] || documents.has(reference.path)) && htmlTypes.test(reference.path)) {
            element.setAttribute('data-qingread-path', reference.path); element.setAttribute('data-qingread-fragment', reference.fragment); element.setAttribute('href', '#');
          } else element.removeAttribute(attribute.name);
        } else if (value.startsWith('#') && element.namespaceURI === 'http://www.w3.org/2000/svg') {
          if (!/^#[\w\p{L}-]+$/u.test(value)) element.removeAttribute(attribute.name);
        } else {
          const url = asset(value, path);
          if (url) element.setAttribute(attribute.name, url); else element.removeAttribute(attribute.name);
        }
      }
      if (element.localName === 'style') element.textContent = css(element.textContent || '', path);
      if (element.localName === 'link' && element.getAttribute('rel') !== 'stylesheet') element.remove();
    }
    if (isSVG) return new XMLSerializer().serializeToString(document);
    document.querySelectorAll('meta[name=viewport]').forEach(element => element.remove());
    const security = document.createElement('meta'); security.setAttribute('http-equiv', 'Content-Security-Policy');
    security.setAttribute('content', "default-src 'none'; script-src 'none'; img-src blob: data:; style-src 'unsafe-inline' blob:; font-src blob: data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
    const viewport = document.createElement('meta'); viewport.setAttribute('name', 'viewport'); viewport.setAttribute('content', 'width=device-width,initial-scale=1');
    const style = document.createElement('style'); style.textContent = ':root{color-scheme:light dark}body{margin:0;padding:24px;overflow-wrap:anywhere;font-size:19px;line-height:1.8}img,svg{max-width:100%;height:auto}table{max-width:100%}a{color:#a64630}';
    const head = document.querySelector('head') ?? document.documentElement.insertBefore(document.createElement('head'), document.documentElement.firstChild);
    head.prepend(security, viewport); head.append(style);
    return '<!doctype html>\n' + document.documentElement.outerHTML;
  }
  try {
    const types: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf' };
    for (const [path, value] of Object.entries(files)) {
      const type = types[path.split('.').pop()!.toLowerCase()];
      if (type) { blob(path, new Uint8Array(value), type); delete files[path]; }
    }
    for (const [path] of Object.entries(files).filter(([path]) => /\.svg$/i.test(path))) {
      const document = new DOMParser().parseFromString(read(path), 'image/svg+xml');
      if (!document.querySelector('parsererror')) blob(path, sanitize(document, path, true), 'image/svg+xml');
      delete files[path];
    }
    for (const [path] of Object.entries(files).filter(([path]) => /\.css$/i.test(path))) { blob(path, css(read(path), path), 'text/css'); delete files[path]; }
    const chapters: RichEpubChapter[] = [], outline: RichEpubOutline[] = [];
    let textIndex = 0;
    for (const reference of elements(opf, 'itemref')) {
      if (reference.getAttribute('linear') === 'no') continue;
      const item = manifest.get(reference.getAttribute('idref'));
      if (!item?.getAttribute('media-type')?.includes('html')) continue;
      const target = epubReference(item.getAttribute('href') || '', opfPath);
      if (!target || !files[target.path]) continue;
      const document = xhtml(read(target.path));
      const title = document.querySelector('h1,h2,h3')?.textContent?.trim() || document.querySelector('title')?.textContent || `第 ${chapters.length + 1} 节`;
      const text = (document.querySelector('body') ?? document.documentElement).cloneNode(true) as HTMLElement;
      text.querySelectorAll('script,style,nav,noscript,iframe,object,svg').forEach(element => element.remove());
      const hasText = Boolean(text.textContent?.trim());
      chapters.push({ path: target.path, title, ...(hasText ? { textChapterIndex: textIndex++ } : {}) });
      const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'));
      const ids = new Set<string>();
      headings.forEach((heading, index) => {
        let id = heading.getAttribute('id');
        if (!id || ids.has(id)) { id = `qingread-heading-${chapters.length}-${index}`; heading.setAttribute('id', id); }
        ids.add(id); const title = heading.textContent?.trim(); if (!title) return;
        outline.push({ id: target.path + '#' + id, path: target.path, fragment: id, title, depth: Number(heading.localName.slice(1)) - 1 });
      });
      if (!headings.length) outline.push({ id: target.path, path: target.path, fragment: '', title, depth: 0 });
      documents.set(target.path, sanitize(document, target.path)); delete files[target.path];
    }
    if (!chapters.length) throw new Error('EPUB 没有可读取的原版页面');
    return { title: elements(opf, 'title')[0]?.textContent?.trim() || 'EPUB', chapters, outline,
      has: path => !disposed && (documents.has(path) || Boolean(files[path] && htmlTypes.test(path))),
      document: path => {
        if (disposed) throw new Error('原版图书已关闭');
        if (documents.has(path)) return documents.get(path)!;
        if (!files[path] || !htmlTypes.test(path)) throw new Error('EPUB 页面不存在');
        const result = sanitize(xhtml(read(path)), path); documents.set(path, result); delete files[path]; return result;
      }, dispose,
    };
  } catch (error) { dispose(); throw error; }
}
