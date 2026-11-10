'use strict';

/* ============================================================
   Service Worker: офлайн-кэш сайта.
   Страницы отдаём по принципу «сначала сеть» — так обновления
   кода подхватываются сразу. Статику — из кэша с фоновым
   обновлением.
   ============================================================ */

const CACHE = 'loviritm-v23';
const ASSETS = [
  '/',
  '/records.html',
  '/manifest.json',
  '/scores.json',
  '/static/css/app.css',
  '/static/js/site.js',
  '/static/js/voice-gate.js',
  '/static/js/mic.js',
  '/static/js/test.js',
  '/static/img/favicon.svg',
  '/static/img/note.svg',
  '/static/img/staff.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Кладём по одному: если один файл временно недоступен,
    // остальные всё равно попадут в офлайн-кэш.
    await Promise.all(
      ASSETS.map((url) => cache.add(url).catch(() => undefined))
    );
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // API-запросы не кэшируем: сайт сам решает, к серверу или в localStorage.
  if (req.url.includes('/api/')) return;

  // Страницы: сеть → кэш.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('/')))
    );
    return;
  }

  // Статика: кэш → сеть, с обновлением копии в фоне.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);

      return cached || network;
    })
  );
});
