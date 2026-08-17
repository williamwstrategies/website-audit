const test = require('node:test');
const assert = require('node:assert/strict');

const {
  aggregateCompetitors,
  aggregateAssessmentResults,
  analyzePromptResponse,
  calculateScore,
  detectBusinessMention,
  detectCitation,
  generateAiVisibilityPrompts,
  normalizeBusinessCategory,
  normalizeBusinessName,
  normalizeDomain,
  recommendationPosition,
  runAiVisibilityAssessment,
  scoreLabel,
} = require('../lib/ai-visibility-assessment');

const roofingInput = {
  businessName: 'Intricate Roofing & Contracting',
  domain: 'https://www.intricateroofing.com/',
  businessCategory: 'Roofing Contractor',
  primaryService: 'Roofing',
  city: 'Ottawa',
  region: 'Ontario',
  countryCode: 'CA',
};

test('generates exactly five deterministic prompts without the business name', () => {
  const prompts = generateAiVisibilityPrompts(roofingInput);
  assert.equal(prompts.length, 5);
  assert.deepEqual(prompts.map((item) => item.intent), [
    'category_discovery',
    'recommendation',
    'service_specific',
    'trust_reputation',
    'high_buying_intent',
  ]);
  assert.equal(new Set(prompts.map((item) => item.prompt)).size, 5);
  assert.equal(prompts.some((item) => item.prompt.includes('Intricate')), false);
  assert.equal(prompts[0].prompt, 'What are the best roofing companies in Ottawa, Ontario?');
});

test('normalizes common and fallback business categories', () => {
  assert.equal(normalizeBusinessCategory({ businessCategory: 'Roofing Contractor' }).categoryPlural, 'roofing companies');
  assert.equal(normalizeBusinessCategory({ businessCategory: 'Concrete Contractor' }).categoryPlural, 'concrete contractors');
  assert.equal(normalizeBusinessCategory({ businessCategory: 'Web Design Agency' }).categoryPlural, 'web design agencies');
});

test('normalizes business names and domains', () => {
  assert.equal(normalizeBusinessName('Intricate Roofing & Contracting Ltd.'), 'intricate roofing and contracting');
  assert.equal(normalizeDomain('https://www.Example.com/path?x=1'), 'example.com');
});

test('detects business mentions without broad fuzzy matching', () => {
  const text = '3. Intricate Roofing and Contracting - a local roofing contractor.';
  assert.equal(detectBusinessMention(text, roofingInput), true);
  assert.equal(detectBusinessMention('3. Intrigue Roof Group - a local contractor.', roofingInput), false);
});

test('detects business mentions beyond the first few recommendation lines', () => {
  const text = [
    '1. Stewart Roofing - Established local roofing contractor.',
    '2. Sanderson Roofing - Established local roofing contractor.',
    '3. Taylor Roofing - Established local roofing contractor.',
    '4. Capital Roof Pros - Established local roofing contractor.',
    '5. Intricate Roofing & Contracting - Local roofing contractor.',
    '6. Ottawa Exterior Group - Established local roofing contractor.',
  ].join('\n');
  assert.equal(detectBusinessMention(text, roofingInput), true);
  assert.equal(recommendationPosition(text, roofingInput), 5);
});

test('extracts recommendation position from ordered lists', () => {
  const text = [
    '1. Stewart Roofing - local contractor.',
    '2. Sanderson Roofing - local contractor.',
    '3. Intricate Roofing and Contracting - local contractor.',
  ].join('\n');
  assert.equal(recommendationPosition(text, roofingInput), 3);
  assert.equal(recommendationPosition('Stewart Roofing is commonly mentioned.', roofingInput), null);
});

test('detects domain citations with URL normalization', () => {
  assert.equal(detectCitation([{ title: 'Intricate', url: 'https://www.intricateroofing.com/services' }], roofingInput.domain), true);
  assert.equal(detectCitation([{ title: 'Other', url: 'https://example.com' }], roofingInput.domain), false);
});

