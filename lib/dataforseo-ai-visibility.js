const DATAFORSEO_LLM_RESPONSES_LIVE_ENDPOINT = 'https://api.dataforseo.com/v3/ai_optimization/chat_gpt/llm_responses/live';
const DEFAULT_MODEL_NAME = 'gpt-4o-mini';
const DEFAULT_SYSTEM_MESSAGE = 'You are a helpful assistant that provides accurate information.';
const DEFAULT_MAX_OUTPUT_TOKENS = 500;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_TOP_P = 1;
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_PROMPT_LENGTH = 500;

function cleanText(value = '', maxLength = 2000) {
  return String(value || '').trim().slice(0, maxLength);
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function featureEnabled() {
  return /^(1|true|yes|on)$/i.test(cleanText(process.env.AI_VISIBILITY_ENABLED, 20));
}

function configuredTimeoutMs(override) {
  const parsed = Number(override ?? process.env.AI_VISIBILITY_TIMEOUT_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.max(1000, Math.min(120000, Math.round(parsed)));
}

function normalizeCountryCode(countryCode) {
  return cleanText(countryCode, 8).toUpperCase();
}

function roundMoney(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000000) / 1000000 : 0;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function dedupeObjectsByUrl(items) {
  const seen = new Set();
  return items.filter((item) => {
    const url = cleanText(item?.url, 2000);
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

function normalizeUrlCandidate(value = '') {
  const text = cleanText(value, 2000);
  if (!/^https?:\/\//i.test(text)) return '';
  try {
    return new URL(text).toString();
  } catch {
    return text;
  }
}

function extractTextFromNode(value, depth = 0) {
  if (value == null || depth > 8) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return '';
  if (Array.isArray(value)) {
    return value
      .map((item) => extractTextFromNode(item, depth + 1))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  const record = asRecord(value);
  const directKeys = [
    'response',
    'response_text',
    'responseText',
    'text',
    'output_text',
    'outputText',
    'answer',
    'content',
    'message',
  ];

  for (const key of directKeys) {
    if (typeof record[key] === 'string' && cleanText(record[key])) {
      return cleanText(record[key], 12000);
    }
  }

  const nestedKeys = ['items', 'content', 'message', 'sections', 'data', 'result', 'output'];
  for (const key of nestedKeys) {
    const nested = extractTextFromNode(record[key], depth + 1);
    if (nested) return cleanText(nested, 12000);
  }

  return '';
}

function collectCitations(value, citations = [], depth = 0) {
  if (value == null || depth > 8) return citations;
  if (Array.isArray(value)) {
    value.forEach((item) => collectCitations(item, citations, depth + 1));
    return citations;
  }
  if (typeof value !== 'object') return citations;

  const record = asRecord(value);
  const url = normalizeUrlCandidate(record.url || record.source_url || record.sourceUrl || record.link);
  if (url) {
    citations.push({
      title: cleanText(record.title || record.name || record.source_title || record.sourceTitle || url, 220),
      url,
    });
  }

  Object.values(record).forEach((child) => collectCitations(child, citations, depth + 1));
  return citations;
}

function collectFanOutQueries(value, queries = [], depth = 0, key = '') {
  if (value == null || depth > 8) return queries;
  const normalizedKey = String(key || '').toLowerCase();

  if (Array.isArray(value)) {
    value.forEach((item) => collectFanOutQueries(item, queries, depth + 1, key));
    return queries;
  }

  if (typeof value === 'string') {
    if (/fan[_-]?out|query|queries/.test(normalizedKey)) {
      const query = cleanText(value, 500);
      if (query) queries.push(query);
    }
    return queries;
  }

  if (typeof value !== 'object') return queries;
  Object.entries(asRecord(value)).forEach(([childKey, childValue]) => {
    if (/fan[_-]?out[_-]?queries/i.test(childKey)) {
      if (Array.isArray(childValue)) {
        childValue.forEach((item) => {
          if (typeof item === 'string') {
            const query = cleanText(item, 500);
            if (query) queries.push(query);
          } else {
            const query = cleanText(asRecord(item).query || asRecord(item).keyword || asRecord(item).text, 500);
            if (query) queries.push(query);
          }
        });
      }
      return;
    }
    collectFanOutQueries(childValue, queries, depth + 1, childKey);
  });
  return queries;
}

function uniqueStrings(values, limit = 30) {
  return Array.from(new Set(values.map((value) => cleanText(value, 500)).filter(Boolean))).slice(0, limit);
}

function disabledResult({ prompt, countryCode, city } = {}) {
  return {
    success: false,
    disabled: true,
    error: 'AI visibility is disabled.',
    code: 'ai_visibility_disabled',
    prompt: cleanText(prompt, MAX_PROMPT_LENGTH),
    countryCode: normalizeCountryCode(countryCode),
    city: cleanText(city, 120),
    provider: 'dataforseo',
  };
}

function validationError(error, code, details = {}) {
  return {
    success: false,
    error,
    code,
    provider: 'dataforseo',
    ...details,
  };
}

function providerError(error, code, details = {}) {
  return {
    success: false,
    error,
    code,
    provider: 'dataforseo',
    ...details,
  };
}

function buildRequestTask({ prompt, countryCode, city }) {
  return {
    system_message: DEFAULT_SYSTEM_MESSAGE,
    user_prompt: prompt,
    model_name: DEFAULT_MODEL_NAME,
    max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
    temperature: DEFAULT_TEMPERATURE,
    top_p: DEFAULT_TOP_P,
    web_search: true,
    force_web_search: true,
    web_search_country_iso_code: countryCode,
    ...(city ? { web_search_city: city } : {}),
  };
}

function parseResponseBody(text = '') {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: cleanText(text, 1000) };
  }
}

function dataForSeoStatusFailed(code) {
  const parsed = Number(code);
  return Number.isFinite(parsed) && parsed >= 40000;
}

function normalizeDataForSeoResponse(data, request, startedAt) {
  const responseData = asRecord(data);
  const task = asRecord(asArray(responseData.tasks)[0]);
  const result = asRecord(asArray(task.result)[0]);
  const responseText = cleanText(extractTextFromNode(result) || extractTextFromNode(task), 12000);
  const cost = firstFiniteNumber(task.cost, responseData.cost, result.cost);
  const moneySpent = firstFiniteNumber(result.money_spent, result.moneySpent, task.money_spent, task.moneySpent);

  return {
    success: true,
    prompt: request.prompt,
    countryCode: request.countryCode,
    city: request.city,
    model: cleanText(result.model_name || task.model_name || DEFAULT_MODEL_NAME, 80),
    webSearch: result.web_search !== undefined ? Boolean(result.web_search) : true,
    responseText,
    citedUrls: dedupeObjectsByUrl(collectCitations(result)).slice(0, 20),
    fanOutQueries: uniqueStrings(collectFanOutQueries(result), 30),
    cost: roundMoney(cost),
    moneySpent: roundMoney(moneySpent),
    durationMs: Date.now() - startedAt,
    provider: 'dataforseo',
    statusCode: task.status_code || responseData.status_code || null,
    statusMessage: cleanText(task.status_message || responseData.status_message, 500),
    taskId: cleanText(task.id, 120),
  };
}

function requestFailedByProvider(data) {
  const responseData = asRecord(data);
  const task = asRecord(asArray(responseData.tasks)[0]);
  if (dataForSeoStatusFailed(responseData.status_code) || dataForSeoStatusFailed(task.status_code)) return true;
  return Number(responseData.tasks_error) > 0;
}

function providerFailureMessage(data) {
  const responseData = asRecord(data);
  const task = asRecord(asArray(responseData.tasks)[0]);
  return cleanText(
    task.status_message ||
    responseData.status_message ||
    responseData.message ||
    'DataForSEO returned an unsuccessful response.',
    1000
  );
}

async function withTimeout(promise, timeoutMs, controller) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      if (controller) controller.abort();
      const error = new Error(`DataForSEO request timed out after ${timeoutMs}ms.`);
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

function authHeader(login, password) {
  return `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;
}

async function runAiVisibilityPrompt(input = {}, options = {}) {
  const startedAt = Date.now();
  const prompt = cleanText(input.prompt, MAX_PROMPT_LENGTH + 1);
  const countryCode = normalizeCountryCode(input.countryCode || input.country_code);
  const city = cleanText(input.city, 120);
  const timeoutMs = configuredTimeoutMs(options.timeoutMs);

  if (!prompt) {
    return validationError('Prompt is required.', 'prompt_required', { durationMs: Date.now() - startedAt });
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return validationError(`Prompt must be ${MAX_PROMPT_LENGTH} characters or fewer.`, 'prompt_too_long', {
      durationMs: Date.now() - startedAt,
    });
  }
  if (!countryCode) {
    return validationError('Country code is required.', 'country_code_required', { durationMs: Date.now() - startedAt });
  }
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    return validationError('Country code must be a two-letter ISO code.', 'country_code_invalid', {
      countryCode,
      durationMs: Date.now() - startedAt,
    });
  }
  if (!featureEnabled()) {
    return disabledResult({ prompt, countryCode, city });
  }

  const login = cleanText(process.env.DATAFORSEO_LOGIN, 320);
  const password = cleanText(process.env.DATAFORSEO_PASSWORD, 1000);
  if (!login || !password) {
    return providerError('DataForSEO credentials are not configured.', 'dataforseo_credentials_missing', {
      durationMs: Date.now() - startedAt,
    });
  }

  const task = buildRequestTask({ prompt, countryCode, city });
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const fetchImpl = options.fetchImpl || fetch;

  try {
    const response = await withTimeout(fetchImpl(DATAFORSEO_LLM_RESPONSES_LIVE_ENDPOINT, {
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
      console.log('[PitchProof][DataForSEO] Response:', JSON.stringify(data, null, 2));
    }

    if (!response.ok) {
      return providerError(`DataForSEO request failed with HTTP ${response.status}.`, 'dataforseo_http_error', {
        status: response.status,
        statusCode: asRecord(data).status_code || null,
        statusMessage: cleanText(asRecord(data).status_message || asRecord(data).message, 500),
        durationMs: Date.now() - startedAt,
      });
    }

    if (requestFailedByProvider(data)) {
      return providerError(providerFailureMessage(data), 'dataforseo_provider_error', {
        statusCode: asRecord(asArray(asRecord(data).tasks)[0]).status_code || asRecord(data).status_code || null,
        durationMs: Date.now() - startedAt,
      });
    }

    return normalizeDataForSeoResponse(data, { prompt, countryCode, city }, startedAt);
  } catch (error) {
    const code = error?.name === 'AbortError' ? 'dataforseo_timeout' : 'dataforseo_request_failed';
    return providerError(
      error?.name === 'AbortError' ? 'DataForSEO request timed out.' : (error?.message || 'DataForSEO request failed.'),
      code,
      { durationMs: Date.now() - startedAt }
    );
  }
}

module.exports = {
  DATAFORSEO_LLM_RESPONSES_LIVE_ENDPOINT,
  DEFAULT_TIMEOUT_MS,
  runAiVisibilityPrompt,
};
