import { common } from '@kit.AbilityKit';
import { request } from '@kit.BasicServicesKit';
import { fileIo, hash } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { NativeDownloadPolicy, DownloadConfiguration, DownloadParameters, DownloadTransfer } from './NativeDownloadPolicy';

interface StoredTransfer {
  profile: string;
  transfer: DownloadTransfer;
  taskID: string;
  taskToken: string;
  filename: string;
}
interface DownloadState { version: number; profile: string; binding: string; jobs: StoredTransfer[] }
export interface DownloadRead { base64: string; nextOffset: number; done: boolean; totalBytes: number; sha256: string }

// The OS owns already-registered background transfers. Only the fixed account-scoped
// /offline/jobs/<uuid>/content route is reachable; callers never choose headers or paths.
export class NativeDownloads {
  private context: common.UIAbilityContext;
  private state: DownloadState = { version: 1, profile: '', binding: '', jobs: [] };
  private token: string = '';
  private base: string = '';
  private generation: number = 0;
  private busy: boolean = false;
  private configurationRevision: number = 0;
  private configuring: Promise<void> = Promise.resolve();
  private statePath: string;
  private encoder: util.TextEncoder = new util.TextEncoder();

  constructor(context: common.UIAbilityContext) {
    this.context = context;
    this.statePath = context.filesDir + '/qingread-downloads-v1.json';
    try {
      if (fileIo.statSync(this.statePath).size > 2 * 1024 * 1024) throw new Error('下载记录过大');
      const saved: DownloadState = JSON.parse(fileIo.readTextSync(this.statePath)) as DownloadState;
      if (saved.version !== 1 || !Array.isArray(saved.jobs) || saved.jobs.length > 20) throw new Error('下载记录无效');
      NativeDownloadPolicy.profile(saved.profile);
      for (const job of saved.jobs) {
        NativeDownloadPolicy.id(job.transfer.id); NativeDownloadPolicy.profile(job.profile);
        if (!/^qingread-download-[a-f0-9-]{36}\.ndjson$/i.test(job.filename) || !/^\d{1,30}$/.test(job.taskID) ||
          !/^[a-f0-9-]{36}$/i.test(job.taskToken)) throw new Error('下载记录无效');
      }
      this.state = saved;
    } catch (_) { /* Fresh installations and invalid private state both start empty. */ }
  }

  async available(): Promise<boolean> {
    const now: number = Date.now();
    try { await request.agent.search({ before: now, after: now - 1 }); return true; }
    catch (_) { return false; }
  }

  private persist(): void {
    const temporary: string = this.statePath + '.pending';
    const file: fileIo.File = fileIo.openSync(temporary, fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC | fileIo.OpenMode.WRITE_ONLY);
    try {
      const bytes: Uint8Array = this.encoder.encodeInto(JSON.stringify(this.state));
      let offset: number = 0;
      while (offset < bytes.byteLength) {
        const count: number = fileIo.writeSync(file.fd, bytes.slice(offset).buffer);
        if (count <= 0) throw new Error('无法保存下载状态');
        offset += count;
      }
    } finally { fileIo.closeSync(file); }
    fileIo.renameSync(temporary, this.statePath);
  }

  private async digest(value: string): Promise<string> {
    const md: cryptoFramework.Md = cryptoFramework.createMd('SHA256');
    await md.update({ data: this.encoder.encodeInto(value) });
    const result: cryptoFramework.DataBlob = await md.digest();
    return Array.from(result.data).map((byte: number): string => byte.toString(16).padStart(2, '0')).join('');
  }

  revoke(): void {
    this.generation++; this.configurationRevision++;
    this.token = ''; this.base = '';
  }

  configure(configuration: DownloadConfiguration, trusted: () => boolean = (): boolean => true): Promise<void> {
    // Revoke synchronously, before waiting for OS task cleanup or a previous configure.
    // A new account must never inherit access just because another mutation is busy.
    this.revoke();
    const revision: number = this.configurationRevision;
    const run: Promise<void> = this.configuring.catch((): void => {}).then(async (): Promise<void> => {
      if (revision !== this.configurationRevision || !trusted()) throw new Error('下载账号已切换');
      await this.applyConfiguration(configuration, trusted);
    });
    this.configuring = run.catch((): void => {});
    return run;
  }

