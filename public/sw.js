/**
 * Push service worker.
 *
 * Deliberately minimal: it renders whatever the server sends and opens the
 * report on tap. Anything clever here fails silently on someone's phone at
 * hole 14, where nobody can debug it.
 */
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "New report", body: "Open ProResponse" };
  }

  const title = data.title || "New report";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      tag: data.tag || "proresponse",
      // Urgent alerts must not be quietly collapsed into an older one.
      renotify: Boolean(data.tag),
      requireInteraction: data.urgency === "urgent",
      data: { url: data.url || "/app" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/app";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      // Reuse an open tab rather than piling up new ones over a shift.
      for (const client of list) {
        if (client.url.includes("/app") && "focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
