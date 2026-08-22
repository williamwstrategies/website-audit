const DATAFORSEO_RANKED_KEYWORDS_ENDPOINT = 'https://api.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live';
const KEYWORD_RANKING_DATASET_VERSION = 'dataforseo_labs_google_ranked_keywords_live_v1';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_CACHE_TTL_DAYS = 7;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

const COUNTRY_NAMES = {
  AU: 'Australia',
  CA: 'Canada',
  GB: 'United Kingdom',
  IE: 'Ireland',
  NZ: 'New Zealand',
  US: 'United States',
};

const COUNTRY_ALIASES = new Map([
  ['au', 'AU'],
  ['australia', 'AU'],
  ['ca', 'CA'],
  ['canada', 'CA'],
  ['gb', 'GB'],
  ['uk', 'GB'],
  ['united kingdom', 'GB'],
  ['great britain', 'GB'],
  ['ie', 'IE'],
  ['ireland', 'IE'],
  ['nz', 'NZ'],
  ['new zealand', 'NZ'],
  ['us', 'US'],
  ['usa', 'US'],
  ['united states', 'US'],
  ['united states of america', 'US'],
]);

const OPPORTUNITY_THRESHOLDS = Object.freeze({
  meaningfulSearchVolume: 20,
  top3OpportunityMinPosition: 4,
  top3OpportunityMaxPosition: 10,
  nearPageOneMinPosition: 11,
  nearPageOneMaxPosition: 20,
  highVolumeWeakMinPosition: 21,
  highVolumeWeakMaxPosition: 50,
  highVolumeWeakSearchVolume: 100,
});

const keywordRankingCache = new Map();

function cleanText(value = '', maxLength = 2000) {
  return String(value || '').trim().slice(0, maxLength);
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function boolFlag(value) {
  return /^(1|true|yes|on)$/i.test(cleanText(value, 20));
}

function featureEnabled() {
  return boolFlag(process.env.KEYWORD_RANKING_ENABLED);
}

function mockModeEnabled() {
  return boolFlag(process.env.KEYWORD_RANKING_MOCK_MODE);
}

function configuredTimeoutMs(override) {
  const parsed = Number(override ?? process.env.KEYWORD_RANKING_TIMEOUT_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.max(1000, Math.min(60000, Math.round(parsed)));
}

function configuredCacheTtlMs() {
  const parsed = Number(process.env.KEYWORD_RANKING_CACHE_TTL_DAYS);
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CACHE_TTL_DAYS;
  return Math.max(1, Math.min(30, days)) * 24 * 60 * 60 * 1000;
}

function configuredLimit(override) {
  const parsed = Number(override ?? process.env.KEYWORD_RANKING_LIMIT);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.round(parsed)));
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function round(value, precision = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const factor = 10 ** precision;
  return Math.round(parsed * factor) / factor;
}

function roundMoney(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000000) / 1000000 : 0;
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

function isValidDomain(domain = '') {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(cleanText(domain, 260));
}

function inferCountryCodeFromDomain(domain = '') {
  const value = cleanText(domain, 260).toLowerCase();
  if (value.endsWith('.ca')) return 'CA';
  if (value.endsWith('.co.uk') || value.endsWith('.uk')) return 'GB';
  if (value.endsWith('.com.au') || value.endsWith('.net.au') || value.endsWith('.au')) return 'AU';
  if (value.endsWith('.co.nz') || value.endsWith('.nz')) return 'NZ';
  if (value.endsWith('.ie')) return 'IE';
  if (value.endsWith('.us')) return 'US';
  return '';
}

function normalizeCountryCode(value = '', domain = '') {
  const normalized = cleanText(value, 80).toLowerCase();
  const explicit = COUNTRY_ALIASES.get(normalized) || (normalized.length === 2 ? normalized.toUpperCase() : '');
  if (explicit && COUNTRY_NAMES[explicit]) return explicit;
  return inferCountryCodeFromDomain(domain);
}

function normalizeLanguageCode(value = '') {
  const normalized = cleanText(value || 'en', 12).toLowerCase();
  return /^[a-z]{2}(?:-[a-z]{2})?$/.test(normalized) ? normalized : 'en';
}

function cacheKey({ domain, countryCode, languageCode }) {
  return [
    KEYWORD_RANKING_DATASET_VERSION,
    cleanText(domain, 260),
    cleanText(countryCode, 8).toUpperCase(),
    cleanText(languageCode, 12).toLowerCase(),
  ].join('|');
}

function getCachedKeywordRanking(key) {
  const hit = keywordRankingCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    keywordRankingCache.delete(key);
    return null;
  }
  return {
    ...hit.value,
    cacheHit: true,
    cachedAt: hit.cachedAt,
  };
}

