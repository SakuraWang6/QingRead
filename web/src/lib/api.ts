import type { Book, Category, Chapter, ChapterContent, DiscoverySection, SearchResponse, SourceDefinition } from '../shared/types';
import { androidServerIssue } from './android';
import { isNativeApp } from './nativePlatform';
import { authenticationRequiredEvent, serverConnectionStore, ServerAuthenticationError } from './connection';

export function apiBase(): string {
  const configured = localStorage.getItem('qingread.apiBase')?.trim().replace(/\/+$/, '') || import.meta.env.VITE_API_BASE?.replace(/\/+$/, '') || '';
  if (isNativeApp()) { const issue = androidServerIssue(configured); if (issue) throw new Error(issue); }
  return serverConnectionStore().apiAddress();
}
function headers(address: string, json = false): HeadersInit {
  const token = serverConnectionStore().tokenFor(address);
  return { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(token ? { 'X-QingRead-Token': token } : {}) };
}
async function checked(response: Response): Promise<Response> {
  if (response.status === 401) {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(authenticationRequiredEvent));
    throw new ServerAuthenticationError();
  }
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.message || `服务请求失败（${response.status}）`); }
  return response;
}
async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const address = apiBase();
  const response = await checked(await fetch(address + path, { method: body === undefined ? 'GET' : 'POST', headers: headers(address, body !== undefined), body: body === undefined ? undefined : JSON.stringify(body), signal, redirect: 'error' }));
  return response.json();
}
export const api = {
  health: (signal?: AbortSignal) => request<{ ok: boolean; version: string; sources: number; requiresToken: boolean }>('/health', undefined, signal),
  sources: (signal?: AbortSignal) => request<SourceDefinition[]>('/sources', undefined, signal),
  search: async (query: string, sourceIDs?: string[], signal?: AbortSignal, onUpdate?: (result: SearchResponse) => void): Promise<SearchResponse> => {
    if (!onUpdate) return request('/search', { query, sourceIDs }, signal);
    const address = apiBase();
    const response = await checked(await fetch(address + '/search/stream', { method: 'POST', headers: headers(address, true), body: JSON.stringify({ query, sourceIDs }), signal, redirect: 'error' }));
    if (!response.body) throw new Error('当前浏览器不支持流式搜索。');
    const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '', result: SearchResponse = { books: [], failures: [] };
    try { for (;;) { const { value, done } = await reader.read(); pending += decoder.decode(value, { stream: !done }); const lines = pending.split('\n'); pending = lines.pop() ?? ''; for (const line of lines) if (line.trim()) { result = JSON.parse(line); onUpdate(result); } if (done) break; }
      if (pending.trim()) { result = JSON.parse(pending); onUpdate(result); } return result;
    } finally { reader.releaseLock(); }
  },
  chapters: (book: Book, signal?: AbortSignal) => request<Chapter[]>('/chapters', { book }, signal),
  content: (book: Book, chapter: Chapter, signal?: AbortSignal) => request<ChapterContent>('/content', { book, chapter }, signal),
  recommendations: (signal?: AbortSignal) => request<{ sections: DiscoverySection[] }>('/recommendations', undefined, signal),
  categories: (signal?: AbortSignal) => request<Category[]>('/categories', undefined, signal),
  category: (id: string, signal?: AbortSignal) => request<Book[]>('/categories/' + encodeURIComponent(id), undefined, signal),
  author:(name:string,signal?:AbortSignal)=>request<{author:string;books:Book[]}>('/author?'+new URLSearchParams({name}),undefined,signal),
  download: async (book: Book, signal?: AbortSignal): Promise<Blob> => { const address = apiBase(); return (await checked(await fetch(address + '/download', { method: 'POST', headers: headers(address, true), body: JSON.stringify({ book }), signal, redirect: 'error' }))).blob(); },
  coverURL: (book: Book): string => book.coverURL?.startsWith('blob:') ? book.coverURL : book.sourceID === 'local' || book.sourceID.startsWith('local-') ? '' : apiBase() + '/cover?' + new URLSearchParams({ sourceID: book.sourceID, bookURL: book.url, ...(book.coverURL ? { url: book.coverURL } : {}) }),
  cover: async (book: Book, signal?: AbortSignal): Promise<Blob> => { const address = apiBase(); return (await checked(await fetch(api.coverURL(book), { headers: headers(address), signal, redirect: 'error' }))).blob(); },
};
