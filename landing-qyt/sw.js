var CACHE_NAME = 'qyt-v5';

var STATIC_ASSETS = [
    './css/style.css',
    './js/keyexchange.js',
    './js/app.js',
    './img/logo.png'
];

self.addEventListener('install', function (event) {
    event.waitUntil(
        caches.open(CACHE_NAME).then(function (cache) {
            return cache.addAll(STATIC_ASSETS);
        }).catch(function (e) {
            console.warn('[sw] cache.addAll failed:', e);
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', function (event) {
    event.waitUntil(
        caches.keys().then(function (names) {
            return Promise.all(
                names.filter(function (n) { return n !== CACHE_NAME; })
                    .map(function (n) { return caches.delete(n); })
            );
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', function (event) {
    if (!event.request.url.startsWith('http')) return;

    var url = new URL(event.request.url);

    if (url.origin !== self.location.origin) return;

    if (event.request.method !== 'GET') return;

    if (url.pathname === '/' || url.pathname === '/index.html') {
        event.respondWith(
            fetch(event.request).catch(function () {
                return caches.match(event.request);
            })
        );
        return;
    }

    event.respondWith(
        caches.match(event.request).then(function (cached) {
            var fetched = fetch(event.request).then(function (response) {
                if (response && response.status === 200) {
                    var cc = response.headers.get('Cache-Control');
                    if (!cc || !cc.includes('no-store')) {
                        var clone = response.clone();
                        caches.open(CACHE_NAME).then(function (cache) {
                            cache.put(event.request, clone);
                        });
                    }
                }
                return response;
            }).catch(function () {
                return cached || new Response('', { status: 404, statusText: 'Not Found' });
            });
            return cached || fetched;
        })
    );
});
