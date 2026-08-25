const DATAFORSEO_BUSINESS_LISTINGS_SEARCH_ENDPOINT = 'https://api.dataforseo.com/v3/business_data/business_listings/search/live';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;

const COUNTRY_ALIASES = new Map([
  ['au', 'AU'],
  ['australia', 'AU'],
  ['ca', 'CA'],
  ['canada', 'CA'],
  ['gb', 'GB'],
  ['uk', 'GB'],
  ['united kingdom', 'GB'],
  ['ie', 'IE'],
  ['ireland', 'IE'],
  ['nz', 'NZ'],
  ['new zealand', 'NZ'],
  ['us', 'US'],
  ['usa', 'US'],
  ['united states', 'US'],
  ['united states of america', 'US'],
]);

const searchCache = new Map();

function cleanText(value = '', maxLength = 2000) {
  return String(value || '').trim().slice(0, maxLength);
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function httpError(statusCode, message, code = 'request_failed', details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details) error.details = details;
  return error;
}

function boolFlag(value) {
  return /^(1|true|yes|on)$/i.test(cleanText(value, 20));
}

function numberOrNull(value) {
  if (cleanText(value, 40) === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampInt(value, fallback, min, max) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function configuredLimit(value) {
  const envMax = clampInt(process.env.LEAD_FINDER_MAX_RESULTS, MAX_LIMIT, 1, MAX_LIMIT);
  return clampInt(value, DEFAULT_LIMIT, 1, envMax);
}

function configuredTimeoutMs() {
  return clampInt(process.env.LEAD_FINDER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 5000, 120000);
}

function configuredCacheTtlMs() {
  return clampInt(process.env.LEAD_FINDER_CACHE_TTL_SECONDS, DEFAULT_CACHE_TTL_MS / 1000, 0, 3600) * 1000;
}

function normalizeCountryCode(value = '') {
  const clean = cleanText(value || process.env.LEAD_FINDER_DEFAULT_COUNTRY || 'CA', 80).toLowerCase();
  return COUNTRY_ALIASES.get(clean) || (clean.length === 2 ? clean.toUpperCase() : 'CA');
}

function normalizeDomain(rawValue = '') {
  const raw = cleanText(rawValue, 800)
    .replace(/^\[+|\]+$/g, '')
    .replace(/[)\]]+$/g, '')
    .trim();
  if (!raw) return '';
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withProtocol).hostname
      .replace(/^www\./i, '')
      .replace(/\.$/, '')
      .toLowerCase();
  } catch {
    return raw
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split('/')[0]
      .split('?')[0]
      .replace(/\.$/, '')
      .toLowerCase();
  }
}

function normalizeUrl(rawValue = '') {
  const raw = cleanText(rawValue, 1000);
  if (!raw) return '';
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withProtocol).toString();
  } catch {
    return withProtocol;
  }
}

function parseLocation(location = '') {
  const parts = cleanText(location, 220)
    .split(',')
    .map(part => cleanText(part, 80))
    .filter(Boolean);
  return {
    city: parts[0] || '',
    region: parts[1] && !COUNTRY_ALIASES.has(parts[1].toLowerCase()) ? parts[1] : '',
  };
}