  private async applyConfiguration(configuration: DownloadConfiguration, trusted: () => boolean): Promise<void> {
    if (!trusted()) throw new Error('页面已关闭');
    this.busy = true;
    const generation: number = this.generation;
    try {
      const profile: string = configuration.profile === null ? '' : NativeDownloadPolicy.profile(configuration.profile);
      const base: string = profile === '' ? '' : NativeDownloadPolicy.base(configuration.apiBase || '');
      const token: string = profile === '' ? '' : NativeDownloadPolicy.token(configuration.authToken || '');
      if (profile !== '') {
        const prefix: string = 'qingread-cloud-' + base + '|';
        if (!profile.startsWith(prefix)) throw new Error('下载账号与服务器不匹配');
        NativeDownloadPolicy.id(profile.substring(prefix.length));
      }
      const binding: string = profile === '' ? '' : await this.digest(base + '\n' + profile + '\n' + token);
      if (generation !== this.generation || !trusted()) throw new Error('下载账号已切换');
      this.base = base; this.token = token;
      const changed: boolean = this.state.binding !== binding || this.state.profile !== profile;
      this.state.profile = profile; this.state.binding = binding;
      if (changed) {
        const previous: StoredTransfer[] = this.state.jobs;
        this.state.jobs = []; this.persist();
        for (const old of previous) await this.destroy(old);
      }
    } finally { this.busy = false; }
  }

  private check(profile: string): void {
    NativeDownloadPolicy.profile(profile);
    if (this.busy || profile !== this.state.profile || this.base === '' || this.token === '') {
      throw new Error('下载账号已切换，请重新打开下载管理');
    }
  }
  private find(profile: string, id: string | undefined): StoredTransfer {
    this.check(profile); NativeDownloadPolicy.id(id);
    const job: StoredTransfer | undefined = this.state.jobs.find((item: StoredTransfer): boolean =>
      item.profile === profile && item.transfer.id === id);
    if (job === undefined) throw new Error('本机下载任务不存在');
    return job;
  }
  private path(job: StoredTransfer): string { return this.context.filesDir + '/' + job.filename; }
  private async task(job: StoredTransfer): Promise<request.agent.Task> {
    return request.agent.getTask(this.context, job.taskID, job.taskToken);
  }

  async enqueue(parameters: DownloadParameters): Promise<DownloadTransfer> {
    this.check(parameters.profile);
    const id: string = NativeDownloadPolicy.id(parameters.id);
    const revision: string = NativeDownloadPolicy.revision(parameters.revision);
    const bookID: string = NativeDownloadPolicy.identity(parameters.bookID);
    const sourceID: string = NativeDownloadPolicy.identity(parameters.sourceID);
    const sourceURL: string = NativeDownloadPolicy.source(parameters.sourceURL);
    if (!Number.isInteger(parameters.bytes) || (parameters.bytes as number) < 0 || (parameters.bytes as number) > NativeDownloadPolicy.MAX_BYTES) {
      throw new Error('云端文件过大，请分批下载');
    }
    const existing: StoredTransfer | undefined = this.state.jobs.find((item: StoredTransfer): boolean => item.transfer.id === id);
    if (existing !== undefined) {
      if (existing.profile !== parameters.profile || existing.transfer.revision !== revision ||
        existing.transfer.bookID !== bookID || existing.transfer.sourceID !== sourceID || existing.transfer.sourceURL !== sourceURL) {
        throw new Error('下载任务来源已变更，请取消旧任务');
      }
      await this.refresh(existing);
      if (['cancelled', 'failed'].includes(existing.transfer.status)) {
        await this.destroy(existing);
        this.state.jobs = this.state.jobs.filter((item: StoredTransfer): boolean => item !== existing); this.persist();
      } else return existing.transfer;
    }
    if (this.state.jobs.filter((item: StoredTransfer): boolean => !['completed', 'failed', 'cancelled'].includes(item.transfer.status)).length >= 2 ||
      this.state.jobs.length >= 20) throw new Error('本机下载任务较多，请先完成或清理任务');
    let reserved: number = NativeDownloadPolicy.MAX_BYTES;
    for (const previous of this.state.jobs) {
      if (['queued', 'running'].includes(previous.transfer.status)) reserved += NativeDownloadPolicy.MAX_BYTES;
      else {
        try { reserved += fileIo.statSync(this.path(previous)).size; } catch (_) {}
      }
    }
    if (reserved > 256 * 1024 * 1024) throw new Error('后台暂存空间已满，请先保存或清理已有文件');
    const generation: number = this.generation;
    const filename: string = 'qingread-download-' + util.generateRandomUUID() + '.ndjson';
    const taskToken: string = util.generateRandomUUID();
    const transfer: DownloadTransfer = { id: id, bookID: bookID, sourceID: sourceID, sourceURL: sourceURL,
      revision: revision, status: 'queued', receivedBytes: 0 };
    const task: request.agent.Task = await request.agent.create(this.context, {
      action: request.agent.Action.DOWNLOAD, mode: request.agent.Mode.BACKGROUND,
      url: this.base + '/offline/jobs/' + id + '/content', method: 'GET',
      headers: { Authorization: 'Bearer ' + this.token },
      saveas: this.context.filesDir + '/' + filename, token: taskToken, overwrite: false,
      redirect: false, retry: true, roaming: false, metered: true,
      title: '清读章节下载', description: '保存已准备的章节',
      // Dynamic NDJSON responses do not support HTTP Range. Keep both range fields
      // unset; restart uses a fresh file and validated server metadata instead.
      gauge: true
    });
    const job: StoredTransfer = { profile: parameters.profile, transfer: transfer,
      taskID: task.tid, taskToken: taskToken, filename: filename };
    if (generation !== this.generation || parameters.profile !== this.state.profile) {
      await this.destroy(job); throw new Error('下载账号已切换');
    }
    this.state.jobs.push(job); this.persist();
    task.on('progress', (progress: request.agent.Progress): void => {
      if (generation !== this.generation || this.state.profile !== job.profile) return;
      transfer.receivedBytes = progress.processed;
      if (progress.processed > NativeDownloadPolicy.MAX_BYTES) {
        transfer.status = 'failed'; transfer.error = '下载文件过大'; this.destroy(job); this.persist();
      }
    });
    await task.start();
    if (generation !== this.generation) { await this.destroy(job); throw new Error('下载账号已切换'); }
    transfer.status = 'running'; this.persist(); return transfer;
  }

