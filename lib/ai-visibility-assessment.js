const { runAiVisibilityPrompt } = require('./dataforseo-ai-visibility');

const PROMPT_SET_VERSION = 'v1';
const DEFAULT_CONCURRENCY = 2;
const TOTAL_PROMPTS = 5;

const INTENTS = [
  'category_discovery',
  'recommendation',
  'service_specific',
  'trust_reputation',
  'high_buying_intent',
];

const CATEGORY_PATTERNS = [
  {
    test: /roof/i,
    categoryPlural: 'roofing companies',
    reputationPlural: 'roofing contractors',
    serviceTerm: 'roofing',
    serviceSpecificPlural: 'roof repair companies',
  },
  {
    test: /landscap/i,
    categoryPlural: 'landscaping companies',
    reputationPlural: 'landscaping companies',
    serviceTerm: 'landscaping',
    serviceSpecificPlural: 'landscaping companies',
  },
  {
    test: /\bhvac\b|heating|cooling|air conditioning/i,
    categoryPlural: 'HVAC companies',
    reputationPlural: 'HVAC contractors',
    serviceTerm: 'HVAC',
    serviceSpecificPlural: 'HVAC companies',
  },
  {
    test: /web design|website design/i,
    categoryPlural: 'web design agencies',
    reputationPlural: 'web design agencies',
    serviceTerm: 'web design',
    serviceSpecificPlural: 'web design agencies',
  },
];

function cleanText(value = '', maxLength = 2000) {
  return String(value || '').trim().slice(0, maxLength);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(cleanText(process.env[name], 20));
}

function clamp(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
}

function round(value, decimals = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  const factor = 10 ** decimals;
  return Math.round(parsed * factor) / factor;
}

function normalizeLocation({ city = '', region = '' } = {}) {
  const cityText = cleanText(city, 80);
  const regionText = cleanText(region, 80);
  return [cityText, regionText].filter(Boolean).join(', ');
}