function setCachedKeywordRanking(key, value) {
  if (!value || !['complete', 'no_keywords'].includes(value.status)) return;
  keywordRankingCache.set(key, {
    value: {
      ...value,
      cacheHit: false,
    },
    cachedAt: new Date().toISOString(),
    expiresAt: Date.now() + configuredCacheTtlMs(),
  });
}

function authHeader(login, password) {
  return `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;
}

function parseResponseBody(text = '') {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: cleanText(text, 1000) };
  }
}

async function withTimeout(promise, timeoutMs, controller) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      if (controller) controller.abort();
      const error = new Error(`DataForSEO keyword ranking request timed out after ${timeoutMs}ms.`);
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

function dataForSeoStatusFailed(code) {
  const parsed = Number(code);
  return Number.isFinite(parsed) && parsed >= 40000;
}

function providerFailureMessage(data) {
  const responseData = asRecord(data);
  const task = asRecord(asArray(responseData.tasks)[0]);
  return cleanText(
    task.status_message ||
    responseData.status_message ||
    responseData.message ||
    'DataForSEO returned an unsuccessful keyword ranking response.',
    1000
  );
}

function requestFailedByProvider(data) {
  const responseData = asRecord(data);
  const task = asRecord(asArray(responseData.tasks)[0]);
  if (dataForSeoStatusFailed(responseData.status_code) || dataForSeoStatusFailed(task.status_code)) return true;
  return Number(responseData.tasks_error) > 0;
}

function unavailableKeywordRanking({ domain, countryCode, languageCode, error, code, durationMs = 0, cacheHit = false } = {}) {
  return {
    status: 'unavailable',
    domain: cleanText(domain, 260),
    countryCode: cleanText(countryCode, 8).toUpperCase(),
    languageCode: cleanText(languageCode, 12).toLowerCase(),
    message: 'Keyword ranking data unavailable for this scan.',
    error: cleanText(error, 500),
    code: cleanText(code, 80),
    provider: 'dataforseo',
    endpoint: DATAFORSEO_RANKED_KEYWORDS_ENDPOINT,
    datasetVersion: KEYWORD_RANKING_DATASET_VERSION,
    providerCost: 0,
    requestDurationMs: Math.max(0, Number(durationMs) || 0),
    resultCount: 0,
    cacheHit,
    testedAt: new Date().toISOString(),
  };
}

function disabledKeywordRanking() {
  return {
    status: 'disabled',
    message: 'Keyword ranking enrichment is disabled.',
    provider: 'dataforseo',
    endpoint: DATAFORSEO_RANKED_KEYWORDS_ENDPOINT,
    datasetVersion: KEYWORD_RANKING_DATASET_VERSION,
    providerCost: 0,
    requestDurationMs: 0,
    resultCount: 0,
    cacheHit: false,
    testedAt: new Date().toISOString(),
  };
}

function noKeywordsResult(base = {}) {
  return {
    ...base,
    status: 'no_keywords',
    message: 'Limited Organic Search Visibility',
    totalRankingKeywords: 0,
    top3Keywords: 0,
    top10Keywords: 0,
    top20Keywords: 0,
    top100Keywords: 0,
    estimatedOrganicTraffic: 0,
    averagePosition: null,
    highestVolumeRankingKeyword: null,
    bestRankingMeaningfulKeyword: null,
    topKeywords: [],
    opportunities: [],
  };
}

function buildRequestTask({ domain, countryCode, languageCode, limit }) {
  return {
    target: domain,
    location_name: COUNTRY_NAMES[countryCode],
    language_code: languageCode,
    item_types: ['organic'],
    historical_serp_mode: 'live',
    ignore_synonyms: true,
    include_clickstream_data: false,
    limit,
    filters: [
      ['keyword_data.keyword_info.search_volume', '>', 0],
      'and',
      ['ranked_serp_element.serp_item.type', '=', 'organic'],
    ],
    order_by: [
      'ranked_serp_element.serp_item.rank_group,asc',
      'keyword_data.keyword_info.search_volume,desc',
    ],
    tag: `pitchproof_keyword_ranking_${Date.now()}`,
  };
}

function domainTokens(domain = '') {
  const firstLabel = cleanText(domain, 260).split('.')[0] || '';
  return firstLabel
    .replace(/[-_]+/g, ' ')
    .split(/\s+/)
    .map(token => token.toLowerCase())
    .filter(token => token.length >= 4);
}

function isLikelyNavigationalKeyword(keyword = '', domain = '') {
  const normalized = cleanText(keyword, 260).toLowerCase();
  if (!normalized) return true;
  if (normalized.includes(cleanText(domain, 260).toLowerCase())) return true;
  const tokens = domainTokens(domain);
  return tokens.length > 0 && tokens.every(token => normalized.includes(token));
}

function normalizeKeywordItem(rawItem = {}, domain = '') {
  const item = asRecord(rawItem);
  const keywordData = asRecord(item.keyword_data);
  const keywordInfo = asRecord(keywordData.keyword_info);
  const intentInfo = asRecord(keywordData.search_intent_info);
  const serpElement = asRecord(item.ranked_serp_element);
  const serpItem = asRecord(serpElement.serp_item);
  const keyword = cleanText(keywordData.keyword, 260);
  const position = firstFiniteNumber(serpItem.rank_group, serpItem.rank_absolute);
  if (!keyword || !position) return null;

  const searchVolume = firstFiniteNumber(keywordInfo.search_volume);
  const estimatedTraffic = firstFiniteNumber(serpItem.etv, item.etv);
  const rankingUrl = cleanText(serpItem.url, 2000);
  const cpc = firstFiniteNumber(keywordInfo.cpc);

  return {
    keyword,
    position,
    searchVolume,
    estimatedTraffic,
    rankingUrl,
    cpc,
    mainIntent: cleanText(intentInfo.main_intent, 80),
    itemType: cleanText(serpItem.type || item.type, 80) || 'organic',
    isBrandedOrNavigational: isLikelyNavigationalKeyword(keyword, domain),
  };
}

function dedupeKeywords(keywords = []) {
  const byKeyword = new Map();
  keywords.forEach((item) => {
    if (!item?.keyword) return;
    const key = item.keyword.toLowerCase();
    const existing = byKeyword.get(key);
    if (!existing || item.position < existing.position) byKeyword.set(key, item);
  });
  return Array.from(byKeyword.values());
}

function countByPosition(keywords = [], min, max) {
  return keywords.filter(item => item.position >= min && item.position <= max).length;
}

function metricCount(metrics = {}, key, fallback) {
  const value = firstFiniteNumber(metrics[key]);
  return value === null ? fallback : value;
}

function keywordSortScore(item = {}) {
  const position = Number(item.position) || 100;
  const searchVolume = Number(item.searchVolume) || 0;
  const traffic = Number(item.estimatedTraffic) || 0;
  return ((101 - Math.min(position, 100)) * 1000) + (Math.log10(searchVolume + 1) * 220) + (traffic * 8);
}

function curatedTopKeywords(keywords = [], domain = '', limit = 10) {
  const meaningful = keywords.filter(item => !item.isBrandedOrNavigational);
  const source = meaningful.length ? meaningful : keywords;
  return [...source]
    .sort((a, b) => keywordSortScore(b) - keywordSortScore(a))
    .slice(0, limit);
}

function highestVolumeKeyword(keywords = []) {
  return [...keywords]
    .filter(item => Number(item.searchVolume) > 0)
    .sort((a, b) => (Number(b.searchVolume) || 0) - (Number(a.searchVolume) || 0))[0] || null;
}

function bestRankingMeaningfulKeyword(keywords = []) {
  const meaningful = keywords.filter(item => !item.isBrandedOrNavigational);
  const source = meaningful.length ? meaningful : keywords;
  return [...source].sort((a, b) => a.position - b.position)[0] || null;
}

function opportunityMessage(type) {
  if (type === 'top_3_opportunity') {
    return "This keyword is already on Google's first page and may represent an opportunity to improve visibility in the highest-click positions.";
  }
  if (type === 'high_volume_weak_ranking') {
    return 'This keyword has meaningful search demand, but the website is not yet ranking strongly for it.';
  }
  return "This keyword is close to Google's first page and may represent a strong opportunity for improved visibility.";
}

function opportunityTypeForKeyword(item = {}) {
  const position = Number(item.position);
  const volume = Number(item.searchVolume) || 0;
  if (!Number.isFinite(position) || volume < OPPORTUNITY_THRESHOLDS.meaningfulSearchVolume) return '';
  if (
    position >= OPPORTUNITY_THRESHOLDS.top3OpportunityMinPosition &&
    position <= OPPORTUNITY_THRESHOLDS.top3OpportunityMaxPosition
  ) return 'top_3_opportunity';
  if (
    position >= OPPORTUNITY_THRESHOLDS.nearPageOneMinPosition &&
    position <= OPPORTUNITY_THRESHOLDS.nearPageOneMaxPosition
  ) return 'near_page_one';
  if (
    position >= OPPORTUNITY_THRESHOLDS.highVolumeWeakMinPosition &&
    position <= OPPORTUNITY_THRESHOLDS.highVolumeWeakMaxPosition &&
    volume >= OPPORTUNITY_THRESHOLDS.highVolumeWeakSearchVolume
  ) return 'high_volume_weak_ranking';
  return '';
}

function detectOpportunities(keywords = [], limit = 10) {
  return keywords
    .filter(item => !item.isBrandedOrNavigational)
    .map(item => ({
      ...item,
      opportunityType: opportunityTypeForKeyword(item),
    }))
    .filter(item => item.opportunityType)
    .sort((a, b) => {
      const typeWeight = { top_3_opportunity: 3, near_page_one: 2, high_volume_weak_ranking: 1 };
      return (typeWeight[b.opportunityType] - typeWeight[a.opportunityType]) ||
        ((Number(b.searchVolume) || 0) - (Number(a.searchVolume) || 0)) ||
        (a.position - b.position);
    })
    .slice(0, limit)
    .map(item => ({
      keyword: item.keyword,
      position: item.position,
      searchVolume: item.searchVolume,
      estimatedTraffic: item.estimatedTraffic,
      rankingUrl: item.rankingUrl,
      opportunityType: item.opportunityType,
      message: opportunityMessage(item.opportunityType),
    }));
}

function averagePosition(keywords = []) {
  if (!keywords.length) return null;
  const total = keywords.reduce((sum, item) => sum + (Number(item.position) || 0), 0);
  return round(total / keywords.length, 1);
}

function normalizeProviderResponse(data, request, startedAt) {
  const responseData = asRecord(data);
  const task = asRecord(asArray(responseData.tasks)[0]);
  const result = asRecord(asArray(task.result)[0]);
  const metrics = asRecord(asRecord(result.metrics).organic);
  const rawItems = asArray(result.items);
  const keywords = dedupeKeywords(rawItems.map(item => normalizeKeywordItem(item, request.domain)).filter(Boolean));
  const totalCount = firstFiniteNumber(result.total_count, metrics.count);
  const providerCost = roundMoney(firstFiniteNumber(task.cost, responseData.cost));

  const base = {
    domain: request.domain,
    countryCode: request.countryCode,
    languageCode: request.languageCode,
    locationName: COUNTRY_NAMES[request.countryCode],
    provider: 'dataforseo',
    endpoint: DATAFORSEO_RANKED_KEYWORDS_ENDPOINT,
    datasetVersion: KEYWORD_RANKING_DATASET_VERSION,
    providerCost,
    requestDurationMs: Date.now() - startedAt,
    resultCount: rawItems.length,
    cacheHit: false,
    testedAt: new Date().toISOString(),
  };

  if (!keywords.length && !totalCount) return noKeywordsResult(base);

  const pos1 = metricCount(metrics, 'pos_1', countByPosition(keywords, 1, 1));
  const pos2To3 = metricCount(metrics, 'pos_2_3', countByPosition(keywords, 2, 3));
  const pos4To10 = metricCount(metrics, 'pos_4_10', countByPosition(keywords, 4, 10));
  const pos11To20 = metricCount(metrics, 'pos_11_20', countByPosition(keywords, 11, 20));
  const top3Keywords = pos1 + pos2To3;
  const top10Keywords = top3Keywords + pos4To10;
  const top20Keywords = top10Keywords + pos11To20;

  return {
    ...base,
    status: 'complete',
    message: 'Organic keyword visibility data was found for this website.',
    totalRankingKeywords: totalCount || keywords.length,
    top3Keywords,
    top10Keywords,
    top20Keywords,
    top100Keywords: metricCount(metrics, 'count', totalCount || keywords.length),
    estimatedOrganicTraffic: round(firstFiniteNumber(metrics.etv), 1),
    averagePosition: averagePosition(keywords),
    highestVolumeRankingKeyword: highestVolumeKeyword(keywords),
    bestRankingMeaningfulKeyword: bestRankingMeaningfulKeyword(keywords),
    topKeywords: curatedTopKeywords(keywords, request.domain, 10),
    opportunities: detectOpportunities(keywords, 10),
  };
}

function mockKeyword(keyword, position, searchVolume, estimatedTraffic, rankingUrl = '') {
  return {
    keyword,
    position,
    searchVolume,
    estimatedTraffic,
    rankingUrl,
    cpc: null,
    mainIntent: 'commercial',
    itemType: 'organic',
    isBrandedOrNavigational: false,
  };
}

function mockKeywordsForScenario(scenario, domain) {
  if (scenario === 'strong') {
    return [
      mockKeyword('roofing company ottawa', 2, 720, 68, `https://${domain}/`),
      mockKeyword('roof repair ottawa', 3, 590, 42, `https://${domain}/roof-repair`),
      mockKeyword('emergency roof repair ottawa', 4, 390, 24, `https://${domain}/emergency-roofing`),
      mockKeyword('metal roofing ottawa', 7, 260, 13, `https://${domain}/metal-roofing`),
      mockKeyword('roof replacement ottawa', 9, 480, 18, `https://${domain}/roof-replacement`),
      mockKeyword('flat roof repair ottawa', 12, 170, 5, `https://${domain}/flat-roofing`),
    ];
  }
  if (scenario === 'weak') {
    return [
      mockKeyword('northstar roofing', 18, 40, 1, `https://${domain}/`),
      mockKeyword('roofing estimate ottawa', 34, 210, 1, `https://${domain}/contact`),
      mockKeyword('roof repair near me', 48, 880, 2, `https://${domain}/roof-repair`),
    ];
  }
  if (scenario === 'no_keywords') return [];
  if (scenario === 'near_page_one') {
    return [
      mockKeyword('roof repair ottawa', 13, 390, 7, `https://${domain}/roof-repair`),
      mockKeyword('roof replacement ottawa', 16, 480, 6, `https://${domain}/roof-replacement`),
      mockKeyword('emergency roofer ottawa', 19, 260, 3, `https://${domain}/emergency-roofing`),
      mockKeyword('metal roofing ottawa', 8, 210, 12, `https://${domain}/metal-roofing`),
    ];
  }
  return [
    mockKeyword('roofing company ottawa', 6, 590, 28, `https://${domain}/`),
    mockKeyword('roof repair ottawa', 12, 390, 9, `https://${domain}/roof-repair`),
    mockKeyword('roof replacement ottawa', 14, 320, 7, `https://${domain}/roof-replacement`),
    mockKeyword('emergency roof repair ottawa', 21, 210, 3, `https://${domain}/emergency-roofing`),
    mockKeyword('flat roof repair ottawa', 34, 170, 1, `https://${domain}/flat-roofing`),
  ];
}

