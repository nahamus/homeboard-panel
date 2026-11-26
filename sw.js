// HomeBoard Control service worker: makes the panel installable and quick to open.
//
// - The page itself (navigations) and its script (app.js): network first, so a published update
//   shows up right away and the page never runs with an older script; the cached copies are only
//   used when offline.
// - Same-origin static files (icons, manifest, images/ui art): served from cache, refreshed
//   in the background (stale-while-revalidate).
// - Everything cross-origin (GitHub API with your token, weather, news, Wikipedia, markets)
//   is never touched or cached here.
const CACHE = "homeboard-panel-v2";
const SHELL = ["./", "app.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  const isScript = url.pathname.endsWith("/app.js");
  if (req.mode === "navigate" || isScript) {
    const key = isScript ? "app.js" : "./";
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
          return res;
        })
        .catch(() => caches.match(key)),
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE).then(async (c) => {
      const cached = await c.match(req);
      const fresh = fetch(req)
        .then((res) => { if (res.ok) c.put(req, res.clone()); return res; })
        .catch(() => cached);
      return cached || fresh;
    }),
  );
});