function stripCompanySuffixes(value = '', maxLength = 240) {
  return cleanText(value, maxLength)
    .replace(/\b(incorporated|inc|limited|ltd|llc|llp|pllc|corp|corporation|co|company)\b\.?/gi, '')
    .replace(/\b(the)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeComparableText(value = '', maxLength = 240) {
  return stripCompanySuffixes(value, maxLength)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeBusinessName(value = '') {
  return normalizeComparableText(value);
}

function normalizeDomain(value = '') {
  const raw = cleanText(value, 500).toLowerCase();
  if (!raw) return '';
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withProtocol).hostname.replace(/^www\./i, '').replace(/\.$/, '');
  } catch {
    return raw
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split('/')[0]
      .split('?')[0]
      .replace(/\.$/, '');
  }
}

function servicePhrase(primaryService = '', businessCategory = '') {
  const service = cleanText(primaryService, 80);
  if (service) return service.toLowerCase();
  const category = cleanText(businessCategory, 120)
    .replace(/\b(contractor|company|agency|business|service|services)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (category || 'service provider').toLowerCase();
}

function pluralizeFallbackCategory(value = '') {
  const normalized = cleanText(value, 120)
    .replace(/\b(company|business|service|services)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return 'service providers';
  if (/contractor$/i.test(normalized)) return normalized.replace(/contractor$/i, 'contractors').toLowerCase();
  if (/agency$/i.test(normalized)) return normalized.replace(/agency$/i, 'agencies').toLowerCase();
  if (/designer$/i.test(normalized)) return `${normalized}s`.toLowerCase();
  if (/s$/i.test(normalized)) return normalized.toLowerCase();
  return `${normalized} companies`.toLowerCase();
}

function normalizeBusinessCategory({ businessCategory = '', primaryService = '' } = {}) {
  const combined = [businessCategory, primaryService].filter(Boolean).join(' ');
  const pattern = CATEGORY_PATTERNS.find((item) => item.test.test(combined));
  const service = servicePhrase(primaryService, businessCategory);
  if (pattern) {
    const serviceSpecificPlural = primaryService && normalizeComparableText(primaryService) !== normalizeComparableText(pattern.serviceTerm)
      ? `${service} companies`
      : pattern.serviceSpecificPlural;
    return {
      categoryPlural: pattern.categoryPlural,
      reputationPlural: pattern.reputationPlural,
      serviceTerm: service || pattern.serviceTerm,
      serviceSpecificPlural,
    };
  }

  const categoryPlural = pluralizeFallbackCategory(businessCategory || primaryService);
  return {
    categoryPlural,
    reputationPlural: categoryPlural,
    serviceTerm: service,
    serviceSpecificPlural: categoryPlural,
  };
}

function generateAiVisibilityPrompts(input = {}) {
  const location = normalizeLocation(input);
  const terms = normalizeBusinessCategory(input);
  const prompts = [
    {
      intent: 'category_discovery',
      prompt: `What are the best ${terms.categoryPlural} in ${location}?`,
    },
    {
      intent: 'recommendation',
      prompt: `Who would you recommend for ${terms.serviceTerm} in ${location}?`,
    },
    {
      intent: 'service_specific',
      prompt: `What are the best ${terms.serviceSpecificPlural} in ${location}?`,
    },
    {
      intent: 'trust_reputation',
      prompt: `What are the most reputable ${terms.reputationPlural} in ${location}?`,
    },
    {
      intent: 'high_buying_intent',
      prompt: `Who should I hire for ${terms.serviceTerm} in ${location}?`,
    },
  ];

  const seen = new Set();
  return prompts.map((item, index) => {
    let prompt = item.prompt.replace(/\s+/g, ' ').trim();
    if (seen.has(prompt.toLowerCase())) {
      prompt = prompt.replace('best ', 'best local ');
    }
    if (seen.has(prompt.toLowerCase())) {
      prompt = `${prompt.replace(/\?$/, '')} for a local project?`;
    }
    seen.add(prompt.toLowerCase());
    return { ...item, prompt, index };
  });
}

function businessAliases(businessName = '') {
  const normalized = normalizeBusinessName(businessName);
  const aliases = new Set([normalized]);
  if (normalized.includes(' and ')) aliases.add(normalized.replace(/\band\b/g, '').replace(/\s+/g, ' ').trim());
  return Array.from(aliases).filter((alias) => alias.length >= 3);
}

function containsComparablePhrase(haystack = '', needle = '') {
  const text = ` ${normalizeComparableText(haystack, 20000)} `;
  const phrase = normalizeComparableText(needle);
  if (!phrase) return false;
  return text.includes(` ${phrase} `);
}

function detectBusinessMention(text = '', { businessName = '', domain = '' } = {}) {
  const aliases = businessAliases(businessName);
  if (aliases.some((alias) => containsComparablePhrase(text, alias))) return true;

  const domainText = normalizeDomain(domain);
  if (!domainText) return false;
  return cleanText(text, 20000).toLowerCase().includes(domainText);
}

function stripMarkdown(value = '') {
  return cleanText(value, 500)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .trim();
}

function cleanCandidateName(value = '') {
  return stripCompanySuffixes(stripMarkdown(value)
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\bwww\.\S+/gi, '')
    .split(/\s[-–—:]\s/)[0]
    .split('(')[0]
    .replace(/^[#"'“”]+|[#"'“”]+$/g, '')
    .trim());
}

function extractDomainFromText(value = '') {
  const match = cleanText(value, 1000).match(/https?:\/\/[^\s)]+|(?:www\.)?[a-z0-9-]+\.[a-z]{2,}(?:\/[^\s)]*)?/i);
  return match ? normalizeDomain(match[0]) : '';
}

function isUsefulBusinessCandidate(name = '') {
  const candidate = cleanText(name, 120);
  const normalized = normalizeComparableText(candidate);
  if (!candidate || candidate.length < 3 || candidate.length > 100) return false;
  if (!/[a-z]/i.test(candidate)) return false;
  if (/^(website|phone|address|reviews?|rating|services?|why choose|notes?|pros?|cons?)$/i.test(candidate)) return false;
  if (normalized.split(' ').length < 2 && !/(hvac|seo|web|roof|landscap)/i.test(normalized)) return false;
  return true;
}

function extractRecommendationEntries(text = '') {
  const normalizedText = cleanText(text, 20000)
    .replace(/(\d{1,2}[.)])\s+/g, '\n$1 ')
    .replace(/([•*])\s+/g, '\n$1 ');
  const lines = normalizedText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const entries = [];

  for (const line of lines) {
    const match = line.match(/^(?:\d{1,2}[.)]|[-*•])\s+(.+)$/);
    if (!match) continue;
    const raw = match[1];
    const businessName = cleanCandidateName(raw);
    if (!isUsefulBusinessCandidate(businessName)) continue;
    entries.push({
      businessName,
      domain: extractDomainFromText(raw),
      position: entries.length + 1,
      raw: cleanText(line, 500),
    });
    if (entries.length >= 15) break;
  }

  return entries;
}