  private async refresh(job: StoredTransfer): Promise<void> {
    if (job.transfer.status === 'cancelled') return;
    const generation: number = this.generation;
    try {
      // Token-protected OS tasks must be queried with touch; show deliberately hides them.
      const info: request.agent.TaskInfo = await request.agent.touch(job.taskID, job.taskToken);
      if (generation !== this.generation || job.profile !== this.state.profile) return;
      const progress: request.agent.Progress = info.progress;
      job.transfer.receivedBytes = progress.processed;
      const size: number = progress.sizes[0];
      if (size >= 0) job.transfer.totalBytes = size;
      if (progress.processed > NativeDownloadPolicy.MAX_BYTES || size > NativeDownloadPolicy.MAX_BYTES) {
        await this.destroy(job); job.transfer.status = 'failed'; job.transfer.error = '下载文件过大';
      } else if (progress.state === request.agent.State.COMPLETED) {
        const actual: number = fileIo.statSync(this.path(job)).size;
        if (actual <= 0 || actual > NativeDownloadPolicy.MAX_BYTES) throw new Error('下载文件大小无效');
        if (!job.transfer.sha256) job.transfer.sha256 = (await hash.hash(this.path(job), 'sha256')).toLowerCase();
        if (generation !== this.generation || job.profile !== this.state.profile) return;
        job.transfer.totalBytes = actual; job.transfer.receivedBytes = actual;
        job.transfer.status = 'completed'; job.transfer.error = undefined;
      } else if ([request.agent.State.PAUSED, request.agent.State.STOPPED].includes(progress.state)) {
        job.transfer.status = 'paused';
      } else if ([request.agent.State.FAILED, request.agent.State.REMOVED].includes(progress.state)) {
        job.transfer.status = 'failed'; job.transfer.error = '后台传输未完成，可继续重试';
      } else job.transfer.status = 'running';
      this.persist();
    } catch (_) {
      if (generation !== this.generation) return;
      job.transfer.status = 'failed'; job.transfer.error = '后台任务已中断，请重新保存章节'; this.persist();
    }
  }

  async list(profile: string): Promise<DownloadTransfer[]> {
    this.check(profile);
    for (const job of this.state.jobs) if (job.profile === profile) await this.refresh(job);
    this.check(profile);
    return this.state.jobs.filter((job: StoredTransfer): boolean => job.profile === profile).map((job: StoredTransfer): DownloadTransfer => job.transfer);
  }

