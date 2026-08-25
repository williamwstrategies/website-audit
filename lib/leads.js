const { calculateOpportunityScore } = require('./opportunity-score');

const LEAD_CORE_COLUMNS = [
  'id',
  'user_id',
  'business_name',
  'category',
  'website_url',
  'website_domain',
  'phone',
  'address',
  'city',
  'region',
  'country_code',
  'rating',
  'review_count',
  'source',
  'external_source_id',
  'scan_status',
  'scan_id',
  'website_score',
  'opportunity_score',
  'opportunity_label',
  'opportunity_state',
  'opportunity_reasons',
  'last_scanned_at',
  'created_at',
  'updated_at',
];

const LEAD_EMAIL_COLUMNS = [
  'email',
  'email_source_url',
  'email_confidence',
  'email_found_at',
];

const LEAD_CORE_SELECT = LEAD_CORE_COLUMNS.join(',');
const LEAD_LIST_SELECT = [...LEAD_CORE_COLUMNS, ...LEAD_EMAIL_COLUMNS].join(',');

const LEAD_SEARCH_SELECT = [
  'id',
  'user_id',
  'query',
  'location',
  'country_code',
  'result_limit',
  'filters',
  'result_count',
  'provider',
  'provider_cost',
  'created_at',
].join(',');

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

function parseJson(text = '') {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: cleanText(text, 1000) };
  }
}

function normalizeSupabaseBaseUrl(rawUrl = process.env.SUPABASE_URL || '') {
  return cleanText(rawUrl)
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1$/i, '')
    .replace(/\/auth\/v1$/i, '');
}

function supabaseBaseUrl() {
  const baseUrl = normalizeSupabaseBaseUrl();
  if (!baseUrl) throw httpError(503, 'Supabase URL is not configured.', 'supabase_not_configured');
  return baseUrl;
}

function supabaseServiceRoleKey() {
  const key = cleanText(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!key) throw httpError(503, 'Supabase service-role key is not configured.', 'supabase_service_role_missing');
  return key;
}

function leadSchemaMissingError(error) {
  return httpError(
    503,
    'Lead Finder database tables are not installed. Run supabase/lead-finder-migration.sql in Supabase, then retry.',
    'lead_schema_missing',
    { original_code: error?.details?.code || error?.details?.message || error?.code || '' }
  );
}

function leadEmailSchemaMissing(error) {
  const body = error?.details || {};
  const text = [
    error?.message,
    error?.code,
    body?.code,
    body?.message,
    body?.hint,
    body?.details,
  ].filter(Boolean).join(' ');
  return /(email|email_source_url|email_confidence|email_found_at)/i.test(text) &&
    /(schema cache|column|does not exist|not found)/i.test(text);
}

function leadEmailSchemaMissingError(error) {
  return httpError(
    503,
    'Lead Email Finder database columns are not installed. Run supabase/lead-email-finder-migration.sql in Supabase, then retry.',
    'lead_email_schema_missing',
    { original_code: error?.details?.code || error?.details?.message || error?.code || '' }
  );
}

async function supabaseRest(path, options = {}) {
  const url = new URL(`${supabaseBaseUrl()}/rest/v1/${String(path).replace(/^\/+/, '')}`);
  Object.entries(options.query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  });

  const key = supabaseServiceRoleKey();
  const headers = {
    apikey: key,
    authorization: `Bearer ${key}`,
    accept: 'application/json',
    ...(options.headers || {}),
  };

  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.prefer) headers.prefer = options.prefer;

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const body = parseJson(await response.text());
  if (!response.ok) {
    const message = body?.message || body?.hint || 'Supabase request failed.';
    const error = httpError(response.status, message, 'supabase_request_failed', body);
    if (body?.code === '42P01' || /relation .*leads.* does not exist/i.test(message)) {
      throw leadSchemaMissingError(error);
    }
    throw error;
  }
  return body;
}

async function supabaseLeadRest(options = {}, { fallbackEmailColumns = false, requireEmailColumns = false } = {}) {
  try {
    return await supabaseRest('leads', options);
  } catch (error) {
    if (!leadEmailSchemaMissing(error)) throw error;
    if (requireEmailColumns) throw leadEmailSchemaMissingError(error);
    if (!fallbackEmailColumns) throw error;

    const fallbackOptions = {
      ...options,
      query: {
        ...(options.query || {}),
        select: LEAD_CORE_SELECT,
      },
    };
    return supabaseRest('leads', fallbackOptions);
  }
}