function entryMatchesBusiness(entry = {}, business = {}) {
  return detectBusinessMention(entry.businessName, business) ||
    (entry.domain && normalizeDomain(entry.domain) === normalizeDomain(business.domain));
}

function recommendationPosition(text = '', business = {}) {
  const match = extractRecommendationEntries(text).find((entry) => entryMatchesBusiness(entry, business));
  return match ? match.position : null;
}

function detectCitation(citedUrls = [], domain = '') {
  const targetDomain = normalizeDomain(domain);
  if (!targetDomain) return false;
  return asArray(citedUrls).some((citation) => {
    const citationDomain = normalizeDomain(asRecord(citation).url || citation);
    return citationDomain === targetDomain || citationDomain.endsWith(`.${targetDomain}`);
  });
}

function competitorEntries(text = '', business = {}) {
  return extractRecommendationEntries(text)
    .filter((entry) => !entryMatchesBusiness(entry, business))
    .map((entry) => ({
      businessName: entry.businessName,
      domain: entry.domain,
      position: entry.position,
    }));
}

function analyzePromptResponse({ intent, prompt, response, business }) {
  const providerResponse = asRecord(response);
  if (!providerResponse.success) {
    return {
      intent,
      prompt,
      success: false,
      mentioned: false,
      recommended: false,
      position: null,
      cited: false,
      competitors: [],
      cost: round(providerResponse.cost || providerResponse.moneySpent, 6),
      durationMs: Number(providerResponse.durationMs) || 0,
      error: cleanText(providerResponse.error, 500),
      code: cleanText(providerResponse.code, 80),
      disabled: providerResponse.disabled === true,
    };
  }

  const responseText = cleanText(providerResponse.responseText, 20000);
  const mentioned = detectBusinessMention(responseText, business);
  const position = recommendationPosition(responseText, business);
  const recommended = hasPosition(position);
  const cited = detectCitation(providerResponse.citedUrls, business.domain);

  return {
    intent,
    prompt,
    success: true,
    mentioned,
    recommended,
    position,
    cited,
    competitors: competitorEntries(responseText, business).slice(0, 10),
    cost: round(providerResponse.cost || providerResponse.moneySpent, 6),
    durationMs: Number(providerResponse.durationMs) || 0,
    model: cleanText(providerResponse.model, 80),
    provider: cleanText(providerResponse.provider, 80),
  };
}

function positionToScore(position) {
  if (position === null || position === undefined || position === '') return 0;
  const value = Number(position);
  if (!Number.isFinite(value)) return 0;
  if (value <= 1) return 100;
  if (value === 2) return 90;
  if (value === 3) return 80;
  if (value === 4) return 70;
  if (value === 5) return 60;
  if (value === 6) return 50;
  if (value === 7) return 40;
  if (value === 8) return 30;
  if (value === 9) return 20;
  if (value === 10) return 10;
  return 5;
}

function hasPosition(position) {
  return position !== null && position !== undefined && position !== '' && Number.isFinite(Number(position));
}

function scoreLabel(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return 'Unavailable';
  if (value <= 24) return 'Very Low';
  if (value <= 49) return 'Low';
  if (value <= 69) return 'Moderate';
  if (value <= 84) return 'Strong';
  return 'Very Strong';
}

