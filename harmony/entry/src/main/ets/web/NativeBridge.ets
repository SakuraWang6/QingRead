import { common } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { batteryInfo } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';
import { LocalOrigin } from './LocalOrigin';
import { NativePolicy, NativeRequest } from './NativePolicy';
import { NativeCredentials } from './NativeCredentials';
import { NativeExport } from './NativeExport';
import { NativeSpeech, NativeVoice, SpeechEvent } from './NativeSpeech';
import { NativeDownloads } from './NativeDownloads';
import { DownloadConfiguration, DownloadParameters, DownloadTransfer } from './NativeDownloadPolicy';
import { NativeUpdates } from './NativeUpdates';
import { UpdateBaseline, WatchedBook } from './UpdatePolicy';

interface NativeResult {
  level?: number;
  value?: string | null;
  exportID?: string;
  saved?: boolean;
  voices?: NativeVoice[];
  transfer?: DownloadTransfer;
  transfers?: DownloadTransfer[];
  base64?: string;
  nextOffset?: number;
  done?: boolean;
  totalBytes?: number;
  sha256?: string;
  enabled?: boolean;
  notifications?: string;
  updates?: Record<string, UpdateBaseline>;
}
interface NativeReply { id: string; ok: boolean; result?: NativeResult; error?: string }
interface NativeEvent { event: string; detail: SpeechEvent }

export class NativeBridge {
  readonly nonce: string = 'qingread-native-' + util.generateRandomUUID();
  private controller: webview.WebviewController;
  private trusted: () => boolean;
  private credentials: NativeCredentials = new NativeCredentials();
  private exporter: NativeExport;
  private speech: NativeSpeech;
  private downloads: NativeDownloads;
  private updates: NativeUpdates;
  private context: common.UIAbilityContext;
  private capabilities: string[] = [];
  private ports: webview.WebMessagePort[] = [];
  private generation: number = 0;
  private connectedGeneration: number = -1;
  private running: Set<string> = new Set();
  private received: number[] = [];
  private credentialBusy: boolean = false;
  private speechBusy: boolean = false;
  private downloadMutationBusy: boolean = false;
  private backgroundConfigurationRevision: number = 0;
  private foreground: boolean = true;

  constructor(controller: webview.WebviewController, context: common.UIAbilityContext, trusted: () => boolean) {
    this.controller = controller; this.trusted = trusted;
    this.context = context;
    this.exporter = new NativeExport(context);
    this.downloads = new NativeDownloads(context);
    this.updates = new NativeUpdates(context);
    this.speech = new NativeSpeech((event: SpeechEvent): void => {
      this.sendEvent({ event: 'speech', detail: event });
    });
  }

  async initialize(): Promise<string[]> {
    this.capabilities = ['exportBackup'];
    try {
      const level: number = batteryInfo.batterySOC;
      if (Number.isInteger(level) && level >= 0 && level <= 100) this.capabilities.push('battery');
    } catch (_) { /* Unsupported devices do not advertise battery. */ }
    if (await this.credentials.available()) this.capabilities.push('secureStorage');
    if (await this.downloads.available()) this.capabilities.push('backgroundDownloads');
    if (await this.updates.available()) this.capabilities.push('updateNotifications');
    let timeout: number = -1;
    try {
      const available: boolean = await Promise.race([
        this.speech.initialize(),
        new Promise<boolean>((resolve): void => { timeout = setTimeout((): void => { resolve(false); }, 8000); })
      ]);
      if (available) this.capabilities.push('speech');
      else this.speech.dispose();
    } finally {
      if (timeout !== -1) clearTimeout(timeout);
    }
    console.info('QingRead available native capabilities: ' + this.capabilities.join(','));
    return this.capabilities.slice();
  }

  beginDocument(): void {
    this.generation++;
    this.speech.stop(); this.exporter.dispose();
    this.running.clear(); this.received = [];
    for (const port of this.ports) { try { port.close(); } catch (_) {} }
    this.ports = [];
    this.connectedGeneration = -1;
  }

