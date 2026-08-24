// Service worker for the Auto 1 Oil Dispatch PWA.
//
// Today this exists so the app is installable to a phone's home screen and
// so the unread-count badge (navigator.setAppBadge) works on the installed
// icon. We intentionally don't cache anything — every request goes to the
// network so admins always see fresh data.
//
// Down the road this is also where Web Push handlers ('push' event) go
// when we wire up real push notifications.

self.addEventListener('install', () => {
  // Activate immediately so the new SW takes over without a tab refresh.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Pass-through fetch handler — required for the browser to consider this
// SW a real PWA SW (some browsers won't show the "Add to home screen"
// prompt without a fetch listener).
self.addEventListener('fetch', () => {
  // Intentionally empty — let the browser default fetch happen.
});

// Web Push: show the banner notification across the top of the screen.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Auto 1 Oil', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Auto 1 Oil';
  const options = {
    body: data.body || '',
    icon: '/brand/auto1-circle.png',
    badge: '/brand/auto1-circle.png',
    tag: data.tag || undefined,
    // Honor the recipient's per-account alert mode. `silent` suppresses sound;
    // `vibrate` adds a buzz pattern. (iOS web push ignores both, so it degrades
    // gracefully to its default banner there.)
    silent: data.silent === true,
    vibrate: data.vibrate === true ? [200, 100, 200] : undefined,
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Focus an existing tab (or open one) when the notification is tapped.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    }),
  );
});
