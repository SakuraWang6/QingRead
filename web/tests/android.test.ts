import { describe, expect, it, vi } from 'vitest';
import { androidServerIssue, BackHandlerStack } from '../src/lib/android';

describe('Android server selection', () => {
  it('requires a remote HTTPS server rather than the bundled localhost asset origin', () => {
    expect(androidServerIssue('')).toContain('服务器地址');
    expect(androidServerIssue('http://read.example.com')).toContain('HTTPS');
    expect(androidServerIssue('https://localhost/api')).toContain('手机本机');
    expect(androidServerIssue('https://127.0.0.1')).toContain('手机本机');
    expect(androidServerIssue('https://[::1]/api')).toContain('手机本机');
    expect(androidServerIssue('https://user:secret@read.example.com')).toContain('不能包含');
    expect(androidServerIssue('https://read.example.com/api')).toBeUndefined();
  });
});

describe('Android hardware back hierarchy', () => {
  it('dismisses the reader layer before detail, settings and the root tab', () => {
    const stack = new BackHandlerStack(); const calls: string[] = [];
    stack.add(() => { calls.push('root'); return true; }, 0);
    const removeSettings = stack.add(() => { calls.push('settings'); return true; }, 100);
    const removeDetail = stack.add(() => { calls.push('detail'); return true; }, 200);
    const removeReader = stack.add(() => { calls.push('reader'); return true; }, 300);
    stack.dispatch(); removeReader(); stack.dispatch(); removeDetail(); stack.dispatch(); removeSettings(); stack.dispatch();
    expect(calls).toEqual(['reader', 'detail', 'settings', 'root']);
  });
  it('allows inactive inner panels to fall through and removes StrictMode registrations', () => {
    const stack = new BackHandlerStack(); const closed = vi.fn(() => false), root = vi.fn(() => true);
    const unmount = stack.add(root); stack.add(closed, 100);
    expect(stack.dispatch()).toBe(true); expect(root).toHaveBeenCalledOnce();
    unmount(); expect(stack.dispatch()).toBe(false);
  });
});