  connect(): void {
    if (!this.trusted() || this.connectedGeneration === this.generation) return;
    const generation: number = this.generation;
    try {
      this.ports = this.controller.createWebMessagePorts();
      this.ports[0].onMessageEvent((message: webview.WebMessage): void => {
        if (generation === this.generation && this.trusted()) this.receive(message as string, generation);
      });
      this.connectedGeneration = generation;
      this.controller.postMessage(this.nonce, [this.ports[1]], LocalOrigin.ORIGIN);
    } catch (_) {
      this.beginDocument();
    }
  }

  setForeground(value: boolean): void {
    this.foreground = value;
    if (!value) this.speech.stop();
  }

  private send(reply: NativeReply, generation: number): void {
    if (generation !== this.generation || !this.trusted() || this.ports.length !== 2) return;
    try {
      const message: string = JSON.stringify(reply);
      this.ports[0].postMessageEvent(message.length <= NativePolicy.MAX_MESSAGE ? message :
        JSON.stringify({ id: reply.id, ok: false, error: '系统返回的数据过大，请缩小范围' } as NativeReply));
    } catch (_) {}
  }

  private sendEvent(event: NativeEvent): void {
    if (!this.trusted() || this.ports.length !== 2) return;
    try { this.ports[0].postMessageEvent(JSON.stringify(event)); } catch (_) {}
  }

  private async receive(raw: string, generation: number): Promise<void> {
    let request: NativeRequest;
    try { request = NativePolicy.parse(raw); } catch (_) { return; }
    const now: number = Date.now();
    this.received = this.received.filter((time: number): boolean => time > now - 10000);
    if (this.received.length >= 512 || this.running.size >= 8 || this.running.has(request.id)) {
      this.send({ id: request.id, ok: false, error: '请求过于频繁，请稍后重试' }, generation); return;
    }
    this.received.push(now); this.running.add(request.id);
    try {
      const result: NativeResult = await this.perform(request, generation);
      this.send({ id: request.id, ok: true, result: result }, generation);
    } catch (error) {
      // Only our short user-facing errors cross back; native paths and OS error payloads never do.
      const message: string = (error as Error).message || '';
      this.send({ id: request.id, ok: false,
        error: message.length > 0 && message.length < 100 && /[\u4e00-\u9fff]/.test(message) ? message : '操作未完成，请重试' }, generation);
    } finally {
      if (generation === this.generation) this.running.delete(request.id);
    }
  }

