import { createHash } from 'node:crypto';
import type {
  AnalysisMode,
  EvidenceItem,
  NormalizedPlace,
  SamplingMetadata,
} from './types.ts';
import { evidenceId, SOURCE_SHA } from './reviews.ts';

export interface SerpApiReviewItem {
  user?: {
    name?: string;
    local_guide?: boolean;
    reviews?: number;
    link?: string;
  };
  author?: string;
  rating?: number;
  date?: string;
  relative_time?: string;
  iso_date?: string;
  isoDate?: string;
  snippet?: string;
  text?: string;
  description?: string;
  likes?: number;
  likesCount?: number;
  review_id?: string;
  id?: string;
}

export class SerpApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SerpApiError';
    this.code = code;
  }
}

const SERPAPI_ENDPOINT = 'https://serpapi.com/search.json';

/**
 * Validates a SerpApi key by querying the account API.
 */
export async function validateSerpApiKey(apiKey: string): Promise<{
  valid: boolean;
  total_searches_left?: number;
  this_month_usage?: number;
  plan_searches_left?: number;
  account_email?: string;
  error?: string;
}> {
  const key = String(apiKey || '').trim();
  if (!key) {
    return { valid: false, error: '請輸入有效的 SerpApi 金鑰' };
  }

  try {
    const res = await fetch(`https://serpapi.com/account.json?api_key=${encodeURIComponent(key)}`, {
      headers: { Accept: 'application/json' },
    });
    const data: any = await res.json().catch(() => null);

    if (!res.ok || data?.error) {
      return {
        valid: false,
        error: data?.error || '金鑰無效或不存在',
      };
    }

    const totalLeft = typeof data.total_searches_left === 'number'
      ? data.total_searches_left
      : (typeof data.plan_searches_left === 'number' ? data.plan_searches_left : 0);

    return {
      valid: true,
      total_searches_left: totalLeft,
      this_month_usage: data.this_month_usage ?? 0,
      plan_searches_left: data.plan_searches_left,
      account_email: data.account_email ? String(data.account_email) : undefined,
    };
  } catch (err: any) {
    return {
      valid: false,
      error: `驗證連線失敗: ${err.message}`,
    };
  }
}

/**
 * Fetches reviews for a given place ID from SerpApi's google_maps_reviews engine.
 * Automatically paginates using `next_page_token` to retrieve up to ~25 reviews.
 */
