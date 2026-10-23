export interface UpdateBook { id: string; title: string; sourceID: string; sourceName: string; url: string }
export interface UpdateChapter { id: string; title: string }
export interface UpdateBaseline {
  knownChapterCount: number;
  lastKnownChapterID?: string;
  lastKnownChapterTitle?: string;
  unreadChapterIDs?: string[];
  checkedAt?: string;
  error?: string;
}
export interface WatchedBook { book: UpdateBook; baseline?: UpdateBaseline; readChapterID?: string }
export interface StoredWatch { book: UpdateBook; baseline: UpdateBaseline; readChapterID: string; attemptedAt: number }
export interface UpdateState {
  version: number;
  epoch: string;
  profile: string;
  apiBase: string;
  credentialFingerprint: string;
  enabled: boolean;
  permissionAsked: boolean;
  watches: StoredWatch[];
}
export interface UpdateSnapshot { enabled: boolean; notifications: string; updates: Record<string, UpdateBaseline> }

/** Pure bounds and conservative directory matching shared by foreground and worker. */
export class UpdatePolicy {
  static readonly WORK_ID: number = 91301;
  static readonly ABILITY: string = 'QingReadUpdateExtension';
  static readonly CYCLE: number = 2 * 60 * 60 * 1000;
  static readonly RUN_BUDGET: number = 80000;
  static readonly REQUEST_BUDGET: number = 20000;
  static readonly RESPONSE_LIMIT: number = 2 * 1024 * 1024;
  static readonly MAX_BOOKS_PER_RUN: number = 3;
  static readonly STATE_LIMIT: number = 512 * 1024;