function mockKeywordRankingResult(input = {}, scenario = '') {
  const startedAt = Date.now();
  const domain = normalizeDomain(input.domain || input.website || input.url) || 'northstarroofing.example';
  const countryCode = normalizeCountryCode(input.countryCode || input.country_code || input.country, domain) || 'CA';
  const languageCode = normalizeLanguageCode(input.languageCode || input.language_code);
  const normalizedScenario = cleanText(scenario || input.mockScenario || input.mock_scenario || 'moderate', 60).toLowerCase();
  if (normalizedScenario === 'provider_failure') {
    return unavailableKeywordRanking({
      domain,
      countryCode,
      languageCode,
      error: 'Mock provider failure.',
      code: 'mock_provider_failure',
      durationMs: Date.now() - startedAt,
    });
  }

  const keywords = mockKeywordsForScenario(normalizedScenario, domain);
  const totals = {
    strong: { total: 500, top3: 15, top10: 60, top20: 130, traffic: 4200 },
    weak: { total: 8, top3: 0, top10: 0, top20: 1, traffic: 18 },
    no_keywords: { total: 0, top3: 0, top10: 0, top20: 0, traffic: 0 },
    near_page_one: { total: 42, top3: 0, top10: 1, top20: 4, traffic: 110 },
    moderate: { total: 75, top3: 2, top10: 8, top20: 19, traffic: 480 },
  }[normalizedScenario] || { total: 75, top3: 2, top10: 8, top20: 19, traffic: 480 };

  const base = {
    domain,
    countryCode,
    languageCode,
    locationName: COUNTRY_NAMES[countryCode] || '',
    provider: 'static-mock',
    endpoint: DATAFORSEO_RANKED_KEYWORDS_ENDPOINT,
    datasetVersion: KEYWORD_RANKING_DATASET_VERSION,
    providerCost: 0,
    requestDurationMs: Date.now() - startedAt,
    resultCount: keywords.length,
    cacheHit: false,
    testedAt: new Date().toISOString(),
    mockScenario: normalizedScenario,
  };

  if (!keywords.length) return noKeywordsResult(base);

  return {
    ...base,
    status: 'complete',
    message: 'Organic keyword visibility data was found for this website.',
    totalRankingKeywords: totals.total,
    top3Keywords: totals.top3,
    top10Keywords: totals.top10,
    top20Keywords: totals.top20,
    top100Keywords: totals.total,
    estimatedOrganicTraffic: totals.traffic,
    averagePosition: averagePosition(keywords),
    highestVolumeRankingKeyword: highestVolumeKeyword(keywords),
    bestRankingMeaningfulKeyword: bestRankingMeaningfulKeyword(keywords),
    topKeywords: curatedTopKeywords(keywords, domain, 10),
    opportunities: detectOpportunities(keywords, 10),
  };
}

