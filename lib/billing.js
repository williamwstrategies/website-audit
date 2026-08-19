const crypto = require('crypto');
const {
  visibilityClassification,
} = require('./ai-visibility-classification');

const STRIPE_API_BASE = 'https://api.stripe.com/v1';
const DEFAULT_PLAN_KEY = 'professional';
const SUBSCRIPTION_TRIAL_DAYS = 7;
const ABANDONED_CART_OFFER_KEY = 'abandoned_cart_50_first_month';
const PLAN_CATALOG = {
  starter: {
    key: 'starter',
    name: 'Starter',
    priceLabel: '$19.99 / month',
    monthlyAllowance: 50,
    aiScanAllowance: 10,
    maxBalance: 100,
    whiteLabel: false,
    badge: '',
    stripePriceEnv: 'STRIPE_STARTER_PRICE_ID',
    checkout: true,
    description: 'Perfect for freelancers and agencies creating their first opportunity reports.',
  },
  professional: {
    key: 'professional',
    name: 'Professional',
    priceLabel: '$39.99 / month',
    monthlyAllowance: 200,
    aiScanAllowance: 30,
    maxBalance: 400,
    whiteLabel: true,
    badge: 'Most Popular',
    stripePriceEnv: 'STRIPE_PROFESSIONAL_PRICE_ID',
    checkout: true,
    description: 'Perfect for agencies presenting opportunity reports directly to prospects.',
  },
  growth: {
    key: 'growth',
    name: 'Growth',
    priceLabel: '$79.99 / month',
    monthlyAllowance: 500,
    aiScanAllowance: 100,
    maxBalance: 1000,
    whiteLabel: true,
    badge: '',
    stripePriceEnv: 'STRIPE_GROWTH_PRICE_ID',
    checkout: true,
    description: 'Built for agencies generating higher report volume.',
  },
  enterprise: {
    key: 'enterprise',
    name: 'Enterprise',
    priceLabel: 'Contact Sales',
    monthlyAllowance: null,
    aiScanAllowance: null,
    maxBalance: null,
    badge: '',
    stripePriceEnv: '',
    checkout: false,
    unlimited: true,
    whiteLabel: true,
    description: 'For teams that need custom pricing, onboarding, and support.',
  },
};
const planSwitchPortalConfigurationIds = new Map();
const PLATFORM_REPORT_BRANDING = {
  agency_name: 'PitchProof',
  tagline: 'Website Assessment',
  primary_color: '#f5c842',
  secondary_color: '#1d1d1f',
  website: '',
  email: '',
  phone: '',
  booking_link: '',
  logo_url: '',
  favicon_url: '',
  disclaimer: 'This assessment is based on observable website signals at the time of review.',
  powered_by: 'Powered by PitchProof',
};
const PROFESSIONAL_PLAN = {
  ...PLAN_CATALOG.professional,
  auditLimit: PLAN_CATALOG.professional.monthlyAllowance,
};
const REPORT_LIST_SELECT = [
  'id',
  'user_id',
  'website_url',
  'website',
  'website_domain',
  'website_name',
  'website_score',
  'scan_status',
  'created_at',
  'updated_at',
].join(',');
const AI_VISIBILITY_REPORT_LIST_SELECT = [
  'id',
  'user_id',
  'business_name',
  'domain',
  'business_category',
  'primary_service',
  'city',
  'region',
  'country_code',
  'score',
  'label',
  'prompt_set_version',
  'prompts_tested',
  'mention_count',
  'recommendation_count',
  'citation_count',
  'mention_rate',
  'recommendation_rate',
  'citation_rate',
  'average_position',
  'successful_requests',
  'failed_requests',
  'status',
  'created_at',
  'updated_at',
].join(',');

const ACTIVE_STATUSES = new Set(['active', 'trialing']);
const COMPLIMENTARY_RESERVATION_TTL_MS = 60 * 60 * 1000;
const INTERNAL_STATUS_MAP = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  canceled: 'cancelled',
  cancelled: 'cancelled',
  incomplete: 'incomplete',
  incomplete_expired: 'incomplete',
  unpaid: 'unpaid',
  paused: 'past_due',
};

function cleanText(value) {
  return String(value || '').trim();
}

function normalizedEmail(value) {
  return cleanText(value).toLowerCase();
}

function httpError(statusCode, message, code = 'request_failed', details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details) error.details = details;
  return error;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function planForKey(value) {
  const key = cleanText(value).toLowerCase();
  return PLAN_CATALOG[key] || PLAN_CATALOG[DEFAULT_PLAN_KEY];
}

function planSupportsWhiteLabel(planKey) {
  return planForKey(planKey).whiteLabel === true;
}

function subscriptionSupportsWhiteLabel(subscription = {}) {
  const sub = subscription || {};
  const status = normalizeStatus(sub.status || sub.subscription_status || 'incomplete');
  return planSupportsWhiteLabel(sub.plan || DEFAULT_PLAN_KEY) && ACTIVE_STATUSES.has(status);
}

function platformReportBranding() {
  return { ...PLATFORM_REPORT_BRANDING };
}

function reportBrandingForSubscription(branding = {}, subscription = {}) {
  if (subscriptionSupportsWhiteLabel(subscription)) {
    return {
      ...(branding || {}),
      white_label_enabled: true,
      powered_by: '',
    };
  }
  return {
    ...platformReportBranding(),
    white_label_enabled: false,
  };
}

function publicPlan(plan) {
  return {
    key: plan.key,
    name: plan.name,
    price_label: plan.priceLabel,
    monthly_allowance: plan.monthlyAllowance,
    ai_scan_allowance: plan.aiScanAllowance,
    maximum_balance: plan.maxBalance,
    badge: plan.badge || '',
    checkout: Boolean(plan.checkout),
    unlimited: Boolean(plan.unlimited),
    white_label_enabled: planSupportsWhiteLabel(plan.key),
    description: plan.description,
    trial_days: plan.checkout ? subscriptionTrialDays() : 0,
    trial_label: plan.checkout ? `${subscriptionTrialDays()} days free` : '',
    stripe_configured: plan.checkout ? Boolean(stripePriceIdForPlan(plan.key)) : false,
  };
}

function publicPlans() {
  return Object.values(PLAN_CATALOG).map(publicPlan);
}

function stripePriceIdForPlan(planKey) {
  const plan = planForKey(planKey);
  if (!plan.checkout) return '';
  return cleanText(
    process.env[plan.stripePriceEnv] ||
    (plan.key === DEFAULT_PLAN_KEY ? process.env.STRIPE_PRICE_ID : '')
  );
}

function abandonedCartCouponId() {
  return cleanText(
    process.env.STRIPE_ABANDONED_CART_COUPON_ID ||
    process.env.STRIPE_ABANDONED_CART_50_COUPON_ID ||
    process.env.STRIPE_FIRST_MONTH_50_COUPON_ID
  );
}

function abandonedCartPromotionCodeId() {
  return cleanText(
    process.env.STRIPE_ABANDONED_CART_PROMOTION_CODE_ID ||
    process.env.STRIPE_ABANDONED_CART_50_PROMOTION_CODE_ID ||
    process.env.STRIPE_FIRST_MONTH_50_PROMOTION_CODE_ID
  );
}

function abandonedCartDiscountConfigured() {
  return Boolean(abandonedCartCouponId() || abandonedCartPromotionCodeId());
}

function normalizeCheckoutOffer(value = '') {
  const clean = cleanText(value).toLowerCase().replace(/-/g, '_');
  if (['abandoned_cart', 'abandoned_cart_50', 'abandoned_cart_50_first_month', 'first_month_50'].includes(clean)) {
    return ABANDONED_CART_OFFER_KEY;
  }
  return '';
}

function checkoutDiscountForOffer(offer) {
  const normalizedOffer = normalizeCheckoutOffer(offer);
  if (normalizedOffer !== ABANDONED_CART_OFFER_KEY) return null;

  const couponId = abandonedCartCouponId();
  const promotionCodeId = abandonedCartPromotionCodeId();
  if (!couponId && !promotionCodeId) {
    throw httpError(
      503,
      'Abandoned-cart discount is not configured. Add STRIPE_ABANDONED_CART_COUPON_ID or STRIPE_ABANDONED_CART_PROMOTION_CODE_ID in Render.',
      'stripe_abandoned_cart_discount_missing'
    );
  }

  return {
    offer: ABANDONED_CART_OFFER_KEY,
    label: '50% off first month',
    params: couponId
      ? { 'discounts[0][coupon]': couponId }
      : { 'discounts[0][promotion_code]': promotionCodeId },
  };
}

function planForStripePriceId(priceId) {
  const cleanId = cleanText(priceId);
  if (!cleanId) return null;
  return Object.values(PLAN_CATALOG).find(plan => stripePriceIdForPlan(plan.key) === cleanId) || null;
}

function maxBalanceForPlan(plan) {
  return plan.unlimited ? null : plan.maxBalance;
}

function subscriptionTrialDays(options = {}) {
  if (options.skipTrial || options.startPaidNow) return 0;
  const configured = Number(process.env.STRIPE_SUBSCRIPTION_TRIAL_DAYS || SUBSCRIPTION_TRIAL_DAYS);
  if (!Number.isFinite(configured) || configured <= 0) return SUBSCRIPTION_TRIAL_DAYS;
  return Math.max(1, Math.min(730, Math.floor(configured)));
}

function allowanceForPlan(plan, status = 'active') {
  if (plan.unlimited) return null;
  return plan.monthlyAllowance;
}

function defaultRemainingForPlan(plan, status = 'active') {
  if (plan.unlimited) return null;
  return allowanceForPlan(plan, status);
}

function aiScanAllowanceForPlan(plan) {
  if (plan.unlimited) return null;
  return Math.max(0, Number(plan.aiScanAllowance) || 0);
}

function numericOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function planRank(planKey) {
  return { starter: 1, professional: 2, growth: 3, enterprise: 4 }[planForKey(planKey).key] || 0;
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

function supabaseAnonKey() {
  return cleanText(process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function supabaseServiceRoleKey() {
  const key = cleanText(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!key) throw httpError(503, 'Supabase service-role key is not configured.', 'supabase_service_role_missing');
  return key;
}

function hasStripeConfig() {
  return Boolean(process.env.STRIPE_SECRET_KEY && Object.values(PLAN_CATALOG).some(plan => plan.checkout && stripePriceIdForPlan(plan.key)));
}

function hasWebhookConfig() {
  return Boolean(process.env.STRIPE_WEBHOOK_SECRET);
}

function billingConfigStatus() {
  return {
    stripeConfigured: hasStripeConfig(),
    webhookConfigured: hasWebhookConfig(),
    supabaseServiceConfigured: Boolean(cleanText(process.env.SUPABASE_SERVICE_ROLE_KEY)),
    priceIdConfigured: Boolean(stripePriceIdForPlan(DEFAULT_PLAN_KEY)),
    abandonedCartDiscountConfigured: abandonedCartDiscountConfigured(),
    aiVisibilityEnabled: /^(1|true|yes|on)$/i.test(cleanText(process.env.AI_VISIBILITY_ENABLED)),
    plan: PROFESSIONAL_PLAN,
    plans: publicPlans(),
    trialDays: subscriptionTrialDays(),
  };
}

function requireStripeConfig(planKey = DEFAULT_PLAN_KEY) {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw httpError(503, 'Stripe secret key is not configured.', 'stripe_secret_missing');
  }
  const plan = planForKey(planKey);
  if (!plan.checkout) {
    throw httpError(409, `${plan.name} uses a contact-sales flow instead of Stripe checkout.`, 'contact_sales_plan');
  }
  if (!stripePriceIdForPlan(plan.key)) {
    throw httpError(503, `${plan.name} Stripe price ID is not configured. Add ${plan.stripePriceEnv}${plan.key === DEFAULT_PLAN_KEY ? ' or STRIPE_PRICE_ID' : ''} in Render.`, 'stripe_price_missing');
  }
}

function requestOrigin(req) {
  const configured = cleanText(process.env.APP_URL || process.env.PUBLIC_APP_URL || process.env.RENDER_EXTERNAL_URL);
  if (configured) return configured.replace(/\/+$/, '');

  const proto = cleanText(req.get('x-forwarded-proto')) || req.protocol || 'https';
  const host = cleanText(req.get('x-forwarded-host') || req.get('host'));
  return host ? `${proto.split(',')[0]}://${host}` : 'http://localhost:3000';
}

function bearerToken(req) {
  const header = cleanText(req.get('authorization'));
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function decodedJwtPayload(rawToken = '') {
  const [, payload] = cleanText(rawToken).split('.');
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function supabaseEnvironmentSummary() {
  const baseUrl = supabaseBaseUrl();
  const host = new URL(baseUrl).host;
  const anonPayload = decodedJwtPayload(process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '');
  const servicePayload = decodedJwtPayload(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  return {
    url_host: host,
    url_project_ref: host.split('.')[0] || '',
    anon_key_ref: anonPayload.ref || '',
    anon_key_role: anonPayload.role || '',
    service_key_ref: servicePayload.ref || '',
    service_key_role: servicePayload.role || '',
  };
}

async function requireAuthenticatedUser(req) {
  const token = bearerToken(req);
  if (!token) throw httpError(401, 'Authentication is required.', 'auth_required');

  const apiKey = supabaseAnonKey();
  if (!apiKey) throw httpError(503, 'Supabase auth key is not configured.', 'supabase_auth_missing');

  const response = await fetch(`${supabaseBaseUrl()}/auth/v1/user`, {
    headers: {
      apikey: apiKey,
      authorization: `Bearer ${token}`,
    },
  });

  const payload = parseJson(await response.text());
  if (!response.ok || !payload?.id) {
    throw httpError(401, 'Authentication is required.', 'auth_required');
  }

  return {
    token,
    user: {
      id: payload.id,
      email: payload.email || '',
      metadata: payload.user_metadata || {},
    },
  };
}

async function getAuthAdminUserStatus(userId) {
  const response = await fetch(`${supabaseBaseUrl()}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    headers: {
      apikey: supabaseServiceRoleKey(),
      authorization: `Bearer ${supabaseServiceRoleKey()}`,
      accept: 'application/json',
    },
  });

  const body = parseJson(await response.text());
  return {
    exists: response.ok && body?.id === userId,
    status: response.status,
    user_id: response.ok ? body?.id || '' : '',
    email: response.ok ? body?.email || '' : '',
    error: response.ok ? '' : body?.message || body?.error_description || body?.error || 'Auth admin lookup failed.',
  };
}

async function assertAuthUserExistsForWrites(user) {
  let status = null;
  const delays = [0, 350, 700, 1200, 1800, 2600];

  for (const delay of delays) {
    if (delay) await wait(delay);
    status = await getAuthAdminUserStatus(user.id);
    if (status.exists) return status;
  }

  throw httpError(
    409,
    'Your account is still finishing setup in Supabase. Wait a few seconds and try again. If this keeps happening, confirm Render SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY are from the same Supabase project.',
    'supabase_user_project_mismatch',
    {
      auth_admin_status: status?.status,
      auth_admin_error: status?.error,
      supabase_environment: supabaseEnvironmentSummary(),
    }
  );
}

async function supabaseRest(path, options = {}) {
  const url = new URL(`${supabaseBaseUrl()}/rest/v1/${String(path).replace(/^\/+/, '')}`);
  Object.entries(options.query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  });

  const headers = {
    apikey: supabaseServiceRoleKey(),
    authorization: `Bearer ${supabaseServiceRoleKey()}`,
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
    throw httpError(response.status, message, 'supabase_request_failed', body);
  }
  return body;
}

async function supabaseRpc(name, body = {}) {
  return supabaseRest(`rpc/${name}`, {
    method: 'POST',
    body,
  });
}

function firstRow(rows) {
  return Array.isArray(rows) ? rows[0] || null : rows || null;
}

function reportDataRoot(reportData) {
  const data = reportData && typeof reportData === 'object' && !Array.isArray(reportData) ? reportData : {};
  return data.report && typeof data.report === 'object' && !Array.isArray(data.report) ? data.report : data;
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asText(value) {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    if ('impact' in value) return asText(value.impact);
    if ('description' in value) return asText(value.description);
    if ('issue' in value) return asText(value.issue);
    if ('detail' in value) return asText(value.detail);
    if ('evidence' in value) return asText(value.evidence);
    if ('snippet' in value) return asText(value.snippet);
  }
  return String(value || '').trim();
}

function firstValue(...values) {
  for (const value of values) {
    if (value == null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    if (Array.isArray(value) && !value.length) continue;
    if (isObject(value) && !Object.keys(value).length) continue;
    return value;
  }
  return null;
}

function previewPriority(rawItem, index = 0) {
  const item = isObject(rawItem) ? rawItem : {};
  const explicit = asText(item.priority || item.severity).toLowerCase();
  const priority = explicit.includes('high')
    ? 'High'
    : explicit.includes('low')
      ? 'Low'
      : explicit.includes('medium') || explicit.includes('moderate')
        ? 'Medium'
        : index === 0 ? 'High' : 'Medium';
  const title = asText(item.label) || asText(item.title) || asText(item.key) || asText(rawItem) || `Priority ${index + 1}`;
  const impact = asText(item.impact) || asText(item.description) || asText(item.issue) || asText(item.detail) || 'This area may affect clarity, trust, or conversion performance.';
  return { title, priority, impact };
}

function categoryLabelForPreview(key, rawCat = {}) {
  const label = asText(rawCat.label);
  const combined = `${key} ${label}`.toLowerCase();
  if (combined.includes('seo') || combined.includes('visibility')) return 'SEO Visibility';
  if (combined.includes('trust') || combined.includes('credibility')) return 'Trust & Credibility';
  if (combined.includes('lead') || combined.includes('conversion')) return 'Lead Conversion';
  if (combined.includes('technical') || combined.includes('performance') || combined.includes('speed')) return 'Technical Health';
  if (combined.includes('visual') || combined.includes('design') || combined.includes('user')) return 'Visual Trust & Design';
  return label || key || 'Website Category';
}

function scoreMaxForPreview(score, max) {
  const numericMax = Number(max);
  if (Number.isFinite(numericMax) && numericMax > 0) return numericMax;
  const numericScore = Number(score);
  if (Number.isFinite(numericScore) && numericScore > 100) return numericScore;
  return 100;
}

function previewCategories(root = {}) {
  const rows = [];
  const seen = new Set();
  Object.entries(isObject(root.categories) ? root.categories : {}).forEach(([key, raw]) => {
    const cat = isObject(raw) ? raw : {};
    const score = Number.isFinite(Number(cat.score)) ? Number(cat.score) : 0;
    const max = scoreMaxForPreview(score, cat.max);
    const label = categoryLabelForPreview(key, cat);
    const canonical = label.toLowerCase();
    if (seen.has(canonical)) return;
    seen.add(canonical);
    rows.push({ key, label, score, max });
  });
  return rows.slice(0, 5);
}

function buildPreviewReportData(report = {}) {
  const originalData = isObject(report.report_data) ? report.report_data : {};
  const root = reportDataRoot(originalData);
  const score = reportScoreValue(firstValue(root.total, root.score, root.websiteScore, root.rating, report.website_score));
  const maxScore = Number(root.maxScore) || 100;
  const aiVisibility = firstValue(root.aiVisibility, root.ai_visibility);
  const prioritySource = [
    ...asArray(root.criticalFlags),
    ...asArray(root.issues),
    ...asArray(root.recommendations),
  ];
  const topPriorities = prioritySource.slice(0, 3).map(previewPriority);
  while (topPriorities.length < 3) {
    const defaults = [
      ['Strengthen Calls-to-Action', 'Make the next step obvious for visitors ready to call, book, or request a quote.'],
      ['Improve Trust Signals', 'Show stronger proof that the business is credible, experienced, and safe to contact.'],
      ['Tighten Local Visibility', 'Help nearby customers understand services, location, and relevance faster.'],
    ];
    const [title, impact] = defaults[topPriorities.length];
    topPriorities.push({ title, priority: topPriorities.length === 0 ? 'High' : 'Medium', impact });
  }
  const categories = previewCategories(root);
  const categoryObject = {};
  categories.forEach(category => {
    categoryObject[category.key || category.label] = {
      label: category.label,
      score: category.score,
      max: category.max,
    };
  });

  return {
    report: {
      url: asText(root.url) || report.website_url || report.website || '',
      total: score,
      score,
      websiteScore: score,
      maxScore,
      categories: categoryObject,
      ...(isObject(aiVisibility) && { aiVisibility }),
      previewLocked: true,
      topPriorities,
      previewTopPriorities: topPriorities,
      lockedSections: [
        'Detailed Findings',
        'How to Fix',
        'Technical Issues',
        'Conversion Recommendations',
        'Complete Assessment',
      ],
    },
    context: {
      ...(isObject(originalData.context) ? originalData.context : {}),
      previewLocked: true,
    },
  };
}

function reportIsComplimentaryPreview(report = {}, subscription = {}) {
  return Boolean(report?.id && subscription?.complimentary_report_id === report.id);
}

function reportForClient(report = {}, subscription = {}) {
  if (isSubscriptionUsable(subscription || {})) {
    return {
      ...report,
      preview_locked: false,
      full_report_locked: false,
    };
  }

  if (reportIsComplimentaryPreview(report, subscription || {})) {
    return {
      ...report,
      report_data: buildPreviewReportData(report),
      preview_locked: true,
      full_report_locked: true,
    };
  }

  throw httpError(
    402,
    'Choose a plan to unlock this complete report.',
    'subscription_required',
    { subscription: normalizeSubscriptionForClient(subscription) }
  );
}

function normalizeReportUrl(value) {
  const raw = cleanText(value);
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function domainFromReportUrl(value) {
  const url = normalizeReportUrl(value);
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return url.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./i, '');
  }
}

function websiteNameFromReportUrl(value) {
  const domain = domainFromReportUrl(value);
  if (!domain) return '';
  return domain
    .split('.')
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function reportScoreValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace('%', '').trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function reportJson(value) {
  try {
    return JSON.parse(JSON.stringify(value || {}));
  } catch {
    return {};
  }
}

function reportOrder(sort = 'created_at.desc') {
  const [requestedColumn = 'created_at', requestedDirection = 'desc'] = cleanText(sort).split('.');
  const columns = {
    created_at: 'created_at',
    updated_at: 'updated_at',
    website: 'website_domain',
    website_url: 'website_url',
    website_domain: 'website_domain',
    website_name: 'website_name',
    website_score: 'website_score',
    scan_status: 'scan_status',
  };
  const column = columns[requestedColumn] || 'created_at';
  const direction = requestedDirection === 'asc' ? 'asc' : 'desc';
  return `${column}.${direction}`;
}

function reportPayloadForUser(userId, input = {}) {
  const data = reportJson(input.reportData ?? input.report_data);
  const root = reportDataRoot(data);
  const normalizedWebsite = normalizeReportUrl(input.websiteUrl || input.website_url || input.website || root.url || root.websiteUrl);
  if (!normalizedWebsite) throw httpError(400, 'Report website is required.', 'report_website_required');

  return {
    user_id: userId,
    website_url: normalizedWebsite,
    website: normalizedWebsite,
    website_domain: domainFromReportUrl(normalizedWebsite),
    website_name: cleanText(input.websiteName || input.website_name) || websiteNameFromReportUrl(normalizedWebsite),
    website_score: reportScoreValue(input.websiteScore ?? input.website_score ?? root.total ?? root.score ?? root.websiteScore ?? root.rating),
    report_data: data,
    scan_status: cleanText(input.scanStatus || input.scan_status) || 'completed',
  };
}

async function createReportForUser(userId, input = {}) {
  const subscription = await getSubscriptionForUser(userId);
  const auditKey = cleanText(input.auditIdempotencyKey || input.audit_idempotency_key);
  const canSaveWithSubscription = isSubscriptionUsable(subscription || {});
  const canSaveComplimentaryReport = Boolean(
    auditKey &&
    subscription?.complimentary_scan_reserved_key === auditKey &&
    !subscription?.complimentary_scan_used_at
  );

  if (!canSaveWithSubscription && !canSaveComplimentaryReport) {
    throw httpError(
      402,
      subscription?.complimentary_scan_used_at
        ? 'Your complimentary report preview has already been used. Choose a plan to generate additional reports.'
        : 'Generate your free report preview or choose a plan before saving reports.',
      'subscription_required',
      { subscription: normalizeSubscriptionForClient(subscription) }
    );
  }

  const rows = await supabaseRest('reports', {
    method: 'POST',
    prefer: 'return=representation',
    query: { select: REPORT_LIST_SELECT },
    body: reportPayloadForUser(userId, input),
  });
  const report = firstRow(rows);
  const complimentaryCompletion = await completeComplimentaryScan(
    userId,
    input.auditIdempotencyKey || input.audit_idempotency_key,
    report?.id
  ).catch(error => {
    console.warn('[LeadCheck] Complimentary scan completion failed:', error?.message || error);
    return null;
  });
  if (report && complimentaryCompletion) report.complimentary_scan_completed = true;
  return report;
}

async function listReportsForUser(userId, options = {}) {
  const safeLimit = Math.max(1, Math.min(Number(options.limit) || 25, 250));
  const term = cleanText(options.search);
  const query = {
    select: REPORT_LIST_SELECT,
    user_id: `eq.${userId}`,
    order: reportOrder(options.sort),
    limit: String(safeLimit),
  };
  if (term) query.website_url = `ilike.*${term.replace(/\*/g, '')}*`;
  return supabaseRest('reports', { query });
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function aiVisibilityReportPayloadForUser(userId, input = {}, assessment = {}, options = {}) {
  const assessmentInput = isObject(assessment.input) ? assessment.input : {};
  const domain = domainFromReportUrl(input.domain || assessmentInput.domain);
  if (!domain) throw httpError(400, 'Business website domain is required.', 'ai_visibility_domain_required');

  return {
    user_id: userId,
    business_name: cleanText(input.businessName || assessmentInput.businessName),
    domain,
    business_category: cleanText(input.businessCategory || assessmentInput.businessCategory),
    primary_service: cleanText(input.primaryService || assessmentInput.primaryService),
    city: cleanText(input.city || assessmentInput.city),
    region: cleanText(input.region || assessmentInput.region),
    country_code: cleanText(input.countryCode || assessmentInput.countryCode).toUpperCase(),
    score: numberOrNull(assessment.score),
    label: cleanText(assessment.label),
    prompt_set_version: cleanText(assessment.promptSetVersion || assessment.prompt_set_version),
    prompts_tested: Math.max(0, Number(assessment.promptsTested || assessment.prompts_tested) || 0),
    mention_count: Math.max(0, Number(assessment.mentions || assessment.mention_count) || 0),
    recommendation_count: Math.max(0, Number(assessment.recommendations || assessment.recommendation_count) || 0),
    citation_count: Math.max(0, Number(assessment.citations || assessment.citation_count) || 0),
    mention_rate: numberOrNull(assessment.mentionRate ?? assessment.mention_rate),
    recommendation_rate: numberOrNull(assessment.recommendationRate ?? assessment.recommendation_rate),
    citation_rate: numberOrNull(assessment.citationRate ?? assessment.citation_rate),
    average_position: numberOrNull(assessment.averagePosition ?? assessment.average_position),
    queries: reportJson(assessment.queries),
    competitors: reportJson(assessment.competitors),
    missed_opportunities: reportJson(assessment.missedOpportunities || assessment.missed_opportunities),
    summary: cleanText(assessment.summary),
    provider: cleanText(assessment.provider),
    model: cleanText(assessment.model),
    provider_cost: numberOrNull(assessment.totalCost ?? assessment.provider_cost),
    average_cost_per_prompt: numberOrNull(assessment.averageCostPerPrompt ?? assessment.average_cost_per_prompt),
    successful_requests: Math.max(0, Number(assessment.successfulRequests || assessment.successful_requests) || 0),
    failed_requests: Math.max(0, Number(assessment.failedRequests || assessment.failed_requests) || 0),
    status: cleanText(assessment.status) || 'complete',
    cache_hit: options.cacheHit === true,
    assessment_data: reportJson(assessment),
  };
}

function aiVisibilityQueryForClient(query = {}) {
  const item = isObject(query) ? query : {};
  return {
    intent: item.intent,
    prompt: item.prompt,
    success: item.success === true,
    mentioned: item.mentioned === true,
    recommended: item.recommended === true,
    position: numberOrNull(item.position),
    cited: item.cited === true,
    competitors: asArray(item.competitors).map((competitor) => ({
      businessName: competitor.businessName,
      ...(competitor.domain ? { domain: competitor.domain } : {}),
      position: numberOrNull(competitor.position),
    })),
    ...(item.success === false ? {
      error: cleanText(item.error),
      code: cleanText(item.code),
    } : {}),
  };
}

function aiVisibilityReportForClient(report = {}) {
  const competitors = asArray(report.competitors);
  const visibility = visibilityClassification({
    status: report.status,
    recommendationCount: report.recommendation_count,
    promptsTested: report.prompts_tested,
    successfulRequests: report.successful_requests,
    competitorCount: competitors.length,
  });
  return {
    id: report.id,
    user_id: report.user_id,
    business_name: report.business_name,
    domain: report.domain,
    business_category: report.business_category,
    primary_service: report.primary_service,
    city: report.city,
    region: report.region,
    country_code: report.country_code,
    score: report.score,
    label: report.label,
    visibility_level: visibility.level,
    visibilityLevel: visibility.level,
    visibility_tone: visibility.tone,
    visibilityTone: visibility.tone,
    visibility_summary: visibility.summary,
    visibilitySummary: visibility.summary,
    recommendations: report.recommendation_count,
    promptsTested: report.prompts_tested,
    prompt_set_version: report.prompt_set_version,
    prompts_tested: report.prompts_tested,
    mention_count: report.mention_count,
    recommendation_count: report.recommendation_count,
    citation_count: report.citation_count,
    mention_rate: report.mention_rate,
    recommendation_rate: report.recommendation_rate,
    citation_rate: report.citation_rate,
    average_position: report.average_position,
    queries: asArray(report.queries).map(aiVisibilityQueryForClient),
    competitors,
    missed_opportunities: asArray(report.missed_opportunities),
    summary: report.summary,
    provider: report.provider,
    model: report.model,
    successful_requests: report.successful_requests,
    failed_requests: report.failed_requests,
    status: report.status,
    created_at: report.created_at,
    updated_at: report.updated_at,
  };
}

async function listAiVisibilityReportsForUser(userId, options = {}) {
  const safeLimit = Math.max(1, Math.min(Number(options.limit) || 25, 250));
  const term = cleanText(options.search).replace(/\*/g, '');
  const query = {
    select: AI_VISIBILITY_REPORT_LIST_SELECT,
    user_id: `eq.${userId}`,
    order: 'created_at.desc',
    limit: String(safeLimit),
  };
  if (term) query.or = `(business_name.ilike.*${term}*,domain.ilike.*${term}*,city.ilike.*${term}*)`;
  const rows = await supabaseRest('ai_visibility_reports', { query });
  return asArray(rows).map(aiVisibilityReportForClient);
}

async function getAiVisibilityReportForUser(userId, reportId) {
  const rows = await supabaseRest('ai_visibility_reports', {
    query: {
      select: '*',
      user_id: `eq.${userId}`,
      id: `eq.${reportId}`,
      limit: '1',
    },
  });
  const report = firstRow(rows);
  if (!report) throw httpError(404, 'AI Visibility report not found or access denied.', 'ai_visibility_report_not_found');
  return report;
}

async function getAiVisibilityReportForUserForClient(userId, reportId) {
  return aiVisibilityReportForClient(await getAiVisibilityReportForUser(userId, reportId));
}

async function createAiVisibilityReportForUser(userId, input = {}, assessment = {}, options = {}) {
  const rows = await supabaseRest('ai_visibility_reports', {
    method: 'POST',
    prefer: 'return=representation',
    query: { select: '*' },
    body: aiVisibilityReportPayloadForUser(userId, input, assessment, options),
  });
  return firstRow(rows);
}

async function deleteAiVisibilityReportForUser(userId, reportId) {
  await supabaseRest('ai_visibility_reports', {
    method: 'DELETE',
    query: {
      user_id: `eq.${userId}`,
      id: `eq.${reportId}`,
    },
  });
  return true;
}

async function checkAiVisibilityAccessForUser(userId) {
  const subscription = await ensureSubscriptionForUser(userId);
  const normalized = normalizeSubscriptionForClient(subscription);
  if (!normalized.can_run_ai_visibility) {
    return {
      allowed: false,
      reason: !subscription
        ? 'no_subscription'
        : (ACTIVE_STATUSES.has(normalized.status) ? 'ai_visibility_limit_reached' : 'subscription_inactive'),
      subscription,
    };
  }
  return {
    allowed: true,
    reason: 'available',
    subscription,
  };
}

async function recordAiVisibilityUsage(userId, reportId) {
  return supabaseRpc('record_ai_visibility_usage', {
    p_user_id: userId,
    p_report_id: reportId,
  });
}

async function getSubscriptionForUser(userId) {
  const rows = await supabaseRest('subscriptions', {
    query: {
      select: '*',
      user_id: `eq.${userId}`,
      limit: '1',
    },
  });
  return firstRow(rows);
}

async function getSubscriptionByStripeSubscriptionId(subscriptionId) {
  if (!subscriptionId) return null;
  const rows = await supabaseRest('subscriptions', {
    query: {
      select: '*',
      stripe_subscription_id: `eq.${subscriptionId}`,
      limit: '1',
    },
  });
  return firstRow(rows);
}

async function getSubscriptionByCustomerId(customerId) {
  if (!customerId) return null;
  const rows = await supabaseRest('subscriptions', {
    query: {
      select: '*',
      stripe_customer_id: `eq.${customerId}`,
      limit: '1',
    },
  });
  return firstRow(rows);
}

async function upsertSubscriptionForUser(userId, payload = {}) {
  const existing = await getSubscriptionForUser(userId);
  const selectedPlan = planForKey(payload.plan || existing?.plan || DEFAULT_PLAN_KEY);
  const selectedStatus = normalizeStatus(payload.status || existing?.status || 'incomplete');
  const allowance = allowanceForPlan(selectedPlan, selectedStatus);
  const aiAllowance = aiScanAllowanceForPlan(selectedPlan);
  const body = {
    plan: selectedPlan.key,
    monthly_allowance: payload.monthly_allowance ?? existing?.monthly_allowance ?? allowance,
    maximum_rollover: payload.maximum_rollover ?? existing?.maximum_rollover ?? maxBalanceForPlan(selectedPlan),
    audit_limit: payload.audit_limit ?? existing?.audit_limit ?? allowance ?? 0,
    scans_remaining: payload.scans_remaining ?? existing?.scans_remaining ?? defaultRemainingForPlan(selectedPlan, selectedStatus),
    white_label_enabled: payload.white_label_enabled ?? planSupportsWhiteLabel(selectedPlan.key),
    subscription_status: payload.subscription_status ?? payload.status ?? existing?.subscription_status ?? selectedStatus,
    renewal_date: payload.renewal_date ?? payload.current_period_end ?? existing?.renewal_date ?? existing?.current_period_end ?? null,
    used_scans: payload.used_scans ?? existing?.used_scans ?? existing?.audits_used ?? 0,
    ai_scan_limit: payload.ai_scan_limit ?? existing?.ai_scan_limit ?? aiAllowance ?? 0,
    ai_scans_used: payload.ai_scans_used ?? existing?.ai_scans_used ?? 0,
    extra_scans_remaining: payload.extra_scans_remaining ?? existing?.extra_scans_remaining ?? 0,
    ...payload,
  };

  if (existing) return patchSubscriptionForUser(userId, body);

  const rows = await supabaseRest('subscriptions', {
    method: 'POST',
    prefer: 'return=representation',
    body: {
      id: crypto.randomUUID(),
      user_id: userId,
      ...body,
      updated_at: new Date().toISOString(),
    },
  });
  return firstRow(rows);
}

async function patchSubscriptionForUser(userId, payload = {}) {
  const rows = await supabaseRest('subscriptions', {
    method: 'PATCH',
    query: {
      user_id: `eq.${userId}`,
      select: '*',
    },
    prefer: 'return=representation',
    body: {
      ...payload,
      updated_at: new Date().toISOString(),
    },
  });
  return firstRow(rows);
}

function complimentaryReservationIsStale(subscription = {}) {
  if (!subscription?.complimentary_scan_reserved_key || subscription?.complimentary_scan_used_at) return false;
  const startedAt = Date.parse(subscription.complimentary_scan_started_at || '');
  return Number.isFinite(startedAt) && Date.now() - startedAt > COMPLIMENTARY_RESERVATION_TTL_MS;
}

async function clearStaleComplimentaryReservation(userId, subscription = {}) {
  if (!complimentaryReservationIsStale(subscription)) return subscription;
  const rows = await supabaseRest('subscriptions', {
    method: 'PATCH',
    query: {
      user_id: `eq.${userId}`,
      complimentary_scan_reserved_key: `eq.${subscription.complimentary_scan_reserved_key}`,
      complimentary_scan_used_at: 'is.null',
      select: '*',
    },
    prefer: 'return=representation',
    body: {
      complimentary_scan_available: true,
      complimentary_scan_reserved_key: null,
      complimentary_scan_started_at: null,
      updated_at: new Date().toISOString(),
    },
  });
  return firstRow(rows) || subscription;
}

async function reserveComplimentaryScan(userId, idempotencyKey, subscription = null) {
  const key = cleanText(idempotencyKey) || crypto.randomUUID();
  let current = subscription || await getSubscriptionForUser(userId);
  if (!current) return null;
  const status = normalizeStatus(current.status || current.subscription_status || 'incomplete');
  if (ACTIVE_STATUSES.has(status) || current.stripe_subscription_id) return null;
  if (current.complimentary_scan_used_at) return null;
  current = await clearStaleComplimentaryReservation(userId, current);
  if (current.complimentary_scan_reserved_key) {
    return {
      allowed: false,
      reason: 'complimentary_scan_in_progress',
      idempotency_key: key,
      complimentary: true,
      subscription: current,
    };
  }
  if (current.complimentary_scan_available !== true) return null;

  const rows = await supabaseRest('subscriptions', {
    method: 'PATCH',
    query: {
      user_id: `eq.${userId}`,
      complimentary_scan_available: 'eq.true',
      complimentary_scan_used_at: 'is.null',
      complimentary_scan_reserved_key: 'is.null',
      select: '*',
    },
    prefer: 'return=representation',
    body: {
      complimentary_scan_available: false,
      complimentary_scan_reserved_key: key,
      complimentary_scan_started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
  const reserved = firstRow(rows);
  if (!reserved) return null;
  return {
    allowed: true,
    reason: '',
    idempotency_key: key,
    complimentary: true,
    subscription: reserved,
  };
}

async function completeComplimentaryScan(userId, idempotencyKey, reportId) {
  const key = cleanText(idempotencyKey);
  if (!key || !reportId) return null;
  const rows = await supabaseRest('subscriptions', {
    method: 'PATCH',
    query: {
      user_id: `eq.${userId}`,
      complimentary_scan_reserved_key: `eq.${key}`,
      complimentary_scan_used_at: 'is.null',
      select: '*',
    },
    prefer: 'return=representation',
    body: {
      complimentary_scan_available: false,
      complimentary_scan_reserved_key: null,
      complimentary_scan_used_at: new Date().toISOString(),
      complimentary_report_id: reportId,
      updated_at: new Date().toISOString(),
    },
  });
  return firstRow(rows);
}

async function refundComplimentaryScan(userId, idempotencyKey) {
  const key = cleanText(idempotencyKey);
  if (!key) return null;
  const rows = await supabaseRest('subscriptions', {
    method: 'PATCH',
    query: {
      user_id: `eq.${userId}`,
      complimentary_scan_reserved_key: `eq.${key}`,
      complimentary_scan_used_at: 'is.null',
      select: '*',
    },
    prefer: 'return=representation',
    body: {
      complimentary_scan_available: true,
      complimentary_scan_reserved_key: null,
      complimentary_scan_started_at: null,
      updated_at: new Date().toISOString(),
    },
  });
  return firstRow(rows);
}

async function getAgencyBrandingForUser(userId) {
  const rows = await supabaseRest('agency_branding', {
    query: {
      select: '*',
      user_id: `eq.${userId}`,
      limit: '1',
    },
  });
  return firstRow(rows);
}

function agencyBrandingPayload(userId, branding = {}) {
  return {
    id: branding.id || crypto.randomUUID(),
    user_id: userId,
    agency_name: cleanText(branding.agencyName || branding.agency_name),
    logo_url: cleanText(branding.logoUrl || branding.logo_url || branding.logoStoragePath || branding.logo_storage_path),
    primary_color: cleanText(branding.primaryAccent || branding.primary_color),
    secondary_color: cleanText(branding.secondaryAccent || branding.secondary_color),
    website: cleanText(branding.website),
    email: cleanText(branding.email),
    phone: cleanText(branding.phone),
    booking_link: cleanText(branding.bookingLink || branding.booking_link),
    favicon_url: cleanText(branding.faviconUrl || branding.favicon_url || branding.faviconStoragePath || branding.favicon_storage_path),
    tagline: cleanText(branding.tagline),
    disclaimer: cleanText(branding.reportDisclaimer || branding.disclaimer || branding.report_disclaimer),
    updated_at: new Date().toISOString(),
  };
}

async function updateAgencyBrandingForUser(userId, branding = {}) {
  const existing = await getAgencyBrandingForUser(userId).catch(() => null);
  const payload = agencyBrandingPayload(userId, { ...(existing || {}), ...(branding || {}) });

  if (existing) {
    const rows = await supabaseRest('agency_branding', {
      method: 'PATCH',
      prefer: 'return=representation',
      query: {
        ...(existing.id ? { id: `eq.${existing.id}` } : { user_id: `eq.${userId}` }),
        select: '*',
      },
      body: payload,
    });
    return firstRow(rows);
  }

  const rows = await supabaseRest('agency_branding', {
    method: 'POST',
    prefer: 'return=representation',
    query: {
      select: '*',
    },
    body: payload,
  });
  return firstRow(rows);
}

function userProfilePayload(user = {}) {
  const metadata = user.metadata || {};
  return {
    id: user.id,
    email: cleanText(user.email),
    full_name: cleanText(metadata.name || metadata.full_name),
    agency_name: cleanText(metadata.agency_name || metadata.company_name),
  };
}

async function ensureProfileForUser(user) {
  const profile = userProfilePayload(user);
  const patchBody = {
    email: profile.email,
    updated_at: new Date().toISOString(),
  };
  if (profile.full_name) patchBody.full_name = profile.full_name;
  if (profile.agency_name) patchBody.agency_name = profile.agency_name;

  const updatedRows = await supabaseRest('profiles', {
    method: 'PATCH',
    query: {
      id: `eq.${user.id}`,
      select: '*',
    },
    prefer: 'return=representation',
    body: patchBody,
  });

  const updated = firstRow(updatedRows);
  if (updated) return updated;

  const rows = await supabaseRest('profiles', {
    method: 'POST',
    prefer: 'return=representation',
    body: profile,
  });
  return firstRow(rows);
}

async function ensureBrandingForUser(user) {
  const existing = await getAgencyBrandingForUser(user.id);
  if (existing) return existing;

  const profile = userProfilePayload(user);
  const rows = await supabaseRest('agency_branding', {
    method: 'POST',
    prefer: 'return=representation',
    body: {
      id: crypto.randomUUID(),
      user_id: user.id,
      agency_name: profile.agency_name || profile.full_name || '',
    },
  });
  return firstRow(rows);
}

async function ensureSubscriptionForUser(userId) {
  const existing = await getSubscriptionForUser(userId);
  if (existing) {
    const status = normalizeStatus(existing.status || existing.subscription_status || 'incomplete');
    const canRepairPreviewAccess = !ACTIVE_STATUSES.has(status)
      && !existing.stripe_customer_id
      && !existing.stripe_subscription_id
      && !existing.complimentary_scan_reserved_key
      && !existing.complimentary_scan_used_at
      && !existing.complimentary_report_id
      && existing.complimentary_scan_available !== true;

    if (!canRepairPreviewAccess) return existing;

    const repaired = await patchSubscriptionForUser(userId, {
      complimentary_scan_available: true,
      complimentary_scan_reserved_key: null,
      complimentary_scan_started_at: null,
      complimentary_scan_used_at: null,
      complimentary_report_id: null,
      subscription_status: status,
    }).catch(error => {
      console.warn('[LeadCheck] Complimentary preview repair failed:', error?.message || error);
      return null;
    });
    return repaired || existing;
  }
  const plan = PLAN_CATALOG[DEFAULT_PLAN_KEY];

  const rows = await supabaseRest('subscriptions', {
    method: 'POST',
    prefer: 'return=representation',
    body: {
      id: crypto.randomUUID(),
      user_id: userId,
      plan: plan.key,
      status: 'incomplete',
      audit_limit: 0,
      monthly_allowance: 0,
      maximum_rollover: plan.maxBalance,
      scans_remaining: 0,
      white_label_enabled: planSupportsWhiteLabel(plan.key),
      audits_used: 0,
      used_scans: 0,
      ai_scan_limit: 0,
      ai_scans_used: 0,
      extra_scans_remaining: 0,
      complimentary_scan_available: true,
      complimentary_scan_reserved_key: null,
      complimentary_scan_started_at: null,
      complimentary_scan_used_at: null,
      complimentary_report_id: null,
      subscription_status: 'incomplete',
    },
  });
  return firstRow(rows);
}

async function ensureAppUser(user) {
  if (!user?.id) throw httpError(401, 'Authentication is required.', 'auth_required');
  const profile = await ensureProfileForUser(user);
  const branding = await ensureBrandingForUser(user);
  const subscription = await ensureSubscriptionForUser(user.id);

  return {
    user_id: user.id,
    profile,
    branding,
    subscription: normalizeSubscriptionForClient(subscription),
  };
}

async function getReportForUser(userId, reportId) {
  const rows = await supabaseRest('reports', {
    query: {
      select: '*',
      user_id: `eq.${userId}`,
      id: `eq.${reportId}`,
      limit: '1',
    },
  });
  const report = firstRow(rows);
  if (!report) throw httpError(404, 'Report not found or access denied.', 'report_not_found');
  return report;
}

async function getReportForUserForClient(userId, reportId) {
  const [report, subscription] = await Promise.all([
    getReportForUser(userId, reportId),
    getSubscriptionForUser(userId),
  ]);
  return reportForClient(report, subscription || {});
}

async function deleteReportForUser(userId, reportId) {
  await getReportForUser(userId, reportId);
  await supabaseRest('reports', {
    method: 'DELETE',
    query: {
      user_id: `eq.${userId}`,
      id: `eq.${reportId}`,
    },
  });
  return true;
}

async function duplicateReportForUser(userId, reportId) {
  const report = await getReportForUser(userId, reportId);
  return createReportForUser(userId, {
    websiteUrl: report.website_url || report.website,
    websiteName: report.website_name,
    websiteScore: report.website_score,
    reportData: report.report_data,
    scanStatus: 'completed',
  });
}

function normalizeStatus(status) {
  return INTERNAL_STATUS_MAP[cleanText(status).toLowerCase()] || 'incomplete';
}

function timestampToIso(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return new Date(number * 1000).toISOString();
}

function unixFromIso(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return 0;
  return Math.floor(date.getTime() / 1000);
}

function stringId(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return cleanText(value.id);
}

function subscriptionPeriod(subscription = {}) {
  const item = Array.isArray(subscription.items?.data) ? subscription.items.data[0] : null;
  return {
    start: timestampToIso(subscription.current_period_start || item?.current_period_start),
    end: timestampToIso(subscription.current_period_end || item?.current_period_end),
  };
}

function isSubscriptionUsable(subscription = {}) {
  const status = normalizeStatus(subscription.status);
  if (!ACTIVE_STATUSES.has(status)) return false;
  if (subscription.current_period_end && new Date(subscription.current_period_end).getTime() <= Date.now()) {
    return false;
  }
  return true;
}

function normalizeSubscriptionForClient(subscription) {
  const sub = subscription || {};
  const status = normalizeStatus(sub.status || 'incomplete');
  const plan = planForKey(sub.plan || DEFAULT_PLAN_KEY);
  const unlimited = Boolean(plan.unlimited);
  const used = Math.max(0, Number(sub.used_scans ?? sub.audits_used) || 0);
  const fallbackAllowance = allowanceForPlan(plan, status);
  const allowance = unlimited ? null : Math.max(0, Number(sub.monthly_allowance ?? sub.audit_limit ?? fallbackAllowance) || 0);
  const rolloverCap = unlimited ? null : Math.max(0, Number(sub.maximum_rollover ?? maxBalanceForPlan(plan) ?? allowance) || 0);
  const storedRemaining = numericOrNull(sub.scans_remaining ?? sub.audits_remaining);
  const remaining = unlimited ? null : Math.max(0, storedRemaining ?? Math.max(0, allowance - used));
  const balanceLimit = unlimited ? null : Math.max(allowance, rolloverCap, remaining);
  const usable = isSubscriptionUsable(sub);
  const canUse = usable && (unlimited || remaining > 0);
  const canWhiteLabel = usable && planSupportsWhiteLabel(plan.key);
  const aiScanLimit = unlimited ? null : Math.max(0, Number(sub.ai_scan_limit ?? aiScanAllowanceForPlan(plan)) || 0);
  const aiScansUsed = Math.max(0, Number(sub.ai_scans_used) || 0);
  const aiScansRemaining = unlimited ? null : Math.max(0, aiScanLimit - aiScansUsed);
  const canRunAiVisibility = usable && (unlimited || aiScansRemaining > 0);
  const complimentaryAvailable = sub.complimentary_scan_available === true && !sub.complimentary_scan_used_at;
  const complimentaryReserved = Boolean(sub.complimentary_scan_reserved_key && !sub.complimentary_scan_used_at);
  const unpaidOnboarding = !usable && !sub.stripe_subscription_id;
  const canRunComplimentary = unpaidOnboarding && complimentaryAvailable && !complimentaryReserved;

  return {
    exists: Boolean(subscription),
    plan: plan.key,
    plan_name: plan.name,
    price_label: plan.priceLabel,
    paid_audit_limit: plan.monthlyAllowance,
    monthly_allowance: allowance,
    monthlyAllowance: allowance,
    ai_scan_limit: aiScanLimit,
    aiScanAllowance: aiScanLimit,
    ai_scans_used: aiScansUsed,
    ai_scans_remaining: aiScansRemaining,
    remaining_ai_scans: aiScansRemaining,
    ai_scan_unlimited: unlimited,
    remaining_scans: remaining,
    remaining_balance: remaining,
    maximum_rollover: rolloverCap,
    maximum_balance: balanceLimit,
    max_balance: balanceLimit,
    extra_scans_remaining: Math.max(0, Number(sub.extra_scans_remaining) || 0),
    unlimited,
    white_label_enabled: canWhiteLabel,
    can_white_label: canWhiteLabel,
    platform_branding_required: !canWhiteLabel,
    platform_branding_name: PLATFORM_REPORT_BRANDING.agency_name,
    plan_description: plan.description,
    plan_badge: plan.badge || '',
    status,
    payment_status: sub.payment_status || '',
    audits_used: used,
    used_scans: used,
    audit_limit: allowance ?? 0,
    audits_remaining: remaining,
    current_period_start: sub.current_period_start || null,
    current_period_end: sub.current_period_end || null,
    renewal_date: sub.renewal_date || sub.current_period_end || null,
    cancel_at_period_end: Boolean(sub.cancel_at_period_end),
    can_run_audit: canUse,
    can_run_ai_visibility: canRunAiVisibility,
    can_run_complimentary_scan: canRunComplimentary,
    complimentary_scan_available: complimentaryAvailable,
    complimentary_scan_reserved: complimentaryReserved,
    complimentary_scan_started_at: sub.complimentary_scan_started_at || null,
    complimentary_scan_used_at: sub.complimentary_scan_used_at || null,
    complimentary_report_id: sub.complimentary_report_id || null,
    can_save_reports: usable,
    can_duplicate_reports: usable,
    can_export_pdf: usable,
    billing_configured: hasStripeConfig(),
    webhook_configured: hasWebhookConfig(),
    stripe_customer_id: sub.stripe_customer_id ? 'configured' : '',
    stripe_subscription_id: sub.stripe_subscription_id ? 'configured' : '',
    can_start_paid_now: status === 'trialing',
    plans: publicPlans(),
  };
}

async function getSubscriptionStatus(userId) {
  const subscription = await ensureSubscriptionForUser(userId);
  return normalizeSubscriptionForClient(subscription);
}

async function refreshSubscriptionFromStripeForUser(userId) {
  const existing = await getSubscriptionForUser(userId);
  if (!existing?.stripe_subscription_id) return existing ? normalizeSubscriptionForClient(existing) : null;

  const stripeSubscription = await stripeRequest(`/subscriptions/${encodeURIComponent(existing.stripe_subscription_id)}`);
  const updated = await upsertSubscriptionFromStripe(stripeSubscription, {
    userId,
    customerId: existing.stripe_customer_id,
    subscriptionId: existing.stripe_subscription_id,
    paymentStatus: existing.payment_status,
    plan: existing.plan,
  });
  return normalizeSubscriptionForClient(updated || existing);
}

async function getBillingDiagnostics(user) {
  if (!user?.id) throw httpError(401, 'Authentication is required.', 'auth_required');
  const authAdmin = await getAuthAdminUserStatus(user.id);
  const subscription = await getSubscriptionForUser(user.id).catch(error => ({
    error: error.message,
    code: error.code || 'subscription_lookup_failed',
    details: error.details || null,
  }));

  return {
    user_id: user.id,
    user_email: user.email || '',
    auth_admin_user_exists: authAdmin.exists,
    auth_admin_status: authAdmin.status,
    auth_admin_error: authAdmin.error,
    subscription_found: Boolean(subscription && !subscription.error),
    subscription_error: subscription?.error || '',
    subscription_error_details: subscription?.details || null,
    supabase_environment: supabaseEnvironmentSummary(),
  };
}

function stripeSecretKey() {
  const key = cleanText(process.env.STRIPE_SECRET_KEY);
  if (!key) throw httpError(503, 'Stripe secret key is not configured.', 'stripe_secret_missing');
  return key;
}

async function stripeRequest(path, options = {}) {
  const method = options.method || 'GET';
  const params = new URLSearchParams();
  Object.entries(options.params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') params.append(key, String(value));
  });

  const url = new URL(`${STRIPE_API_BASE}${path}`);
  const body = method === 'GET' ? null : params;
  if (method === 'GET') {
    for (const [key, value] of params.entries()) url.searchParams.append(key, value);
  }

  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${stripeSecretKey()}`,
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body,
  });

  const payload = parseJson(await response.text());
  if (!response.ok) {
    const message = payload?.error?.message || 'Stripe request failed.';
    throw httpError(response.status, message, payload?.error?.code || 'stripe_request_failed', payload?.error || payload);
  }
  return payload;
}

async function createStripeCustomer(user, branding) {
  const agencyName = cleanText(branding?.agency_name);
  return stripeRequest('/customers', {
    method: 'POST',
    params: {
      email: user.email,
      name: agencyName || user.email || user.id,
      'metadata[supabase_user_id]': user.id,
      'metadata[user_email]': user.email || '',
      ...(agencyName && { 'metadata[agency_name]': agencyName }),
    },
  });
}

async function createCheckoutSession(req, user, options = {}) {
  await assertAuthUserExistsForWrites(user);
  await ensureProfileForUser(user);
  const branding = await ensureBrandingForUser(user).catch(() => null);
  const existing = await ensureSubscriptionForUser(user.id);
  const selectedPlan = planForKey(options.plan || options.planKey || existing?.plan || DEFAULT_PLAN_KEY);
  requireStripeConfig(selectedPlan.key);
  const normalized = normalizeSubscriptionForClient(existing);
  const status = normalizeStatus(existing?.status);

  if (normalized.can_run_audit && existing?.stripe_subscription_id) {
    throw httpError(409, 'Your subscription or trial is already active. Manage billing from the Stripe portal.', 'subscription_already_active');
  }

  if (existing?.stripe_subscription_id && status === 'active') {
    throw httpError(409, 'Your subscription is already active. Manage billing from the Stripe portal.', 'subscription_already_active');
  }

  let customerId = existing?.stripe_customer_id || '';

  if (!customerId) {
    const customer = await createStripeCustomer(user, branding);
    customerId = customer.id;
    await upsertSubscriptionForUser(user.id, {
      plan: selectedPlan.key,
      stripe_customer_id: customerId,
      status: existing?.status || 'incomplete',
      audits_used: existing?.audits_used || 0,
      used_scans: existing?.used_scans || existing?.audits_used || 0,
      audit_limit: selectedPlan.monthlyAllowance,
      monthly_allowance: selectedPlan.monthlyAllowance,
      maximum_rollover: maxBalanceForPlan(selectedPlan),
      scans_remaining: selectedPlan.monthlyAllowance,
      ai_scan_limit: aiScanAllowanceForPlan(selectedPlan) ?? 0,
      ai_scans_used: 0,
      subscription_status: existing?.status || 'incomplete',
      white_label_enabled: planSupportsWhiteLabel(selectedPlan.key),
    });
  } else if (existing?.plan !== selectedPlan.key) {
    await upsertSubscriptionForUser(user.id, {
      plan: selectedPlan.key,
      audit_limit: selectedPlan.monthlyAllowance,
      monthly_allowance: selectedPlan.monthlyAllowance,
      maximum_rollover: maxBalanceForPlan(selectedPlan),
      scans_remaining: selectedPlan.monthlyAllowance,
      ai_scan_limit: aiScanAllowanceForPlan(selectedPlan) ?? 0,
      white_label_enabled: planSupportsWhiteLabel(selectedPlan.key),
    });
  }

  const origin = requestOrigin(req);
  const agencyName = cleanText(branding?.agency_name);
  const stripePriceId = stripePriceIdForPlan(selectedPlan.key);
  const trialDays = subscriptionTrialDays(options);
  const checkoutOffer = normalizeCheckoutOffer(options.offer || options.checkoutOffer || options.discount || '');
  const checkoutDiscount = checkoutDiscountForOffer(checkoutOffer);
  const session = await stripeRequest('/checkout/sessions', {
    method: 'POST',
    params: {
      mode: 'subscription',
      customer: customerId,
      client_reference_id: user.id,
      success_url: `${origin}/app/billing/success?session_id={CHECKOUT_SESSION_ID}&plan=${encodeURIComponent(selectedPlan.key)}`,
      cancel_url: `${origin}/app/billing/cancelled`,
      'line_items[0][price]': stripePriceId,
      'line_items[0][quantity]': '1',
      ...(checkoutDiscount ? {} : { allow_promotion_codes: 'true' }),
      'metadata[supabase_user_id]': user.id,
      'metadata[user_email]': user.email || '',
      'metadata[plan]': selectedPlan.key,
      ...(checkoutDiscount && {
        'metadata[checkout_offer]': checkoutDiscount.offer,
        'metadata[checkout_offer_label]': checkoutDiscount.label,
      }),
      ...(trialDays > 0 && { 'metadata[trial_days]': trialDays }),
      ...(agencyName && { 'metadata[agency_name]': agencyName }),
      'subscription_data[metadata][supabase_user_id]': user.id,
      'subscription_data[metadata][user_email]': user.email || '',
      'subscription_data[metadata][plan]': selectedPlan.key,
      ...(checkoutDiscount && {
        'subscription_data[metadata][checkout_offer]': checkoutDiscount.offer,
        'subscription_data[metadata][checkout_offer_label]': checkoutDiscount.label,
      }),
      ...(trialDays > 0 && {
        payment_method_collection: 'always',
        'subscription_data[trial_period_days]': trialDays,
        'subscription_data[metadata][trial_days]': trialDays,
      }),
      ...(agencyName && { 'subscription_data[metadata][agency_name]': agencyName }),
      ...(checkoutDiscount?.params || {}),
    },
  });

  await upsertSubscriptionForUser(user.id, {
    plan: selectedPlan.key,
    stripe_customer_id: customerId,
    status: 'incomplete',
    subscription_status: 'incomplete',
    audit_limit: selectedPlan.monthlyAllowance,
    monthly_allowance: selectedPlan.monthlyAllowance,
    maximum_rollover: maxBalanceForPlan(selectedPlan),
    ai_scan_limit: aiScanAllowanceForPlan(selectedPlan) ?? 0,
    white_label_enabled: planSupportsWhiteLabel(selectedPlan.key),
  }).catch(error => {
    console.warn('[LeadCheck] Checkout timestamp refresh failed:', error?.message || error);
  });

  return {
    id: session.id,
    url: session.url,
    plan: publicPlan(selectedPlan),
    trial_days: trialDays,
    checkout_offer: checkoutDiscount?.offer || '',
    checkout_offer_label: checkoutDiscount?.label || '',
  };
}

async function createBillingPortalSession(req, user) {
  requireStripeConfig();
  const subscription = await getSubscriptionForUser(user.id);
  const customerId = subscription?.stripe_customer_id;
  if (!customerId) {
    throw httpError(409, 'No Stripe customer exists for this workspace yet.', 'stripe_customer_missing');
  }

  const portal = await stripeRequest('/billing_portal/sessions', {
    method: 'POST',
    params: {
      customer: customerId,
      return_url: `${requestOrigin(req)}/app/billing`,
    },
  });

  return {
    id: portal.id,
    url: portal.url,
  };
}

async function createPlanSwitchPortalConfiguration(selectedPlan) {
  const priceId = stripePriceIdForPlan(selectedPlan.key);
  const cacheKey = `${selectedPlan.key}:${priceId}`;
  const cachedId = planSwitchPortalConfigurationIds.get(cacheKey);
  if (cachedId) return cachedId;

  const price = await stripeRequest(`/prices/${encodeURIComponent(priceId)}`);
  const productId = stringId(price.product);
  if (!productId) {
    throw httpError(409, 'Stripe price is missing a product for this plan change.', 'stripe_price_product_missing');
  }

  const configuration = await stripeRequest('/billing_portal/configurations', {
    method: 'POST',
    params: {
      name: `PitchProof ${selectedPlan.name} switch`,
      'business_profile[headline]': `Confirm your ${selectedPlan.name} plan`,
      'features[customer_update][enabled]': 'false',
      'features[invoice_history][enabled]': 'true',
      'features[payment_method_update][enabled]': 'true',
      'features[subscription_update][enabled]': 'true',
      'features[subscription_update][billing_cycle_anchor]': 'now',
      'features[subscription_update][default_allowed_updates][0]': 'price',
      'features[subscription_update][proration_behavior]': 'always_invoice',
      'features[subscription_update][trial_update_behavior]': 'continue_trial',
      'features[subscription_update][products][0][product]': productId,
      'features[subscription_update][products][0][prices][0]': priceId,
      'features[subscription_update][products][0][adjustable_quantity][enabled]': 'false',
      'metadata[purpose]': 'plan_switch',
      'metadata[target_plan]': selectedPlan.key,
    },
  });

  const configurationId = stringId(configuration.id);
  if (!configurationId) {
    throw httpError(502, 'Stripe portal configuration could not be created.', 'stripe_portal_configuration_missing');
  }
  planSwitchPortalConfigurationIds.set(cacheKey, configurationId);
  return configurationId;
}

async function changeSubscriptionPlan(req, user, options = {}) {
  await assertAuthUserExistsForWrites(user);
  await ensureProfileForUser(user);
  const existing = await getSubscriptionForUser(user.id);
  const selectedPlan = planForKey(options.plan || options.planKey || existing?.plan || DEFAULT_PLAN_KEY);
  if (!selectedPlan.checkout) {
    throw httpError(400, 'Enterprise plan changes are handled by contact sales.', 'enterprise_contact_sales');
  }
  requireStripeConfig(selectedPlan.key);

  if (!existing?.stripe_subscription_id) {
    return createCheckoutSession(req, user, { plan: selectedPlan.key });
  }

  const status = normalizeStatus(existing.status);
  if (status !== 'active' && status !== 'trialing') {
    throw httpError(409, 'An active subscription is required to switch plans.', 'active_subscription_required');
  }
  if (planForKey(existing.plan).key === selectedPlan.key) {
    return {
      subscription: normalizeSubscriptionForClient(existing),
      planChange: '',
      previousPlan: existing.plan,
      currentPlan: selectedPlan.key,
    };
  }

  const currentStripeSubscription = await stripeRequest(`/subscriptions/${encodeURIComponent(existing.stripe_subscription_id)}`);
  const subscriptionItemId = stringId(currentStripeSubscription.items?.data?.[0]?.id);
  if (!subscriptionItemId) {
    throw httpError(409, 'Stripe subscription item could not be found for this plan change.', 'stripe_subscription_item_missing');
  }

  const customerId = existing.stripe_customer_id || stringId(currentStripeSubscription.customer);
  if (!customerId) {
    throw httpError(409, 'No Stripe customer exists for this subscription.', 'stripe_customer_missing');
  }

  const configurationId = await createPlanSwitchPortalConfiguration(selectedPlan);
  const origin = requestOrigin(req);
  const portal = await stripeRequest('/billing_portal/sessions', {
    method: 'POST',
    params: {
      customer: customerId,
      configuration: configurationId,
      return_url: `${origin}/app/billing`,
      'flow_data[type]': 'subscription_update_confirm',
      'flow_data[after_completion][type]': 'redirect',
      'flow_data[after_completion][redirect][return_url]': `${origin}/app/billing/success?plan_switch=1&plan=${encodeURIComponent(selectedPlan.key)}`,
      'flow_data[subscription_update_confirm][subscription]': existing.stripe_subscription_id,
      'flow_data[subscription_update_confirm][items][0][id]': subscriptionItemId,
      'flow_data[subscription_update_confirm][items][0][price]': stripePriceIdForPlan(selectedPlan.key),
    },
  });

  return {
    id: portal.id,
    url: portal.url,
    plan: publicPlan(selectedPlan),
    planChange: planRank(selectedPlan.key) > planRank(existing.plan) ? 'upgraded' : 'downgraded',
    previousPlan: existing.plan,
    currentPlan: selectedPlan.key,
    hostedFlow: 'stripe_subscription_update_confirm',
  };
}

async function startPaidSubscriptionNow(req, user, options = {}) {
  await assertAuthUserExistsForWrites(user);
  const existing = await getSubscriptionForUser(user.id);
  const selectedPlan = planForKey(options.plan || existing?.plan || DEFAULT_PLAN_KEY);
  requireStripeConfig(selectedPlan.key);
  const status = normalizeStatus(existing?.status);

  if (!existing?.stripe_subscription_id) {
    return createCheckoutSession(req, user, { skipTrial: true, startPaidNow: true, plan: selectedPlan.key });
  }

  if (status === 'active') {
    return { subscription: normalizeSubscriptionForClient(existing) };
  }

  if (status !== 'trialing') {
    throw httpError(409, 'Choose a paid plan to start billing.', 'paid_plan_required');
  }

  const currentStripeSubscription = await stripeRequest(`/subscriptions/${existing.stripe_subscription_id}`);
  const subscriptionItemId = stringId(currentStripeSubscription.items?.data?.[0]?.id);
  const selectedPriceId = stripePriceIdForPlan(selectedPlan.key);
  const updateParams = {
    trial_end: 'now',
    payment_behavior: 'allow_incomplete',
    'metadata[plan]': selectedPlan.key,
  };

  if (subscriptionItemId && selectedPriceId) {
    updateParams['items[0][id]'] = subscriptionItemId;
    updateParams['items[0][price]'] = selectedPriceId;
  }

  const subscription = await stripeRequest(`/subscriptions/${existing.stripe_subscription_id}`, {
    method: 'POST',
    params: updateParams,
  });

  const updated = await upsertSubscriptionFromStripe(subscription, {
    userId: user.id,
    customerId: existing.stripe_customer_id,
    subscriptionId: existing.stripe_subscription_id,
    paymentStatus: existing.payment_status,
  });

  return { subscription: normalizeSubscriptionForClient(updated) };
}

function verifyStripeWebhook(rawBody, signatureHeader) {
  const secret = cleanText(process.env.STRIPE_WEBHOOK_SECRET);
  if (!secret) throw httpError(503, 'Stripe webhook secret is not configured.', 'stripe_webhook_secret_missing');
  if (!signatureHeader) throw httpError(400, 'Stripe signature is missing.', 'stripe_signature_missing');

  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  const parts = Object.fromEntries(signatureHeader.split(',').map(part => {
    const [key, ...rest] = part.split('=');
    return [key, rest.join('=')];
  }));
  const timestamp = parts.t;
  const signatures = signatureHeader
    .split(',')
    .filter(part => part.startsWith('v1='))
    .map(part => part.slice(3));

  if (!timestamp || !signatures.length) {
    throw httpError(400, 'Stripe signature is invalid.', 'stripe_signature_invalid');
  }

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (Number.isFinite(age) && age > 300) {
    throw httpError(400, 'Stripe signature timestamp is too old.', 'stripe_signature_expired');
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`, 'utf8')
    .digest('hex');

  const verified = signatures.some(signature => {
    const expectedBuffer = Buffer.from(expected, 'hex');
    const actualBuffer = Buffer.from(signature, 'hex');
    return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
  });

  if (!verified) throw httpError(400, 'Stripe signature verification failed.', 'stripe_signature_failed');
  return JSON.parse(payload);
}

async function findUserIdForStripeObject(object = {}, fallback = {}) {
  const fromMetadata = cleanText(object.metadata?.supabase_user_id || fallback.userId);
  if (fromMetadata) return fromMetadata;

  const subscriptionId = stringId(object.id || object.subscription || fallback.subscriptionId);
  const bySubscription = subscriptionId ? await getSubscriptionByStripeSubscriptionId(subscriptionId) : null;
  if (bySubscription?.user_id) return bySubscription.user_id;

  const customerId = stringId(object.customer || fallback.customerId);
  const byCustomer = customerId ? await getSubscriptionByCustomerId(customerId) : null;
  if (byCustomer?.user_id) return byCustomer.user_id;

  return '';
}

function subscriptionPayloadFromStripe(subscription, existing = {}, fallback = {}) {
  const period = subscriptionPeriod(subscription);
  const status = normalizeStatus(subscription.status);
  const stripeSubscriptionId = stringId(subscription.id || fallback.subscriptionId);
  const stripeCustomerId = stringId(subscription.customer || fallback.customerId);
  const priceId = stringId(subscription.items?.data?.[0]?.price);
  const pricePlan = priceId ? planForStripePriceId(priceId) : null;
  const plan = planForKey(pricePlan?.key || subscription.metadata?.plan || fallback.plan || existing.plan || DEFAULT_PLAN_KEY);
  const oldPeriodStart = unixFromIso(existing.current_period_start);
  const newPeriodStart = unixFromIso(period.start);
  const periodChanged = Boolean(newPeriodStart && oldPeriodStart && newPeriodStart !== oldPeriodStart);
  const allowance = allowanceForPlan(plan, status);
  const auditLimit = allowance ?? 0;
  const aiScanLimit = aiScanAllowanceForPlan(plan) ?? 0;
  const maxBalance = maxBalanceForPlan(plan);
  const wasTrialing = normalizeStatus(existing.status) === 'trialing';
  const becamePaid = wasTrialing && status === 'active';
  const previousAllowance = Number(existing.monthly_allowance ?? existing.audit_limit) || 0;
  const allowanceIncreased = allowance != null && previousAllowance > 0 && allowance > previousAllowance;
  const allowanceDelta = allowanceIncreased ? allowance - previousAllowance : 0;
  const limitChanged = Number(existing.audit_limit) > 0 && Number(existing.audit_limit) !== auditLimit;
  const shouldResetUsage = !existing?.id || periodChanged || becamePaid;
  const existingRemaining = numericOrNull(existing.scans_remaining) ?? Math.max(0, (Number(existing.audit_limit) || auditLimit) - (Number(existing.audits_used) || 0));
  let scansRemaining = allowance;

  if (plan.unlimited) {
    scansRemaining = null;
  } else if (!existing?.id) {
    scansRemaining = auditLimit;
  } else if (shouldResetUsage) {
    scansRemaining = Math.min(existingRemaining + auditLimit, maxBalance || auditLimit);
  } else if (allowanceIncreased) {
    scansRemaining = Math.min(existingRemaining + allowanceDelta, maxBalance || auditLimit);
  } else {
    scansRemaining = Math.min(existingRemaining, maxBalance || auditLimit);
  }

  return {
    stripe_customer_id: stripeCustomerId || existing.stripe_customer_id || null,
    stripe_subscription_id: stripeSubscriptionId || existing.stripe_subscription_id || null,
    stripe_price_id: priceId || stripePriceIdForPlan(plan.key) || existing.stripe_price_id || null,
    plan: plan.key,
    status,
    subscription_status: status,
    payment_status: fallback.paymentStatus || existing.payment_status || '',
    current_period_start: period.start || existing.current_period_start || null,
    current_period_end: period.end || existing.current_period_end || null,
    renewal_date: period.end || existing.current_period_end || null,
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    cancel_at: timestampToIso(subscription.cancel_at) || null,
    ended_at: timestampToIso(subscription.ended_at) || null,
    audit_limit: auditLimit,
    monthly_allowance: auditLimit,
    maximum_rollover: maxBalance,
    scans_remaining: scansRemaining,
    white_label_enabled: planSupportsWhiteLabel(plan.key),
    audits_used: shouldResetUsage ? 0 : Math.max(0, Number(existing.audits_used) || 0),
    used_scans: shouldResetUsage ? 0 : Math.max(0, Number(existing.used_scans ?? existing.audits_used) || 0),
    ai_scan_limit: aiScanLimit,
    ai_scans_used: shouldResetUsage ? 0 : Math.max(0, Number(existing.ai_scans_used) || 0),
    extra_scans_remaining: Math.max(0, Number(existing.extra_scans_remaining) || 0),
  };
}

async function upsertSubscriptionFromStripe(subscription, fallback = {}) {
  const userId = await findUserIdForStripeObject(subscription, fallback);
  if (!userId) {
    throw httpError(422, 'Could not associate Stripe subscription with a user.', 'stripe_user_missing');
  }

  const existing = await getSubscriptionForUser(userId);
  const payload = subscriptionPayloadFromStripe(subscription, existing || {}, fallback);
  const updated = await upsertSubscriptionForUser(userId, payload);
  if (updated && existing?.plan && existing.plan !== payload.plan) {
    updated.__plan_change = planRank(payload.plan) > planRank(existing.plan) ? 'upgraded' : 'downgraded';
    updated.__previous_plan = existing.plan;
    updated.__current_plan = payload.plan;
  }

  return updated;
}

function subscriptionIdFromInvoice(invoice = {}) {
  return stringId(
    invoice.subscription ||
    invoice.parent?.subscription_details?.subscription ||
    invoice.lines?.data?.find(line => line.subscription)?.subscription
  );
}

async function handleCheckoutCompleted(session) {
  const subscriptionId = stringId(session.subscription);
  if (!subscriptionId) return null;

  const subscription = await stripeRequest(`/subscriptions/${subscriptionId}`);
  return upsertSubscriptionFromStripe(subscription, {
    userId: cleanText(session.client_reference_id || session.metadata?.supabase_user_id),
    customerId: stringId(session.customer),
    subscriptionId,
    paymentStatus: session.payment_status || '',
    plan: session.metadata?.plan,
    checkoutSessionId: stringId(session.id),
  });
}

async function handleInvoiceEvent(invoice, paymentStatus) {
  const subscriptionId = subscriptionIdFromInvoice(invoice);
  if (subscriptionId) {
    const subscription = await stripeRequest(`/subscriptions/${subscriptionId}`);
    return upsertSubscriptionFromStripe(subscription, {
      customerId: stringId(invoice.customer),
      subscriptionId,
      paymentStatus,
    });
  }

  const customerId = stringId(invoice.customer);
  const existing = await getSubscriptionByCustomerId(customerId);
  if (!existing?.user_id) return null;
  return patchSubscriptionForUser(existing.user_id, {
    payment_status: paymentStatus,
    ...(paymentStatus === 'payment_failed' && { status: 'past_due' }),
  });
}

async function handleStripeWebhook(rawBody, signatureHeader) {
  const event = verifyStripeWebhook(rawBody, signatureHeader);
  const object = event?.data?.object || {};
  let updatedSubscription = null;

  switch (event.type) {
    case 'checkout.session.completed':
      updatedSubscription = await handleCheckoutCompleted(object);
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      updatedSubscription = await upsertSubscriptionFromStripe(object);
      break;
    case 'invoice.paid':
      updatedSubscription = await handleInvoiceEvent(object, 'paid');
      break;
    case 'invoice.payment_failed':
      updatedSubscription = await handleInvoiceEvent(object, 'payment_failed');
      break;
    default:
      break;
  }

  return {
    received: true,
    type: event.type,
    id: event.id,
    subscription: updatedSubscription ? normalizeSubscriptionForClient(updatedSubscription) : null,
    planChange: updatedSubscription?.__plan_change || '',
    previousPlan: updatedSubscription?.__previous_plan || '',
    currentPlan: updatedSubscription?.__current_plan || '',
  };
}

async function reserveAuditUsage(userId, idempotencyKey) {
  const subscription = await ensureSubscriptionForUser(userId);
  const normalized = normalizeSubscriptionForClient(subscription);
  if (!normalized.can_run_audit) {
    const complimentaryReservation = await reserveComplimentaryScan(userId, idempotencyKey, subscription);
    if (complimentaryReservation) return complimentaryReservation;
    const reason = !subscription
      ? 'no_subscription'
      : (subscription.complimentary_scan_used_at ? 'complimentary_scan_used' : (ACTIVE_STATUSES.has(normalized.status) ? 'audit_limit_reached' : 'subscription_inactive'));
    return {
      allowed: false,
      reason,
      idempotency_key: cleanText(idempotencyKey) || crypto.randomUUID(),
      subscription,
    };
  }

  return supabaseRpc('reserve_audit_usage', {
    p_user_id: userId,
    p_idempotency_key: cleanText(idempotencyKey) || crypto.randomUUID(),
  });
}

async function completeAuditUsage(userId, idempotencyKey, details = {}) {
  if (!idempotencyKey) return null;
  return supabaseRpc('complete_audit_usage', {
    p_user_id: userId,
    p_idempotency_key: idempotencyKey,
    p_website_url: details.websiteUrl || null,
    p_website_score: Number.isFinite(Number(details.websiteScore)) ? Number(details.websiteScore) : null,
  });
}

async function refundAuditUsage(userId, idempotencyKey) {
  if (!idempotencyKey) return null;
  const complimentaryRefund = await refundComplimentaryScan(userId, idempotencyKey).catch(error => {
    console.warn('[LeadCheck] Complimentary scan refund failed:', error?.message || error);
    return null;
  });
  if (complimentaryRefund) return complimentaryRefund;
  return supabaseRpc('refund_audit_usage', {
    p_user_id: userId,
    p_idempotency_key: idempotencyKey,
  });
}

function publicError(error) {
  const statusCode = error?.statusCode || 500;
  const safeServerCodes = new Set([
    'stripe_secret_missing',
    'stripe_price_missing',
    'stripe_abandoned_cart_discount_missing',
    'stripe_webhook_secret_missing',
    'supabase_not_configured',
    'supabase_service_role_missing',
    'supabase_auth_missing',
    'lifecycle_secret_missing',
    'lifecycle_schema_missing',
    'lifecycle_email_not_configured',
    'ai_visibility_disabled',
  ]);
  const exposeMessage = statusCode < 500 || safeServerCodes.has(error?.code);
  return {
    statusCode,
    body: {
      error: exposeMessage ? error.message : 'Request failed. Please try again.',
      code: error?.code || 'request_failed',
      ...(error?.details && statusCode < 500 ? { details: error.details } : {}),
    },
  };
}

module.exports = {
  PLAN_CATALOG,
  PROFESSIONAL_PLAN,
  ABANDONED_CART_OFFER_KEY,
  ACTIVE_STATUSES,
  abandonedCartDiscountConfigured,
  billingConfigStatus,
  checkAiVisibilityAccessForUser,
  cleanText,
  createBillingPortalSession,
  createCheckoutSession,
  createAiVisibilityReportForUser,
  changeSubscriptionPlan,
  createReportForUser,
  deleteAiVisibilityReportForUser,
  deleteReportForUser,
  duplicateReportForUser,
  ensureAppUser,
  getAgencyBrandingForUser,
  getBillingDiagnostics,
  getAiVisibilityReportForUserForClient,
  getReportForUser,
  getReportForUserForClient,
  listAiVisibilityReportsForUser,
  listReportsForUser,
  getSubscriptionStatus,
  handleStripeWebhook,
  httpError,
  isSubscriptionUsable,
  normalizeSubscriptionForClient,
  platformReportBranding,
  planSupportsWhiteLabel,
  publicPlans,
  publicError,
  refreshSubscriptionFromStripeForUser,
  reportBrandingForSubscription,
  recordAiVisibilityUsage,
  refundAuditUsage,
  requireAuthenticatedUser,
  reserveAuditUsage,
  startPaidSubscriptionNow,
  completeAuditUsage,
  supabaseBaseUrl,
  supabaseServiceRoleKey,
  updateAgencyBrandingForUser,
};
