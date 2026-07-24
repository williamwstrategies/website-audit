const crypto = require('crypto');
const billing = require('./billing');

const RESEND_EMAIL_API_URL = 'https://api.resend.com/emails';
const CAMPAIGN_KEY = 'abandoned_signup';
const DEFAULT_MAX_PER_RUN = 25;
const MAX_PER_RUN_CAP = 100;

const ABANDONED_SIGNUP_STEPS = [
  {
    key: 'finish_setup_1h',
    delayHours: 1,
    subject: 'Finish setting up your Website Strategy Scan account',
    headline: 'Your account is ready. Pick the plan that fits.',
    intro: 'You created your account, but plan setup was not finished yet. Choose a plan to start generating professional website assessments.',
    cta: 'Choose Your Plan',
  },
  {
    key: 'finish_setup_24h',
    delayHours: 24,
    subject: 'Still want to generate your first website assessment?',
    headline: 'Start with one prospect website.',
    intro: 'Website Strategy Scan is ready when you are. Choose a plan, run your first assessment, and see the report your prospects can review.',
    cta: 'Finish Setup',
  },
  {
    key: 'finish_setup_72h',
    delayHours: 72,
    subject: 'Last reminder to finish your account setup',
    headline: 'Finish setup when you are ready.',
    intro: 'Your account is still waiting for plan selection. If website assessments are still useful for your agency, you can continue from your billing page.',
    cta: 'Continue Setup',
  },
];

function cleanText(value = '') {
  return String(value || '').trim();
}

function normalizeEmail(value = '') {
  return cleanText(value).toLowerCase();
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(cleanText(process.env[name]));
}

