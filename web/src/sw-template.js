// Relayium service worker — hand-written, no Workbox. The build plugin
// (vite-plugin-pwa.ts) string-replaces the __PLACEHOLDERS__ with the real
// precache list, a content-derived version, and the share-target route, then
// emits the result as /sw.js. This file is never bundled or imported directly.
/* eslint-disable */
const VERSION = "__VERSION__";
const CACHE = "relayium-shell-" + VERSION;
const PRECACHE = __PRECACHE__; // JSON array of shell URLs
const SHARE_ROUTE = "__SHARE_ROUTE__"; // e.g. "/share-target"
const SHARE_CACHE = "relayium-share";

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("relayium-shell-") && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Inbound Web Share Target: stash the shared files, hand off to the app.
  if (req.method === "POST" && url.pathname === SHARE_ROUTE) {
    e.respondWith(handleShare(req));
    return;
  }
  if (req.method !== "GET") return; // never intercept other writes

  if (req.mode === "navigate") {
    // Network-first: fresh HTML when online, the cached shell when offline so
    // the app still opens instantly (signalling/transfer then need the network).
    e.respondWith(fetch(req).catch(() => caches.match("/")));
    return;
  }

  if (url.origin === self.location.origin) {
    // Cache-first for our own hashed, immutable assets.
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
  }
});

// Read the shared files out of the multipart POST, park them in a dedicated
// cache keyed by a one-off token, then redirect the launch to the app, which
// drains them back into File objects. A cache (not postMessage) is used because
// at share time the app may not have an open client yet.
async function handleShare(req) {
  try {
    const form = await req.formData();
    const files = form.getAll("files").filter((f) => f instanceof File);
    const token = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    const cache = await caches.open(SHARE_CACHE);
    const base = "/__shared__/" + token + "/";
    await cache.put(base + "count", new Response(String(files.length)));
    for (let i = 0; i < files.length; i++) {
      await cache.put(
        base + i,
        new Response(files[i], {
          headers: {
            "content-type": files[i].type || "application/octet-stream",
            // Header values must be ASCII; percent-encode to survive non-Latin names.
            "x-name": encodeURIComponent(files[i].name),
          },
        }),
      );
    }
    return Response.redirect("/?share-target=" + token, 303);
  } catch {
    return Response.redirect("/", 303);
  }
}
