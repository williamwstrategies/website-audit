const OPPORTUNITY_WEIGHTS = Object.freeze({
  websiteNeed: 0.55,
  conversionNeed: 0.15,
  seoNeed: 0.10,
  trustNeed: 0.10,
  businessQuality: 0.10,
});

function cleanText(value = '', maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength);
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clamp(value, min = 0, max = 100) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
}

function round(value, precision = 0) {
  const factor = 10 ** precision;
  return Math.round(Number(value || 0) * factor) / factor;
}

function reportRoot(report = {}) {
  const root = asRecord(report);
  const nested = asRecord(root.report);
  return Object.keys(nested).length ? nested : root;
}

function normalizedMax(score, max) {
  const numericMax = Number(max);
  if (Number.isFinite(numericMax) && numericMax > 0) return numericMax;
  const numericScore = Number(score);
  if (Number.isFinite(numericScore) && numericScore > 100) return numericScore;
  return 100;
}

function scorePercent(score, max = 100) {
  const numericScore = Number(score);
  if (!Number.isFinite(numericScore)) return null;
  const numericMax = normalizedMax(numericScore, max);
  if (!numericMax) return null;
  return clamp((numericScore / numericMax) * 100);
}

function getCategoryDisplay(key = '', label = '') {
  const normalized = `${key} ${label}`.toLowerCase();
  const fallback = cleanText(label || key);
  if (normalized.includes('lead') || normalized.includes('conversion')) return 'conversion';
  if (normalized.includes('seo') || normalized.includes('visibility')) return 'seo';
  if (normalized.includes('trust') || normalized.includes('local') || normalized.includes('credibility')) return 'trust';
  if (normalized.includes('technical') || normalized.includes('performance') || normalized.includes('speed')) return 'technical';
  return fallback.toLowerCase();
}

function normalizedCategories(report = {}) {
  const root = reportRoot(report);
  const categories = asRecord(root.categories);
  return Object.entries(categories).map(([key, rawCategory]) => {
    const category = asRecord(rawCategory);
    const score = firstFiniteNumber(category.score, category.value, rawCategory);
    const max = normalizedMax(score, category.max);
    const label = cleanText(category.label || key);
    return {
      key,
      label,
      canonical: getCategoryDisplay(key, label),
      score,
      max,
      percent: scorePercent(score, max),
    };
  });
}

function categoryNeed(report, terms, fallbackNeed) {
  const categories = normalizedCategories(report);
  const match = categories.find(category => {
    const haystack = `${category.key} ${category.label} ${category.canonical}`.toLowerCase();
    return terms.some(term => haystack.includes(term));
  });
  if (!match || !Number.isFinite(match.percent)) return fallbackNeed;
  return clamp(100 - match.percent);
}

function businessQualityScore({ rating, reviewCount, isClaimed } = {}) {
  const numericRating = firstFiniteNumber(rating);
  const numericReviews = firstFiniteNumber(reviewCount);

  let ratingScore = 18;
  if (Number.isFinite(numericRating)) {
    if (numericRating >= 4.7) ratingScore = 48;
    else if (numericRating >= 4.4) ratingScore = 44;
    else if (numericRating >= 4.0) ratingScore = 38;
    else if (numericRating >= 3.5) ratingScore = 28;
    else if (numericRating >= 3.0) ratingScore = 18;
    else if (numericRating > 0) ratingScore = 8;
  }

  let reviewScore = 0;
  if (Number.isFinite(numericReviews)) {
    if (numericReviews >= 200) reviewScore = 44;
    else if (numericReviews >= 100) reviewScore = 38;
    else if (numericReviews >= 50) reviewScore = 30;
    else if (numericReviews >= 20) reviewScore = 22;
    else if (numericReviews >= 10) reviewScore = 16;
    else if (numericReviews > 0) reviewScore = 8;
  }

  return clamp(ratingScore + reviewScore + (isClaimed === true ? 8 : 0));
}

