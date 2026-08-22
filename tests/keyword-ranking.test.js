const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DATAFORSEO_RANKED_KEYWORDS_ENDPOINT,
  normalizeDomain,
  normalizeCountryCode,
  buildRequestTask,
  runKeywordRankingAnalysis,
  mockKeywordRankingResult,
} = require('../lib/keyword-ranking');

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.KEYWORD_RANKING_ENABLED;
  delete process.env.KEYWORD_RANKING_MOCK_MODE;
  delete process.env.KEYWORD_RANKING_TIMEOUT_MS;
  delete process.env.DATAFORSEO_LOGIN;
  delete process.env.DATAFORSEO_PASSWORD;
}

test.afterEach(resetEnv);

test('normalizes website URLs to root domains', () => {
  assert.equal(normalizeDomain('https://www.example.com/path?x=1'), 'example.com');
  assert.equal(normalizeDomain('www.example.com/'), 'example.com');
  assert.equal(normalizeDomain('example.com/'), 'example.com');
});

test('does not default unknown country to US', () => {
  assert.equal(normalizeCountryCode('', 'example.com'), '');
  assert.equal(normalizeCountryCode('', 'example.ca'), 'CA');
  assert.equal(normalizeCountryCode('Canada', 'example.com'), 'CA');
});

test('feature disabled returns without provider request', async () => {
  let called = false;
  const result = await runKeywordRankingAnalysis({
    domain: 'example.ca',
    countryCode: 'CA',
  }, {
    fetchImpl: async () => {
      called = true;
      throw new Error('should not call provider');
    },
  });

  assert.equal(result.status, 'disabled');
  assert.equal(called, false);
});

test('mock mode returns deterministic moderate result with no provider cost', async () => {
  process.env.KEYWORD_RANKING_ENABLED = 'true';
  process.env.KEYWORD_RANKING_MOCK_MODE = 'true';

  const result = await runKeywordRankingAnalysis({
    domain: 'northstarroofing.ca',
    countryCode: 'CA',
    mockScenario: 'moderate',
  });

  assert.equal(result.status, 'complete');
  assert.equal(result.provider, 'static-mock');
  assert.equal(result.totalRankingKeywords, 75);
  assert.equal(result.top10Keywords, 8);
  assert.equal(result.top3Keywords, 2);
  assert.equal(result.providerCost, 0);
  assert.ok(result.topKeywords.length > 0);
  assert.ok(result.opportunities.some(item => item.opportunityType === 'near_page_one'));
});

test('mock provider failure remains non-blocking and unavailable', async () => {
  process.env.KEYWORD_RANKING_ENABLED = 'true';
  process.env.KEYWORD_RANKING_MOCK_MODE = 'true';

  const result = await runKeywordRankingAnalysis({
    domain: 'northstarroofing.ca',
    countryCode: 'CA',
    mockScenario: 'provider_failure',
  });

  assert.equal(result.status, 'unavailable');
  assert.equal(result.message, 'Keyword ranking data unavailable for this scan.');
  assert.equal(result.code, 'mock_provider_failure');
});

test('builds DataForSEO ranked keywords task with organic-only settings', () => {
  const task = buildRequestTask({
    domain: 'example.ca',
    countryCode: 'CA',
    languageCode: 'en',
    limit: 25,
  });

  assert.equal(task.target, 'example.ca');
  assert.equal(task.location_name, 'Canada');
  assert.equal(task.language_code, 'en');
  assert.deepEqual(task.item_types, ['organic']);
  assert.equal(task.historical_serp_mode, 'live');
  assert.equal(task.include_clickstream_data, false);
  assert.equal(task.limit, 25);
});

