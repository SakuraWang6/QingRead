import { textToSpeech } from '@kit.CoreSpeechKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import { NativePolicy } from './NativePolicy';

export interface NativeVoice {
  id: string;
  name: string;
  lang: string;
  localService: boolean;
}

export interface SpeechEvent {
  utteranceID: string;
  type: string;
  charIndex?: number;
  message?: string;
}

// CoreSpeech reports playback completion, not word positions. The Web reader sends
// short sentences, so a speed change applies to the next sentence without restarting this one.
export class NativeSpeech {
  private engine?: textToSpeech.TextToSpeechEngine;
  private voices: NativeVoice[] = [];
  private selectedVoice: string = 'harmony:zh-CN:13';
  private utterance: string = '';
  private request: string = '';
  private length: number = 0;
  private serial: number = 0;
  private currentRate: number = 1;
  private disposed: boolean = false;
  private emit: (event: SpeechEvent) => void;

  constructor(emit: (event: SpeechEvent) => void) { this.emit = emit; }

  async initialize(): Promise<boolean> {
    try {
      const engine: textToSpeech.TextToSpeechEngine = await textToSpeech.createEngine({
        language: 'zh-CN', person: 13, online: 1,
        extraParams: { isBackStage: false }
      });
      if (this.disposed) { engine.shutdown(); return false; }
      this.engine = engine;
      this.listen(engine);
      this.voices = deviceInfo.sdkApiVersion < 19 ?
        [{ id: this.selectedVoice, name: '聆小珊 · 女声', lang: 'zh-CN', localService: true }] : [];
      try {
        const values: textToSpeech.VoiceInfo[] = await engine.listVoices({
          requestId: this.nextID(), online: 1
        });
        for (const voice of values) {
          // Before API 19 the service does not say whether a voice is installed.
          // Do not advertise unverified/downloadable voices as offline-ready.
          if (deviceInfo.sdkApiVersion < 19 || voice.status !== 'INSTALLED') continue;
          const language: string = voice.language.replace('_', '-');
          if (!['zh-CN', 'en-US'].includes(language) || ![8, 13, 21].includes(voice.person)) continue;
          const id: string = 'harmony:' + language + ':' + voice.person;
          if (!this.voices.some((existing: NativeVoice): boolean => existing.id === id)) {
            this.voices.push({ id: id,
              name: voice.person === 21 ? '凌飞哲 · 男声' : voice.person === 8 ? 'Laura · 英文女声' : '聆小珊 · 女声',
              lang: language, localService: true });
          }
        }
      } catch (_) {
        // Newer services must positively report INSTALLED before we call a voice offline-ready.
      }
      if (this.voices.length === 0) { engine.shutdown(); this.engine = undefined; return false; }
      return !this.disposed;
    } catch (_) {
      return false;
    }
  }

  private nextID(): string { return 'QingRead' + Date.now() + (++this.serial); }

  private listen(engine: textToSpeech.TextToSpeechEngine): void {
    engine.setListener({
      onStart: (request: string, _response: textToSpeech.StartResponse): void => {
        if (request === this.request) this.emit({ utteranceID: this.utterance, type: 'start', charIndex: 0 });
      },
      onComplete: (request: string, response: textToSpeech.CompleteResponse): void => {
        if (request !== this.request || response.type !== 1) return;
        const utterance: string = this.utterance;
        const length: number = this.length;
        this.request = ''; this.utterance = '';
        this.emit({ utteranceID: utterance, type: 'boundary', charIndex: length });
        this.emit({ utteranceID: utterance, type: 'end', charIndex: length });
      },
      onStop: (request: string, _response: textToSpeech.StopResponse): void => {
        if (request !== this.request) return;
        const utterance: string = this.utterance;
        this.request = ''; this.utterance = '';
        this.emit({ utteranceID: utterance, type: 'stop', charIndex: 0 });
      },
      onError: (request: string, _code: number, _message: string): void => {
        if (request !== this.request) return;
        const utterance: string = this.utterance;
        this.request = ''; this.utterance = '';
        this.emit({ utteranceID: utterance, type: 'error', message: '系统听书暂不可用，请检查已安装的语音资源。' });
      }
    });
  }

  list(): NativeVoice[] { return this.voices.slice(); }

  rate(value: number): void { this.currentRate = NativePolicy.rate(value); }

  async speak(utterance: string, text: string, rate: number, voiceIdentifier: string): Promise<void> {
    if (typeof utterance !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(utterance) ||
      typeof text !== 'string' || text.trim().length === 0 || text.length > 1000 ||
      typeof voiceIdentifier !== 'string') throw new Error('听书参数不正确');
    this.currentRate = NativePolicy.rate(rate);
    const voice: string = voiceIdentifier === '' ? (this.voices[0]?.id || '') : voiceIdentifier;
    if (!this.voices.some((item: NativeVoice): boolean => item.id === voice)) throw new Error('该音色尚未安装');
    this.stop();
    if (this.disposed || this.engine === undefined) throw new Error('当前设备没有可用的系统语音');
    if (voice !== this.selectedVoice) {
      const parts: string[] = voice.split(':');
      const generation: number = this.serial;
      const engine: textToSpeech.TextToSpeechEngine = await textToSpeech.createEngine({
        language: parts[1], person: Number(parts[2]), online: 1, extraParams: { isBackStage: false }
      });
      if (this.disposed || generation !== this.serial) { engine.shutdown(); throw new Error('听书已取消'); }
      this.engine.shutdown();
      this.engine = engine; this.selectedVoice = voice; this.listen(engine);
    }
    this.request = this.nextID(); this.utterance = utterance; this.length = text.length;
    try {
      this.engine.speak(text, { requestId: this.request,
        extraParams: { speed: this.currentRate, volume: 1, pitch: 1,
          languageContext: voice.split(':')[1], queueMode: 0, playType: 1, soundChannel: 3 } });
    } catch (_) {
      this.request = ''; this.utterance = '';
      throw new Error('系统听书暂不可用，请检查已安装的语音资源。');
    }
  }

  stop(): void {
    this.serial++;
    const previous: string = this.utterance;
    this.request = ''; this.utterance = '';
    try { this.engine?.stop(); } catch (_) { /* Already stopped or service unavailable. */ }
    if (previous !== '') this.emit({ utteranceID: previous, type: 'stop', charIndex: 0 });
  }

  dispose(): void {
    this.disposed = true; this.stop();
    try { this.engine?.shutdown(); } catch (_) { /* Service may have already been reclaimed. */ }
    this.engine = undefined;
  }
}
