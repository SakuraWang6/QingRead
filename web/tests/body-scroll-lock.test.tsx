// @vitest-environment jsdom
import { StrictMode, act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireBodyScrollLock, useBodyScrollLock } from '../src/lib/bodyScrollLock';

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  document.body.style.removeProperty('overflow');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); document.body.style.removeProperty('overflow'); vi.unstubAllGlobals(); });
function ReaderLayer({ onStop }: { onStop: () => void }) {
  useBodyScrollLock();
  useEffect(() => onStop, [onStop]);
  return <article>阅读</article>;
}
function ReadingHost({ open, original = false, onStop }: { open: boolean; original?: boolean; onStop: () => void }) {
  useBodyScrollLock(open);
  return open ? original ? <article>EPUB 原版</article> : <ReaderLayer onStop={onStop}/> : <section>设置</section>;
}

describe('shared reader body scroll ownership', () => {
  it('restores scrolling after child-reader cleanup followed by the parent reading-state cleanup', async () => {
    const stop = vi.fn();
    await act(async () => root.render(<ReadingHost open={false} onStop={stop}/>));
    await act(async () => root.render(<ReadingHost open onStop={stop}/>));
    expect(document.body.style.overflow).toBe('hidden');
    await act(async () => root.render(<ReadingHost open={false} onStop={stop}/>));
    expect(host.textContent).toBe('设置'); expect(document.body.style.overflow).toBe(''); expect(stop).toHaveBeenCalledOnce();
  });
  it('survives StrictMode effect replay and repeated text/original-reader transitions', async () => {
    const stop = vi.fn(); document.body.style.overflow = 'auto';
    for (let cycle = 0; cycle < 3; cycle++) {
      await act(async () => root.render(<StrictMode><ReadingHost open onStop={stop}/></StrictMode>));
      expect(document.body.style.overflow).toBe('hidden');
      await act(async () => root.render(<StrictMode><ReadingHost open original onStop={stop}/></StrictMode>));
      expect(document.body.style.overflow).toBe('hidden');
      await act(async () => root.render(<StrictMode><ReadingHost open={false} onStop={stop}/></StrictMode>));
      expect(document.body.style.overflow).toBe('auto');
    }
    expect(stop).toHaveBeenCalled();
  });
  it('keeps every remaining owner locked for all three-owner release orders and ignores duplicate releases', () => {
    for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
      const body = document.createElement('body'); body.style.setProperty('overflow', 'scroll', 'important');
      const release = [acquireBodyScrollLock(body), acquireBodyScrollLock(body), acquireBodyScrollLock(body)];
      for (let index = 0; index < order.length; index++) {
        release[order[index]](); release[order[index]]();
        expect(body.style.overflow).toBe(index === 2 ? 'scroll' : 'hidden');
      }
      expect(body.style.getPropertyPriority('overflow')).toBe('important');
      const next = acquireBodyScrollLock(body); next(); expect(body.style.overflow).toBe('scroll');
    }
  });
  it('does not let releasing an old token unlock a later reading session', () => {
    const body = document.createElement('body'), old = acquireBodyScrollLock(body); old();
    const current = acquireBodyScrollLock(body); old(); expect(body.style.overflow).toBe('hidden');
    current(); expect(body.style.overflow).toBe('');
  });
  it('releases both nested owners when the entire app unmounts, then permits a clean remount', async () => {
    const stop = vi.fn();
    await act(async () => root.render(<ReadingHost open onStop={stop}/>));
    await act(async () => root.unmount());
    expect(document.body.style.overflow).toBe('');
    root = createRoot(host); await act(async () => root.render(<ReadingHost open onStop={stop}/>));
    expect(document.body.style.overflow).toBe('hidden');
    await act(async () => root.render(<ReadingHost open={false} onStop={stop}/>)); expect(document.body.style.overflow).toBe('');
  });
});