test('normalizes provider ranked keyword response', async () => {
  process.env.KEYWORD_RANKING_ENABLED = 'true';
  process.env.DATAFORSEO_LOGIN = 'login';
  process.env.DATAFORSEO_PASSWORD = 'password';

  const payload = {
    status_code: 20000,
    cost: 0.0102,
    tasks: [{
      id: 'task-1',
      status_code: 20000,
      cost: 0.0102,
      result: [{
        target: 'example.ca',
        total_count: 124,
        metrics: {
          organic: {
            pos_1: 1,
            pos_2_3: 3,
            pos_4_10: 14,
            pos_11_20: 19,
            count: 124,
            etv: 420,
          },
        },
        items: [
          {
            keyword_data: {
              keyword: 'roofing company ottawa',
              keyword_info: { search_volume: 590, cpc: 8.5 },
              search_intent_info: { main_intent: 'commercial' },
            },
            ranked_serp_element: {
              serp_item: {
                type: 'organic',
                rank_group: 4,
                url: 'https://example.ca/roofing',
                etv: 25,
              },
            },
          },
          {
            keyword_data: {
              keyword: 'roof repair ottawa',
              keyword_info: { search_volume: 480, cpc: 7.2 },
              search_intent_info: { main_intent: 'commercial' },
            },
            ranked_serp_element: {
              serp_item: {
                type: 'organic',
                rank_group: 14,
                url: 'https://example.ca/roof-repair',
                etv: 12,
              },
            },
          },
        ],
      }],
    }],
  };

  const result = await runKeywordRankingAnalysis({
    domain: 'example.ca',
    countryCode: 'CA',
    languageCode: 'en',
  }, {
    skipCache: true,
    fetchImpl: async (url) => {
      assert.equal(url, DATAFORSEO_RANKED_KEYWORDS_ENDPOINT);
      return {
        ok: true,
        text: async () => JSON.stringify(payload),
      };
    },
  });

  assert.equal(result.status, 'complete');
  assert.equal(result.totalRankingKeywords, 124);
  assert.equal(result.top3Keywords, 4);
  assert.equal(result.top10Keywords, 18);
  assert.equal(result.top20Keywords, 37);
  assert.equal(result.estimatedOrganicTraffic, 420);
  assert.equal(result.providerCost, 0.0102);
  assert.equal(result.topKeywords[0].keyword, 'roofing company ottawa');
  assert.equal(result.opportunities[0].keyword, 'roofing company ottawa');
});

test('successful provider no-keywords response returns no_keywords', async () => {
  process.env.KEYWORD_RANKING_ENABLED = 'true';
  process.env.DATAFORSEO_LOGIN = 'login';
  process.env.DATAFORSEO_PASSWORD = 'password';

  const result = await runKeywordRankingAnalysis({
    domain: 'example.ca',
    countryCode: 'CA',
  }, {
    skipCache: true,
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify({
        status_code: 20000,
        tasks: [{
          status_code: 20000,
          cost: 0.0102,
          result: [{ total_count: 0, metrics: { organic: { count: 0, etv: 0 } }, items: [] }],
        }],
      }),
    }),
  });

  assert.equal(result.status, 'no_keywords');
  assert.equal(result.totalRankingKeywords, 0);
  assert.deepEqual(result.topKeywords, []);
});

test('provider failure returns unavailable instead of throwing', async () => {
  process.env.KEYWORD_RANKING_ENABLED = 'true';
  process.env.DATAFORSEO_LOGIN = 'login';
  process.env.DATAFORSEO_PASSWORD = 'password';

  const result = await runKeywordRankingAnalysis({
    domain: 'example.ca',
    countryCode: 'CA',
  }, {
    skipCache: true,
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify({
        status_code: 20000,
        tasks_error: 1,
        tasks: [{ status_code: 40501, status_message: 'Invalid Field' }],
      }),
    }),
  });

  assert.equal(result.status, 'unavailable');
  assert.equal(result.code, 'dataforseo_provider_error');
});

test('cache prevents a second provider request for the same domain and market', async () => {
  process.env.KEYWORD_RANKING_ENABLED = 'true';
  process.env.DATAFORSEO_LOGIN = 'login';
  process.env.DATAFORSEO_PASSWORD = 'password';

  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: true,
      text: async () => JSON.stringify({
        status_code: 20000,
        cost: 0.02,
        tasks: [{
          status_code: 20000,
          cost: 0.02,
          result: [{
            total_count: 1,
            metrics: { organic: { count: 1, pos_1: 0, pos_2_3: 0, pos_4_10: 1, etv: 10 } },
            items: [{
              keyword_data: { keyword: 'roofing ottawa', keyword_info: { search_volume: 100 } },
              ranked_serp_element: { serp_item: { type: 'organic', rank_group: 9, url: 'https://cache-test.ca/' } },
            }],
          }],
        }],
      }),
    };
  };

  const first = await runKeywordRankingAnalysis({ domain: 'cache-test.ca', countryCode: 'CA' }, { fetchImpl });
  const second = await runKeywordRankingAnalysis({ domain: 'cache-test.ca', countryCode: 'CA' }, { fetchImpl });

  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(calls, 1);
});

test('mock fixture helper exposes required scenarios', () => {
  assert.equal(mockKeywordRankingResult({ domain: 'example.ca', countryCode: 'CA' }, 'strong').totalRankingKeywords, 500);
  assert.equal(mockKeywordRankingResult({ domain: 'example.ca', countryCode: 'CA' }, 'weak').top10Keywords, 0);
  assert.equal(mockKeywordRankingResult({ domain: 'example.ca', countryCode: 'CA' }, 'no_keywords').status, 'no_keywords');
  assert.equal(mockKeywordRankingResult({ domain: 'example.ca', countryCode: 'CA' }, 'provider_failure').status, 'unavailable');
});
