import { createHash } from 'node:crypto';
import { SummaryError, summarize } from './analysis.ts';
import {
  ReviewError,
  detectIncentiveSignals,
  normalizeEvidence,
  parseGooglePlacesPayload,
} from './reviews.ts';
import { StorageManager } from './storage.ts';
import type {
  AnalysisMode,
  AnalysisRequestPayload,
  AnalysisResponsePayload,
  Env,
  EvidenceItem,
} from './types.ts';

function createRequestId(): string {
  return crypto.randomUUID().slice(0, 12);
}

function getCorsHeaders(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get('Origin') || '';
  const configured = (env.STORE_PULSE_API_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  let allowedOrigin = '';
  if (configured.length === 0) {
    // If no origins configured, allow same-origin or any in local dev
    allowedOrigin = origin || '*';
  } else if (configured.includes(origin)) {
    allowedOrigin = origin;
  }

  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
  if (allowedOrigin) {
    headers['Access-Control-Allow-Origin'] = allowedOrigin;
  }
  return headers;
}

function jsonResponse(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
  });
}

function errorResponse(status: string, message: string, httpStatus = 400, extraHeaders: HeadersInit = {}): Response {
  return jsonResponse(
    {
      status,
      message,
      request_id: createRequestId(),
    },
    httpStatus,
    extraHeaders
  );
}

function validatePayload(payload: unknown): { placeId: string; mode: AnalysisMode; windowDays: number } {
  if (!payload || typeof payload !== 'object') {
    throw new Error('request body must be an object');
  }
  const body = payload as AnalysisRequestPayload;
  const placeId = String(body.place_id || '').trim();
  const mode = (String(body.mode || 'recent').trim() as AnalysisMode);
  const windowDays = Number(body.window_days ?? 90);

  if (!placeId || placeId.length > 256) {
    throw new Error('place_id is required');
  }
  if (mode !== 'recent' && mode !== 'low_rating') {
    throw new Error('mode must be recent or low_rating');
  }
  if (isNaN(windowDays) || windowDays < 1 || windowDays > 3650) {
    throw new Error('window_days must be between 1 and 3650');
  }
  if (!body.place || typeof body.place !== 'object' || String(body.place.place_id || '') !== placeId) {
    throw new Error('place must match place_id');
  }
  if (!Array.isArray(body.reviews) || body.reviews.length > 5) {
    throw new Error('reviews must be a list of up to five Google Places reviews');
  }

  return { placeId, mode, windowDays };
}

