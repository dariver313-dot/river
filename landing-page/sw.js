var CACHE_NAME = 'landing-v9';

var STATIC_ASSETS = [
    './css/style.css',
    './js/keyexchange.js',
    './js/app.js',
    './img/bg.webp',
    './img/amylc-logo.webp',
    './img/amylc-logo.png',
    './img/a-xiazai2.webp',
    './img/kefu.webp',
    './img/11.png',
    './img/22.png',
    './img/33.png',
    './img/click.svg',
    './img/return.png',
    './img/tutorialnew.png'
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

    if (url.pathname.endsWith('.webp') || url.pathname.endsWith('.png') || url.pathname.endsWith('.jpg')) {
        event.respondWith(
            caches.match(event.request).then(function (cached) {
                if (cached) return cached;
                return fetch(event.request).then(function (response) {
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
                    return new Response('', { status: 404, statusText: 'Not Found' });
                });
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
