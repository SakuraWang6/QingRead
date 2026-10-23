import { common } from '@kit.AbilityKit';
import { workScheduler } from '@kit.BackgroundTasksKit';
import { notificationManager } from '@kit.NotificationKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import { http } from '@kit.NetworkKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { util } from '@kit.ArkTS';
import { NativeCredentials } from './NativeCredentials';
import { UpdateStore } from './UpdateStore';
import { UpdatePolicy, UpdateState, UpdateBook, UpdateChapter, UpdateBaseline, WatchedBook, StoredWatch, UpdateSnapshot } from './UpdatePolicy';

interface NotificationPermission { notifications: string }
interface RememberedConnection { address: string; token: string }
interface RunToken { epoch: string; profile: string; apiBase: string; credentialFingerprint: string }
const NOTICE_ID: number = 91301;

async function fingerprint(profile: string, base: string, token: string): Promise<string> {
  if (!token) return '';
  if (token.length > 1024 || /[\u0000-\u001f\u007f]/.test(token)) throw new Error('访问码格式无效');
  const encoder: util.TextEncoder = new util.TextEncoder();
  const md: cryptoFramework.Md = cryptoFramework.createMd('SHA256');
  await md.update({ data: encoder.encodeInto(base + '\n' + profile + '\n' + token) });
  const digest: cryptoFramework.DataBlob = await md.digest();
  return Array.from(digest.data).map((value: number): string => value.toString(16).padStart(2, '0')).join('');
}

function workInfo(): workScheduler.WorkInfo {
  return { workId: UpdatePolicy.WORK_ID, bundleName: 'app.qingread.harmony', abilityName: UpdatePolicy.ABILITY,
    networkType: workScheduler.NetworkType.NETWORK_TYPE_ANY, isRepeat: true, repeatCycleTime: UpdatePolicy.CYCLE, isPersisted: true };
}

async function clearNotice(): Promise<void> { try { await notificationManager.cancel(NOTICE_ID); } catch (_) {} }
function stopWork(): void { try { workScheduler.stopWork(workInfo(), true); } catch (_) {} }

/** Explicit opt-in control plane. Tokens never enter the durable watcher JSON. */
export class NativeUpdates {
  private store: UpdateStore;
  constructor(context: common.Context) { this.store = new UpdateStore(context); }

  async available(): Promise<boolean> {
    // maxRedirects:0 is API 23+. Never pretend a header callback prevents credential redirects on older OS versions.
    if (deviceInfo.sdkApiVersion < 23) return false;
    try { await workScheduler.obtainAllWorks(); return true; } catch (_) { return false; }
  }

  async configureProfile(profile: string | null, apiBase: string = '', accessToken: string = '', trusted: () => boolean = (): boolean => true): Promise<void> {
    const next: string = profile === null ? '' : UpdatePolicy.profile(profile);
    const base: string = next ? UpdatePolicy.apiBase(apiBase) : '';
    const credential: string = next ? await fingerprint(next, base, accessToken) : '';
    await this.store.locked(async (state: UpdateState): Promise<boolean> => {
      if (!trusted()) throw new Error('页面已关闭');
      if (state.profile === next && state.apiBase === base && state.credentialFingerprint === credential) return false;
      state.epoch = util.generateRandomUUID(); state.profile = next; state.apiBase = base;
      state.credentialFingerprint = credential; state.enabled = false; state.watches = [];
      // The OS registration and notice cancellation share the state lock with publishing.
      stopWork(); await clearNotice(); return true;
    });
  }

  async replaceWatchedBooks(profile: string, enabled: boolean, books: WatchedBook[], trusted: () => boolean = (): boolean => true): Promise<void> {
    UpdatePolicy.profile(profile);
    if (typeof enabled !== 'boolean' || !Array.isArray(books) || books.length > 20 || JSON.stringify(books).length > 120000) throw new Error('追更书架范围无效');
    if (enabled && !(await this.available())) throw new Error('当前系统暂不支持后台追更');
    if (enabled && !(await notificationManager.isNotificationEnabled())) throw new Error('请在系统设置允许清读通知');
    await this.store.locked(async (state: UpdateState): Promise<boolean> => {
      if (!trusted() || profile !== state.profile) throw new Error('账号已切换');
      const next: StoredWatch[] = [];
      const seen: Set<string> = new Set<string>();
      if (enabled) books.forEach((value: WatchedBook): void => {
        const book: UpdateBook = UpdatePolicy.book(value.book);
        if (seen.has(book.id)) throw new Error('追更书架包含重复书籍');
        seen.add(book.id);
        let baseline: UpdateBaseline = UpdatePolicy.baseline(value.baseline);
        const old: StoredWatch | undefined = state.watches.find((watch: StoredWatch): boolean => UpdatePolicy.sameSource(watch.book, book));
        if (old !== undefined && Date.parse(old.baseline.checkedAt || '') > Date.parse(baseline.checkedAt || '1970-01-01')) baseline = old.baseline;
        const read: string = value.readChapterID || '';
        if (typeof read !== 'string' || read.length > 4096) throw new Error('阅读位置无效');
        next.push({ book: book, baseline: baseline, readChapterID: read, attemptedAt: old === undefined ? 0 : old.attemptedAt });
      });
      state.epoch = util.generateRandomUUID(); state.enabled = enabled; state.watches = next;
      if (!enabled || next.length === 0) { stopWork(); await clearNotice(); }
      else {
        const works: workScheduler.WorkInfo[] = await workScheduler.obtainAllWorks();
        if (!works.some((work: workScheduler.WorkInfo): boolean => work.workId === UpdatePolicy.WORK_ID)) workScheduler.startWork(workInfo());
      }
      if (!trusted()) { stopWork(); throw new Error('页面已关闭'); }
      return true;
    });
  }