function appUrl() {
  return cleanText(process.env.APP_URL || process.env.PUBLIC_APP_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

function lifecycleSecret() {
  return cleanText(process.env.LIFECYCLE_EMAIL_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function resendApiKey() {
  return cleanText(process.env.RESEND_API_KEY);
}

function emailFrom() {
  return cleanText(process.env.LIFECYCLE_EMAIL_FROM || process.env.SUPPORT_EMAIL_FROM);
}

function emailReplyTo() {
  return cleanText(process.env.LIFECYCLE_EMAIL_REPLY_TO || process.env.SUPPORT_EMAIL_TO);
}

function maxPerRun(value = process.env.LIFECYCLE_EMAIL_MAX_PER_RUN) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_PER_RUN;
  return Math.min(MAX_PER_RUN_CAP, Math.floor(parsed));
}

function htmlEscape(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function timingSafeEqual(a = '', b = '') {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function tokenFor(email, campaign = CAMPAIGN_KEY) {
  const secret = lifecycleSecret();
  if (!secret) return '';
  return crypto
    .createHmac('sha256', secret)
    .update(`${normalizeEmail(email)}:${cleanText(campaign)}`)
    .digest('hex');
}

function verifyToken(email, campaign, token) {
  const expected = tokenFor(email, campaign);
  return Boolean(expected && token && timingSafeEqual(expected, token));
}

async function supabaseRest(path, options = {}) {
  const url = new URL(`${billing.supabaseBaseUrl()}/rest/v1/${String(path).replace(/^\/+/, '')}`);
  Object.entries(options.query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  });

  const headers = {
    apikey: billing.supabaseServiceRoleKey(),
    authorization: `Bearer ${billing.supabaseServiceRoleKey()}`,
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
    throw billing.httpError(response.status, message, 'supabase_request_failed', body);
  }
  return body;
}

function lifecycleSchemaError(error) {
  const missingRelation = error?.details?.code === '42P01' || /lifecycle_email_/i.test(error?.message || '');
  if (!missingRelation) return error;
  return billing.httpError(
    503,
    'Lifecycle email tables are not installed yet. Run supabase/lifecycle-emails.sql in Supabase SQL Editor.',
    'lifecycle_schema_missing',
    error.details || null
  );
}

async function listRestRows(path, query = {}, pageSize = 1000) {
  const rows = [];
  for (let offset = 0; offset < 10000; offset += pageSize) {
    const page = await supabaseRest(path, {
      query,
      headers: { Range: `${offset}-${offset + pageSize - 1}` },
    });
    const batch = Array.isArray(page) ? page : [];
    rows.push(...batch);
    if (batch.length < pageSize) break;
  }
  return rows;
}

async function listAuthUsers() {
  const users = [];
  const perPage = 1000;
  for (let page = 1; page <= 10; page += 1) {
    const url = new URL(`${billing.supabaseBaseUrl()}/auth/v1/admin/users`);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(perPage));

    const response = await fetch(url, {
      headers: {
        apikey: billing.supabaseServiceRoleKey(),
        authorization: `Bearer ${billing.supabaseServiceRoleKey()}`,
        accept: 'application/json',
      },
    });

    const body = parseJson(await response.text());
    if (!response.ok) {
      throw billing.httpError(response.status, body?.message || body?.error || 'Supabase auth users could not be loaded.', 'supabase_auth_admin_failed', body);
    }

    const batch = Array.isArray(body) ? body : Array.isArray(body?.users) ? body.users : [];
    users.push(...batch);
    if (batch.length < perPage) break;
  }
  return users;
}

function subscriptionLooksUnpaid(subscription) {
  if (!subscription) return true;
  const status = cleanText(subscription.status || subscription.subscription_status).toLowerCase();
  if (subscription.stripe_subscription_id) return false;
  return !status || ['incomplete', 'incomplete_expired', 'cancelled', 'canceled'].includes(status);
}

function accountAgeHours(user) {
  const createdAt = new Date(user.created_at || user.createdAt || '');
  if (!Number.isFinite(createdAt.getTime())) return 0;
  return (Date.now() - createdAt.getTime()) / 3600000;
}

function displayName(user, profile) {
  return cleanText(profile?.full_name || user.user_metadata?.name || user.user_metadata?.full_name || '').split(/\s+/)[0] || '';
}

function unsubscribeKey(email, campaign) {
  return `${normalizeEmail(email)}:${campaign}`;
}

function chooseNextStep(user, sentSteps) {
  const age = accountAgeHours(user);
  return ABANDONED_SIGNUP_STEPS.find(step => age >= step.delayHours && !sentSteps.has(step.key)) || null;
}

function unsubscribeUrl(email, campaign = CAMPAIGN_KEY) {
  const url = new URL(`${appUrl()}/api/email/unsubscribe`);
  url.searchParams.set('email', normalizeEmail(email));
  url.searchParams.set('campaign', campaign);
  url.searchParams.set('token', tokenFor(email, campaign));
  return url.toString();
}

function billingUrl() {
  return `${appUrl()}/app/billing`;
}

function websiteUrl() {
  return appUrl();
}

function emailHtml({ user, profile, step }) {
  const name = displayName(user, profile);
  const greeting = name ? `Hi ${htmlEscape(name)},` : 'Hi,';
  const unsubscribe = unsubscribeUrl(user.email);
  const accountLink = billingUrl();
  const websiteLink = websiteUrl();
  return `
    <div style="margin:0;padding:28px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1d1d1f;">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e5e5ea;border-radius:18px;overflow:hidden;box-shadow:0 18px 48px rgba(0,0,0,0.08);">
        <div style="padding:28px 30px;border-bottom:1px solid #ececf0;">
          <p style="margin:0 0 10px;color:#8a6312;text-transform:uppercase;letter-spacing:.08em;font-size:12px;font-weight:800;">Website Strategy Scan</p>
          <h1 style="margin:0;color:#1d1d1f;font-size:26px;line-height:1.2;letter-spacing:0;">${htmlEscape(step.headline)}</h1>
        </div>
        <div style="padding:28px 30px;">
          <p style="margin:0 0 14px;font-size:15px;line-height:1.65;">${greeting}</p>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.65;color:#3d3d43;">${htmlEscape(step.intro)}</p>
          <a href="${htmlEscape(accountLink)}" style="display:inline-block;padding:13px 18px;border-radius:12px;background:#f5c842;color:#1d1d1f;text-decoration:none;font-weight:800;">${htmlEscape(step.cta)}</a>
          <div style="margin:22px 0 0;padding:14px 16px;border:1px solid #ececf0;border-radius:14px;background:#fafafa;font-size:13px;line-height:1.7;color:#4a4a50;">
            <div><strong style="color:#1d1d1f;">Your account:</strong> <a href="${htmlEscape(accountLink)}" style="color:#8a6312;">${htmlEscape(accountLink)}</a></div>
            <div><strong style="color:#1d1d1f;">Website:</strong> <a href="${htmlEscape(websiteLink)}" style="color:#8a6312;">${htmlEscape(websiteLink)}</a></div>
          </div>
          <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#6e6e73;">If you already finished setup, you can ignore this email.</p>
        </div>
        <div style="padding:18px 30px;background:#fafafa;border-top:1px solid #ececf0;font-size:12px;line-height:1.6;color:#777;">
          <a href="${unsubscribe}" style="color:#6e6e73;">Unsubscribe from account setup reminders</a>
        </div>
      </div>
    </div>
  `;
}

function emailText({ user, profile, step }) {
  const name = displayName(user, profile);
  return [
    name ? `Hi ${name},` : 'Hi,',
    '',
    step.headline,
    '',
    step.intro,
    '',
    `${step.cta}: ${billingUrl()}`,
    `Your account: ${billingUrl()}`,
    `Website: ${websiteUrl()}`,
    '',
    `Unsubscribe: ${unsubscribeUrl(user.email)}`,
  ].join('\n');
}

async function sendLifecycleEmail({ user, profile, step }) {
  const apiKey = resendApiKey();
  const from = emailFrom();
  if (!apiKey || !from) {
    throw billing.httpError(503, 'Lifecycle email is not configured. Add RESEND_API_KEY and LIFECYCLE_EMAIL_FROM or SUPPORT_EMAIL_FROM in Render.', 'lifecycle_email_not_configured');
  }

  const body = {
    from,
    to: [user.email],
    subject: step.subject,
    html: emailHtml({ user, profile, step }),
    text: emailText({ user, profile, step }),
  };
  const replyTo = emailReplyTo();
  if (replyTo) body.reply_to = replyTo.split(',').map(item => cleanText(item)).filter(Boolean)[0] || replyTo;

  const response = await fetch(RESEND_EMAIL_API_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'Idempotency-Key': `${CAMPAIGN_KEY}:${normalizeEmail(user.email)}:${step.key}`,
    },
    body: JSON.stringify(body),
  });

  const responseBody = parseJson(await response.text());
  if (!response.ok) {
    throw billing.httpError(response.status, responseBody?.message || responseBody?.error || 'Lifecycle email could not be sent.', 'resend_lifecycle_email_failed', responseBody);
  }
  return responseBody || {};
}

async function recordEmailEvent({ user, step, providerId, metadata = {} }) {
  try {
    const rows = await supabaseRest('lifecycle_email_events', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        id: crypto.randomUUID(),
        user_id: user.id || null,
        email: normalizeEmail(user.email),
        campaign: CAMPAIGN_KEY,
        step: step.key,
        status: 'sent',
        provider: 'resend',
        provider_message_id: cleanText(providerId),
        metadata,
        sent_at: new Date().toISOString(),
      },
    });
    return Array.isArray(rows) ? rows[0] || null : rows || null;
  } catch (error) {
    if (error?.details?.code === '23505') return null;
    throw lifecycleSchemaError(error);
  }
}

