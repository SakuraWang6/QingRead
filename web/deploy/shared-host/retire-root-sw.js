// Serve only at the previous QingRead /sw.js URL during a root-to-subpath move.
// Keep IndexedDB, localStorage and offline books; retire only this registration.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await self.registration.unregister();
    const windows = await self.clients.matchAll({ type: 'window' });
    await Promise.all(windows.map(client => {
      const url = new URL(client.url);
      return url.pathname === '/' || url.pathname === '/index.html'
        ? client.navigate(client.url)
        : undefined;
    }));
  })());
});