async function runKeywordRankingAnalysis(input = {}, options = {}) {
  const startedAt = Date.now();
  if (!featureEnabled() && options.ignoreFeatureFlag !== true) return disabledKeywordRanking();

  const domain = normalizeDomain(input.domain || input.website || input.websiteUrl || input.website_url || input.url);
  const countryCode = normalizeCountryCode(input.countryCode || input.country_code || input.country, domain);
  const languageCode = normalizeLanguageCode(input.languageCode || input.language_code);
  const limit = configuredLimit(options.limit ?? input.limit);

  if (!domain || !isValidDomain(domain)) {
    return unavailableKeywordRanking({
      domain,
      countryCode,
      languageCode,
      error: 'A valid domain is required for keyword ranking data.',
      code: 'domain_invalid',
      durationMs: Date.now() - startedAt,
    });
  }

  if (!countryCode || !COUNTRY_NAMES[countryCode]) {
    return unavailableKeywordRanking({
      domain,
      countryCode,
      languageCode,
      error: 'Country could not be determined reliably for keyword ranking data.',
      code: 'country_unavailable',
      durationMs: Date.now() - startedAt,
    });
  }

  console.log('[Keyword Ranking] started', { domain, countryCode, languageCode, mockMode: mockModeEnabled() });

  if (mockModeEnabled() || options.mockMode === true) {
    const result = mockKeywordRankingResult({ ...input, domain, countryCode, languageCode }, input.mockScenario || input.mock_scenario);
    console.log('[Keyword Ranking] completed', {
      domain,
      status: result.status,
      resultCount: result.resultCount,
      providerCost: 0,
      cacheHit: false,
    });
    return result;
  }

  const key = cacheKey({ domain, countryCode, languageCode });
  const cached = options.skipCache === true ? null : getCachedKeywordRanking(key);
  if (cached) {
    console.log('[Keyword Ranking] completed', {
      domain,
      status: cached.status,
      resultCount: cached.resultCount,
      providerCost: 0,
      cacheHit: true,
    });
    return cached;
  }

  const login = cleanText(process.env.DATAFORSEO_LOGIN, 320);
  const password = cleanText(process.env.DATAFORSEO_PASSWORD, 1000);
  if (!login || !password) {
    const unavailable = unavailableKeywordRanking({
      domain,
      countryCode,
      languageCode,
      error: 'DataForSEO credentials are not configured.',
      code: 'dataforseo_credentials_missing',
      durationMs: Date.now() - startedAt,
    });
    console.log('[Keyword Ranking] unavailable', { domain, code: unavailable.code, durationMs: unavailable.requestDurationMs });
    return unavailable;
  }

  const task = buildRequestTask({ domain, countryCode, languageCode, limit });
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = configuredTimeoutMs(options.timeoutMs);

  try {
    const response = await withTimeout(fetchImpl(DATAFORSEO_RANKED_KEYWORDS_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: authHeader(login, password),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([task]),
      ...(controller ? { signal: controller.signal } : {}),
    }), timeoutMs, controller);

    const responseText = await response.text().catch(() => '');
    const data = parseResponseBody(responseText);
    if (process.env.NODE_ENV !== 'production' && process.env.DATAFORSEO_DEBUG_RAW === 'true') {
      console.log('[PitchProof][Keyword Ranking][DataForSEO] Response:', JSON.stringify(data, null, 2));
    }

    if (!response.ok) {
      const unavailable = unavailableKeywordRanking({
        domain,
        countryCode,
        languageCode,
        error: `DataForSEO keyword ranking request failed with HTTP ${response.status}.`,
        code: 'dataforseo_http_error',
        durationMs: Date.now() - startedAt,
      });
      console.log('[Keyword Ranking] unavailable', { domain, code: unavailable.code, durationMs: unavailable.requestDurationMs });
      return unavailable;
    }

    if (requestFailedByProvider(data)) {
      const unavailable = unavailableKeywordRanking({
        domain,
        countryCode,
        languageCode,
        error: providerFailureMessage(data),
        code: 'dataforseo_provider_error',
        durationMs: Date.now() - startedAt,
      });
      console.log('[Keyword Ranking] unavailable', { domain, code: unavailable.code, durationMs: unavailable.requestDurationMs });
      return unavailable;
    }

    const normalized = normalizeProviderResponse(data, { domain, countryCode, languageCode }, startedAt);
    setCachedKeywordRanking(key, normalized);
    console.log('[Keyword Ranking] completed', {
      domain,
      status: normalized.status,
      resultCount: normalized.resultCount,
      providerCost: normalized.providerCost,
      cacheHit: false,
      durationMs: normalized.requestDurationMs,
    });
    return normalized;
  } catch (error) {
    const unavailable = unavailableKeywordRanking({
      domain,
      countryCode,
      languageCode,
      error: error?.name === 'AbortError' ? 'DataForSEO keyword ranking request timed out.' : (error?.message || 'DataForSEO keyword ranking request failed.'),
      code: error?.name === 'AbortError' ? 'dataforseo_timeout' : 'dataforseo_request_failed',
      durationMs: Date.now() - startedAt,
    });
    console.log('[Keyword Ranking] unavailable', { domain, code: unavailable.code, durationMs: unavailable.requestDurationMs });
    return unavailable;
  }
}

function keywordRankingFeatureEnabled() {
  return featureEnabled();
}

module.exports = {
  DATAFORSEO_RANKED_KEYWORDS_ENDPOINT,
  KEYWORD_RANKING_DATASET_VERSION,
  OPPORTUNITY_THRESHOLDS,
  normalizeDomain,
  normalizeCountryCode,
  normalizeLanguageCode,
  inferCountryCodeFromDomain,
  buildRequestTask,
  runKeywordRankingAnalysis,
  mockKeywordRankingResult,
  keywordRankingFeatureEnabled,
};