function numberOrNull(value) {
  if (cleanText(value, 40) === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

function normalizeUrl(value = '') {
  const clean = cleanText(value, 1000);
  if (!clean) return '';
  const withProtocol = /^https?:\/\//i.test(clean) ? clean : `https://${clean}`;
  try {
    return new URL(withProtocol).toString();
  } catch {
    return withProtocol;
  }
}

function normalizeEmail(value = '') {
  const match = cleanText(value, 320).toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/i);
  return match ? match[0] : '';
}

function identityText(value = '') {
  return cleanText(value, 500).toLowerCase().replace(/\s+/g, ' ');
}

function leadPayload(userId, input = {}) {
  const websiteUrl = normalizeUrl(input.websiteUrl || input.website_url || input.website || '');
  const domain = normalizeDomain(input.websiteDomain || input.website_domain || websiteUrl);
  const finalWebsiteUrl = websiteUrl || (domain ? `https://${domain}` : '');
  const businessName = cleanText(input.businessName || input.business_name || input.title, 220);
  if (!businessName) throw httpError(400, 'Business name is required.', 'lead_business_name_required');

  return {
    user_id: userId,
    business_name: businessName,
    category: cleanText(input.category, 220),
    website_url: domain ? finalWebsiteUrl : '',
    website_domain: domain,
    phone: cleanText(input.phone, 80),
    ...(input.email !== undefined && { email: normalizeEmail(input.email) || null }),
    ...(input.emailSourceUrl !== undefined || input.email_source_url !== undefined
      ? { email_source_url: cleanText(input.emailSourceUrl || input.email_source_url, 1000) || null }
      : {}),
    ...(input.emailConfidence !== undefined || input.email_confidence !== undefined
      ? { email_confidence: cleanText(input.emailConfidence || input.email_confidence, 40) || null }
      : {}),
    ...(input.emailFoundAt !== undefined || input.email_found_at !== undefined
      ? { email_found_at: cleanText(input.emailFoundAt || input.email_found_at, 80) || null }
      : {}),
    address: cleanText(input.address, 500),
    city: cleanText(input.city, 120),
    region: cleanText(input.region, 120),
    country_code: cleanText(input.countryCode || input.country_code, 8).toUpperCase(),
    rating: numberOrNull(input.rating),
    review_count: numberOrNull(input.reviewCount ?? input.review_count),
    source: cleanText(input.source, 80) || 'manual',
    external_source_id: cleanText(input.externalSourceId || input.external_source_id, 260),
    scan_status: cleanText(input.scanStatus || input.scan_status, 40) || 'not_scanned',
  };
}

function leadUpdatePayload(input = {}, existingLead = null) {
  const payload = {};
  const setText = (key, value, maxLength) => {
    if (value !== undefined) payload[key] = cleanText(value, maxLength);
  };
  setText('business_name', input.businessName ?? input.business_name, 220);
  setText('category', input.category, 220);
  setText('phone', input.phone, 80);
  setText('address', input.address, 500);
  setText('city', input.city, 120);
  setText('region', input.region, 120);
  if (input.countryCode !== undefined || input.country_code !== undefined) {
    payload.country_code = cleanText(input.countryCode || input.country_code, 8).toUpperCase();
  }
  if (input.rating !== undefined) payload.rating = numberOrNull(input.rating);
  if (input.reviewCount !== undefined || input.review_count !== undefined) {
    payload.review_count = numberOrNull(input.reviewCount ?? input.review_count);
  }
  if (input.websiteUrl !== undefined || input.website_url !== undefined || input.website !== undefined) {
    const websiteUrl = normalizeUrl(input.websiteUrl || input.website_url || input.website || '');
    const domain = normalizeDomain(input.websiteDomain || input.website_domain || websiteUrl);
    payload.website_url = domain ? (websiteUrl || `https://${domain}`) : '';
    payload.website_domain = domain;
  }
  if (input.scanStatus !== undefined || input.scan_status !== undefined) {
    payload.scan_status = cleanText(input.scanStatus || input.scan_status, 40);
  }
  if (input.scanId !== undefined || input.scan_id !== undefined) {
    payload.scan_id = cleanText(input.scanId || input.scan_id, 80) || null;
  }
  if (input.websiteScore !== undefined || input.website_score !== undefined) {
    payload.website_score = numberOrNull(input.websiteScore ?? input.website_score);
  }
  if (input.email !== undefined) {
    payload.email = normalizeEmail(input.email) || null;
  }
  if (input.emailSourceUrl !== undefined || input.email_source_url !== undefined) {
    payload.email_source_url = cleanText(input.emailSourceUrl || input.email_source_url, 1000) || null;
  }
  if (input.emailConfidence !== undefined || input.email_confidence !== undefined) {
    payload.email_confidence = cleanText(input.emailConfidence || input.email_confidence, 40) || null;
  }
  if (input.emailFoundAt !== undefined || input.email_found_at !== undefined) {
    payload.email_found_at = cleanText(input.emailFoundAt || input.email_found_at, 80) || null;
  }

  const shouldScore = input.reportData !== undefined ||
    input.report_data !== undefined ||
    input.websiteScore !== undefined ||
    input.website_score !== undefined ||
    input.hasWebsite === false;
  if (shouldScore) {
    const reportData = input.reportData || input.report_data || {};
    const website = payload.website_url ?? existingLead?.website_url ?? '';
    const score = calculateOpportunityScore({
      report: reportData,
      websiteScore: payload.website_score ?? existingLead?.website_score,
      website,
      hasWebsite: input.hasWebsite === false ? false : Boolean(website || existingLead?.website_url),
      rating: payload.rating ?? existingLead?.rating,
      reviewCount: payload.review_count ?? existingLead?.review_count,
      isClaimed: input.isClaimed === true || input.is_claimed === true,
    });
    payload.opportunity_score = score.score;
    payload.opportunity_label = score.label;
    payload.opportunity_state = score.state;
    payload.opportunity_reasons = score.reasons;
    payload.last_scanned_at = new Date().toISOString();
    if (!payload.scan_status) payload.scan_status = score.state === 'no_website' ? 'no_website' : 'scanned';
  }

  return payload;
}

async function listLeadsForUser(userId, options = {}) {
  const safeLimit = Math.max(1, Math.min(Number(options.limit) || 250, 500));
  const term = cleanText(options.search, 200);
  const safeTerm = term.replace(/[*,()]/g, ' ').trim();
  const status = cleanText(options.status, 80);
  const query = {
    select: LEAD_LIST_SELECT,
    user_id: `eq.${userId}`,
    order: cleanText(options.sort, 80) || 'updated_at.desc',
    limit: String(safeLimit),
  };
  if (safeTerm) query.or = `(business_name.ilike.*${safeTerm}*,website_domain.ilike.*${safeTerm}*,category.ilike.*${safeTerm}*)`;
  if (status && status !== 'all') query.scan_status = `eq.${status}`;
  return supabaseLeadRest({ query }, { fallbackEmailColumns: true });
}

async function getLeadForUser(userId, leadId) {
  const rows = await supabaseLeadRest({
    query: {
      select: LEAD_LIST_SELECT,
      user_id: `eq.${userId}`,
      id: `eq.${cleanText(leadId, 80)}`,
      limit: '1',
    },
  }, { fallbackEmailColumns: true });
  const lead = asArray(rows)[0] || null;
  if (!lead) throw httpError(404, 'Lead not found.', 'lead_not_found');
  return lead;
}

function sameBusinessLocation(left = {}, right = {}) {
  return identityText(left.business_name) === identityText(right.business_name) &&
    identityText(left.city) === identityText(right.city) &&
    identityText(left.region) === identityText(right.region) &&
    cleanText(left.country_code).toUpperCase() === cleanText(right.country_code).toUpperCase();
}

async function findDuplicateLeadForUser(userId, payload) {
  const existingLeads = await listLeadsForUser(userId, { limit: 500 });
  return existingLeads.find(lead => {
    if (payload.external_source_id && lead.external_source_id && payload.source === lead.source) {
      return payload.external_source_id === lead.external_source_id;
    }
    if (payload.website_domain && lead.website_domain) {
      return payload.website_domain === lead.website_domain;
    }
    return sameBusinessLocation(lead, payload);
  }) || null;
}

async function saveLeadForUser(userId, input = {}) {
  const payload = leadPayload(userId, input);
  const duplicate = await findDuplicateLeadForUser(userId, payload);
  if (duplicate) {
    const update = { ...payload };
    if (input.scanStatus === undefined && input.scan_status === undefined) delete update.scan_status;
    const updated = await updateLeadForUser(userId, duplicate.id, update);
    return { ...updated, duplicate: true };
  }

  const rows = await supabaseLeadRest({
    method: 'POST',
    prefer: 'return=representation',
    query: { select: LEAD_LIST_SELECT },
    body: payload,
  }, { fallbackEmailColumns: true });
  return asArray(rows)[0] || null;
}

async function updateLeadForUser(userId, leadId, input = {}) {
  const existingLead = await getLeadForUser(userId, leadId);
  const payload = leadUpdatePayload(input, existingLead);
  if (!Object.keys(payload).length) return existingLead;

  const requiresEmailColumns = Object.keys(payload).some(key => LEAD_EMAIL_COLUMNS.includes(key));
  const rows = await supabaseLeadRest({
    method: 'PATCH',
    prefer: 'return=representation',
    query: {
      select: LEAD_LIST_SELECT,
      user_id: `eq.${userId}`,
      id: `eq.${cleanText(leadId, 80)}`,
    },
    body: payload,
  }, { fallbackEmailColumns: true, requireEmailColumns: requiresEmailColumns });
  return asArray(rows)[0] || existingLead;
}

async function deleteLeadForUser(userId, leadId) {
  await supabaseRest('leads', {
    method: 'DELETE',
    query: {
      user_id: `eq.${userId}`,
      id: `eq.${cleanText(leadId, 80)}`,
    },
  });
  return true;
}

function decorateBusinessResult(result, lead) {
  if (!lead) return result;
  return {
    ...result,
    saved: true,
    lead_id: lead.id,
    scan_status: lead.scan_status,
    scan_id: lead.scan_id,
    website_score: lead.website_score,
    opportunity_score: lead.opportunity_score,
    opportunity_label: lead.opportunity_label,
    opportunity_state: lead.opportunity_state,
    opportunity_reasons: lead.opportunity_reasons,
    email: lead.email,
    email_source_url: lead.email_source_url,
    email_confidence: lead.email_confidence,
    email_found_at: lead.email_found_at,
  };
}

async function decorateBusinessResultsForUser(userId, results = []) {
  const leads = await listLeadsForUser(userId, { limit: 500 });
  return asArray(results).map(result => {
    const normalized = leadPayload(userId, {
      ...result,
      businessName: result.business_name,
      websiteUrl: result.website_url,
      websiteDomain: result.website_domain,
      countryCode: result.country_code,
      reviewCount: result.review_count,
      externalSourceId: result.external_source_id,
    });
    const match = leads.find(lead => {
      if (normalized.external_source_id && lead.external_source_id && normalized.source === lead.source) {
        return normalized.external_source_id === lead.external_source_id;
      }
      if (normalized.website_domain && lead.website_domain) return normalized.website_domain === lead.website_domain;
      return sameBusinessLocation(lead, normalized);
    });
    return decorateBusinessResult(result, match);
  });
}

async function recordLeadSearchForUser(userId, input = {}, providerResult = {}) {
  const body = {
    user_id: userId,
    query: cleanText(input.businessType || input.query || input.category, 220),
    location: cleanText(input.location, 220),
    country_code: cleanText(providerResult.request?.countryCode || input.countryCode || input.country_code, 8).toUpperCase(),
    result_limit: Math.max(1, Math.min(Number(input.limit) || 25, 50)),
    filters: asRecord(input.filters || {
      minRating: input.minRating ?? input.ratingMin ?? null,
      maxRating: input.maxRating ?? input.ratingMax ?? null,
      minReviews: input.minReviews ?? input.reviewsMin ?? null,
      maxReviews: input.maxReviews ?? input.reviewsMax ?? null,
      websiteStatus: input.websiteStatus || 'all',
    }),
    result_count: Number(providerResult.result_count) || asArray(providerResult.results).length || 0,
    provider: cleanText(providerResult.provider || 'dataforseo', 80),
    provider_cost: numberOrNull(providerResult.cost) || 0,
  };
  const rows = await supabaseRest('lead_searches', {
    method: 'POST',
    prefer: 'return=representation',
    query: { select: LEAD_SEARCH_SELECT },
    body,
  });
  return asArray(rows)[0] || null;
}

async function getLeadDiscoveryUsageForUser(userId, options = {}) {
  const query = {
    select: 'result_count',
    user_id: `eq.${userId}`,
    limit: String(Math.max(1, Math.min(Number(options.limit) || 5000, 10000))),
  };
  if (options.since) query.created_at = `gte.${options.since}`;
  if (options.until) query.created_at = `lt.${options.until}`;

  const rows = await supabaseRest('lead_searches', { query });
  return asArray(rows).reduce((sum, row) => sum + (Math.max(0, Number(row?.result_count) || 0)), 0);
}

async function listRecentLeadSearchesForUser(userId, options = {}) {
  const safeLimit = Math.max(1, Math.min(Number(options.limit) || 8, 25));
  return supabaseRest('lead_searches', {
    query: {
      select: LEAD_SEARCH_SELECT,
      user_id: `eq.${userId}`,
      order: 'created_at.desc',
      limit: String(safeLimit),
    },
  });
}

module.exports = {
  decorateBusinessResultsForUser,
  deleteLeadForUser,
  getLeadForUser,
  getLeadDiscoveryUsageForUser,
  listLeadsForUser,
  listRecentLeadSearchesForUser,
  recordLeadSearchForUser,
  saveLeadForUser,
  updateLeadForUser,
};
