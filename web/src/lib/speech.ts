import { safeOffset } from './readerLayout';
import { hasHarmonyCapability, harmonyRequest } from './harmonyNative';

export interface SpeechPosition { offset: number; speaking: boolean; paused: boolean }
export interface SpeechOptions {
  rate: number; voiceIdentifier: string;
  onPosition: (state: SpeechPosition) => void;
  onEnd: () => void; onError: (message: string) => void;
}
export interface ReaderVoice { voiceURI: string; name: string; lang: string; localService: boolean }
const speechEvent = 'qingread:harmony-speech';
let utteranceSequence = 0;

/** Installed voices only. Native Harmony does not fall back to network synthesis. */
export function observeSpeechVoices(onChange: (voices: ReaderVoice[]) => void, onError?: (message: string) => void): () => void {
  if (hasHarmonyCapability('speech')) {
    let active = true;
    void harmonyRequest<{ voices: { id: string; name: string; lang: string; localService: boolean }[] }>('speech', 'speech.voices', {}, 60_000).then(result => {
      if (!Array.isArray(result?.voices)) throw new Error('无法读取设备音色，请稍后重试');
      const voices = result.voices.slice(0, 100).filter(voice => typeof voice.id === 'string' && voice.id.length <= 200 && typeof voice.name === 'string' && voice.name.length <= 200 && typeof voice.lang === 'string' && voice.lang.length <= 40 && voice.localService === true);
      if (active) onChange(voices.map(voice => ({ voiceURI: voice.id, name: voice.name, lang: voice.lang, localService: true })));
    }).catch(error => { if (active) onError?.(error instanceof Error ? error.message : '无法读取设备音色'); });
    return () => { active = false; };
  }
  if (!ReaderSpeech.supported) return () => {};
  const update = () => onChange(window.speechSynthesis.getVoices());
  update(); window.speechSynthesis.addEventListener('voiceschanged', update);
  return () => window.speechSynthesis.removeEventListener('voiceschanged', update);
}

/** Uses only the device/browser's installed voices. No cloud credentials or AI claims. */
export class ReaderSpeech {
  private text = '';
  private offset = 0;
  private generation = 0;
  private options?: SpeechOptions;
  private utterance?: SpeechSynthesisUtterance;
  private native = false;
  private detachNative?: () => void;
  private nativeWriting = Promise.resolve();
  speaking = false;
  paused = false;
  static get supported(): boolean {
    return hasHarmonyCapability('speech') || typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  }

  start(text: string, offset: number, options: SpeechOptions): void {
    this.stop(); this.text = text; this.offset = safeOffset(text, offset); this.options = options;
    this.native = hasHarmonyCapability('speech');
    if (!ReaderSpeech.supported) { options.onError('这个设备暂不支持系统听书。'); return; }
    this.speaking = true; this.paused = false; this.publish(); this.speakChunk(this.generation);
  }

  update(rate: number, voiceIdentifier: string): void {
    if (!this.options) return;
    const voiceChanged = voiceIdentifier !== this.options.voiceIdentifier;
    const changed = rate !== this.options.rate || voiceChanged;
    this.options = { ...this.options, rate, voiceIdentifier };
    if (changed && this.speaking) {
      if (this.native && !voiceChanged) {
        // Huawei exposes sentence boundaries, not word boundaries. Apply speed to
        // the next native phrase without restarting the current phrase or page.
        const generation = this.generation;
        this.queueNative(() => harmonyRequest('speech', 'speech.rate', { rate: Math.max(.5, Math.min(2, rate)) }), generation);
        return;
      }
      const paused = this.paused;
      this.generation++; this.cancelBackend();
      // Boundary offsets preserve the current sentence/word, rather than returning to the page.
      this.paused = paused;
      if (!paused) this.speakChunk(this.generation);
    }
  }