function summaryForLabel(label) {
  if (label === 'Very Strong') {
    return 'This business has strong visibility across representative AI recommendation searches and is consistently surfaced for high-intent local queries.';
  }
  if (label === 'Strong') {
    return 'This business appears consistently across AI recommendation searches, although some competitors are still being surfaced more frequently or in stronger positions.';
  }
  if (label === 'Moderate') {
    return 'This business appears in some AI-generated recommendations, but visibility is inconsistent across different buyer-intent searches.';
  }
  return 'This business has very limited visibility across representative AI recommendation searches. Competitors are being surfaced more consistently for high-intent local queries.';
}

function calculateScore(queryResults = []) {
  const successful = queryResults.filter((query) => query.success);
  const denominator = successful.length;
  if (denominator < 3) {
    return {
      status: 'insufficient_data',
      score: null,
      label: 'Unavailable',
      recommendationFrequency: 0,
      positionScore: 0,
      citationScore: 0,
      intentCoverage: 0,
    };
  }

  const recommendations = successful.filter((query) => query.recommended).length;
  const citations = successful.filter((query) => query.cited).length;
  const recommendationFrequency = (recommendations / denominator) * 100;
  const positionScore = successful.reduce((sum, query) => sum + positionToScore(query.position), 0) / denominator;
  const citationScore = (citations / denominator) * 100;
  const intentCoverage = (new Set(successful.filter((query) => query.recommended).map((query) => query.intent)).size / denominator) * 100;
  const score = clamp(Math.round(
    recommendationFrequency * 0.50 +
    positionScore * 0.30 +
    citationScore * 0.10 +
    intentCoverage * 0.10
  ), 0, 100);

  return {
    status: 'complete',
    score,
    label: scoreLabel(score),
    recommendationFrequency: round(recommendationFrequency, 2),
    positionScore: round(positionScore, 2),
    citationScore: round(citationScore, 2),
    intentCoverage: round(intentCoverage, 2),
  };
}

function aggregateCompetitors(queryResults = [], limit = 5) {
  const byName = new Map();
  queryResults.forEach((query) => {
    if (!query.success) return;
    query.competitors.forEach((competitor) => {
      const key = normalizeBusinessName(competitor.businessName);
      if (!key) return;
      const existing = byName.get(key) || {
        businessName: competitor.businessName,
        domain: competitor.domain || '',
        appearances: 0,
        positions: [],
      };
      existing.appearances += 1;
      if (competitor.domain && !existing.domain) existing.domain = competitor.domain;
      if (Number.isFinite(Number(competitor.position))) existing.positions.push(Number(competitor.position));
      byName.set(key, existing);
    });
  });

  return Array.from(byName.values())
    .map((competitor) => ({
      businessName: competitor.businessName,
      ...(competitor.domain ? { domain: competitor.domain } : {}),
      appearances: competitor.appearances,
      positions: competitor.positions,
      averagePosition: competitor.positions.length
        ? round(competitor.positions.reduce((sum, value) => sum + value, 0) / competitor.positions.length, 2)
        : null,
    }))
    .sort((a, b) => b.appearances - a.appearances || (a.averagePosition || 99) - (b.averagePosition || 99))
    .slice(0, limit);
}

function missedOpportunities(queryResults = []) {
  return queryResults
    .filter((query) => query.success && !query.recommended && query.competitors.length)
    .map((query) => ({
      prompt: query.prompt,
      competitorsShown: query.competitors.slice(0, 3).map((competitor) => competitor.businessName),
    }))
    .slice(0, 3);
}

function costSummary(queryResults = []) {
  const totalCost = round(queryResults.reduce((sum, query) => sum + (Number(query.cost) || 0), 0), 6);
  const successfulRequests = queryResults.filter((query) => query.success).length;
  const failedRequests = queryResults.length - successfulRequests;
  return {
    totalCost,
    averageCostPerPrompt: successfulRequests ? round(totalCost / successfulRequests, 6) : 0,
    successfulRequests,
    failedRequests,
  };
}

