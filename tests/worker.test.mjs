import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { parseModelObservations, summarize } from '../src/analysis.ts';
import {
  parseGooglePlacesPayload,
  normalizeEvidence,
  evidenceId,
  detectIncentiveSignals,
} from '../src/reviews.ts';
import { StorageManager, _resetStorageMemoryForTest } from '../src/storage.ts';
import {
  validateSerpApiKey,
  fetchSerpApiReviews,
  curateSerpApiReviews,
} from '../src/serpapi.ts';

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
  _resetStorageMemoryForTest();
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

test('StorageManager - KV-backed distributed rate limiting and daily budget across instances and restarts', async () => {
  _resetStorageMemoryForTest();
  const kvData = new Map();
  const mockKV = {
    async get(key, type) {
      const val = kvData.get(key);
      if (val === undefined) return null;
      if (type === 'json') return JSON.parse(val);
      return val;
    },
    async put(key, val) {
      kvData.set(key, String(val));
    },
  };

  // Simulate Instance 1 (e.g. Taipei Colo)
  const instance1 = new StorageManager({ STORE_PULSE_KV: mockKV });
  // Simulate Instance 2 (e.g. Tokyo Colo - different isolate memory)
  const instance2 = new StorageManager({ STORE_PULSE_KV: mockKV });

  // Rate limiting across instances: limit 2 per minute for 'shared-client-ip'
  assert.equal(await instance1.allowClient('shared-client-ip', 2), true);
  assert.equal(await instance2.allowClient('shared-client-ip', 2), true);
  // 3rd call from either instance should be blocked by KV distributed count!
  assert.equal(await instance1.allowClient('shared-client-ip', 2), false);
  assert.equal(await instance2.allowClient('shared-client-ip', 2), false);

  // Daily budget across instances and restart simulation: limit 2 per day
  const testDate = new Date('2026-10-21T10:00:00Z');
  assert.equal(await instance1.reserveDaily(2, testDate), true);
  assert.equal(await instance2.reserveDaily(2, testDate), true);

  // Reset memory to simulate isolate restart / new isolate
  _resetStorageMemoryForTest();
  const newInstanceAfterRestart = new StorageManager({ STORE_PULSE_KV: mockKV });
  // Fresh isolate sees KV count is already 2, so cannot bypass budget!
  assert.equal(await newInstanceAfterRestart.reserveDaily(2, testDate), false);

  // Cache test across instances
  await instance1.put('test-cache-key', { foo: 'bar' }, 60);
  _resetStorageMemoryForTest(); // clear memory cache
  const cachedFromNewInstance = await newInstanceAfterRestart.get('test-cache-key');
  assert.ok(cachedFromNewInstance);
  assert.equal(cachedFromNewInstance.foo, 'bar');
  assert.equal(cachedFromNewInstance.cache.hit, true);
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

test('parseModelObservations - parses valid observations and filters invalid categories or unknown evidence', () => {
  const evidence = [{ evidence_id: 'ev_123', text: '服務很好' }];
  const raw = {
    observations: [
      { category: 'service', finding: '服務態度良好', evidence_ids: ['ev_123'], suggested_action: '保持' },
      { category: 'unknown_cat', finding: '無效分類', evidence_ids: ['ev_123'] },
      { category: 'price', finding: '無效證據ID', evidence_ids: ['ev_999'] },
    ],
  };
  const result = parseModelObservations(raw, evidence, 'gemini-3.8-flash');
  assert.equal(result.summary.observations.length, 1);
  assert.equal(result.summary.observations[0].category, 'service');
  assert.equal(result.summary.observations[0].finding, '服務態度良好');
});

test('summarize - handles native env.AI binding', async () => {
  const mockAI = {
    async run(model, payload) {
      assert.equal(model, '@cf/openai/gpt-oss-20b');
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                observations: [
                  { category: 'service', finding: '店員親切熱情', evidence_ids: ['ev_1'] },
                ],
              }),
            },
          },
        ],
      };
    },
  };

  const evidence = [{ evidence_id: 'ev_1', text: '服務很好', author: 'Test' }];
  const res = await summarize(evidence, { AI: mockAI });
  assert.ok(res.summary);
  assert.equal(res.summary.observations.length, 1);
  assert.equal(res.summary.observations[0].category, 'service');
  assert.equal(res.usage.model, '@cf/openai/gpt-oss-20b');
});