function computeCacheKey(env: Env, placeId: string, mode: string, windowDays: number): string {
  const modelUrl = env.MODEL_API_URL || '';
  const modelName = env.MODEL_NAME || '';
  const modelAuth = Boolean(env.MODEL_API_KEY);
  const analysisVersion = env.STORE_PULSE_ANALYSIS_VERSION || '2';
  const material = [analysisVersion, modelUrl, modelName, String(modelAuth), 'zh-TW'].join('|');
  const versionHash = createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 16);
  return `cache:${versionHash}|${placeId}|${mode}|${windowDays}`;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = getCorsHeaders(request, env);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    // Health check endpoint
    if (url.pathname === '/api/health') {
      const isEnabled = env.STORE_PULSE_ENABLE_ANALYSIS !== 'false';
      return jsonResponse(
        {
          status: 'ok',
          analysis_enabled: isEnabled,
          runtime: 'cloudflare-worker',
        },
        200,
        corsHeaders
      );
    }

    // Review analysis endpoint
    if (url.pathname === '/api/review-analysis') {
      if (request.method !== 'POST') {
        return errorResponse('method_not_allowed', 'Only POST is supported', 405, corsHeaders);
      }

      if (env.STORE_PULSE_ENABLE_ANALYSIS === 'false') {
        return errorResponse('analysis_disabled', '深度分析目前已停用。', 503, corsHeaders);
      }

      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return errorResponse('invalid_request', 'Invalid JSON body', 422, corsHeaders);
      }

      let validated: { placeId: string; mode: AnalysisMode; windowDays: number };
      try {
        validated = validatePayload(payload);
      } catch (err: any) {
        return errorResponse('invalid_request', err.message, 422, corsHeaders);
      }

      const { placeId, mode, windowDays } = validated;
      const storage = new StorageManager(env);

      // Cache lookup
      const cacheKey = computeCacheKey(env, placeId, mode, windowDays);
      const cached = await storage.get<AnalysisResponsePayload>(cacheKey);
      if (cached) {
        return jsonResponse(cached, 200, corsHeaders);
      }

      // Rate limit check
      const clientIp = request.headers.get('cf-connecting-ip') || 'anonymous';
      const rateLimit = Number(env.STORE_PULSE_CLIENT_RATE_LIMIT) || 5;
      const allowed = await storage.allowClient(clientIp, rateLimit);
      if (!allowed) {
        return errorResponse('rate_limited', '分析請求過於頻繁，請稍後再試。', 429, corsHeaders);
      }

      // Process places & review evidence
      const reqBody = payload as AnalysisRequestPayload;
      let placeParsed: ReturnType<typeof parseGooglePlacesPayload>;
      try {
        placeParsed = parseGooglePlacesPayload(placeId, reqBody.place, reqBody.reviews);
      } catch (err: any) {
        if (err instanceof ReviewError) {
          if (err.message === 'place_mismatch') {
            return errorResponse('place_mismatch', '回傳的評論無法確認屬於所選分店。', 502, corsHeaders);
          }
        }
        return errorResponse('service_unavailable', '評論服務暫時無法完成這家分店的分析。', 502, corsHeaders);
      }

      const { place, reviews } = placeParsed;

      // Sort reviews based on mode
      if (mode === 'recent') {
        reviews.sort((a, b) => (b.published_at || '').localeCompare(a.published_at || ''));
      } else {
        reviews.sort((a, b) => {
          const rA = a.rating ?? 6;
          const rB = b.rating ?? 6;
          if (rA !== rB) return rA - rB;
          return (b.published_at || '').localeCompare(a.published_at || '');
        });
      }

      const norm = normalizeEvidence(place, reviews, mode, windowDays);
      norm.sampling.truncated = (reqBody.reviews || []).length >= 5;

      const rawEvidence = norm.evidence.slice(0, 5);
      const usedEvidence: EvidenceItem[] = [];
      let totalChars = 0;

      for (let item of rawEvidence) {
        const remaining = 8000 - totalChars;
        if (remaining <= 0) {
          norm.sampling.truncated = true;
          break;
        }
        let text = item.text;
        if (text.length > 1200) {
          text = text.slice(0, 1200).trimEnd() + '…';
          item = { ...item, text, is_excerpt: true };
        }
        if (text.length > remaining) {
          item = { ...item, text: text.slice(0, Math.max(1, remaining - 1)).trimEnd() + '…', is_excerpt: true };
        }
        totalChars += item.text.length;
        usedEvidence.push(item);
      }

      norm.sampling.used = usedEvidence.length;

      const defaultTtl = Number(env.STORE_PULSE_CACHE_TTL_SECONDS) || 21600;
      const emptyTtl = Number(env.STORE_PULSE_EMPTY_CACHE_TTL_SECONDS) || 600;

      const result: AnalysisResponsePayload = {
        status: usedEvidence.length > 0 ? 'success' : 'insufficient_evidence',
        request_id: createRequestId(),
        place: {
          place_id: place.place_id,
          name: place.name,
          address: place.address,
          rating: place.rating,
          source_url: place.source_url,
        },
        sampling: norm.sampling,
        evidence: usedEvidence,
        signals: detectIncentiveSignals(usedEvidence),
        source_sha: norm.source_sha,
        fetched_at: new Date().toISOString(),
        usage: {
          review_source: 'google_places',
          model_calls: 0,
        },
        cache: {
          hit: false,
          ttl_seconds: usedEvidence.length > 0 ? defaultTtl : emptyTtl,
        },
      };

      if (usedEvidence.length === 0) {
        await storage.put(cacheKey, result, emptyTtl);
        return jsonResponse(result, 200, corsHeaders);
      }

      // LLM Summarization
      const dailyBudget = Number(env.STORE_PULSE_DAILY_MODEL_BUDGET) || 100;
      try {
        const summarizeResult = await summarize(usedEvidence, env, {
          timeoutSeconds: 25,
          beforeRequest: async () => {
            const hasBudget = await storage.reserveDaily(dailyBudget);
            if (!hasBudget) {
              throw new SummaryError('quota_exceeded');
            }
          },
        });

        result.summary = summarizeResult.summary;
        Object.assign(result.usage, summarizeResult.usage);
        if (!summarizeResult.summary) {
          result.status = (summarizeResult.usage.status as any) || 'summary_unavailable';
        }
        result.analyzed_at = new Date().toISOString();
      } catch (err: any) {
        if (err instanceof SummaryError) {
          if (err.message === 'quota_exceeded') {
            result.status = 'quota_exceeded';
          } else if (err.message === 'model_timeout') {
            result.status = 'timeout';
          } else {
            result.status = 'summary_unavailable';
          }
        } else {
          result.status = 'summary_unavailable';
        }
        result.summary = null;
        result.usage.summary_error = err.message || 'unknown_error';
      }

      // Cache successful analyses or clean unconfigured fallback, but NEVER cache transient model errors
      const hasModelError = Boolean(result.usage.summary_error) || result.status === 'quota_exceeded' || result.status === 'timeout';
      if (!hasModelError) {
        await storage.put(cacheKey, result, defaultTtl);
      }

      return jsonResponse(result, 200, corsHeaders);
    }

    // Serve static assets if ASSETS binding is present
    if (env.ASSETS) {
      return await env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  },
};
