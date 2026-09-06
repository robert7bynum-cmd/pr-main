/**
 * Push service worker.
 *
 * Deliberately minimal: it renders whatever the server sends and opens the
 * report on tap. Anything clever here fails silently on someone's phone at
 * hole 14, where nobody can debug it.
 *
 * Version marker below. A service worker is cached hard by the browser, so a
 * change here reaches an installed phone only when the file's bytes differ and
 * the worker is allowed to take over — which is what skipWaiting and
 * clients.claim at the bottom are for.
 */
const SW_VERSION = 3;

/**
 * The one thing this worker caches: a page to show when the phone has no
 * signal. Versioned by SW_VERSION so a new worker never serves the previous
 * worker's copy; activate below deletes every cache that is not this one.
 *
 * Nothing else is ever cached. Every app page carries RLS-scoped data for
 * the signed-in person, and a cached queue is a queue shown to whoever picks
 * up the phone next — and a stale one that looks current, which is worse.
 */
const OFFLINE_CACHE = `proresponse-offline-v${SW_VERSION}`;
const OFFLINE_URL = "/offline.html";

/**
 * How it should feel, by urgency.
 *
 * The first version passed no vibration pattern at all, so an alert arrived
 * silently: the banner appeared and the phone in somebody's pocket did nothing.
 * On a golf course, a notification you have to be looking at the screen to
 * notice is not a notification.
 *
 * Two short pulses for ordinary work, and a longer insistent pattern for
 * urgent — different enough to tell apart from a pocket without looking.
 * Android honours these; iOS Safari ignores vibrate entirely, which is one more
 * reason the native app is the answer there.
 */
const BUZZ = {
  urgent: [300, 120, 300, 120, 300],
  high: [200, 100, 200],
  normal: [180, 90, 180],
  low: [150],
};

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "New report", body: "Open ProResponse" };
  }

  const title = data.title || "New report";
  const urgency = data.urgency || "normal";

  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      tag: data.tag || "proresponse",
      // Urgent alerts must not be quietly collapsed into an older one.
      renotify: Boolean(data.tag),
      requireInteraction: urgency === "urgent",
      vibrate: BUZZ[urgency] || BUZZ.normal,
      // Without these the phone shows a generic browser glyph, which in a
      // notification shade full of other apps is not recognisable as the club.
      icon: "/notification-icon.png",
      badge: "/notification-badge.png",
      timestamp: Date.now(),
      // A shift is long and alerts pile up; opening the right one matters more
      // than clearing them, so give the useful action a name.
      actions: [{ action: "open", title: "Open report" }],
      data: { url: data.url || "/app" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/app";

  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      // Reuse an open tab rather than piling up new ones over a shift.
      for (const client of list) {
        if (!client.url.includes("/app")) continue;
        try {
          // navigate() rejects on some platforms for a client the worker does
          // not control. Focusing without navigating still puts the person in
          // the app, which beats doing nothing at all.
          await client.focus();
          if ("navigate" in client) await client.navigate(url);
          return;
        } catch {
          // Fall through to opening a window.
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(OFFLINE_CACHE);
      // `cache: "reload"` bypasses the HTTP cache so a redeploy's offline
      // page is the one that gets stored, not the one the browser already had.
      await cache.add(new Request(OFFLINE_URL, { cache: "reload" }));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== OFFLINE_CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

/**
 * Only navigations, and only when the network has already failed.
 *
 * A dead zone on the course used to be a blank tab with a browser error in
 * it. Now it is a page in the club's colours that says the report is not
 * lost. Every other request — data, scripts, the server action that files
 * the report — goes straight to the network untouched, so a failed submit
 * still fails loudly in the form instead of being answered from a cache.
 */
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(async () => {
      const cached = await caches.match(OFFLINE_URL, { cacheName: OFFLINE_CACHE });
      return cached || Response.error();
    }),
  );
});
