import type { Env } from './types.ts';

interface MemoryCacheEntry {
  payload: any;
  expiresAt: number;
}

// In-memory fallback and L1 cache for isolate
const memoryCache = new Map<string, MemoryCacheEntry>();
const memoryRateLimit = new Map<string, { count: number; bucket: number }>();
const memoryBudget = new Map<string, number>();

export function _resetStorageMemoryForTest(): void {
  memoryCache.clear();
  memoryRateLimit.clear();
  memoryBudget.clear();
}

export class StorageManager {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  async get<T = any>(key: string): Promise<T | null> {
    // 1. Check L1 in-memory cache first (0ms latency within isolate)
    const entry = memoryCache.get(key);
    if (entry) {
      if (Date.now() <= entry.expiresAt) {
        const cloned = JSON.parse(JSON.stringify(entry.payload));
        cloned.cache = { ...(cloned.cache || {}), hit: true };
        return cloned as T;
      }
      memoryCache.delete(key);
    }

    // 2. Check L2 KV distributed cache if bound
    if (this.env.STORE_PULSE_KV) {
      try {
        const data = await this.env.STORE_PULSE_KV.get(key, 'json');
        if (data && typeof data === 'object') {
          (data as any).cache = { ...(data as any).cache, hit: true };
          // Populate local L1 cache with remaining TTL (up to 5 minutes)
          memoryCache.set(key, {
            payload: data,
            expiresAt: Date.now() + 300 * 1000,
          });
          return data as T;
        }
      } catch (err) {
        console.warn('KV get cache error, using fallback:', err);
      }
    }

    return null;
  }

  async put(key: string, payload: any, ttlSeconds: number): Promise<void> {
    // 1. Populate L1 in-memory cache
    memoryCache.set(key, {
      payload,
      expiresAt: Date.now() + Math.min(ttlSeconds, 300) * 1000,
    });

    // 2. Persist to L2 KV globally
    if (this.env.STORE_PULSE_KV) {
      try {
        await this.env.STORE_PULSE_KV.put(key, JSON.stringify(payload), {
          expirationTtl: Math.max(60, ttlSeconds),
        });
      } catch (err) {
        console.warn('KV put cache error:', err);
      }
    }
  }

  async allowClient(clientIp: string, limitPerMinute: number): Promise<boolean> {
    const bucket = Math.floor(Date.now() / 60000);
    const rateKey = `rate:${clientIp}:${bucket}`;

    // 1. Prune stale buckets in local memory upfront to prevent isolate memory leaks
    if (memoryRateLimit.size > 200) {
      const minBucket = bucket - 2;
      for (const [k, v] of memoryRateLimit.entries()) {
        if (v.bucket < minBucket) {
          memoryRateLimit.delete(k);
        }
      }
    }

    // 2. L1 fast rejection: if this isolate already recorded >= limit, reject immediately
    const current = memoryRateLimit.get(rateKey);
    const memCount = current && current.bucket === bucket ? current.count : 0;
    if (memCount >= limitPerMinute) {
      return false;
    }

    // Optimistically increment in L1 memory to serialize concurrent requests within this isolate
    memoryRateLimit.set(rateKey, { count: memCount + 1, bucket });

    // 3. L2 KV distributed check: synchronize across all edge colos and isolates
    if (this.env.STORE_PULSE_KV) {
      try {
        const raw = await this.env.STORE_PULSE_KV.get(rateKey);
        const kvCount = Number(raw) || 0;
        if (kvCount >= limitPerMinute) {
          memoryRateLimit.set(rateKey, { count: limitPerMinute, bucket });
          return false;
        }
        const nextCount = Math.max(memCount + 1, kvCount + 1);
        await this.env.STORE_PULSE_KV.put(rateKey, String(nextCount), {
          expirationTtl: 120, // 2 minutes auto-expire
        });
        memoryRateLimit.set(rateKey, { count: nextCount, bucket });
        return true;
      } catch (err) {
        console.warn('KV rate limit access error, falling back to local memory:', err);
      }
    }

    return true;
  }

  async reserveDaily(budget: number, nowDate?: Date): Promise<boolean> {
    const day = (nowDate || new Date()).toISOString().slice(0, 10);
    const budgetKey = `budget:${day}`;

    // 1. Prune stale days in local memory
    if (memoryBudget.size > 10) {
      for (const k of memoryBudget.keys()) {
        if (k !== day) memoryBudget.delete(k);
      }
    }

    // 2. L1 fast rejection: if this isolate already observed today's budget exhausted, reject immediately
    const memCount = memoryBudget.get(day) || 0;
    if (memCount >= budget) {
      return false;
    }

    // Optimistically reserve in local memory for concurrent requests within this isolate
    memoryBudget.set(day, memCount + 1);

    // 3. L2 KV distributed check: enforce global daily budget across all isolates and colos
    if (this.env.STORE_PULSE_KV) {
      try {
        const raw = await this.env.STORE_PULSE_KV.get(budgetKey);
        const kvCount = Number(raw) || 0;
        if (kvCount >= budget) {
          memoryBudget.set(day, Math.max(budget, kvCount));
          return false;
        }
        const nextCount = Math.max(memCount + 1, kvCount + 1);
        await this.env.STORE_PULSE_KV.put(budgetKey, String(nextCount), {
          expirationTtl: 86400 * 2, // 2 days auto-expire
        });
        memoryBudget.set(day, nextCount);
        return true;
      } catch (err) {
        // Fail-Closed: If KV is bound but encounters storage failure, block model execution
        // to strictly prevent unmetered cost overruns!
        console.error('Critical: KV budget access failed, failing closed to prevent cost overrun:', err);
        return false;
      }
    }

    return true;
  }
}