function aggregateAssessmentResults(input = {}, prompts = [], queryResults = []) {
  const successful = queryResults.filter((query) => query.success);
  const disabled = queryResults.length > 0 && queryResults.every((query) => query.disabled);
  const scoring = disabled
    ? { status: 'disabled', score: null, label: 'Unavailable' }
    : calculateScore(queryResults);
  const costs = costSummary(queryResults);
  const mentions = successful.filter((query) => query.mentioned).length;
  const recommendations = successful.filter((query) => query.recommended).length;
  const citations = successful.filter((query) => query.cited).length;
  const positions = successful.map((query) => query.position).filter(hasPosition);

  return {
    status: scoring.status,
    score: scoring.score,
    label: scoring.label,
    promptSetVersion: PROMPT_SET_VERSION,
    promptsPlanned: prompts.length,
    promptsTested: successful.length,
    mentions,
    recommendations,
    citations,
    mentionRate: successful.length ? round((mentions / successful.length) * 100, 2) : 0,
    recommendationRate: successful.length ? round((recommendations / successful.length) * 100, 2) : 0,
    citationRate: successful.length ? round((citations / successful.length) * 100, 2) : 0,
    averagePosition: positions.length ? round(positions.reduce((sum, value) => sum + Number(value), 0) / positions.length, 2) : null,
    scoring: {
      recommendationFrequency: scoring.recommendationFrequency ?? 0,
      positionScore: scoring.positionScore ?? 0,
      citationScore: scoring.citationScore ?? 0,
      intentCoverage: scoring.intentCoverage ?? 0,
      formula: 'recommendationFrequency*0.50 + positionScore*0.30 + citationScore*0.10 + intentCoverage*0.10',
      denominator: successful.length,
    },
    queries: queryResults,
    competitors: aggregateCompetitors(queryResults),
    missedOpportunities: missedOpportunities(queryResults),
    summary: scoring.status === 'complete' ? summaryForLabel(scoring.label) : 'AI visibility could not be scored because fewer than three standardized prompts returned usable results.',
    provider: 'dataforseo',
    model: cleanText(successful.find((query) => query.model)?.model || 'gpt-4o-mini', 80),
    ...costs,
    input: {
      businessName: cleanText(input.businessName, 160),
      domain: normalizeDomain(input.domain),
      businessCategory: cleanText(input.businessCategory, 120),
      primaryService: cleanText(input.primaryService, 120),
      city: cleanText(input.city, 80),
      region: cleanText(input.region, 80),
      countryCode: cleanText(input.countryCode, 8).toUpperCase(),
    },
    testedAt: new Date().toISOString(),
  };
}

function mockModeEnabled() {
  return envFlag('AI_VISIBILITY_MOCK_MODE');
}

function mockScenarioName(input = {}) {
  return cleanText(input.mockScenario || process.env.AI_VISIBILITY_MOCK_SCENARIO || 'appears_3_of_5', 80);
}

function mockBusinessList({ businessName, domain, includeBusiness, position = 3, cited = false } = {}) {
  const competitors = ['Stewart Roofing', 'Sanderson Roofing', 'Taylor Roofing', 'Capital Roof Pros', 'Ottawa Exterior Group'];
  const lines = competitors.slice(0, 5).map((name, index) => `${index + 1}. ${name} - Established local roofing contractor.`);
  if (includeBusiness) {
    const safePosition = clamp(position, 1, 6);
    lines.splice(safePosition - 1, 0, `${safePosition}. ${businessName} - Local roofing contractor${cited ? ` (${domain})` : ''}.`);
  }
  return lines.map((line, index) => line.replace(/^\d+/, String(index + 1))).join('\n');
}

