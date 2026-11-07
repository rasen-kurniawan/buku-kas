/*
 * sw.js â€” service worker: menyimpan file aplikasi supaya bisa dibuka tanpa internet.
 * Data keuangan TIDAK disimpan di sini (ada di IndexedDB). Panggilan ke Google tidak pernah di-cache.
 *
 * Saat merilis perubahan kode, naikkan VERSION supaya perangkat mengambil versi baru.
 */
const VERSION = 'bukukas-v2';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './js/config.js',
  './js/store.js',
  './js/backend.js',
  './js/auth.js',
  './js/drive.js',
  './js/sync.js',
  './js/app-shell.js',
  './vendor/chart.umd.min.js',
  './vendor/chartjs-plugin-datalabels.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION && key !== 'bukukas-fonts') await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Font Google: simpan setelah pertama kali diunduh.
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(caches.open('bukukas-fonts').then(async cache => {
      const hit = await cache.match(req);
      if (hit) return hit;
      try { const res = await fetch(req); if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; }
      catch (e) { return new Response('', { status: 504 }); }
    }));
    return;
  }

  // Selain file aplikasi sendiri (mis. Google login/Drive), biarkan lewat tanpa cache.
  if (url.origin !== self.location.origin) return;

  // File aplikasi: pakai cache dulu supaya cepat & bisa offline, perbarui diam-diam di belakang.
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const isPage = req.mode === 'navigate';
    const hit = await cache.match(isPage ? './index.html' : req, { ignoreSearch: isPage });
    const update = fetch(req).then(res => {
      if (res.ok) cache.put(isPage ? './index.html' : req, res.clone());
      return res;
    }).catch(() => null);
    if (hit) { event.waitUntil(update); return hit; }
    const res = await update;
    return res || new Response('Offline dan file belum tersimpan.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  })());
});