function opportunityLabel(score, state = '') {
  if (state === 'no_website') return 'No Website - High Opportunity';
  const value = Number(score);
  if (value >= 80) return 'Very High Opportunity';
  if (value >= 65) return 'High Opportunity';
  if (value >= 45) return 'Moderate Opportunity';
  if (value >= 25) return 'Low Opportunity';
  return 'Very Low Opportunity';
}

function buildReasons({ state, scoreInputs }) {
  if (state === 'no_website') {
    return [
      'No website was found, creating a clear opening for a new website conversation.',
      'A business with visible public presence but no site can be easier to position as a website opportunity.',
    ];
  }

  const reasons = [];
  if (scoreInputs.websiteNeed >= 40) {
    reasons.push('Overall website health leaves meaningful room for improvement.');
  } else if (scoreInputs.websiteNeed <= 20) {
    reasons.push('The website appears relatively healthy, so the opportunity is less urgent.');
  }
  if (scoreInputs.conversionNeed >= 35) {
    reasons.push('Conversion signals suggest the site may not be turning enough visitors into enquiries.');
  }
  if (scoreInputs.seoNeed >= 35) {
    reasons.push('SEO visibility signals suggest local search improvements may be worth discussing.');
  }
  if (scoreInputs.trustNeed >= 35) {
    reasons.push('Trust and credibility signals could be strengthened before asking visitors to take action.');
  }
  if (scoreInputs.businessQuality >= 60) {
    reasons.push('The business has enough review or rating proof to make website improvements more commercially relevant.');
  } else if (scoreInputs.businessQuality <= 25) {
    reasons.push('Public review proof is limited, so the sales angle should focus on trust building.');
  }
  return reasons.slice(0, 4);
}

function calculateOpportunityScore(input = {}) {
  const hasWebsite = input.hasWebsite !== false && Boolean(cleanText(input.website || input.websiteUrl || input.domain || 'website'));
  if (!hasWebsite) {
    return {
      score: 92,
      label: opportunityLabel(92, 'no_website'),
      state: 'no_website',
      weights: OPPORTUNITY_WEIGHTS,
      inputs: {
        websiteNeed: 100,
        conversionNeed: 100,
        seoNeed: 100,
        trustNeed: 100,
        businessQuality: businessQualityScore(input),
      },
      reasons: buildReasons({ state: 'no_website', scoreInputs: {} }),
    };
  }

  const root = reportRoot(input.report || input.reportData || {});
  const overallScore = firstFiniteNumber(
    input.websiteScore,
    root.total,
    root.score,
    root.websiteScore,
    root.rating
  );
  const overallPercent = scorePercent(overallScore, root.maxScore || input.maxScore || 100);
  const websiteNeed = Number.isFinite(overallPercent) ? clamp(100 - overallPercent) : 50;
  const scoreInputs = {
    websiteNeed,
    conversionNeed: categoryNeed(root, ['conversion', 'lead'], websiteNeed),
    seoNeed: categoryNeed(root, ['seo', 'visibility'], websiteNeed),
    trustNeed: categoryNeed(root, ['trust', 'credibility', 'local'], websiteNeed),
    businessQuality: businessQualityScore(input),
  };
  const score = round(
    scoreInputs.websiteNeed * OPPORTUNITY_WEIGHTS.websiteNeed +
      scoreInputs.conversionNeed * OPPORTUNITY_WEIGHTS.conversionNeed +
      scoreInputs.seoNeed * OPPORTUNITY_WEIGHTS.seoNeed +
      scoreInputs.trustNeed * OPPORTUNITY_WEIGHTS.trustNeed +
      scoreInputs.businessQuality * OPPORTUNITY_WEIGHTS.businessQuality
  );

  return {
    score: clamp(score),
    label: opportunityLabel(score),
    state: 'scored',
    weights: OPPORTUNITY_WEIGHTS,
    inputs: Object.fromEntries(Object.entries(scoreInputs).map(([key, value]) => [key, round(value, 1)])),
    reasons: buildReasons({ state: 'scored', scoreInputs }),
  };
}

module.exports = {
  OPPORTUNITY_WEIGHTS,
  businessQualityScore,
  calculateOpportunityScore,
  normalizedCategories,
  opportunityLabel,
  scorePercent,
};
