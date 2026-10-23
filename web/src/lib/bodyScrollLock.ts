import { useEffect } from 'react';

interface ScrollLock { tokens: Set<symbol>; overflow: string; priority: string }
const locks = new WeakMap<HTMLElement, ScrollLock>();

/** Nested readers and their parent modal may release in either order. */
export function acquireBodyScrollLock(body: HTMLElement): () => void {
  let lock = locks.get(body);
  if (!lock) {
    lock = { tokens: new Set(), overflow: body.style.getPropertyValue('overflow'), priority: body.style.getPropertyPriority('overflow') };
    locks.set(body, lock);
    body.style.setProperty('overflow', 'hidden', lock.priority);
  }
  const token = Symbol('body-scroll-lock');
  lock.tokens.add(token);
  return () => {
    if (!lock.tokens.delete(token) || lock.tokens.size) return;
    if (lock.overflow) body.style.setProperty('overflow', lock.overflow, lock.priority);
    else body.style.removeProperty('overflow');
    locks.delete(body);
  };
}

export function useBodyScrollLock(enabled = true): void {
  useEffect(() => {
    if (!enabled || typeof document === 'undefined' || !document.body) return;
    return acquireBodyScrollLock(document.body);
  }, [enabled]);
}
