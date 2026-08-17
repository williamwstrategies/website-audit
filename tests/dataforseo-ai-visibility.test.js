const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_TIMEOUT_MS,
  runAiVisibilityPrompt,
} = require('../lib/dataforseo-ai-visibility');

test('DataForSEO live request omits top_p when temperature is set', async () => {
  const originalEnv = {
    AI_VISIBILITY_ENABLED: process.env.AI_VISIBILITY_ENABLED,
    DATAFORSEO_LOGIN: process.env.DATAFORSEO_LOGIN,
    DATAFORSEO_PASSWORD: process.env.DATAFORSEO_PASSWORD,
  };
  process.env.AI_VISIBILITY_ENABLED = 'true';
  process.env.DATAFORSEO_LOGIN = 'login';
  process.env.DATAFORSEO_PASSWORD = 'password';

  let body;
  const fakeResponse = {
    ok: true,
    text: async () => JSON.stringify({
      status_code: 20000,
      status_message: 'Ok.',
      tasks_error: 0,
      tasks: [{
        id: 'task-1',
        status_code: 20000,
        status_message: 'Ok.',
        result: [{
          model_name: 'gpt-4o-mini-2024-07-18',
          web_search: true,
          items: [{
            type: 'message',
            sections: [{ type: 'text', text: '1. Example Roofing - local contractor.' }],
          }],
        }],
      }],
    }),
  };

  try {
    await runAiVisibilityPrompt({
      prompt: 'What are the best roofing companies in Ottawa?',
      countryCode: 'CA',
      city: 'Ottawa',
    }, {
      fetchImpl: async (_url, options) => {
        body = JSON.parse(options.body);
        return fakeResponse;
      },
    });
  } finally {
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }

  assert.equal(DEFAULT_TIMEOUT_MS, 120000);
  assert.equal(Array.isArray(body), true);
  assert.equal(body[0].temperature, 0.2);
  assert.equal(Object.hasOwn(body[0], 'top_p'), false);
  assert.equal(body[0].web_search, true);
  assert.equal(body[0].force_web_search, true);
});