function authHeader(login, password) {
  return `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;
}

function parseJson(text = '') {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: cleanText(text, 1000) };
  }
}

function combineFilters(conditions) {
  return conditions.reduce((filters, condition, index) => {
    if (index > 0) filters.push('and');
    filters.push(condition);
    return filters;
  }, []);
}

function buildSearchTask(input = {}) {
  const businessType = cleanText(input.businessType || input.category || input.query, 200);
  const location = cleanText(input.location, 220);
  const { city, region } = parseLocation(location);
  const countryCode = normalizeCountryCode(input.countryCode || input.country);
  const limit = configuredLimit(input.limit);
  const providerLimit = Math.min(100, Math.max(limit, limit * 2));
  const conditions = [];

  if (!businessType) {
    throw httpError(400, 'Business type is required.', 'lead_business_type_required');
  }
  if (!location) {
    throw httpError(400, 'Location is required.', 'lead_location_required');
  }

  conditions.push(['address_info.country_code', '=', countryCode]);
  if (city) conditions.push(['address_info.city', 'ilike', `%${city}%`]);
  if (region) conditions.push(['address_info.region', 'ilike', `%${region}%`]);

  const minRating = numberOrNull(input.minRating ?? input.ratingMin);
  const maxRating = numberOrNull(input.maxRating ?? input.ratingMax);
  const minReviews = numberOrNull(input.minReviews ?? input.reviewsMin);
  const maxReviews = numberOrNull(input.maxReviews ?? input.reviewsMax);

  if (Number.isFinite(minRating)) conditions.push(['rating.value', '>=', minRating]);
  if (Number.isFinite(maxRating)) conditions.push(['rating.value', '<=', maxRating]);
  if (Number.isFinite(minReviews)) conditions.push(['rating.votes_count', '>=', minReviews]);
  if (Number.isFinite(maxReviews)) conditions.push(['rating.votes_count', '<=', maxReviews]);

  return {
    task: {
      description: businessType,
      limit: providerLimit,
      order_by: ['rating.value,desc', 'rating.votes_count,desc'],
      ...(conditions.length ? { filters: combineFilters(conditions) } : {}),
    },
    metadata: {
      businessType,
      location,
      city,
      region,
      countryCode,
      limit,
      websiteStatus: cleanText(input.websiteStatus || 'all', 40).toLowerCase(),
      minRating,
      maxRating,
      minReviews,
      maxReviews,
    },
  };
}

function cacheKeyFor(metadata) {
  return JSON.stringify({
    businessType: metadata.businessType.toLowerCase(),
    location: metadata.location.toLowerCase(),
    countryCode: metadata.countryCode,
    limit: metadata.limit,
    websiteStatus: metadata.websiteStatus,
    minRating: metadata.minRating,
    maxRating: metadata.maxRating,
    minReviews: metadata.minReviews,
    maxReviews: metadata.maxReviews,
  });
}

function getCachedSearch(key) {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    searchCache.delete(key);
    return null;
  }
  return {
    ...hit.value,
    cached: true,
  };
}

function setCachedSearch(key, value) {
  const ttl = configuredCacheTtlMs();
  if (!ttl) return;
  searchCache.set(key, {
    value: {
      ...value,
      cached: false,
    },
    expiresAt: Date.now() + ttl,
  });
}

function normalizeBusinessItem(item = {}) {
  const record = asRecord(item);
  const rating = asRecord(record.rating);
  const addressInfo = asRecord(record.address_info);
  const domain = normalizeDomain(record.domain || record.url);
  const websiteUrl = normalizeUrl(record.url || domain);
  const externalId = cleanText(record.place_id || record.cid || record.feature_id || '', 260);
  const businessName = cleanText(record.title || record.original_title, 220);

  return {
    business_name: businessName,
    category: cleanText(record.category, 220),
    website_url: domain ? websiteUrl : '',
    website_domain: domain,
    phone: cleanText(record.phone, 80),
    address: cleanText(record.address, 500),
    city: cleanText(addressInfo.city, 120),
    region: cleanText(addressInfo.region, 120),
    country_code: cleanText(addressInfo.country_code, 8).toUpperCase(),
    rating: numberOrNull(rating.value),
    review_count: numberOrNull(rating.votes_count),
    source: 'dataforseo_business_listings',
    external_source_id: externalId,
    is_claimed: record.is_claimed === true,
    logo_url: cleanText(record.logo, 1000),
    main_image_url: cleanText(record.main_image, 1000),
  };
}

function applyLocalFilters(results, metadata) {
  let filtered = results;
  if (metadata.websiteStatus === 'has_website') {
    filtered = filtered.filter(result => Boolean(result.website_domain));
  } else if (metadata.websiteStatus === 'no_website') {
    filtered = filtered.filter(result => !result.website_domain);
  }
  return filtered.slice(0, metadata.limit);
}

async function withTimeout(promise, timeoutMs, controller) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      if (controller) controller.abort();
      const error = new Error(`DataForSEO business search request timed out after ${timeoutMs}ms.`);
      error.name = 'AbortError';
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function providerConfigured() {
  return Boolean(cleanText(process.env.DATAFORSEO_LOGIN) && cleanText(process.env.DATAFORSEO_PASSWORD));
}

function leadFinderConfigStatus() {
  return {
    provider: 'dataforseo',
    configured: providerConfigured(),
    max_results: configuredLimit(MAX_LIMIT),
    cache_ttl_seconds: configuredCacheTtlMs() / 1000,
    mock_mode: boolFlag(process.env.LEAD_FINDER_MOCK_MODE),
  };
}

async function searchBusinessListings(input = {}) {
  const login = cleanText(process.env.DATAFORSEO_LOGIN);
  const password = cleanText(process.env.DATAFORSEO_PASSWORD);
  if (!login || !password) {
    throw httpError(
      503,
      'Lead Finder is not configured. Add DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD in Render.',
      'lead_finder_not_configured'
    );
  }

  const { task, metadata } = buildSearchTask(input);
  const key = cacheKeyFor(metadata);
  const cached = getCachedSearch(key);
  if (cached) return cached;

  const controller = new AbortController();
  let response;
  try {
    response = await withTimeout(fetch(DATAFORSEO_BUSINESS_LISTINGS_SEARCH_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: authHeader(login, password),
        'content-type': 'application/json',
      },
      body: JSON.stringify([task]),
      signal: controller.signal,
    }), configuredTimeoutMs(), controller);
  } catch (error) {
    throw httpError(
      error?.name === 'AbortError' ? 504 : 502,
      error?.message || 'Lead Finder provider request failed.',
      'business_search_provider_error'
    );
  }

  const body = parseJson(await response.text());
  const taskResult = asArray(body.tasks)[0] || {};
  const providerStatusCode = Number(taskResult.status_code || body.status_code);
  const providerStatusMessage = cleanText(taskResult.status_message || body.status_message || 'Provider request failed.', 500);

  if (!response.ok || providerStatusCode !== 20000) {
    throw httpError(
      response.ok ? 502 : response.status,
      providerStatusMessage,
      'business_search_provider_error',
      { providerStatusCode, providerStatusMessage }
    );
  }

  const resultRoot = asArray(taskResult.result)[0] || {};
  const normalizedResults = asArray(resultRoot.items)
    .map(normalizeBusinessItem)
    .filter(result => result.business_name);
  const results = applyLocalFilters(normalizedResults, metadata);
  const payload = {
    provider: 'dataforseo',
    cached: false,
    cost: numberOrNull(taskResult.cost) || numberOrNull(body.cost) || 0,
    total_count: Number(resultRoot.total_count) || normalizedResults.length,
    result_count: results.length,
    request: metadata,
    results,
  };
  setCachedSearch(key, payload);
  return payload;
}

module.exports = {
  buildSearchTask,
  leadFinderConfigStatus,
  normalizeBusinessItem,
  normalizeCountryCode,
  normalizeDomain,
  parseLocation,
  searchBusinessListings,
};