  async snapshot(profile: string): Promise<UpdateSnapshot> {
    UpdatePolicy.profile(profile);
    let result: UpdateSnapshot = { enabled: false, notifications: 'denied', updates: {} };
    await this.store.locked(async (state: UpdateState): Promise<boolean> => {
      if (state.profile !== profile) throw new Error('账号已切换');
      let allowed: boolean = false;
      try { allowed = await notificationManager.isNotificationEnabled(); } catch (_) {}
      const updates: Record<string, UpdateBaseline> = {};
      state.watches.forEach((watch: StoredWatch): void => {
        const value: UpdateBaseline = UpdatePolicy.baseline(watch.baseline);
        if (watch.baseline.error) value.error = '本次检查未完成';
        updates[watch.book.id] = value;
      });
      result = { enabled: state.enabled, notifications: allowed ? 'granted' : state.permissionAsked ? 'denied' : 'prompt', updates: updates };
      // A bridge response is bounded even for unusually long chapter IDs.
      while (JSON.stringify(result).length > 120000) {
        let trimmed: boolean = false;
        Object.keys(updates).forEach((id: string): void => {
          const ids: string[] = updates[id].unreadChapterIDs || [];
          if (ids.length > 0) { ids.shift(); trimmed = true; }
        });
        if (!trimmed) throw new Error('追更记录过大');
      }
      return false;
    });
    return result;
  }

  async requestNotificationPermission(context: common.UIAbilityContext, trusted: () => boolean = (): boolean => true): Promise<NotificationPermission> {
    if (!(await this.available())) throw new Error('当前系统暂不支持后台追更');
    await this.store.locked(async (state: UpdateState): Promise<boolean> => {
      if (!trusted()) throw new Error('页面已关闭');
      state.permissionAsked = true; return true;
    });
    if (!trusted()) throw new Error('页面已关闭');
    try { await notificationManager.requestEnableNotification(context); } catch (_) {}
    return { notifications: (await notificationManager.isNotificationEnabled()) ? 'granted' : 'denied' };
  }
}

class UpdateRequestError extends Error {
  stopRound: boolean;
  constructor(stopRound: boolean) { super('本次检查未完成'); this.stopRound = stopRound; }
}

/** A single bounded Extension run. It never polls on a foreground timer or requires AGC. */
export class NativeUpdateRunner {
  private store: UpdateStore;
  private stopped: boolean = false;
  private request?: http.HttpRequest;
  private rejectRequest?: () => void;
  private deadline: number = 0;
  constructor(context: common.Context) { this.store = new UpdateStore(context); }

  stop(): void {
    this.stopped = true;
    if (this.request !== undefined) { try { this.request.destroy(); } catch (_) {} }
    if (this.rejectRequest !== undefined) this.rejectRequest();
  }

  private running(): boolean { return !this.stopped && Date.now() < this.deadline; }

  private async credential(token: RunToken): Promise<string> {
    if (!token.credentialFingerprint) return '';
    const secret: string | null = await new NativeCredentials().load('connection');
    if (secret === null) throw new UpdateRequestError(true);
    const connection: RememberedConnection = JSON.parse(secret) as RememberedConnection;
    if (connection === null || connection.address !== token.apiBase || typeof connection.token !== 'string' ||
      await fingerprint(token.profile, token.apiBase, connection.token) !== token.credentialFingerprint) throw new UpdateRequestError(true);
    return connection.token;
  }

