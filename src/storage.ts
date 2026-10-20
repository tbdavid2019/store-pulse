import type { Env } from './types.ts';

interface MemoryCacheEntry {
  payload: any;
  expiresAt: number;
}

// In-memory fallback when KV is not bound
const memoryCache = new Map<string, MemoryCacheEntry>();
const memoryRateLimit = new Map<string, { count: number; bucket: number }>();
const memoryBudget = new Map<string, number>();

export class StorageManager {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  async get<T = any>(key: string): Promise<T | null> {
    if (this.env.STORE_PULSE_KV) {
      const data = await this.env.STORE_PULSE_KV.get(key, 'json');
      if (data && typeof data === 'object') {
        (data as any).cache = { ...(data as any).cache, hit: true };
      }
      return data as T | null;
    }

    const entry = memoryCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      memoryCache.delete(key);
      return null;
    }
    const cloned = JSON.parse(JSON.stringify(entry.payload));
    cloned.cache = { ...(cloned.cache || {}), hit: true };
    return cloned as T;
  }

  async put(key: string, payload: any, ttlSeconds: number): Promise<void> {
    if (this.env.STORE_PULSE_KV) {
      await this.env.STORE_PULSE_KV.put(key, JSON.stringify(payload), {
        expirationTtl: Math.max(60, ttlSeconds),
      });
      return;
    }

    memoryCache.set(key, {
      payload,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async allowClient(clientIp: string, limitPerMinute: number): Promise<boolean> {
    const bucket = Math.floor(Date.now() / 60000);
    const rateKey = `rate:${clientIp}:${bucket}`;

    if (this.env.STORE_PULSE_KV) {
      const raw = await this.env.STORE_PULSE_KV.get(rateKey);
      const count = Number(raw) || 0;
      if (count >= limitPerMinute) {
        return false;
      }
      await this.env.STORE_PULSE_KV.put(rateKey, String(count + 1), {
        expirationTtl: 120, // 2 minutes auto-expire
      });
      return true;
    }

    const current = memoryRateLimit.get(rateKey);
    const count = current && current.bucket === bucket ? current.count : 0;
    if (count >= limitPerMinute) {
      return false;
    }

    // Prune stale buckets to avoid memory leaks in long-running isolates
    if (memoryRateLimit.size > 200) {
      const minBucket = bucket - 2;
      for (const [k, v] of memoryRateLimit.entries()) {
        if (v.bucket < minBucket) {
          memoryRateLimit.delete(k);
        }
      }
    }

    memoryRateLimit.set(rateKey, { count: count + 1, bucket });
    return true;
  }

  async reserveDaily(budget: number, nowDate?: Date): Promise<boolean> {
    const day = (nowDate || new Date()).toISOString().slice(0, 10);
    const budgetKey = `budget:${day}`;

    if (this.env.STORE_PULSE_KV) {
      const raw = await this.env.STORE_PULSE_KV.get(budgetKey);
      const count = Number(raw) || 0;
      if (count >= budget) {
        return false;
      }
      await this.env.STORE_PULSE_KV.put(budgetKey, String(count + 1), {
        expirationTtl: 86400 * 2, // 2 days auto-expire
      });
      return true;
    }

    const count = memoryBudget.get(day) || 0;
    if (count >= budget) {
      return false;
    }
    memoryBudget.set(day, count + 1);
    return true;
  }
}
