// Push notifications, loaded into the generated service worker (vite.config.ts).
self.addEventListener("push", (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = { body: event.data && event.data.text() };
  }
  event.waitUntil(
    self.registration.showNotification(d.title || "סל זול", {
      body: d.body,
      tag: d.tag,
      icon: "icon-192.png",
      badge: "icon-192.png",
      dir: "rtl",
      lang: "he",
      data: { url: d.url || "./" },
    }),
  );
});

// a tap opens the app (or brings it forward) at the price drops
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "./", self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.startsWith(self.registration.scope)) return w.navigate(url).then((c) => (c || w).focus());
      }
      return self.clients.openWindow(url);
    }),
  );
});
