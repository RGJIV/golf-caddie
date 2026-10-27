/* Offline: keep the whole app and course on the phone. Bump VERSION when any file changes. */
const VERSION = "caddie-2026-10-27f";
const FILES = ["./", "index.html", "css/app.css", "js/geo.js", "js/engine.js", "js/aim.js", "js/app.js", "vendor/three.min.js",
  "manifest.webmanifest", "icons/icon-180.png", "icons/icon-512.png",
  "data/course.json", "data/height.png", "data/canopy.png", "data/water.png", "data/aerial.jpg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;           // weather: network only
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
