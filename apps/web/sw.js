// Offline shell: the app's own files are cached so it opens without network.
// API calls are never cached (they carry private, encrypted-at-rest data).
const CACHE = "biruni-shell-v6";
const SHELL = ["./", "index.html", "styles.css", "app.js", "manifest.webmanifest", "vendor/maplibre-gl.js", "legal.html", "modules/securelocal.js", "modules/legal.js", "modules/sos.js", "modules/people.js", "modules/battery.js", "modules/fall.js", "modules/format.js", "modules/permissions.js", "modules/image.js", "modules/effects.js", "modules/style.js", "modules/falldetect.js", "vendor/maplibre-gl.css", "icons/icon-192.png", "icons/icon-512.png", "icons/favicon-32.png"];

self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // Network first (fresh code after updates), cache when offline.
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok) {
          const copy = r.clone(); // clone now, before the page consumes the body
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return r;
      })
      .catch(() => caches.match(e.request).then((m) => m ?? caches.match("index.html"))),
  );
});

// Tapping an SOS notification opens (or focuses) Biruni.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => (cs.find((c) => "focus" in c)?.focus() ?? self.clients.openWindow("./"))));
});
