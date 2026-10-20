import { safeOffset } from './readerLayout';

export interface SpeechPosition { offset: number; speaking: boolean; paused: boolean }
export interface SpeechOptions {
  rate: number; voiceIdentifier: string;
  onPosition: (state: SpeechPosition) => void;
  onEnd: () => void; onError: (message: string) => void;
}

/** Uses only the device/browser's installed voices. No cloud credentials or AI claims. */
export class ReaderSpeech {
  private text = '';
  private offset = 0;
  private generation = 0;
  private options?: SpeechOptions;
  private utterance?: SpeechSynthesisUtterance;
  speaking = false;
  paused = false;
  static get supported(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  }

  start(text: string, offset: number, options: SpeechOptions): void {
    this.stop(); this.text = text; this.offset = safeOffset(text, offset); this.options = options;
    if (!ReaderSpeech.supported) { options.onError('这个浏览器暂不支持系统听书。'); return; }
    this.speaking = true; this.paused = false; this.publish(); this.speakChunk(this.generation);
  }

  update(rate: number, voiceIdentifier: string): void {
    if (!this.options) return;
    const changed = rate !== this.options.rate || voiceIdentifier !== this.options.voiceIdentifier;
    this.options = { ...this.options, rate, voiceIdentifier };
    if (changed && this.speaking) {
      const paused = this.paused;
      this.generation++; window.speechSynthesis.cancel();
      // Boundary offsets preserve the current sentence/word, rather than returning to the page.
      this.paused = paused;
      if (!paused) this.speakChunk(this.generation);
    }
  }

  pause(): void {
    if (!this.speaking || !ReaderSpeech.supported) return;
    window.speechSynthesis.pause(); this.paused = true; this.publish();
  }
  resume(): void {
    if (!this.speaking || !ReaderSpeech.supported) return;
    this.paused = false;
    if (!window.speechSynthesis.speaking) this.speakChunk(this.generation);
    else window.speechSynthesis.resume();
    this.publish();
  }
  stop(): void {
    this.generation++;
    if (ReaderSpeech.supported) window.speechSynthesis.cancel();
    this.utterance = undefined; this.speaking = false; this.paused = false;
    this.publish();
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
    window.speechSynthesis.speak(utterance);
  }
}