  pause(): void {
    if (!this.speaking || !ReaderSpeech.supported) return;
    if (this.native) { this.generation++; this.cancelBackend(); }
    else window.speechSynthesis.pause();
    this.paused = true; this.publish();
  }
  resume(): void {
    if (!this.speaking || !ReaderSpeech.supported) return;
    this.paused = false;
    if (this.native || !window.speechSynthesis.speaking) this.speakChunk(this.generation);
    else window.speechSynthesis.resume();
    this.publish();
  }
  stop(): void {
    this.generation++; this.cancelBackend();
    this.utterance = undefined; this.speaking = false; this.paused = false;
    this.publish();
  }
  private cancelBackend(): void {
    this.detachNative?.(); this.detachNative = undefined;
    if (this.native) this.queueNative(() => harmonyRequest('speech', 'speech.stop'), this.generation);
    else if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  }
  private queueNative(work: () => Promise<unknown>, generation: number): void {
    this.nativeWriting = this.nativeWriting.catch(() => {}).then(work).then(() => {}, error => {
      if (generation !== this.generation) return;
      this.detachNative?.(); this.detachNative = undefined; this.speaking = false; this.paused = false; this.publish();
      this.options?.onError(error instanceof Error ? error.message : '系统听书暂时中断，请重试');
    });
  }
  private publish(): void { this.options?.onPosition({ offset: this.offset, speaking: this.speaking, paused: this.paused }); }
  private speakChunk(generation: number): void {
    if (generation !== this.generation || !this.options || this.paused) return;
    while (this.offset < this.text.length && /\s/.test(this.text[this.offset])) this.offset++;
    if (this.offset >= this.text.length) {
      this.speaking = false; this.publish(); this.options.onEnd(); return;
    }
    const base = this.offset;
    const remaining = this.text.slice(base);
    const match = remaining.match(/^[\s\S]{1,140}?[。！？!?；;\n](?:[”’」』])?|^[\s\S]{1,140}/);
    let end = safeOffset(this.text, base + (match?.[0].length ?? remaining.length));
    if (end <= base) end = this.text.length;
    if (this.native) { this.speakNativeChunk(generation, base, end); return; }
    const utterance = new SpeechSynthesisUtterance(this.text.slice(base, end));
    const voices = window.speechSynthesis.getVoices();
    const voice = voices.find(item => item.voiceURI === this.options!.voiceIdentifier);
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang || 'zh-CN'; utterance.rate = Math.max(.5, Math.min(2, this.options.rate));
    utterance.onboundary = event => {
      if (generation !== this.generation) return;
      this.offset = safeOffset(this.text, base + event.charIndex); this.publish();
    };
    utterance.onend = () => {
      if (generation !== this.generation) return;
      this.offset = end; this.publish(); this.speakChunk(generation);
    };
    utterance.onerror = event => {
      if (generation !== this.generation || event.error === 'interrupted' || event.error === 'canceled') return;
      this.speaking = false; this.publish(); this.options?.onError(`系统听书暂时中断（${event.error}），可点击播放重试。`);
    };
    this.utterance = utterance;
    window.speechSynthesis.speak(this.utterance);
  }
  private speakNativeChunk(generation: number, base: number, end: number): void {
    const utteranceID = `reader-${Date.now().toString(36)}-${++utteranceSequence}`;
    this.detachNative?.();
    const detach = () => window.removeEventListener(speechEvent, receive);
    const receive = (event: Event) => {
      const detail: unknown = (event as CustomEvent).detail;
      if (generation !== this.generation || !detail || typeof detail !== 'object' || !('utteranceID' in detail) || detail.utteranceID !== utteranceID || !('type' in detail)) return;
      if (detail.type === 'boundary' && 'charIndex' in detail && typeof detail.charIndex === 'number' && Number.isFinite(detail.charIndex)) {
        this.offset = safeOffset(this.text, base + Math.max(0, Math.min(end - base, detail.charIndex))); this.publish();
      } else if (detail.type === 'end') {
        detach(); this.detachNative = undefined; this.offset = end; this.publish(); this.speakChunk(generation);
      } else if (detail.type === 'error' || detail.type === 'stop') {
        detach(); this.detachNative = undefined; this.speaking = detail.type === 'stop'; this.paused = detail.type === 'stop'; this.publish();
        if (detail.type === 'error') this.options?.onError('message' in detail && typeof detail.message === 'string' ? detail.message.slice(0, 300) : '设备音色暂不可用，请在系统设置安装中文离线语音');
      }
    };
    window.addEventListener(speechEvent, receive); this.detachNative = detach;
    const params = { utteranceID, text: this.text.slice(base, end), rate: Math.max(.5, Math.min(2, this.options!.rate)), voiceIdentifier: this.options!.voiceIdentifier.startsWith('harmony:') ? this.options!.voiceIdentifier : '' };
    this.queueNative(async () => { if (generation === this.generation) await harmonyRequest('speech', 'speech.speak', params, 60_000); }, generation);
  }
}
