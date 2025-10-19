const CACHE_NAME = 'store-pulse-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/style.css',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png'
];

// 安裝 Service Worker
self.addEventListener('install', event => {
  console.log('Service Worker 正在安裝...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('快取已開啟');
        return cache.addAll(urlsToCache);
      })
      .catch(err => {
        console.error('快取安裝失敗:', err);
      })
  );
});

// 攔截網路請求
self.addEventListener('fetch', event => {
  // 只快取同源請求，避免快取 Google Maps API
  if (event.request.url.startsWith(self.location.origin)) {
    event.respondWith(
      caches.match(event.request)
        .then(response => {
          // 如果在快取中找到，則返回快取版本
          if (response) {
            return response;
          }
          // 否則從網路取得
          return fetch(event.request);
        })
        .catch(err => {
          console.error('Service Worker fetch 錯誤:', err);
          return fetch(event.request);
        })
    );
  }
});

// 清理舊快取
self.addEventListener('activate', event => {
  console.log('Service Worker 已激活');
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
    })
  );
});