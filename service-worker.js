const CACHE_NAME = "techlib-v1";

const FILES_TO_CACHE = [
  "/",
  "/index.html",
  "/styles.css",
  "/script.js",
  "/manifest.json",
  "/assets/icon-192.png",
  "/assets/icon-512.png"
];


// Instala o Service Worker
self.addEventListener("install", (event) => {

  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {

        return cache.addAll(FILES_TO_CACHE);

      })
  );

  self.skipWaiting();

});


// Ativa o Service Worker
self.addEventListener("activate", (event) => {

  event.waitUntil(

    self.clients.claim()

  );

});


// Intercepta requisições
self.addEventListener("fetch", (event) => {

  event.respondWith(

    caches.match(event.request)
      .then((cachedResponse) => {

        return cachedResponse || fetch(event.request);

      })

  );

});
