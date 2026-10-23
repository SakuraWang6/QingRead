// Injected only before the packaged top-level document. The handshake nonce and port
// stay in this closure; neither is exposed as a web property or an iframe proxy.
export class NativeBootstrap {
  static script(metadata: string, nonce: string): string {
    return `(() => {
      if (window !== window.top || location.origin !== 'https://localhost' ||
        !['/', '/index.html'].includes(location.pathname)) return;
      const metadata = ${metadata};
      metadata.capabilities = Object.freeze(metadata.capabilities);
      Object.defineProperty(window, '__QINGREAD_HARMONY__', {
        value: Object.freeze(metadata), writable: false, configurable: false
      });
      let port;
      let resolveReady;
      const ready = new Promise(resolve => { resolveReady = resolve; });
      const pending = new Map();
      function receive(event) {
        if (typeof event.data !== 'string' || event.data.length > 140000) return;
        let response;
        try { response = JSON.parse(event.data); } catch (_) { return; }
        if (response.event === 'speech') {
          window.dispatchEvent(new CustomEvent('qingread:harmony-speech', { detail: response.detail }));
          return;
        }
        const task = pending.get(response.id);
        if (!task) return;
        pending.delete(response.id); clearTimeout(task.timer); task.resolve(event.data);
      }
      function connect(event) {
        if (event.data !== ${JSON.stringify(nonce)} || event.ports.length !== 1 || port ||
          (event.source && event.source !== window)) return;
        port = event.ports[0]; port.onmessage = receive; port.start();
        window.removeEventListener('message', connect); resolveReady();
      }
      window.addEventListener('message', connect);
      async function request(raw) {
        if (typeof raw !== 'string' || raw.length > 140000) throw new Error('请求过大');
        const value = JSON.parse(raw);
        if (!value || typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.id))
          throw new Error('请求格式不正确');
        let timeout;
        try {
          await Promise.race([ready, new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('原生连接尚未准备好，请重新打开应用')), 10000);
          })]);
        } finally { clearTimeout(timeout); }
        if (pending.size >= 16 || pending.has(value.id)) throw new Error('请求过于频繁');
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(value.id); reject(new Error('操作超时，请重试')); },
            value.method === 'export.commit' ? 300000 : value.method === 'updates.requestPermission' ? 120000 : 30000);
          pending.set(value.id, { resolve, reject, timer });
          try { port.postMessage(raw); }
          catch (_) { clearTimeout(timer); pending.delete(value.id); reject(new Error('原生连接已关闭')); }
        });
      }
      window.addEventListener('pagehide', () => {
        if (port) port.close();
        for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('页面已关闭')); }
        pending.clear();
      }, { once: true });
      Object.defineProperty(window, 'QingReadNative', {
        value: Object.freeze({ request }), writable: false, configurable: false
      });
    })();`;
  }
}
