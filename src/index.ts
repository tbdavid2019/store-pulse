import { createHash } from 'node:crypto';
import { SummaryError, summarize } from './analysis.ts';
import {
  ReviewError,
  detectIncentiveSignals,
  normalizeEvidence,
  parseGooglePlacesPayload,
} from './reviews.ts';
import {
  SerpApiError,
  curateSerpApiReviews,
  fetchSerpApiReviews,
  validateSerpApiKey,
  type SerpApiReviewItem,
} from './serpapi.ts';
import {
  fetchProviderModels,
  type LLMProvider,
} from './llm.ts';
import { StorageManager } from './storage.ts';
import type {
  AnalysisMode,
  AnalysisRequestPayload,
  AnalysisResponsePayload,
  Env,
  EvidenceItem,
  NormalizedPlace,
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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-SerpApi-Key, X-LLM-Provider, X-LLM-Key, X-LLM-Model',
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
  if (!Array.isArray(body.reviews) || body.reviews.length > 50) {
    throw new Error('reviews must be a list of up to 50 reviews');
  }

  return { placeId, mode, windowDays };
}

function computeEvidenceFingerprint(items: EvidenceItem[]): string {
  if (!items || items.length === 0) return 'empty';
  const content = items.map(i => `${i.evidence_id}:${i.rating ?? 0}:${i.text}`).join('|');
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

function computeCacheKey(
  env: Env,
  placeId: string,
  mode: string,
  windowDays: number,
  evidenceFingerprint = '',
  sourcePrefix = 'places',
  byokModel?: string
): string {
  const modelUrl = env.MODEL_API_URL || '';
  const modelName = env.MODEL_NAME || byokModel || '';
  const modelAuth = Boolean(env.MODEL_API_KEY || byokModel);
  const analysisVersion = env.STORE_PULSE_ANALYSIS_VERSION || '8';
  const material = [analysisVersion, modelUrl, modelName, String(modelAuth), 'zh-TW', evidenceFingerprint, sourcePrefix].join('|');
  const versionHash = createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 24);
  return `cache:${versionHash}|${placeId}|${mode}|${windowDays}|${sourcePrefix}`;
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

    // Explicit handler for llms.txt & llms-full.txt to guarantee UTF-8 encoding in web browsers
    if (url.pathname === '/llms.txt' || url.pathname === '/llms-full.txt') {
      if (env.ASSETS) {
        const assetRes = await env.ASSETS.fetch(request);
        if (assetRes.status === 200) {
          const content = await assetRes.text();
          return new Response(content, {
            status: 200,
            headers: {
              'Content-Type': 'text/plain; charset=utf-8',
              'Content-Disposition': 'inline',
              'Cache-Control': 'public, max-age=1800, must-revalidate',
              'Access-Control-Allow-Origin': '*',
            },
          });
        }
      }
    }

    // SerpApi account validation & quota check endpoint (BYOK)
    if (url.pathname === '/api/serpapi-account') {
      if (request.method !== 'POST') {
        return errorResponse('method_not_allowed', 'Only POST is supported', 405, corsHeaders);
      }

      let key = request.headers.get('X-SerpApi-Key')?.trim() || '';
      if (!key) {
        try {
          const body: any = await request.json();
          key = String(body.api_key || body.key || '').trim();
        } catch {}
      }

      if (!key) {
        return errorResponse('missing_key', '請提供 SerpApi 金鑰', 400, corsHeaders);
      }

      const clientIp = request.headers.get('cf-connecting-ip') || 'anonymous';
      const storage = new StorageManager(env);
      const allowed = await storage.allowClient(`serp_check:${clientIp}`, 10);
      if (!allowed) {
        return errorResponse('rate_limited', '驗證請求過於頻繁，請稍後再試。', 429, corsHeaders);
      }

      const checkResult = await validateSerpApiKey(key);
      return jsonResponse(checkResult, checkResult.valid ? 200 : 400, corsHeaders);
    }

    // BYOK LLM models query endpoint
    if (url.pathname === '/api/llm-models') {
      if (request.method !== 'POST') {
        return errorResponse('method_not_allowed', 'Only POST is supported', 405, corsHeaders);
      }

      const clientIp = request.headers.get('cf-connecting-ip') || 'anonymous';
      const storage = new StorageManager(env);
      const allowed = await storage.allowClient(`llm_models:${clientIp}`, 10);
      if (!allowed) {
        return errorResponse('rate_limited', '查詢模型請求過於頻繁，請稍後再試。', 429, corsHeaders);
      }

      let provider = (request.headers.get('X-LLM-Provider')?.trim().toLowerCase() || '') as LLMProvider;
      let key = request.headers.get('X-LLM-Key')?.trim() || '';

      if (!provider || !key) {
        try {
          const body: any = await request.json();
          if (!provider) provider = String(body.provider || '').trim().toLowerCase() as LLMProvider;
          if (!key) key = String(body.api_key || body.key || '').trim();
        } catch {}
      }

      const validProviders: LLMProvider[] = ['gemini', 'groq', 'openai', 'xai', 'anthropic'];
      if (!validProviders.includes(provider)) {
        return errorResponse('invalid_provider', '請選擇合法的 LLM 提供商 (gemini, groq, openai, xai, anthropic)', 400, corsHeaders);
      }
      if (!key) {
        return errorResponse('missing_key', '請輸入該提供商的 API 金鑰', 400, corsHeaders);
      }

      try {
        const models = await fetchProviderModels(provider, key);
        return jsonResponse({ provider, models }, 200, corsHeaders);
      } catch (err: any) {
        return errorResponse('fetch_models_failed', err.message || '無法取得模型清單，請檢查金鑰是否正確', 400, corsHeaders);
      }
    }

    // Direct SerpApi deep reviews fetching endpoint for store cards
    if (url.pathname === '/api/serpapi-reviews') {
      if (request.method !== 'POST') {
        return errorResponse('method_not_allowed', 'Only POST is supported', 405, corsHeaders);
      }

      const clientIp = request.headers.get('cf-connecting-ip') || 'anonymous';
      const storage = new StorageManager(env);
      const allowed = await storage.allowClient(`serp_reviews:${clientIp}`, 10);
      if (!allowed) {
        return errorResponse('rate_limited', '評論請求過於頻繁，請稍後再試。', 429, corsHeaders);
      }

      let key = request.headers.get('X-SerpApi-Key')?.trim() || '';
      let body: any = {};
      try {
        body = await request.json();
      } catch {}

      if (!key) key = String(body.api_key || body.key || '').trim();
      if (!key) return errorResponse('missing_key', '未提供 SerpApi 金鑰', 400, corsHeaders);

      const placeId = String(body.place_id || '').trim();
      if (!placeId) return errorResponse('missing_place_id', '未提供 place_id', 400, corsHeaders);

      const mode = (String(body.mode || 'recent').trim() as AnalysisMode);
      const windowDays = Number(body.window_days || 3650);

      try {
        const serpRes = await fetchSerpApiReviews(key, placeId, { mode, lang: 'zh-TW' });
        const placeStub: NormalizedPlace = {
          place_id: placeId,
          name: String(body.place?.name || body.name || '分店'),
          address: String(body.place?.address || body.address || ''),
          rating: typeof body.place?.rating === 'number' ? body.place.rating : null,
          user_ratings_total: typeof serpRes.total === 'number' ? serpRes.total : null,
          source_url: null,
        };
        const norm = curateSerpApiReviews(serpRes.reviews, placeStub, mode, windowDays);
        return jsonResponse({
          status: 'success',
          place_id: placeId,
          total: serpRes.total || norm.evidence.length,
          evidence: norm.evidence,
          sampling: norm.sampling,
        }, 200, corsHeaders);
      } catch (err: any) {
        return errorResponse('serpapi_error', err.message || '無法擷取 SerpApi 評論', 400, corsHeaders);
      }
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

      // Rate limit check
      const clientIp = request.headers.get('cf-connecting-ip') || 'anonymous';
      const rateLimit = Number(env.STORE_PULSE_CLIENT_RATE_LIMIT) || 5;
      const allowed = await storage.allowClient(clientIp, rateLimit);
      if (!allowed) {
        return errorResponse('rate_limited', '分析請求過於頻繁，請稍後再試。', 429, {
          ...corsHeaders,
          'Retry-After': '60',
        });
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

      // Check for BYOK SerpApi Key in request header or body
      const serpApiKey = request.headers.get('X-SerpApi-Key')?.trim() || '';
      let rawSerpReviews: SerpApiReviewItem[] | null = null;
      let reviewSource = 'google_places';

      // Check for BYOK LLM Key in request headers or body
      const byokProvider = (request.headers.get('X-LLM-Provider')?.trim().toLowerCase() || String(reqBody.llm_provider || '').trim().toLowerCase()) as LLMProvider;
      const byokKey = request.headers.get('X-LLM-Key')?.trim() || String(reqBody.llm_key || '').trim();
      const byokModel = request.headers.get('X-LLM-Model')?.trim() || String(reqBody.llm_model || '').trim();
      const byokConfig = (byokProvider && byokKey && byokModel)
        ? { provider: byokProvider, key: byokKey, model: byokModel }
        : undefined;

      if (serpApiKey) {
        try {
          const serpRes = await fetchSerpApiReviews(serpApiKey, placeId, { mode, lang: 'zh-TW' });
          if (serpRes.reviews && serpRes.reviews.length > 0) {
            rawSerpReviews = serpRes.reviews;
            reviewSource = 'serpapi';
          }
        } catch (err: any) {
          if (err instanceof SerpApiError) {
            if (err.code === 'invalid_api_key') {
              return errorResponse('invalid_serpapi_key', 'SerpApi 金鑰無效或不存在，請於「設定」中重新檢查。', 400, corsHeaders);
            }
            if (err.code === 'quota_exceeded') {
              return errorResponse('serpapi_quota_exceeded', 'SerpApi 本月免費搜尋額度已用盡。', 429, corsHeaders);
            }
          }
          console.warn('SerpApi fetching failed, falling back to Google Places:', err.message);
        }
      }

      let norm: ReturnType<typeof normalizeEvidence> | ReturnType<typeof curateSerpApiReviews>;
      let usedEvidence: EvidenceItem[] = [];
      let cacheKey: string;
      const modelTag = byokConfig ? `${byokConfig.provider}:${byokConfig.model}` : undefined;

      if (rawSerpReviews && rawSerpReviews.length > 0) {
        norm = curateSerpApiReviews(rawSerpReviews, place, mode, windowDays);
        usedEvidence = norm.evidence;
      } else {
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

        norm = normalizeEvidence(place, reviews, mode, windowDays);
        norm.sampling.truncated = (reqBody.reviews || []).length >= 5;

        const rawEvidence = norm.evidence.slice(0, 5);
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
      }

      // Compute tamper-resistant cache key incorporating normalized review fingerprint
      const evidenceFingerprint = computeEvidenceFingerprint(usedEvidence);
      cacheKey = computeCacheKey(env, placeId, mode, windowDays, evidenceFingerprint, reviewSource, modelTag);

      // Cache lookup (using verified evidence fingerprint to prevent cache poisoning)
      const cached = await storage.get<AnalysisResponsePayload>(cacheKey);
      if (cached) {
        return jsonResponse(cached, 200, corsHeaders);
      }

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
          review_source: reviewSource,
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
          timeoutSeconds: 45,
          byok: byokConfig,
          beforeRequest: async () => {
            if (!byokConfig) {
              const hasBudget = await storage.reserveDaily(dailyBudget);
              if (!hasBudget) {
                throw new SummaryError('quota_exceeded');
              }
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
      const assetRes = await env.ASSETS.fetch(request);
      const contentType = assetRes.headers.get('Content-Type') || '';
      const pathname = url.pathname.toLowerCase();

      // Ensure UTF-8 charset is explicitly set on text files (llms.txt, robots.txt, json, xml, markdown) to prevent browser mojibake
      if (
        pathname === '/llms.txt' ||
        pathname === '/llms-full.txt' ||
        pathname.endsWith('.txt') ||
        pathname.endsWith('.json') ||
        pathname.endsWith('.xml') ||
        contentType.startsWith('text/') ||
        contentType.includes('application/json')
      ) {
        const newHeaders = new Headers(assetRes.headers);
        if (pathname === '/llms.txt' || pathname === '/llms-full.txt') {
          newHeaders.set('Content-Type', 'text/plain; charset=utf-8');
          newHeaders.set('Content-Disposition', 'inline');
        } else if (!contentType.toLowerCase().includes('charset')) {
          newHeaders.set('Content-Type', `${contentType || 'text/plain'}; charset=utf-8`);
        }
        return new Response(assetRes.body, {
          status: assetRes.status,
          statusText: assetRes.statusText,
          headers: newHeaders,
        });
      }

      return assetRes;
    }

    return new Response('Not Found', { status: 404 });
  },
};
