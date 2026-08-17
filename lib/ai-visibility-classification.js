function cleanText(value = '', maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength);
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function countValue(value) {
  const parsed = numberOrNull(value);
  if (parsed === null) return 0;
  return Math.max(0, Math.round(parsed));
}

function hasInsufficientData({ status = '', successfulRequests, promptsTested } = {}) {
  const normalizedStatus = cleanText(status, 80).toLowerCase();
  if (['insufficient_data', 'disabled', 'invalid_input'].includes(normalizedStatus)) return true;
  const successful = numberOrNull(successfulRequests);
  if (successful !== null) return successful < 3;
  const prompts = numberOrNull(promptsTested);
  return normalizedStatus && normalizedStatus !== 'complete' && prompts !== null && prompts < 3;
}

function visibilityLevelFromRecommendations(input = {}) {
  if (hasInsufficientData(input)) return 'Insufficient Data';
  const recommendations = countValue(input.recommendationCount ?? input.recommendations ?? input.recommendation_count);
  if (recommendations <= 0) return 'Not Mentioned';
  if (recommendations === 1) return 'Low Visibility';
  if (recommendations <= 3) return 'Some Visibility';
  if (recommendations === 4) return 'Strong Visibility';
  return 'Very Strong Visibility';
}

function visibilityTone(level = '') {
  switch (cleanText(level, 80)) {
    case 'Not Mentioned':
    case 'Low Visibility':
      return 'high';
    case 'Some Visibility':
      return 'medium';
    case 'Strong Visibility':
    case 'Very Strong Visibility':
      return 'low';
    case 'Insufficient Data':
    default:
      return 'partial';
  }
}

function visibilitySummary(input = {}) {
  const level = cleanText(input.level || visibilityLevelFromRecommendations(input), 80);
  const recommendations = countValue(input.recommendationCount ?? input.recommendations ?? input.recommendation_count);
  const prompts = Math.max(1, countValue(input.promptsTested ?? input.prompts_tested) || 5);
  const competitors = countValue(input.competitorCount ?? input.competitors_found);

  if (level === 'Insufficient Data') {
    return 'Not enough AI recommendation searches completed successfully to produce a reliable visibility assessment.';
  }
  if (level === 'Not Mentioned') {
    return competitors > 0
      ? `Your business was not surfaced in any of the ${prompts} representative AI recommendation searches tested. Competing businesses were recommended instead across these high-intent local searches.`
      : `Your business was not surfaced in any of the ${prompts} representative AI recommendation searches tested. No clear competitor recommendations were extracted from the usable searches.`;
  }
  if (level === 'Low Visibility') {
    return `Your business appeared in only 1 of ${prompts} representative AI recommendation searches. AI visibility is currently limited, with competitors appearing more consistently across relevant buyer searches.`;
  }
  if (level === 'Some Visibility') {
    return `Your business appeared in ${recommendations} of ${prompts} representative AI recommendation searches, but visibility is inconsistent depending on what potential customers ask.`;
  }
  if (level === 'Strong Visibility') {
    return `Your business appeared in 4 of ${prompts} representative AI recommendation searches and is being surfaced consistently for high-intent local queries.`;
  }
  if (level === 'Very Strong Visibility') {
    return `Your business appeared across all ${prompts} representative AI recommendation searches, indicating very strong visibility across the buyer-intent queries tested.`;
  }
  return 'AI visibility data is unavailable for this report.';
}

function visibilityClassification(input = {}) {
  const level = visibilityLevelFromRecommendations(input);
  return {
    level,
    tone: visibilityTone(level),
    summary: visibilitySummary({ ...input, level }),
  };
}

module.exports = {
  visibilityClassification,
  visibilityLevelFromRecommendations,
  visibilitySummary,
  visibilityTone,
};