test('summarize - handles direct Cloudflare REST API fallback when env.AI is unavailable', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.ok(url.includes('/accounts/379570860738dd1757ba7f67ef2bdffe/ai/run/'));
      assert.equal(init.headers['Authorization'], 'Bearer cf_test_token');
      return new Response(JSON.stringify({
        result: {
          response: JSON.stringify({
            observations: [
              { category: 'product_quality', finding: '咖啡品質極佳', evidence_ids: ['ev_2'] },
            ],
          }),
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const evidence = [{ evidence_id: 'ev_2', text: '咖啡濃郁香醇', author: 'Tester' }];
    const res = await summarize(evidence, {
      CLOUDFLARE_ACCOUNT_ID: '379570860738dd1757ba7f67ef2bdffe',
      CLOUDFLARE_API_TOKEN: 'cf_test_token',
    });

    assert.ok(res.summary);
    assert.equal(res.summary.observations.length, 1);
    assert.equal(res.summary.observations[0].category, 'product_quality');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('validateSerpApiKey - validates key with SerpApi account endpoint', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (url.includes('api_key=valid_key')) {
        return new Response(JSON.stringify({
          total_searches_left: 245,
          this_month_usage: 5,
          account_email: 'tester@example.com',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        error: 'Invalid API key.',
      }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    };

    const validRes = await validateSerpApiKey('valid_key');
    assert.equal(validRes.valid, true);
    assert.equal(validRes.total_searches_left, 245);
    assert.equal(validRes.account_email, 'tester@example.com');

    const invalidRes = await validateSerpApiKey('bad_key');
    assert.equal(invalidRes.valid, false);
    assert.ok(invalidRes.error);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('curateSerpApiReviews - prioritizes Local Guides and critical reviews in 4 tiers', () => {
  const place = {
    place_id: 'place_test',
    name: '測試餐廳',
    address: '台北市',
    rating: 4.0,
    source_url: 'https://maps.google.com/?cid=1',
  };

  const rawReviews = [
    {
      author: 'Normal Person',
      user: { name: 'Normal Person', local_guide: false },
      rating: 5,
      snippet: '普通的好評，餐點不錯',
      iso_date: '2026-10-10T00:00:00Z',
      likes: 0,
    },
    {
      author: 'Angry Guy',
      user: { name: 'Angry Guy', local_guide: false },
      rating: 1,
      snippet: '等太久了，肉質柴又冷，極度不推！',
      iso_date: '2026-10-12T00:00:00Z',
      likes: 1,
    },
    {
      author: 'Elite Guide',
      user: { name: 'Elite Guide', local_guide: true },
      rating: 4,
      snippet: '在地嚮導探店：招牌牛肉麵湯頭濃郁，建議避開中午人潮',
      iso_date: '2026-10-14T00:00:00Z',
      likes: 8,
    },
    {
      author: 'Popular Reviewer',
      user: { name: 'Popular Reviewer', local_guide: false },
      rating: 5,
      snippet: '超多人按讚的美味心得',
      iso_date: '2026-10-15T00:00:00Z',
      likes: 15,
    },
  ];

  const curated = curateSerpApiReviews(rawReviews, place, 'recent', 90, {
    nowDate: new Date('2026-10-20T00:00:00Z'),
  });

  assert.equal(curated.evidence.length, 4);
  // Tier 1 should be Local Guide
  assert.ok(curated.evidence[0].author.includes('Elite Guide'));
  assert.ok(curated.evidence[0].author.includes('[在地嚮導]'));
  // Tier 2 should be critical rating <= 3
  assert.ok(curated.evidence[1].author.includes('Angry Guy'));
  // Tier 3 should be liked
  assert.ok(curated.evidence[2].author.includes('Popular Reviewer'));
  // Tier 4 should be normal
  assert.ok(curated.evidence[3].author.includes('Normal Person'));
});

test('Worker Fetch Handler - /api/serpapi-account validation endpoint', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (url.includes('api_key=my_serp_key')) {
        return new Response(JSON.stringify({
          total_searches_left: 200,
          this_month_usage: 50,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'Invalid API key.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const reqValid = new Request('http://localhost:8787/api/serpapi-account', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SerpApi-Key': 'my_serp_key',
      },
    });
    const resValid = await worker.fetch(reqValid, {}, {});
    assert.equal(resValid.status, 200);
    const dataValid = await resValid.json();
    assert.equal(dataValid.valid, true);
    assert.equal(dataValid.total_searches_left, 200);

    const reqInvalid = new Request('http://localhost:8787/api/serpapi-account', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SerpApi-Key': 'invalid_key',
      },
    });
    const resInvalid = await worker.fetch(reqInvalid, {}, {});
    assert.equal(resInvalid.status, 400);
    const dataInvalid = await resInvalid.json();
    assert.equal(dataInvalid.valid, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker Fetch Handler - /api/review-analysis with BYOK X-SerpApi-Key', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (url.includes('engine=google_maps_reviews')) {
        return new Response(JSON.stringify({
          reviews: [
            {
              author: 'Serp User 1',
              user: { name: 'Serp User 1', local_guide: true },
              rating: 5,
              snippet: '這是在地嚮導透過 SerpApi 抓取的評論',
              iso_date: '2026-10-18T00:00:00Z',
            },
            {
              author: 'Serp User 2',
              user: { name: 'Serp User 2', local_guide: false },
              rating: 2,
              snippet: '等太久了很不滿意',
              iso_date: '2026-10-19T00:00:00Z',
            },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const mockEnv = {
      AI: {
        async run() {
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  observations: [
                    { category: 'service', finding: '等候時間過長', evidence_ids: [] },
                  ],
                }),
              },
            }],
          };
        },
      },
    };

    const payload = {
      place_id: 'branch_byok',
      mode: 'recent',
      window_days: 90,
      place: {
        place_id: 'branch_byok',
        name: 'BYOK 測試門市',
        address: '台北市信義區',
        rating: 4.3,
        url: 'https://maps.google.com/?cid=byok',
      },
      reviews: [
        {
          author_name: 'Places Fallback',
          text: '原本 Places 的備援評論',
          rating: 4,
          time: Math.floor(Date.now() / 1000) - 3600,
        },
      ],
    };

    const req = new Request('http://localhost:8787/api/review-analysis', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SerpApi-Key': 'valid_byok_serp_key',
        'cf-connecting-ip': 'client-byok-test',
      },
      body: JSON.stringify(payload),
    });

    const res = await worker.fetch(req, mockEnv, {});
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.usage.review_source, 'serpapi');
    assert.equal(data.evidence.length, 2);
    assert.ok(data.evidence[0].author.includes('Serp User 1'));
    assert.ok(data.evidence[0].author.includes('[在地嚮導]'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker Fetch Handler - /api/llm-models endpoint', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (url.includes('generativelanguage.googleapis.com')) {
        return new Response(JSON.stringify({
          models: [
            { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'unsupported' }), { status: 400 });
    };

    const req = new Request('http://localhost:8787/api/llm-models', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-LLM-Provider': 'gemini',
        'X-LLM-Key': 'mock-gemini-key',
      },
      body: JSON.stringify({}),
    });

    const res = await worker.fetch(req, {}, {});
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.provider, 'gemini');
    assert.equal(data.models.length, 2);
    assert.equal(data.models[0].id, 'gemini-2.5-flash');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker Fetch Handler - /api/serpapi-reviews endpoint', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (url.includes('engine=google_maps_reviews')) {
        return new Response(JSON.stringify({
          reviews: [
            {
              author: 'Card Reviewer 1',
              rating: 1,
              snippet: '負評：服務非常差。',
              iso_date: '2026-10-19T00:00:00Z',
            },
            {
              author: 'Card Reviewer 2',
              rating: 5,
              snippet: '好評：非常好喝。',
              iso_date: '2026-10-19T00:00:00Z',
            },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    };

    const req = new Request('http://localhost:8787/api/serpapi-reviews', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SerpApi-Key': 'mock-serp-key',
      },
      body: JSON.stringify({
        place_id: 'test_card_place',
        place: { name: '測試門市', address: '測試路1號' },
      }),
    });

    const res = await worker.fetch(req, {}, {});
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'success');
    assert.equal(data.evidence.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('StorageManager - Fail-Closed on KV storage failure for daily budget', async () => {
  _resetStorageMemoryForTest();
  const brokenKV = {
    async get() {
      throw new Error('KV network timeout');
    },
    async put() {
      throw new Error('KV write error');
    },
  };
  const storage = new StorageManager({ STORE_PULSE_KV: brokenKV });
  const testDate = new Date('2026-10-21T12:00:00Z');
  // When KV fails, reserveDaily must fail closed (return false)
  const allowed = await storage.reserveDaily(100, testDate);
  assert.equal(allowed, false);
});

test('summarize - BYOK execution and strict non-fallback security', async () => {
  const originalFetch = globalThis.fetch;
  try {
    // 1. Successful BYOK execution
    globalThis.fetch = async (url) => {
      if (url.includes('generativelanguage.googleapis.com')) {
        return new Response(JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  observations: [{ category: 'service', finding: '店員非常親切熱情', evidence_ids: ['ev_byok'] }]
                })
              }]
            }
          }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('Not Found', { status: 404 });
    };

    const evidence = [{ evidence_id: 'ev_byok', text: '店員非常親切熱情', author: 'ByokUser' }];
    const successRes = await summarize(evidence, {}, {
      byok: {
        provider: 'gemini',
        key: 'valid_gemini_key',
        model: 'gemini-2.5-flash',
      }
    });

    assert.ok(successRes.summary);
    assert.equal(successRes.summary.observations.length, 1);
    assert.equal(successRes.summary.observations[0].category, 'service');
    assert.equal(successRes.usage.model, 'gemini:gemini-2.5-flash');

    // 2. Failed BYOK execution: MUST throw byok_failed and NEVER fall back to host Workers AI
    let aiCalled = false;
    const mockAI = {
      async run() {
        aiCalled = true;
        return { response: '{}' };
      }
    };

    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 });
    };

    await assert.rejects(
      async () => {
        await summarize(evidence, { AI: mockAI }, {
          byok: {
            provider: 'gemini',
            key: 'invalid_gemini_key',
            model: 'gemini-2.5-flash',
          }
        });
      },
      (err) => {
        assert.ok(err.message.includes('byok_failed'));
        return true;
      }
    );

    // Assert that host Workers AI was strictly NOT called
    assert.equal(aiCalled, false, 'Host Workers AI must NEVER be called when user BYOK fails');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Worker Fetch Handler - /api/llm-models rate limit', async () => {
  _resetStorageMemoryForTest();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ models: [{ id: 'gemini-2.5-flash' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    // Send 11 requests from same IP (limit is 10/min)
    let lastStatus = 200;
    for (let i = 0; i < 11; i++) {
      const req = new Request('http://localhost:8787/api/llm-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': 'ratelimit-ip' },
        body: JSON.stringify({ provider: 'gemini', api_key: 'test_key' }),
      });
      const res = await worker.fetch(req, {}, {});
      lastStatus = res.status;
    }
    assert.equal(lastStatus, 429);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