export async function fetchSerpApiReviews(
  apiKey: string,
  placeId: string,
  options: {
    mode?: AnalysisMode;
    lang?: string;
    timeoutMs?: number;
    maxPages?: number;
    targetReviews?: number;
  } = {}
): Promise<{
  reviews: SerpApiReviewItem[];
  total?: number;
}> {
  const key = String(apiKey || '').trim();
  if (!key) {
    throw new SerpApiError('missing_key', '未提供 SerpApi 金鑰');
  }

  const mode = options.mode || 'recent';
  const lang = options.lang || 'zh-TW';
  const sortBy = mode === 'low_rating' ? 'ratingLow' : 'newestFirst';
  const maxPages = options.maxPages || 3;
  const targetReviews = options.targetReviews || 25;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 35000);

  const allReviews: SerpApiReviewItem[] = [];
  let totalReviewsCount: number | undefined;
  let nextToken: string | null = null;
  let page = 0;

  try {
    while (page < maxPages && allReviews.length < targetReviews) {
      page++;
      const params = new URLSearchParams({
        engine: 'google_maps_reviews',
        place_id: placeId,
        api_key: key,
        hl: lang,
        sort_by: sortBy,
      });
      if (nextToken) {
        params.set('next_page_token', nextToken);
      }

      const res = await fetch(`${SERPAPI_ENDPOINT}?${params.toString()}`, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
        },
      });

      const data: any = await res.json().catch(() => null);

      if (!res.ok || (data && data.error)) {
        if (page === 1) {
          const errMsg = String(data?.error || `HTTP ${res.status}`);
          if (errMsg.toLowerCase().includes('invalid api key')) {
            throw new SerpApiError('invalid_api_key', 'SerpApi 金鑰無效，請於設定中檢查。');
          }
          if (errMsg.toLowerCase().includes('run out of searches') || errMsg.toLowerCase().includes('quota')) {
            throw new SerpApiError('quota_exceeded', 'SerpApi 免費搜尋額度已用盡。');
          }
          throw new SerpApiError('upstream_error', `SerpApi 回傳錯誤: ${errMsg}`);
        } else {
          // If subsequent pages fail, gracefully continue with reviews gathered so far
          break;
        }
      }

      const rawList: any[] = data?.reviews || data?.reviews_results || [];
      if (typeof data?.place_info?.reviews === 'number') {
        totalReviewsCount = data.place_info.reviews;
      } else if (typeof data?.place_info?.user_ratings_total === 'number') {
        totalReviewsCount = data.place_info.user_ratings_total;
      }

      allReviews.push(...rawList);
      nextToken = data?.serpapi_pagination?.next_page_token || null;

      if (!nextToken || rawList.length === 0 || allReviews.length >= targetReviews) {
        break;
      }
    }

    return {
      reviews: allReviews,
      total: totalReviewsCount,
    };
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new SerpApiError('timeout', 'SerpApi 抓取逾時，請稍後重試。');
    }
    if (err instanceof SerpApiError) {
      throw err;
    }
    throw new SerpApiError('network_error', `無法連線至 SerpApi: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Curates and normalizes SerpApi reviews following TLDReview's 4-tier selection algorithm:
 * Tier 1: Local Guides (在地嚮導，資訊豐富度最高)
 * Tier 2: Critical Reviews (1~3 星真實負評，痛點地雷)
 * Tier 3: Helpful Reviews (社群按讚數高，強烈共識)
 * Tier 4: Other Reviews (普通評論補底)
 */
export function curateSerpApiReviews(
  rawReviews: SerpApiReviewItem[],
  place: NormalizedPlace,
  mode: AnalysisMode,
  windowDays: number,
  options: {
    maxReviews?: number;
    maxTotalChars?: number;
    maxSingleChars?: number;
    nowDate?: Date;
  } = {}
): {
  evidence: EvidenceItem[];
  sampling: SamplingMetadata;
  source_sha: string;
} {
  const maxReviews = options.maxReviews || 25;
  const maxTotalChars = options.maxTotalChars || 8000;
  const maxSingleChars = options.maxSingleChars || 1200;
  const now = options.nowDate || new Date();
  const start = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const seenIds = new Set<string>();
  const parsedReviews: Array<{
    item: EvidenceItem;
    is_local_guide: boolean;
    likes: number;
    published: Date | null;
  }> = [];

  const excluded = {
    duplicate: 0,
    missing_date: 0,
    outside_window: 0,
    rating: 0,
    empty_text: 0,
  };

  for (const raw of rawReviews) {
    const text = String(raw.snippet || raw.text || raw.description || '').trim();
    if (!text) {
      excluded.empty_text++;
      continue;
    }

    const author = String(raw.user?.name || raw.author || '匿名使用者').trim();
    const isLocalGuide = Boolean(raw.user?.local_guide);
    const likes = Number(raw.likes || raw.likesCount || 0);
    const rating = typeof raw.rating === 'number' ? raw.rating : null;

    let published: Date | null = null;
    const rawDate = raw.iso_date || raw.isoDate;
    if (rawDate) {
      const d = new Date(rawDate);
      if (!isNaN(d.getTime())) published = d;
    }

    // Time window filtering (if date is present and valid)
    if (published && (published < start || published > now)) {
      excluded.outside_window++;
      continue;
    }

    // Rating filtering for low_rating mode
    if (mode === 'low_rating' && (rating === null || rating > 3)) {
      excluded.rating++;
      continue;
    }

    const dummyReview = {
      provider_review_id: raw.review_id || raw.id || null,
      author,
      published_at: published ? published.toISOString() : null,
      text,
    };
    const evId = evidenceId(place.place_id, dummyReview);

    if (seenIds.has(evId)) {
      excluded.duplicate++;
      continue;
    }
    seenIds.add(evId);

    const guideTag = isLocalGuide ? ' [在地嚮導]' : '';
    const helpfulTag = likes > 0 ? ` [${likes}人覺得實用]` : '';
    const displayAuthor = `${author}${guideTag}${helpfulTag}`;

    parsedReviews.push({
      item: {
        evidence_id: evId,
        provider_review_id: dummyReview.provider_review_id,
        author: displayAuthor,
        published_at: published ? published.toISOString() : now.toISOString(),
        rating,
        text,
        is_excerpt: false,
        source_url: place.source_url || null,
        source_url_kind: 'branch',
      },
      is_local_guide: isLocalGuide,
      likes,
      published,
    });
  }

  // Four-tier prioritization (TLDReview Engine)
  const guides = parsedReviews.filter(r => r.is_local_guide);
  const critical = parsedReviews.filter(r => !r.is_local_guide && r.item.rating !== null && r.item.rating <= 3.0);
  const liked = parsedReviews.filter(r => !r.is_local_guide && (r.item.rating === null || r.item.rating > 3.0) && r.likes > 0);
  const others = parsedReviews.filter(r => !r.is_local_guide && (r.item.rating === null || r.item.rating > 3.0) && r.likes <= 0);

  const prioritized = [...guides, ...critical, ...liked, ...others];

  // Clip reviews for LLM prompt budget
  const evidence: EvidenceItem[] = [];
  let totalChars = 0;
  let truncated = false;

  for (const entry of prioritized) {
    if (evidence.length >= maxReviews || totalChars >= maxTotalChars) {
      truncated = true;
      break;
    }

    let text = entry.item.text;
    let isExcerpt = false;

    if (text.length > maxSingleChars) {
      text = text.slice(0, maxSingleChars).trimEnd() + '…';
      isExcerpt = true;
    }

    const remaining = maxTotalChars - totalChars;
    if (text.length > remaining) {
      if (remaining <= 10) break;
      text = text.slice(0, Math.max(1, remaining - 1)).trimEnd() + '…';
      isExcerpt = true;
    }

    totalChars += text.length;
    evidence.push({
      ...entry.item,
      text,
      is_excerpt: isExcerpt,
    });
  }

  return {
    evidence,
    sampling: {
      mode,
      window_days: windowDays,
      start_at: start.toISOString(),
      end_at: now.toISOString(),
      fetched: rawReviews.length,
      deduplicated: parsedReviews.length,
      eligible: prioritized.length,
      used: evidence.length,
      excluded,
      truncated,
    },
    source_sha: SOURCE_SHA,
  };
}