  private async chapters(token: RunToken, book: UpdateBook, accessToken: string): Promise<UpdateChapter[]> {
    if (!this.running()) throw new UpdateRequestError(true);
    const request: http.HttpRequest = http.createHttp(); this.request = request;
    let timer: number = -1;
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (accessToken) headers['X-QingRead-Token'] = accessToken;
    try {
      const cancelled: Promise<http.HttpResponse> = new Promise<http.HttpResponse>((_, reject): void => {
        this.rejectRequest = (): void => { reject(new UpdateRequestError(true)); };
        timer = setTimeout((): void => {
          try { request.destroy(); } catch (_) {}
          reject(new UpdateRequestError(true));
        }, Math.min(UpdatePolicy.REQUEST_BUDGET, this.deadline - Date.now()));
      });
      const response: http.HttpResponse = await Promise.race([request.request(token.apiBase + '/chapters', {
        method: http.RequestMethod.POST, header: headers, extraData: JSON.stringify({ book: book }),
        expectDataType: http.HttpDataType.STRING, usingCache: false, connectTimeout: 8000, readTimeout: 15000,
        maxLimit: UpdatePolicy.RESPONSE_LIMIT, maxRedirects: 0
      }), cancelled]);
      if (!this.running()) throw new UpdateRequestError(true);
      if (response.responseCode !== 200) throw new UpdateRequestError([401, 403, 429].includes(response.responseCode));
      if (typeof response.result !== 'string' || response.result.length > UpdatePolicy.RESPONSE_LIMIT) throw new UpdateRequestError(false);
      return UpdatePolicy.chapters(JSON.parse(response.result) as UpdateChapter[]);
    } finally {
      if (timer !== -1) clearTimeout(timer);
      this.rejectRequest = undefined; this.request = undefined;
      try { request.destroy(); } catch (_) {}
    }
  }

  async run(): Promise<void> {
    if (deviceInfo.sdkApiVersion < 23 || this.stopped) return;
    this.deadline = Date.now() + UpdatePolicy.RUN_BUDGET;
    const timer: number = setTimeout((): void => { this.stop(); }, UpdatePolicy.RUN_BUDGET);
    try { await this.execute(); } finally { clearTimeout(timer); }
  }

  private async execute(): Promise<void> {
    let token: RunToken = { epoch: '', profile: '', apiBase: '', credentialFingerprint: '' };
    let books: StoredWatch[] = [];
    await this.store.locked(async (state: UpdateState): Promise<boolean> => {
      if (!state.enabled || !state.profile || !this.running()) return false;
      token = { epoch: state.epoch, profile: state.profile, apiBase: state.apiBase, credentialFingerprint: state.credentialFingerprint };
      books = state.watches.slice().sort((a: StoredWatch, b: StoredWatch): number => a.attemptedAt - b.attemptedAt).slice(0, UpdatePolicy.MAX_BOOKS_PER_RUN);
      return false;
    });
    if (books.length === 0 || !(await notificationManager.isNotificationEnabled()) || !this.running()) return;
    let accessToken: string;
    try { accessToken = await this.credential(token); } catch (_) { return; }
    for (const candidate of books) {
      if (!this.running()) break;
      let reserved: boolean = false;
      await this.store.locked(async (state: UpdateState): Promise<boolean> => {
        if (!this.running() || !UpdatePolicy.active(state, token.epoch, token.profile, token.apiBase, candidate.book)) return false;
        const current: StoredWatch = state.watches.find((watch: StoredWatch): boolean => watch.book.id === candidate.book.id) as StoredWatch;
        current.attemptedAt = Date.now(); reserved = true; return true;
      });
      if (!reserved) break;
      try {
        const chapters: UpdateChapter[] = await this.chapters(token, candidate.book, accessToken);
        await this.store.locked(async (state: UpdateState): Promise<boolean> => {
          if (!this.running() || !UpdatePolicy.active(state, token.epoch, token.profile, token.apiBase, candidate.book)) return false;
          const current: StoredWatch = state.watches.find((watch: StoredWatch): boolean => watch.book.id === candidate.book.id) as StoredWatch;
          const appended: Set<string> = new Set<string>(UpdatePolicy.appended(current.baseline, chapters));
          current.baseline = UpdatePolicy.updated(current, chapters, Date.now());
          const notify: boolean = (current.baseline.unreadChapterIDs || []).some((id: string): boolean => appended.has(id));
          // Persist before requesting a notification: failed publish cannot repeatedly announce the same tail.
          // Hold the OS state lock until publish resolves; profile/disable then cancels this generic notice.
          this.store.save(state);
          if (notify && this.running() && await notificationManager.isNotificationEnabled() && this.running()) {
            try {
              await notificationManager.publish({ id: NOTICE_ID, notificationSlotType: notificationManager.SlotType.CONTENT_INFORMATION,
                content: { notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
                  normal: { title: '清读', text: '书架有新章节，打开清读查看' } } });
            } catch (_) { /* Progress remains durable; OS notification delivery is best effort. */ }
          }
          return false;
        });
      } catch (error) {
        if (!this.running()) break;
        await this.store.locked(async (state: UpdateState): Promise<boolean> => {
          if (!this.running() || !UpdatePolicy.active(state, token.epoch, token.profile, token.apiBase, candidate.book)) return false;
          const current: StoredWatch = state.watches.find((watch: StoredWatch): boolean => watch.book.id === candidate.book.id) as StoredWatch;
          current.baseline.error = '本次检查未完成'; return true;
        });
        if (error instanceof UpdateRequestError && error.stopRound) break;
      }
    }
  }
}