async function unsubscribe(email, campaign = CAMPAIGN_KEY) {
  const cleanEmail = normalizeEmail(email);
  const cleanCampaign = cleanText(campaign || CAMPAIGN_KEY);
  if (!cleanEmail) throw billing.httpError(400, 'Email is required.', 'email_required');

  try {
    await supabaseRest('lifecycle_email_unsubscribes', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
        id: crypto.randomUUID(),
        email: cleanEmail,
        campaign: cleanCampaign,
        token_hash: tokenFor(cleanEmail, cleanCampaign),
      },
    });
  } catch (error) {
    if (error?.details?.code !== '23505') throw lifecycleSchemaError(error);
  }

  return { email: cleanEmail, campaign: cleanCampaign };
}

async function runAbandonedSignupCampaign(options = {}) {
  const dryRun = options.dryRun === true;
  const limit = maxPerRun(options.limit);
  const users = await listAuthUsers();

  let subscriptions;
  let profiles;
  let events;
  let unsubscribes;
  try {
    [subscriptions, profiles, events, unsubscribes] = await Promise.all([
      listRestRows('subscriptions', { select: 'user_id,status,subscription_status,stripe_customer_id,stripe_subscription_id,plan,created_at,updated_at' }),
      listRestRows('profiles', { select: 'id,email,full_name,agency_name' }),
      listRestRows('lifecycle_email_events', { select: 'email,campaign,step,status', campaign: `eq.${CAMPAIGN_KEY}`, status: 'eq.sent' }),
      listRestRows('lifecycle_email_unsubscribes', { select: 'email,campaign' }),
    ]);
  } catch (error) {
    throw lifecycleSchemaError(error);
  }

  const subscriptionByUser = new Map((subscriptions || []).map(row => [row.user_id, row]));
  const profileByUser = new Map((profiles || []).map(row => [row.id, row]));
  const sentByEmail = new Map();
  (events || []).forEach(row => {
    const key = normalizeEmail(row.email);
    if (!sentByEmail.has(key)) sentByEmail.set(key, new Set());
    sentByEmail.get(key).add(row.step);
  });
  const unsubscribed = new Set((unsubscribes || []).map(row => unsubscribeKey(row.email, row.campaign)));

  const candidates = [];
  const skipped = {
    missing_email: 0,
    already_subscribed: 0,
    unsubscribed: 0,
    no_step_due: 0,
  };

  users.forEach(user => {
    const email = normalizeEmail(user.email);
    if (!email || user.deleted_at) {
      skipped.missing_email += 1;
      return;
    }
    if (unsubscribed.has(unsubscribeKey(email, CAMPAIGN_KEY)) || unsubscribed.has(unsubscribeKey(email, 'all'))) {
      skipped.unsubscribed += 1;
      return;
    }

    const subscription = subscriptionByUser.get(user.id);
    if (!subscriptionLooksUnpaid(subscription)) {
      skipped.already_subscribed += 1;
      return;
    }

    const sentSteps = sentByEmail.get(email) || new Set();
    const step = chooseNextStep(user, sentSteps);
    if (!step) {
      skipped.no_step_due += 1;
      return;
    }

    candidates.push({
      user: { ...user, email },
      profile: profileByUser.get(user.id) || null,
      subscription,
      step,
    });
  });

  candidates.sort((a, b) => new Date(a.user.created_at || 0) - new Date(b.user.created_at || 0));
  const selected = candidates.slice(0, limit);
  const sent = [];
  const failed = [];

  for (const candidate of selected) {
    if (dryRun) {
      sent.push({
        email: candidate.user.email,
        user_id: candidate.user.id,
        step: candidate.step.key,
        dry_run: true,
      });
      continue;
    }

    try {
      const delivery = await sendLifecycleEmail(candidate);
      await recordEmailEvent({
        user: candidate.user,
        step: candidate.step,
        providerId: delivery.id || '',
        metadata: {
          signup_created_at: candidate.user.created_at || null,
          subscription_status: candidate.subscription?.status || null,
        },
      });
      sent.push({
        email: candidate.user.email,
        user_id: candidate.user.id,
        step: candidate.step.key,
        provider_message_id: delivery.id || '',
      });
    } catch (error) {
      failed.push({
        email: candidate.user.email,
        user_id: candidate.user.id,
        step: candidate.step.key,
        error: error?.message || 'Email failed.',
        code: error?.code || 'email_failed',
      });
    }
  }

  return {
    ok: failed.length === 0,
    dryRun,
    campaign: CAMPAIGN_KEY,
    scanned_users: users.length,
    eligible: candidates.length,
    selected: selected.length,
    sent: sent.length,
    failed: failed.length,
    skipped,
    deliveries: sent,
    failures: failed,
  };
}

module.exports = {
  CAMPAIGN_KEY,
  envFlag,
  runAbandonedSignupCampaign,
  tokenFor,
  unsubscribe,
  verifyToken,
};
