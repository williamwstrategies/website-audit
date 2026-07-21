const crypto = require('crypto');

const STRIPE_API_BASE = 'https://api.stripe.com/v1';
const PROFESSIONAL_PLAN = {
  key: 'professional',
  name: 'Professional',
  priceLabel: '$79.99 / month',
  trialDays: 7,
  auditLimit: 100,
};

const ACTIVE_STATUSES = new Set(['active', 'trialing']);
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

function httpError(statusCode, message, code = 'request_failed', details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details) error.details = details;
  return error;
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
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);
}

function hasWebhookConfig() {
  return Boolean(process.env.STRIPE_WEBHOOK_SECRET);
}

function billingConfigStatus() {
  return {
    stripeConfigured: hasStripeConfig(),
    webhookConfigured: hasWebhookConfig(),
    supabaseServiceConfigured: Boolean(cleanText(process.env.SUPABASE_SERVICE_ROLE_KEY)),
    priceIdConfigured: Boolean(cleanText(process.env.STRIPE_PRICE_ID)),
    plan: PROFESSIONAL_PLAN,
  };
}

function requireStripeConfig() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw httpError(503, 'Stripe secret key is not configured.', 'stripe_secret_missing');
  }
  if (!process.env.STRIPE_PRICE_ID) {
    throw httpError(503, 'Stripe price ID is not configured.', 'stripe_price_missing');
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
  const body = {
    plan: PROFESSIONAL_PLAN.key,
    audit_limit: PROFESSIONAL_PLAN.auditLimit,
    ...payload,
  };

  const existing = await getSubscriptionForUser(userId);
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
  if (existing) return existing;

  const rows = await supabaseRest('subscriptions', {
    method: 'POST',
    prefer: 'return=representation',
    body: {
      id: crypto.randomUUID(),
      user_id: userId,
      plan: PROFESSIONAL_PLAN.key,
      status: 'incomplete',
      audit_limit: PROFESSIONAL_PLAN.auditLimit,
      audits_used: 0,
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
  const used = Math.max(0, Number(sub.audits_used) || 0);
  const limit = Math.max(0, Number(sub.audit_limit) || PROFESSIONAL_PLAN.auditLimit);
  const usable = isSubscriptionUsable(sub);
  const remaining = Math.max(0, limit - used);
  const canUse = usable && remaining > 0;

  return {
    exists: Boolean(subscription),
    plan: sub.plan || PROFESSIONAL_PLAN.key,
    plan_name: PROFESSIONAL_PLAN.name,
    price_label: PROFESSIONAL_PLAN.priceLabel,
    trial_days: PROFESSIONAL_PLAN.trialDays,
    status: normalizeStatus(sub.status || 'incomplete'),
    payment_status: sub.payment_status || '',
    audits_used: used,
    audit_limit: limit,
    audits_remaining: remaining,
    current_period_start: sub.current_period_start || null,
    current_period_end: sub.current_period_end || null,
    cancel_at_period_end: Boolean(sub.cancel_at_period_end),
    can_run_audit: canUse,
    can_export_pdf: usable,
    billing_configured: hasStripeConfig(),
    webhook_configured: hasWebhookConfig(),
    stripe_customer_id: sub.stripe_customer_id ? 'configured' : '',
    stripe_subscription_id: sub.stripe_subscription_id ? 'configured' : '',
  };
}

async function getSubscriptionStatus(userId) {
  const subscription = await getSubscriptionForUser(userId);
  return normalizeSubscriptionForClient(subscription);
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

async function createCheckoutSession(req, user) {
  requireStripeConfig();
  const existing = await getSubscriptionForUser(user.id);
  const normalized = normalizeSubscriptionForClient(existing);

  if (normalized.can_run_audit && existing?.stripe_subscription_id) {
    throw httpError(409, 'Your subscription is already active.', 'subscription_already_active');
  }

  const branding = await getAgencyBrandingForUser(user.id).catch(() => null);
  let customerId = existing?.stripe_customer_id || '';

  if (!customerId) {
    const customer = await createStripeCustomer(user, branding);
    customerId = customer.id;
    await upsertSubscriptionForUser(user.id, {
      stripe_customer_id: customerId,
      status: existing?.status || 'incomplete',
      audits_used: existing?.audits_used || 0,
    });
  }

  const origin = requestOrigin(req);
  const agencyName = cleanText(branding?.agency_name);
  const session = await stripeRequest('/checkout/sessions', {
    method: 'POST',
    params: {
      mode: 'subscription',
      customer: customerId,
      client_reference_id: user.id,
      success_url: `${origin}/app/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/app/billing/cancelled`,
      'line_items[0][price]': process.env.STRIPE_PRICE_ID,
      'line_items[0][quantity]': '1',
      allow_promotion_codes: 'true',
      'subscription_data[trial_period_days]': String(PROFESSIONAL_PLAN.trialDays),
      'metadata[supabase_user_id]': user.id,
      'metadata[user_email]': user.email || '',
      ...(agencyName && { 'metadata[agency_name]': agencyName }),
      'subscription_data[metadata][supabase_user_id]': user.id,
      'subscription_data[metadata][user_email]': user.email || '',
      ...(agencyName && { 'subscription_data[metadata][agency_name]': agencyName }),
    },
  });

  return {
    id: session.id,
    url: session.url,
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
  const oldPeriodStart = unixFromIso(existing.current_period_start);
  const newPeriodStart = unixFromIso(period.start);
  const periodChanged = Boolean(newPeriodStart && oldPeriodStart && newPeriodStart !== oldPeriodStart);
  const shouldResetUsage = !existing?.id || periodChanged;

  return {
    stripe_customer_id: stripeCustomerId || existing.stripe_customer_id || null,
    stripe_subscription_id: stripeSubscriptionId || existing.stripe_subscription_id || null,
    stripe_price_id: priceId || process.env.STRIPE_PRICE_ID || existing.stripe_price_id || null,
    plan: PROFESSIONAL_PLAN.key,
    status,
    payment_status: fallback.paymentStatus || existing.payment_status || '',
    current_period_start: period.start || existing.current_period_start || null,
    current_period_end: period.end || existing.current_period_end || null,
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    cancel_at: timestampToIso(subscription.cancel_at) || null,
    ended_at: timestampToIso(subscription.ended_at) || null,
    audit_limit: PROFESSIONAL_PLAN.auditLimit,
    audits_used: shouldResetUsage ? 0 : Math.max(0, Number(existing.audits_used) || 0),
  };
}

async function upsertSubscriptionFromStripe(subscription, fallback = {}) {
  const userId = await findUserIdForStripeObject(subscription, fallback);
  if (!userId) {
    throw httpError(422, 'Could not associate Stripe subscription with a user.', 'stripe_user_missing');
  }

  const existing = await getSubscriptionForUser(userId);
  const payload = subscriptionPayloadFromStripe(subscription, existing || {}, fallback);
  return upsertSubscriptionForUser(userId, payload);
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

  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(object);
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await upsertSubscriptionFromStripe(object);
      break;
    case 'invoice.paid':
      await handleInvoiceEvent(object, 'paid');
      break;
    case 'invoice.payment_failed':
      await handleInvoiceEvent(object, 'payment_failed');
      break;
    default:
      break;
  }

  return { received: true, type: event.type, id: event.id };
}

async function reserveAuditUsage(userId, idempotencyKey) {
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
    'stripe_webhook_secret_missing',
    'supabase_not_configured',
    'supabase_service_role_missing',
    'supabase_auth_missing',
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
  PROFESSIONAL_PLAN,
  ACTIVE_STATUSES,
  billingConfigStatus,
  cleanText,
  createBillingPortalSession,
  createCheckoutSession,
  ensureAppUser,
  getAgencyBrandingForUser,
  getReportForUser,
  getSubscriptionStatus,
  handleStripeWebhook,
  httpError,
  isSubscriptionUsable,
  normalizeSubscriptionForClient,
  publicError,
  refundAuditUsage,
  requireAuthenticatedUser,
  reserveAuditUsage,
  completeAuditUsage,
  supabaseBaseUrl,
  supabaseServiceRoleKey,
};
