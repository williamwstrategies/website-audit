function cleanText(value) {
  return String(value || '').trim();
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function featureEnabled() {
  return /^(1|true|yes|on)$/i.test(cleanText(process.env.AI_VISIBILITY_WEBSITE_SCAN_ENABLED));
}

function scoreLabel(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return 'Unavailable';
  if (value < 2.5) return 'Very Low';
  if (value < 5) return 'Low';
  if (value < 7) return 'Moderate';
  if (value < 8.5) return 'Strong';
  return 'Very Strong';
}

function safeRate(count, total) {
  const numerator = Number(count);
  const denominator = Number(total);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function normalizeAiVisibility(input = {}) {
  const data = asRecord(input);
  const promptsTested = Math.max(0, Number(data.promptsTested || data.prompts_tested) || 0);
  const mentions = Math.max(0, Number(data.mentions) || 0);
  const recommendations = Math.max(0, Number(data.recommendations) || 0);
  const citations = Math.max(0, Number(data.citations) || 0);
  const score = Number(data.score);
  const normalizedScore = Number.isFinite(score) ? Math.max(0, Math.min(10, Math.round(score * 10) / 10)) : null;

  return {
    status: cleanText(data.status) || (normalizedScore === null ? 'unavailable' : 'complete'),
    beta: data.beta !== false,
    score: normalizedScore,
    maxScore: 10,
    label: cleanText(data.label) || scoreLabel(normalizedScore),
    mentionRate: data.mentionRate ?? data.mention_rate ?? safeRate(mentions, promptsTested),
    recommendationRate: data.recommendationRate ?? data.recommendation_rate ?? safeRate(recommendations, promptsTested),
    citationRate: data.citationRate ?? data.citation_rate ?? safeRate(citations, promptsTested),
    promptsTested,
    mentions,
    recommendations,
    citations,
    competitorShareOfVoice: data.competitorShareOfVoice ?? data.competitor_share_of_voice ?? null,
    strongestTopic: cleanText(data.strongestTopic || data.strongest_topic),
    biggestGap: cleanText(data.biggestGap || data.biggest_gap),
    summary: cleanText(data.summary),
    testedAt: cleanText(data.testedAt || data.tested_at) || new Date().toISOString(),
    provider: cleanText(data.provider),
    disclaimer: cleanText(data.disclaimer) || 'Based on a sample of representative AI recommendation searches. Results may vary by platform, prompt, location, and time.',
    opportunities: asArray(data.opportunities).map(cleanText).filter(Boolean).slice(0, 4),
  };
}

function unavailableAiVisibility(reason = 'AI visibility data unavailable for this scan.') {
  return normalizeAiVisibility({
    status: 'unavailable',
    score: null,
    promptsTested: 0,
    mentions: 0,
    recommendations: 0,
    citations: 0,
    summary: cleanText(reason) || 'AI visibility data unavailable for this scan.',
    provider: cleanText(process.env.AI_VISIBILITY_PROVIDER),
  });
}

function demoAiVisibility() {
  return normalizeAiVisibility({
    status: 'complete',
    score: 2.2,
    promptsTested: 15,
    mentions: 2,
    recommendations: 1,
    citations: 1,
    strongestTopic: 'General roofing company searches',
    biggestGap: 'Emergency repair and service-area recommendation prompts',
    summary: 'This business has limited visibility across representative AI recommendation searches. Several competitors appear more frequently for high-intent local queries.',
    provider: 'static-demo',
    opportunities: [
      'Strengthen clear service and location content.',
      'Add more detailed service pages for high-intent searches.',
      'Improve consistent business information across trusted sources.',
      'Earn reputable third-party mentions that reinforce local authority.',
    ],
  });
}

function buildRepresentativePrompts({ businessName = '', service = '', location = '' } = {}) {
  const serviceLabel = cleanText(service) || 'service provider';
  const locationLabel = cleanText(location) || 'my area';
  const businessLabel = cleanText(businessName);
  return [
    `Best ${serviceLabel}s in ${locationLabel}`,
    `Recommended ${serviceLabel} in ${locationLabel}`,
    `Who should I hire for ${serviceLabel} in ${locationLabel}?`,
    `Top-rated ${serviceLabel}s near ${locationLabel}`,
    `${serviceLabel} company for urgent help in ${locationLabel}`,
    `Most trusted ${serviceLabel} near ${locationLabel}`,
    ...(businessLabel ? [`Is ${businessLabel} recommended for ${serviceLabel} in ${locationLabel}?`] : []),
  ].slice(0, 20);
}

async function analyzeAiVisibility(result = {}, context = {}) {
  if (!featureEnabled()) return null;

  try {
    const provider = cleanText(process.env.AI_VISIBILITY_PROVIDER || 'none').toLowerCase();
    if (!provider || provider === 'none') {
      return unavailableAiVisibility('AI visibility data unavailable for this scan.');
    }

    return unavailableAiVisibility('AI visibility provider is not connected yet.');
  } catch (error) {
    console.warn('[PitchProof] AI visibility unavailable:', error?.message || error);
    return unavailableAiVisibility('AI visibility data unavailable for this scan.');
  }
}

async function enrichReportWithAiVisibility(result = {}, context = {}) {
  const aiVisibility = await analyzeAiVisibility(result, context);
  if (!aiVisibility) return result;
  return {
    ...result,
    aiVisibility,
  };
}

module.exports = {
  buildRepresentativePrompts,
  demoAiVisibility,
  enrichReportWithAiVisibility,
  featureEnabled,
  normalizeAiVisibility,
  scoreLabel,
  unavailableAiVisibility,
};
