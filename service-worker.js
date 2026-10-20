const CACHE_NAME = 'store-pulse-v6';
const urlsToCache = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
  '/icons/og-image.png'
];

// 安裝 Service Worker
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
      .catch(err => {
        console.error('快取安裝失敗:', err);
      })
  );
});

// 清理舊快取並立即接管頁面
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('正在刪除舊快取:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 攔截網路請求：HTML 導航採 Network-First，避免使用者卡在舊快取
self.addEventListener('fetch', event => {
  const isSameOrigin = event.request.url.startsWith(self.location.origin);
  const isApi = new URL(event.request.url).pathname.startsWith('/api/');
  
  if (event.request.method === 'GET' && isSameOrigin && !isApi) {
    const url = new URL(event.request.url);
    const isNavigationOrHtml = event.request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html';

    if (isNavigationOrHtml) {
      // Network-First：優先從網路取得最新 HTML，若離線才使用快取（支援帶參忽略與 SPA 首頁回退）
      event.respondWith(
        fetch(event.request)
          .then(networkResponse => {
            if (networkResponse && networkResponse.status === 200) {
              const responseClone = networkResponse.clone();
              caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
            }
            return networkResponse;
          })
          .catch(() =>
            caches.match(event.request, { ignoreSearch: true })
              .then(res => res || caches.match('/index.html') || caches.match('/'))
          )
      );
      return;
    }

    // 靜態資源：Cache-First with Network Fallback
    event.respondWith(
      caches.match(event.request, { ignoreSearch: true }).then(response => {
        return response || fetch(event.request);
      })
    );
  }
});
