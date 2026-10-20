import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReaderSpeech } from '../src/lib/speech';

class Utterance {
  text: string; rate = 1; lang = ''; voice?: unknown;
  onboundary?: (event: { charIndex: number }) => void;
  onend?: () => void;
  onerror?: (event: { error: string }) => void;
  constructor(text: string) { this.text = text; }
}
let utterances: Utterance[];
let mock: { speak: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn>; speaking: boolean; getVoices: () => unknown[] };
beforeEach(() => {
  utterances = [];
  mock = { speak: vi.fn((utterance: Utterance) => utterances.push(utterance)), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(), speaking: false, getVoices: () => [] };
  vi.stubGlobal('window', { speechSynthesis: mock, SpeechSynthesisUtterance: Utterance });
  vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
});
afterEach(() => vi.unstubAllGlobals());
const options = () => ({ rate: 1, voiceIdentifier: '', onPosition: vi.fn(), onEnd: vi.fn(), onError: vi.fn() });

describe('system speech cursor', () => {
  it('changing speed resumes from the latest word boundary instead of restarting the page', () => {
    const speech = new ReaderSpeech();
    speech.start('前一页的内容。当前句子的中间。下一句话。', 7, options());
    expect(utterances[0].text).toBe('当前句子的中间。');
    utterances[0].onboundary?.({ charIndex: 4 });
    speech.update(1.5, '');
    expect(utterances[1].text).toBe('的中间。'); expect(utterances[1].rate).toBe(1.5);
    // The canceled utterance must not advance the reading cursor or start another chunk.
    utterances[0].onend?.(); expect(utterances).toHaveLength(2);
  });
  it('keeps a paused cursor when the user changes rate and later resumes', () => {
    const speech = new ReaderSpeech(); const callbacks = options();
    speech.start('甲乙丙丁。', 0, callbacks);
    utterances[0].onboundary?.({ charIndex: 2 }); speech.pause(); speech.update(.8, '');
    expect(speech.paused).toBe(true); expect(utterances).toHaveLength(1);
    speech.resume(); expect(utterances[1].text).toBe('丙丁。'); expect(utterances[1].rate).toBe(.8);
  });
  it('continues across paragraphs exactly once then invokes the next-chapter callback', () => {
    const speech = new ReaderSpeech(); const callbacks = options();
    speech.start('第一段。\n第二段。', 0, callbacks);
    expect(utterances[0].text).toBe('第一段。'); utterances[0].onend?.();
    expect(utterances[1].text).toBe('第二段。'); utterances[1].onend?.();
    expect(callbacks.onEnd).toHaveBeenCalledTimes(1); expect(speech.speaking).toBe(false);
  });
  it('ignores completion of a stopped session', () => {
    const speech = new ReaderSpeech(); const callbacks = options();
    speech.start('不再播放。', 0, callbacks); speech.stop(); utterances[0].onend?.();
    expect(callbacks.onEnd).not.toHaveBeenCalled(); expect(utterances).toHaveLength(1);
  });
});