  async action(profile: string, id: string, action: string): Promise<void> {
    const job: StoredTransfer = this.find(profile, id);
    const generation: number = this.generation;
    if (action === 'cancel') { await this.destroy(job); job.transfer.status = 'cancelled'; this.persist(); return; }
    if (action === 'resume') {
      if (!['paused', 'failed', 'completed'].includes(job.transfer.status)) throw new Error('这份文件无法继续下载');
      // The dynamic NDJSON route does not promise byte-range support. Start a fresh
      // OS task/file instead of concatenating a resumed response with stale bytes.
      await this.destroy(job);
      if (generation !== this.generation || !this.state.jobs.includes(job)) throw new Error('下载账号或任务已变化');
      this.state.jobs = this.state.jobs.filter((item: StoredTransfer): boolean => item !== job); this.persist();
      await this.enqueue({ profile: profile, id: job.transfer.id, bookID: job.transfer.bookID,
        sourceID: job.transfer.sourceID, sourceURL: job.transfer.sourceURL, revision: job.transfer.revision, bytes: 0 });
      return;
    }
    const task: request.agent.Task = await this.task(job);
    this.check(profile);
    if (generation !== this.generation || !this.state.jobs.includes(job)) throw new Error('下载账号或任务已变化');
    if (action === 'pause') { await task.pause(); job.transfer.status = 'paused'; }
    else throw new Error('不支持的下载操作');
    this.persist();
  }

  async read(parameters: DownloadParameters): Promise<DownloadRead> {
    const job: StoredTransfer = this.find(parameters.profile, parameters.id);
    const generation: number = this.generation;
    if (parameters.revision !== job.transfer.revision) throw new Error('下载任务版本已变化');
    await this.refresh(job); this.check(parameters.profile);
    if (generation !== this.generation || !this.state.jobs.includes(job)) throw new Error('下载账号或任务已变化');
    if (job.transfer.status !== 'completed' || !job.transfer.sha256) throw new Error('后台文件尚未完整下载');
    const size: number = fileIo.statSync(this.path(job)).size;
    const offset: number = parameters.offset as number;
    const limit: number = parameters.limit as number;
    if (size !== job.transfer.totalBytes || !Number.isSafeInteger(offset) || offset < 0 || offset > size ||
      !Number.isInteger(limit) || limit < 1 || limit > 49152) throw new Error('下载读取范围无效');
    // Re-hash before the first pass so modified same-size staging files cannot be
    // exposed under a previously verified digest, including after process restart.
    if (offset === 0 && (await hash.hash(this.path(job), 'sha256')).toLowerCase() !== job.transfer.sha256) {
      await this.destroy(job); job.transfer.status = 'failed'; this.persist(); throw new Error('下载文件校验失败，请重新下载');
    }
    this.check(parameters.profile);
    if (generation !== this.generation || !this.state.jobs.includes(job)) throw new Error('下载账号或任务已变化');
    const count: number = Math.min(limit, size - offset);
    const buffer: ArrayBuffer = new ArrayBuffer(count);
    const file: fileIo.File = fileIo.openSync(this.path(job), fileIo.OpenMode.READ_ONLY);
    let received: number = 0;
    try { if (count > 0) received = fileIo.readSync(file.fd, buffer, { offset: offset, length: count }); }
    finally { fileIo.closeSync(file); }
    if (received !== count) throw new Error('下载文件读取不完整');
    return { base64: new util.Base64Helper().encodeToStringSync(new Uint8Array(buffer)), nextOffset: offset + count,
      done: offset + count === size, totalBytes: size, sha256: job.transfer.sha256 };
  }

  async acknowledge(parameters: DownloadParameters): Promise<void> {
    const job: StoredTransfer = this.find(parameters.profile, parameters.id);
    if (job.transfer.status !== 'completed' || parameters.revision !== job.transfer.revision) throw new Error('下载文件尚未保存完成');
    await this.destroy(job);
    this.state.jobs = this.state.jobs.filter((item: StoredTransfer): boolean => item !== job); this.persist();
  }

  async clear(profile: string, bookID?: string): Promise<void> {
    this.check(profile);
    const targets: StoredTransfer[] = this.state.jobs.filter((job: StoredTransfer): boolean => job.profile === profile &&
      (bookID === undefined || job.transfer.bookID === bookID));
    this.state.jobs = this.state.jobs.filter((job: StoredTransfer): boolean => !targets.includes(job)); this.persist();
    for (const job of targets) await this.destroy(job);
  }

  private async destroy(job: StoredTransfer): Promise<void> {
    try { await request.agent.remove(job.taskID); } catch (_) { /* Already removed tasks have no remaining transfer. */ }
    try { fileIo.unlinkSync(this.path(job)); } catch (_) { /* Missing files are already clean. */ }
  }
}
