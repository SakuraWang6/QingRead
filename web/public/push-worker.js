// Imported by the QingRead worker for this PWA's own root or /qingread/ scope.
// Notifications deliberately contain no book title, account ID, source or URL.
self.addEventListener('push', event => {
  event.waitUntil(self.registration.showNotification('清读', {
    body: '书架有新章节，打开查看。', tag: 'qingread-updates',
    icon: new URL('apple-touch-icon.png', self.registration.scope).href,
    badge: new URL('icon.svg', self.registration.scope).href,
    data: { scope: self.registration.scope },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = self.registration.scope;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => client.url.startsWith(target));
    if (existing) { await existing.focus(); return; }
    await self.clients.openWindow(target);
  })());
});
