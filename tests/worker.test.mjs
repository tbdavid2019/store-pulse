import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import {
  parseGooglePlacesPayload,
  normalizeEvidence,
  evidenceId,
  detectIncentiveSignals,
} from '../src/reviews.ts';
import { StorageManager } from '../src/storage.ts';

test('parseGooglePlacesPayload - normalizes places and reviews', () => {
  const placeData = {
    place_id: 'place_123',
    name: '星巴克 台北門市',
    address: '台北市信義區',
    rating: 4.5,
    url: 'https://maps.google.com/?cid=123',
  };
  const reviewsData = [
    {
      author_name: 'Alice',
      text: '咖啡好喝，環境舒適！',
      rating: 5,
      time: Math.floor(Date.now() / 1000) - 3600,
    },
  ];

  const { place, reviews } = parseGooglePlacesPayload('place_123', placeData, reviewsData);
  assert.equal(place.place_id, 'place_123');
  assert.equal(place.name, '星巴克 台北門市');
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].author, 'Alice');
  assert.equal(reviews[0].rating, 5);
  assert.ok(reviews[0].published_at);
});

test('parseGooglePlacesPayload - throws on place_mismatch', () => {
  assert.throws(
    () => {
      parseGooglePlacesPayload('place_123', { place_id: 'different_id' }, []);
    },
    { message: 'place_mismatch' }
  );
});

test('evidenceId - generates deterministic hash', () => {
  const rev = {
    provider_review_id: 'rev_1',
    author: 'Bob',
    published_at: '2026-01-01T00:00:00Z',
    text: '普通',
  };
  const id1 = evidenceId('place_1', rev);
  const id2 = evidenceId('place_1', rev);
  assert.equal(id1, id2);
  assert.ok(id1.startsWith('ev_'));
});

test('normalizeEvidence - filters by mode and date window', () => {
  const now = new Date('2026-10-19T00:00:00Z');
  const place = {
    place_id: 'p1',
    name: 'Test Store',
    address: 'Address',
    rating: 4.0,
    source_url: 'https://maps.google.com/?cid=1',
  };

  const reviews = [
    {
      provider_review_id: 'r1',
      author: 'Recent Low',
      text: '等太久了，服務差',
      rating: 2,
      published_at: '2026-10-10T00:00:00Z', // 9 days ago
      relative_time: '1 週前',
      source_url: null,
      source_url_kind: 'branch',
    },
    {
      provider_review_id: 'r2',
      author: 'Recent High',
      text: '服務很好，推薦！',
      rating: 5,
      published_at: '2026-10-15T00:00:00Z', // 4 days ago
      relative_time: '4 天前',
      source_url: null,
      source_url_kind: 'branch',
    },
    {
      provider_review_id: 'r3',
      author: 'Old Review',
      text: '古早以前的評論',
      rating: 1,
      published_at: '2025-01-01T00:00:00Z', // > 90 days ago
      relative_time: '1 年前',
      source_url: null,
      source_url_kind: 'branch',
    },
  ];

  // Mode: recent (90 days)
  const recentNorm = normalizeEvidence(place, reviews, 'recent', 90, now);
  assert.equal(recentNorm.evidence.length, 2);
  assert.equal(recentNorm.sampling.excluded.outside_window, 1);

  // Mode: low_rating (90 days) -> only <= 3 stars
  const lowNorm = normalizeEvidence(place, reviews, 'low_rating', 90, now);
  assert.equal(lowNorm.evidence.length, 1);
  assert.equal(lowNorm.evidence[0].author, 'Recent Low');
  assert.equal(lowNorm.sampling.excluded.rating, 1);
});

test('detectIncentiveSignals - identifies marketing promotions in reviews', () => {
  const evidence = [
    { evidence_id: 'ev_1', text: '五星好評送可樂，餐點一般' },
    { evidence_id: 'ev_2', text: '打卡送小菜，環境不錯' },
    { evidence_id: 'ev_3', text: '真實顧客，牛肉麵湯頭濃郁' },
  ];
  const signals = detectIncentiveSignals(evidence);
  assert.equal(signals.length, 2);
  assert.equal(signals[0].evidence_ids[0], 'ev_1');
  assert.equal(signals[1].evidence_ids[0], 'ev_2');
});

test('StorageManager - in-memory rate limiting and daily budget', async () => {
  const storage = new StorageManager({});
  
  // Rate limit: 2 per minute
  assert.equal(await storage.allowClient('test-ip', 2), true);
  assert.equal(await storage.allowClient('test-ip', 2), true);
  assert.equal(await storage.allowClient('test-ip', 2), false);

  // Daily budget: 2 per day
  const testDate = new Date('2026-10-19T10:00:00Z');
  assert.equal(await storage.reserveDaily(2, testDate), true);
  assert.equal(await storage.reserveDaily(2, testDate), true);
  assert.equal(await storage.reserveDaily(2, testDate), false);
});

test('Worker Fetch Handler - /api/health', async () => {
  const req = new Request('http://localhost:8787/api/health');
  const res = await worker.fetch(req, {}, {});
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'ok');
  assert.equal(data.runtime, 'cloudflare-worker');
  assert.equal(data.analysis_enabled, true);
});

test('Worker Fetch Handler - CORS preflight', async () => {
  const req = new Request('http://localhost:8787/api/health', {
    method: 'OPTIONS',
    headers: { Origin: 'https://example.com' },
  });
  const res = await worker.fetch(req, {}, {});
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://example.com');
});

test('Worker Fetch Handler - /api/review-analysis validation', async () => {
  const req = new Request('http://localhost:8787/api/review-analysis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ place_id: '' }),
  });
  const res = await worker.fetch(req, {}, {});
  assert.equal(res.status, 422);
  const data = await res.json();
  assert.equal(data.status, 'invalid_request');
});

test('Worker Fetch Handler - /api/review-analysis execution and caching', async () => {
  const payload = {
    place_id: 'branch_a',
    mode: 'recent',
    window_days: 90,
    place: {
      place_id: 'branch_a',
      name: '分店 A',
      address: '台北市',
      rating: 4.2,
      url: 'https://maps.google.com/?cid=1',
    },
    reviews: [
      {
        author_name: 'Carol',
        text: '出餐速度很快，服務人員親切！五星好評送紅茶',
        rating: 5,
        time: Math.floor(Date.now() / 1000) - 86400,
      },
    ],
  };

  const req1 = new Request('http://localhost:8787/api/review-analysis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': 'client-1' },
    body: JSON.stringify(payload),
  });
  const res1 = await worker.fetch(req1, {}, {});
  assert.equal(res1.status, 200);
  const data1 = await res1.json();
  assert.equal(data1.place.place_id, 'branch_a');
  assert.equal(data1.evidence.length, 1);
  assert.equal(data1.signals.length, 1);
  assert.equal(data1.cache.hit, false);

  // Second call should hit cache
  const req2 = new Request('http://localhost:8787/api/review-analysis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': 'client-1' },
    body: JSON.stringify(payload),
  });
  const res2 = await worker.fetch(req2, {}, {});
  assert.equal(res2.status, 200);
  const data2 = await res2.json();
  assert.equal(data2.cache.hit, true);
});