  static profile(value: string): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error('账号标识无效');
    }
    return value;
  }

  static apiBase(value: string): string {
    if (typeof value !== 'string' || value.length > 2000) throw new Error('需要有效的 HTTPS 服务地址');
    const base: string = value.replace(/\/+$/, '');
    if (!/^https:\/\/(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|\[[0-9a-fA-F:]+\])(?::[0-9]{1,5})?(?:\/[a-zA-Z0-9._~-]+)*\/api$/.test(base) ||
      /\/\.{1,2}(?:\/|$)/.test(base) || /^https:\/\/(?:localhost|127\.[0-9.]+|0\.0\.0\.0|\[::1\])(?::|\/)/i.test(base)) {
      throw new Error('需要有效的 HTTPS 服务地址');
    }
    return base;
  }

  static book(value: UpdateBook): UpdateBook {
    if (value === null || typeof value !== 'object' || typeof value.id !== 'string' || !value.id || value.id.length > 8192 ||
      ['__proto__', 'constructor', 'prototype'].includes(value.id) || typeof value.title !== 'string' || !value.title || value.title.length > 1000 ||
      typeof value.sourceID !== 'string' || !value.sourceID || value.sourceID.length > 80 || value.sourceID.startsWith('local') ||
      typeof value.sourceName !== 'string' || value.sourceName.length > 200 || typeof value.url !== 'string' ||
      value.url.length > 3000 || !/^https?:\/\/[^\s@]+$/i.test(value.url) || /[\u0000-\u001f\u007f]/.test(value.id + value.url)) {
      throw new Error('追更书籍信息无效');
    }
    return { id: value.id, title: value.title, sourceID: value.sourceID, sourceName: value.sourceName, url: value.url };
  }

  static sameSource(a: UpdateBook, b: UpdateBook): boolean {
    return a.id === b.id && a.sourceID === b.sourceID && a.url === b.url;
  }

  static baseline(value?: UpdateBaseline): UpdateBaseline {
    if (value === undefined) return { knownChapterCount: 0, unreadChapterIDs: [] };
    if (value === null || !Number.isInteger(value.knownChapterCount) || value.knownChapterCount < 0 || value.knownChapterCount > 25000 ||
      (value.lastKnownChapterID !== undefined && (typeof value.lastKnownChapterID !== 'string' || value.lastKnownChapterID.length > 4096)) ||
      (value.lastKnownChapterTitle !== undefined && (typeof value.lastKnownChapterTitle !== 'string' || value.lastKnownChapterTitle.length > 2000)) ||
      (value.checkedAt !== undefined && (typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt))))) {
      throw new Error('追更基线无效');
    }
    const unread: string[] = value.unreadChapterIDs === undefined ? [] : value.unreadChapterIDs;
    if (!Array.isArray(unread) || unread.some((id: string): boolean => typeof id !== 'string' || !id || id.length > 4096)) {
      throw new Error('追更基线无效');
    }
    const result: UpdateBaseline = { knownChapterCount: value.knownChapterCount, lastKnownChapterID: value.lastKnownChapterID,
      lastKnownChapterTitle: value.lastKnownChapterTitle, unreadChapterIDs: Array.from(new Set<string>(unread)).slice(-200), checkedAt: value.checkedAt };
    while (JSON.stringify(result).length > 8192 && (result.unreadChapterIDs as string[]).length > 0) (result.unreadChapterIDs as string[]).shift();
    return result;
  }

  static title(value: string): string { return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); }

  static chapters(value: UpdateChapter[]): UpdateChapter[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > 25000) throw new Error('目录暂不可用');
    const seen: Set<string> = new Set<string>();
    return value.map((chapter: UpdateChapter): UpdateChapter => {
      if (chapter === null || typeof chapter.id !== 'string' || !chapter.id || chapter.id.length > 4096 || seen.has(chapter.id) ||
        typeof chapter.title !== 'string' || chapter.title.length > 2000) throw new Error('目录暂不可用');
      seen.add(chapter.id); return { id: chapter.id, title: chapter.title };
    });
  }

  static appended(baseline: UpdateBaseline, chapters: UpdateChapter[]): string[] {
    let matches: number[] = [];
    if (baseline.lastKnownChapterID) chapters.forEach((chapter: UpdateChapter, index: number): void => {
      if (chapter.id === baseline.lastKnownChapterID) matches.push(index);
    });
    if (matches.length !== 1) {
      matches = [];
      const title: string = UpdatePolicy.title(baseline.lastKnownChapterTitle || '');
      if (title) chapters.forEach((chapter: UpdateChapter, index: number): void => {
        if (UpdatePolicy.title(chapter.title) === title) matches.push(index);
      });
    }
    // Missing/ambiguous old tails establish a new baseline; never call a whole catalog new.
    return matches.length === 1 ? chapters.slice(matches[0] + 1).map((chapter: UpdateChapter): string => chapter.id) : [];
  }

  static updated(watch: StoredWatch, chapters: UpdateChapter[], now: number): UpdateBaseline {
    const appended: string[] = UpdatePolicy.appended(watch.baseline, chapters);
    const unread: Set<string> = new Set<string>([...(watch.baseline.unreadChapterIDs || []), ...appended]);
    const read: number = chapters.findIndex((chapter: UpdateChapter): boolean => chapter.id === watch.readChapterID);
    const end: UpdateChapter = chapters[chapters.length - 1];
    return UpdatePolicy.baseline({ knownChapterCount: chapters.length, lastKnownChapterID: end.id, lastKnownChapterTitle: end.title,
      unreadChapterIDs: chapters.slice(Math.max(0, read + 1)).filter((chapter: UpdateChapter): boolean => unread.has(chapter.id))
        .map((chapter: UpdateChapter): string => chapter.id), checkedAt: new Date(now).toISOString() });
  }

  static active(state: UpdateState, epoch: string, profile: string, apiBase: string, book?: UpdateBook): boolean {
    return state.enabled && state.epoch === epoch && state.profile === profile && state.apiBase === apiBase &&
      (book === undefined || state.watches.some((watch: StoredWatch): boolean => UpdatePolicy.sameSource(watch.book, book)));
  }
}