  private async perform(request: NativeRequest, generation: number): Promise<NativeResult> {
    if (!this.trusted() || generation !== this.generation) throw new Error('页面已关闭');
    const params = request.params;
    const currentDocument: () => boolean = (): boolean => generation === this.generation && this.trusted();
    if (request.method === 'background.configure') {
      if (!this.capabilities.includes('backgroundDownloads') && !this.capabilities.includes('updateNotifications')) throw new Error('当前设备后台功能不可用');
      const configurationRevision: number = ++this.backgroundConfigurationRevision;
      const currentConfiguration: () => boolean = (): boolean => currentDocument() &&
        configurationRevision === this.backgroundConfigurationRevision;
      // Account/server changes revoke reads and in-flight enqueue results immediately.
      this.downloads.revoke();
        if (this.capabilities.includes('updateNotifications')) {
          await this.updates.configureProfile(params.profile as string | null, params.apiBase || '', params.accessToken || '', currentConfiguration);
        }
        if (!currentConfiguration()) throw new Error('页面或下载账号已变化');
        if (this.capabilities.includes('backgroundDownloads')) {
          const cloud: boolean = typeof params.profile === 'string' && params.profile.startsWith('qingread-cloud-') &&
            typeof params.authToken === 'string' && /^[a-zA-Z0-9_-]{43}$/.test(params.authToken);
          await this.downloads.configure(cloud ? params as DownloadConfiguration : { profile: null }, currentConfiguration);
        }
        return {};
    }
    if (request.method.startsWith('updates.')) {
      if (!this.capabilities.includes('updateNotifications')) throw new Error('当前系统暂不支持后台追更');
      switch (request.method) {
        case 'updates.watch':
          await this.updates.replaceWatchedBooks(params.profile as string, params.enabled as boolean, params.books as WatchedBook[], currentDocument); return {};
        case 'updates.snapshot': return this.updates.snapshot(params.profile as string);
        case 'updates.requestPermission':
          if (!this.foreground) throw new Error('请在应用内开启通知');
          return this.updates.requestNotificationPermission(this.context, currentDocument);
        default: throw new Error('不支持的追更操作');
      }
    }
    if (request.method.startsWith('downloads.')) {
      if (!this.capabilities.includes('backgroundDownloads')) throw new Error('当前设备后台下载不可用');
      const profile: string = params.profile as string;
      const mutates: boolean = !['downloads.list', 'downloads.read'].includes(request.method);
      if (mutates && this.downloadMutationBusy) throw new Error('下载状态正在保存，请稍后重试');
      if (mutates) this.downloadMutationBusy = true;
      try {
      switch (request.method) {
        case 'downloads.enqueue': return { transfer: await this.downloads.enqueue(params as DownloadParameters) };
        case 'downloads.list': return { transfers: await this.downloads.list(profile) };
        case 'downloads.pause': case 'downloads.resume': case 'downloads.cancel':
          await this.downloads.action(profile, params.id as string, request.method.substring('downloads.'.length)); return {};
        case 'downloads.clearCache': await this.downloads.clear(profile); return {};
        case 'downloads.removeBook': await this.downloads.clear(profile, params.bookID as string); return {};
        case 'downloads.read': return this.downloads.read(params as DownloadParameters);
        case 'downloads.acknowledge': await this.downloads.acknowledge(params as DownloadParameters); return {};
        default: throw new Error('不支持的下载操作');
      }
      } finally { if (mutates) this.downloadMutationBusy = false; }
    }
    if (request.method.startsWith('credentials.')) {
      if (!this.capabilities.includes('secureStorage')) throw new Error('当前设备安全存储不可用');
      if (this.credentialBusy) throw new Error('登录信息正在保存，请稍后重试');
      this.credentialBusy = true;
      try {
        const slot: string = NativePolicy.slot(params.slot);
        if (request.method === 'credentials.load') return { value: await this.credentials.load(slot) };
        if (request.method === 'credentials.clear') { await this.credentials.clear(slot); return {}; }
        if (!this.foreground) throw new Error('请在应用内保存登录信息');
        await this.credentials.save(slot, params.value as string,
          (): boolean => generation === this.generation && this.trusted()); return {};
      } finally { this.credentialBusy = false; }
    }
    switch (request.method) {
      case 'battery.get': {
        const level: number = batteryInfo.batterySOC;
        if (!Number.isInteger(level) || level < 0 || level > 100) throw new Error('暂时无法读取电量');
        return { level: level };
      }
      case 'export.begin':
        if (!this.foreground) throw new Error('请在应用内导出备份');
        return { exportID: this.exporter.begin(params.name as string, params.size as number) };
      case 'export.append': this.exporter.append(params.exportID as string, params.content as string); return {};
      case 'export.cancel': this.exporter.cancel(params.exportID as string); return {};
      case 'export.commit':
        if (!this.foreground) throw new Error('请在应用内保存备份');
        return { saved: await this.exporter.commit(params.exportID as string,
          (): boolean => generation === this.generation && this.trusted()) };
      case 'speech.voices': return { voices: this.speech.list() };
      case 'speech.stop': this.speech.stop(); return {};
      case 'speech.rate': this.speech.rate(params.rate as number); return {};
      case 'speech.speak':
        if (!this.foreground || !this.capabilities.includes('speech')) throw new Error('当前设备系统听书不可用');
        if (this.speechBusy) throw new Error('听书正在准备，请稍后重试');
        this.speechBusy = true;
        try {
          await this.speech.speak(params.utteranceID as string, params.text as string,
            params.rate as number, params.voiceIdentifier as string);
          return {};
        } finally { this.speechBusy = false; }
      default: throw new Error('不支持的功能');
    }
  }

  dispose(): void { this.beginDocument(); this.speech.dispose(); }
}
