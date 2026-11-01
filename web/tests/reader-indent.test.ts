// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { measureReaderIndent, observeReaderIndent } from '../src/lib/readerIndent';

let probe: HTMLSpanElement, width: number, fonts: EventTarget & { ready: Promise<unknown> };
let fontDescriptor: PropertyDescriptor | undefined;
let observers: { callback: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[];
const disposers: (() => void)[] = [];
function observe(changed: (value: number | undefined) => void) {
  const dispose = observeReaderIndent(probe, changed); disposers.push(dispose); return dispose;
}
beforeEach(() => {
  width = 42.375; observers = [];
  probe = document.createElement('span'); probe.textContent = '水水'; document.body.append(probe);
  vi.spyOn(probe, 'getBoundingClientRect').mockImplementation(() => ({ width } as DOMRect));
  fontDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
  fonts = Object.assign(new EventTarget(), { ready: Promise.resolve() });
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn(); disconnect = vi.fn();
    constructor(public callback: () => void) { observers.push(this); }
  });
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  probe.remove();
  if (fontDescriptor) Object.defineProperty(document, 'fonts', fontDescriptor); else Reflect.deleteProperty(document, 'fonts');
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('actual reader two-glyph indent measurement', () => {
  it('uses fractional rendered glyph advances rather than the specified font size', () => {
    probe.style.fontSize = '26px';
    expect(measureReaderIndent(probe)).toBe(42.375);
    expect(probe.textContent).toBe('水水');
  });
  it('falls back safely when layout is absent, invalid or throws', () => {
    for (const value of [0, -1, NaN, Infinity]) { width = value; expect(measureReaderIndent(probe)).toBeUndefined(); }
    vi.mocked(probe.getBoundingClientRect).mockImplementation(() => { throw new Error('detached layout'); });
    expect(measureReaderIndent(probe)).toBeUndefined();
  });
  it('synchronously publishes once, then tracks native/font resizing without duplicate state changes', async () => {
    const changed = vi.fn(); observe(changed);
    expect(changed.mock.calls).toEqual([[42.375]]);
    expect(observers[0].observe).toHaveBeenCalledWith(probe);
    await fonts.ready; observers[0].callback();
    expect(changed).toHaveBeenCalledTimes(1);
    width = 34.234375; observers[0].callback();
    expect(changed).toHaveBeenLastCalledWith(34.234375);
    width += 0.0001; observers[0].callback(); expect(changed).toHaveBeenCalledTimes(2);
    width = 55.234375; fonts.dispatchEvent(new Event('loadingdone'));
    expect(changed).toHaveBeenLastCalledWith(55.234375);
    width = 0; fonts.dispatchEvent(new Event('loadingerror')); expect(changed).toHaveBeenLastCalledWith(undefined);
  });
  it('removes all observers/listeners and ignores late font completion after unmount', async () => {
    let ready!: () => void; fonts.ready = new Promise<void>(resolve => { ready = resolve; });
    const removed = vi.spyOn(fonts, 'removeEventListener'), changed = vi.fn(), dispose = observe(changed);
    dispose(); dispose(); width = 99;
    observers[0].callback(); fonts.dispatchEvent(new Event('loadingdone')); window.dispatchEvent(new Event('resize'));
    ready(); await fonts.ready; await Promise.resolve();
    expect(changed.mock.calls).toEqual([[42.375]]);
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledWith('loadingdone', expect.any(Function));
    expect(removed).toHaveBeenCalledWith('loadingerror', expect.any(Function));
    expect(probe.parentElement).toBe(document.body); // React, not the helper, owns this node.
    expect(probe.childNodes).toHaveLength(1);
  });
  it('keeps font and resize fallbacks when ResizeObserver cannot attach', async () => {
    vi.stubGlobal('ResizeObserver', class { constructor() { throw new Error('unavailable'); } });
    const changed = vi.fn(); observe(changed); await fonts.ready;
    width = 30; window.dispatchEvent(new Event('resize')); expect(changed).toHaveBeenLastCalledWith(30);
    width = 44; fonts.dispatchEvent(new Event('loadingdone')); expect(changed).toHaveBeenLastCalledWith(44);
  });
  it('finishes listener cleanup even if the observer fails during disconnect', () => {
    const changed = vi.fn(), dispose = observe(changed);
    observers[0].disconnect.mockImplementation(() => { throw new Error('observer gone'); });
    expect(dispose).not.toThrow(); width = 99;
    fonts.dispatchEvent(new Event('loadingdone')); window.dispatchEvent(new Event('resize'));
    expect(changed.mock.calls).toEqual([[42.375]]);
  });
});