test('aggregates competitors safely from recommendation entries', () => {
  const competitors = aggregateCompetitors([
    {
      success: true,
      competitors: [
        { businessName: 'Stewart Roofing', position: 1 },
        { businessName: 'Sanderson Roofing', position: 2 },
      ],
    },
    {
      success: true,
      competitors: [
        { businessName: 'Stewart Roofing', position: 2 },
      ],
    },
  ]);
  assert.equal(competitors[0].businessName, 'Stewart Roofing');
  assert.equal(competitors[0].appearances, 2);
  assert.equal(competitors[0].averagePosition, 1.5);
});

test('calculates score and labels from deterministic query results', () => {
  const score = calculateScore([
    { success: true, recommended: true, cited: true, position: 1, intent: 'a' },
    { success: true, recommended: true, cited: false, position: 3, intent: 'b' },
    { success: true, recommended: true, cited: true, position: 5, intent: 'c' },
    { success: true, recommended: false, cited: false, position: null, intent: 'd' },
    { success: true, recommended: false, cited: false, position: null, intent: 'e' },
  ]);
  assert.equal(score.status, 'complete');
  assert.equal(score.score, 54);
  assert.equal(score.label, 'Moderate');
  assert.equal(scoreLabel(10), 'Very Low');
  assert.equal(scoreLabel(50), 'Moderate');
  assert.equal(scoreLabel(85), 'Very Strong');
});

test('requires at least three successful prompts to score', () => {
  const score = calculateScore([
    { success: true, recommended: true, cited: true, position: 1, intent: 'a' },
    { success: true, recommended: false, cited: false, position: null, intent: 'b' },
    { success: false },
    { success: false },
    { success: false },
  ]);
  assert.equal(score.status, 'insufficient_data');
  assert.equal(score.score, null);
});

test('successful provider responses without usable text do not produce completed zero reports', () => {
  const analyzed = analyzePromptResponse({
    intent: 'category_discovery',
    prompt: 'What are the best roofing companies in Ottawa, Ontario?',
    business: roofingInput,
    response: {
      success: true,
      responseText: '',
      citedUrls: [],
      fanOutQueries: ['roofing companies ottawa'],
      cost: 0.026,
      durationMs: 400,
      provider: 'dataforseo',
      model: 'gpt-4o-mini-2024-07-18',
      statusCode: 20000,
      statusMessage: 'Ok.',
    },
  });

  assert.equal(analyzed.success, false);
  assert.equal(analyzed.code, 'empty_provider_response');
  assert.equal(analyzed.cost, 0.026);
  assert.equal(analyzed.responseTextLength, 0);

  const assessment = aggregateAssessmentResults(roofingInput, generateAiVisibilityPrompts(roofingInput), [
    analyzed,
    { ...analyzed, prompt: 'Who would you recommend for roofing in Ottawa, Ontario?' },
    { ...analyzed, prompt: 'What are the best roof repair companies in Ottawa, Ontario?' },
    { ...analyzed, prompt: 'What are the most reputable roofing contractors in Ottawa, Ontario?' },
    { ...analyzed, prompt: 'Who should I hire for roofing in Ottawa, Ontario?' },
  ]);

  assert.equal(assessment.status, 'insufficient_data');
  assert.equal(assessment.score, null);
  assert.equal(assessment.successfulRequests, 0);
  assert.equal(assessment.failedRequests, 5);
});

test('mock assessment scenarios produce expected recommendation counts', async () => {
  const assessment = await runAiVisibilityAssessment({
    ...roofingInput,
    mockScenario: 'appears_3_of_5',
  }, { mockMode: true });
  assert.equal(assessment.status, 'complete');
  assert.equal(assessment.promptsPlanned, 5);
  assert.equal(assessment.successfulRequests, 5);
  assert.equal(assessment.recommendations, 3);
  assert.equal(assessment.totalCost, 0);
});

test('mock assessment returns insufficient data after three provider failures', async () => {
  const assessment = await runAiVisibilityAssessment({
    ...roofingInput,
    mockScenario: 'three_provider_failures',
  }, { mockMode: true });
  assert.equal(assessment.status, 'insufficient_data');
  assert.equal(assessment.score, null);
  assert.equal(assessment.successfulRequests, 2);
  assert.equal(assessment.failedRequests, 3);
});