function mockProviderResponse({ promptIndex, input, scenario }) {
  const scenarioMap = {
    appears_0_of_5: { appearances: [], citations: [], failures: [] },
    appears_1_of_5: { appearances: [0], citations: [0], failures: [] },
    appears_3_of_5: { appearances: [0, 1, 4], citations: [0, 4], failures: [] },
    appears_5_of_5: { appearances: [0, 1, 2, 3, 4], citations: [0, 1, 2, 3, 4], failures: [] },
    mixed_citations: { appearances: [0, 1, 2, 3, 4], citations: [1, 3], failures: [] },
    mixed_positions: { appearances: [0, 1, 2, 3, 4], citations: [0, 2, 4], failures: [], positions: [1, 5, 9, 2, 7] },
    one_provider_failure: { appearances: [0, 1, 3, 4], citations: [0, 4], failures: [2] },
    three_provider_failures: { appearances: [0, 4], citations: [0], failures: [1, 2, 3] },
  };
  const config = scenarioMap[scenario] || scenarioMap.appears_3_of_5;
  if (config.failures.includes(promptIndex)) {
    return {
      success: false,
      error: 'Mock provider failure.',
      code: 'mock_provider_failure',
      provider: 'dataforseo',
      cost: 0,
      durationMs: 0,
    };
  }

  const includeBusiness = config.appearances.includes(promptIndex);
  const cited = config.citations.includes(promptIndex);
  const position = config.positions ? config.positions[promptIndex] : (promptIndex % 3) + 2;
  return {
    success: true,
    responseText: mockBusinessList({
      businessName: input.businessName,
      domain: input.domain,
      includeBusiness,
      position,
      cited,
    }),
    citedUrls: cited ? [{ title: input.businessName, url: `https://${normalizeDomain(input.domain)}/` }] : [],
    fanOutQueries: [],
    cost: 0,
    durationMs: 0,
    provider: 'dataforseo',
    model: 'gpt-4o-mini',
  };
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function assessmentConcurrency() {
  const parsed = Number(process.env.AI_VISIBILITY_ASSESSMENT_CONCURRENCY);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CONCURRENCY;
  return Math.max(1, Math.min(5, Math.round(parsed)));
}

function validateAssessmentInput(input = {}) {
  const body = asRecord(input);
  const required = ['businessName', 'domain', 'businessCategory', 'city', 'countryCode'];
  const missing = required.filter((key) => !cleanText(body[key]));
  if (missing.length) {
    return {
      valid: false,
      error: `Missing required fields: ${missing.join(', ')}.`,
      code: 'ai_visibility_assessment_invalid_input',
    };
  }
  return { valid: true };
}

async function runAiVisibilityAssessment(input = {}, options = {}) {
  const validation = validateAssessmentInput(input);
  if (!validation.valid) {
    return {
      status: 'invalid_input',
      score: null,
      label: 'Unavailable',
      error: validation.error,
      code: validation.code,
      provider: 'dataforseo',
      promptSetVersion: PROMPT_SET_VERSION,
      testedAt: new Date().toISOString(),
    };
  }

  const prompts = generateAiVisibilityPrompts(input);
  const mock = options.mockMode ?? mockModeEnabled();
  const scenario = mockScenarioName(input);
  const countryCode = cleanText(input.countryCode, 8).toUpperCase();
  const city = cleanText(input.city, 80);

  const queryResults = await mapWithConcurrency(prompts, options.concurrency || assessmentConcurrency(), async (promptItem, index) => {
    const response = mock
      ? mockProviderResponse({ promptIndex: index, input, scenario })
      : await runAiVisibilityPrompt({
        prompt: promptItem.prompt,
        countryCode,
        city,
      });
    return analyzePromptResponse({
      intent: promptItem.intent,
      prompt: promptItem.prompt,
      response,
      business: input,
    });
  });

  return {
    ...aggregateAssessmentResults(input, prompts, queryResults),
    mockMode: mock,
    ...(mock ? { mockScenario: scenario } : {}),
  };
}

module.exports = {
  PROMPT_SET_VERSION,
  aggregateAssessmentResults,
  aggregateCompetitors,
  analyzePromptResponse,
  calculateScore,
  competitorEntries,
  detectBusinessMention,
  detectCitation,
  generateAiVisibilityPrompts,
  normalizeBusinessCategory,
  normalizeBusinessName,
  normalizeDomain,
  positionToScore,
  recommendationPosition,
  runAiVisibilityAssessment,
  scoreLabel,
};
