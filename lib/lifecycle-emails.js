const crypto = require('crypto');
const billing = require('./billing');
const { ensureResendTrackingEnabled } = require('./resend-tracking');
const { outboundEmailsPaused } = require('./email-controls');

const RESEND_EMAIL_API_URL = 'https://api.resend.com/emails';
const CAMPAIGN_KEY = 'abandoned_signup';
const TRIAL_BROADCAST_CAMPAIGN_KEY = 'seven_day_trial_broadcast';
const TRIAL_BROADCAST_STEP_KEY = 'seven_day_trial_offer_2026_08';
const DEFAULT_MAX_PER_RUN = 25;
const MAX_PER_RUN_CAP = 100;
const DEFAULT_BROADCAST_MAX_PER_RUN = 500;
const BROADCAST_MAX_PER_RUN_CAP = 1000;
const DEFAULT_TEST_DELAYS_MINUTES = [1, 2, 3, 4, 5, 6, 7, 8, 9];

const abandonedSignupSteps = [
  {
    key: 'finish_setup_15m',
    delayMinutes: 15,
    legacyKeys: ['finish_setup_1h'],
    subject: 'Your first website assessment is waiting',
    previewText: 'Your complimentary website assessment is ready when you are.',
    headline: 'Your first website assessment is waiting.',
    paragraphs: [
      'Thanks for creating your account. Your complimentary website assessment is ready when you are.',
      'It only takes about a minute to see the biggest opportunities on a website.',
    ],
    cta: 'Generate My Free Report',
  },
  {
    key: 'finish_setup_24h',
    delayMinutes: 1440,
    subject: 'Stop telling prospects. Show them.',
    previewText: 'Turn a website into a professional client-facing assessment.',
    headline: 'Stop telling prospects. Show them.',
    paragraphs: [
      'Most agencies tell prospects their website needs work. The stronger approach is showing them exactly why.',
      'Website Strategy Scan turns a website into a professional client-facing assessment your prospect can actually understand.',
    ],
    cta: 'Generate My Report',
  },
  {
    key: 'finish_setup_3d',
    delayMinutes: 4320,
    legacyKeys: ['finish_setup_72h'],
    subject: 'Imagine your next sales call...',
    previewText: 'Open the call with evidence instead of a generic pitch.',
    headline: 'Imagine your next sales call...',
    paragraphs: [
      'Imagine opening a discovery call with a professional website assessment instead of a generic pitch.',
      'The conversation becomes about the problems you found, not whether the prospect agrees with your opinion.',
    ],
    cta: 'Run My First Assessment',
  },
  {
    key: 'finish_setup_5d',
    delayMinutes: 7200,
    subject: 'Most websites lose leads for the same reasons',
    previewText: 'Weak CTAs, missing trust signals, and conversion friction are easier to show than explain.',
    headline: 'Most websites lose leads for the same reasons.',
    paragraphs: [
      'Weak calls-to-action, missing trust signals, poor conversion structure, technical friction, and unclear offers show up again and again.',
      'Your free assessment can show what your next prospect site is missing.',
    ],
    cta: 'Scan a Website',
  },
  {
    key: 'finish_setup_7d',
    delayMinutes: 10080,
    subject: 'How agencies are using Website Strategy Scan',
    previewText: 'Use reports in sales calls, outreach, proposals, follow-up, and more.',
    headline: 'How agencies are using Website Strategy Scan.',
    paragraphs: [
      'The report is useful before, during, and after the sales conversation.',
    ],
    bullets: ['Sales calls', 'Cold outreach', 'Follow-up', 'Proposals', 'Networking', 'Lead magnets'],
    cta: 'Generate My Free Preview',
  },
  {
    key: 'finish_setup_10d',
    delayMinutes: 14400,
    subject: 'The biggest mistake agencies make when selling websites',
    previewText: 'Prospects buy business outcomes, not design opinions.',
    headline: 'The biggest mistake agencies make when selling websites.',
    paragraphs: [
      'Agencies often sell design. Prospects buy business outcomes.',
      'Website Strategy Scan helps bridge that gap with clear evidence and business-focused findings.',
    ],
    cta: 'Try It on a Prospect',
  },
  {
    key: 'finish_setup_14d',
    delayMinutes: 20160,
    subject: 'Can I ask you one question?',
    previewText: 'What stopped you from trying your complimentary assessment?',
    headline: 'Can I ask you one question?',
    paragraphs: [
      'What stopped you from trying your complimentary assessment?',
      'If it was timing, confusion, pricing, or you were just browsing, that is completely fine. You can reply to this email, or use your free assessment whenever you are ready.',
    ],
    cta: 'Try My Free Assessment',
  },
  {
    key: 'finish_setup_21d',
    delayMinutes: 30240,
    subject: "You don't need another audit tool",
    previewText: 'This is built for agency sales conversations, not generic technical audits.',
    headline: "You don't need another audit tool.",
    paragraphs: [
      'Website Strategy Scan is not SEMrush, GTmetrix, or PageSpeed.',
      'It is designed to help agencies present website problems in a way prospects can understand and act on.',
    ],
    cta: 'Experience the Platform',
  },
  {
    key: 'finish_setup_30d',
    delayMinutes: 43200,
    subject: 'Your account is still waiting',
    previewText: 'Your complimentary assessment is still available.',
    headline: 'Your account is still waiting.',
    paragraphs: [
      'You created an account but never used your complimentary assessment.',
      'If you are still interested, your account and free preview are still available.',
    ],
    cta: 'Generate My First Report',
  },
];

const LIFECYCLE_CAMPAIGNS = {
  [CAMPAIGN_KEY]: {
    key: CAMPAIGN_KEY,
    steps: abandonedSignupSteps,
  },
};

const sevenDayTrialBroadcastStep = {
  key: TRIAL_BROADCAST_STEP_KEY,
  campaign: TRIAL_BROADCAST_CAMPAIGN_KEY,
  subject: '7 Days to Close Your Next Website Project',
  previewText: "We've unlocked a 7-day free trial on your Website Strategy Scan account.",
  headline: 'Your 7-day free trial is unlocked.',
  cta: 'start your free 7 day free trial',
  template: 'seven_day_trial_broadcast',
};

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

function broadcastMaxPerRun(value = process.env.BROADCAST_EMAIL_MAX_PER_RUN) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BROADCAST_MAX_PER_RUN;
  return Math.min(BROADCAST_MAX_PER_RUN_CAP, Math.floor(parsed));
}

function splitList(value = '') {
  return cleanText(value)
    .split(/[\s,]+/)
    .map(item => cleanText(item))
    .filter(Boolean);
}

function testRecipientSet() {
  return new Set(splitList(process.env.LIFECYCLE_EMAIL_TEST_RECIPIENTS).map(item => item.toLowerCase()));
}

function testDelayMinutes() {
  const values = splitList(process.env.LIFECYCLE_EMAIL_TEST_DELAYS_MINUTES)
    .map(value => Number(value))
    .filter(value => Number.isFinite(value) && value > 0);
  return values.length ? values : DEFAULT_TEST_DELAYS_MINUTES;
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

function subscriptionHasComplimentaryPreview(subscription) {
  return Boolean(subscription?.complimentary_scan_used_at || subscription?.complimentary_report_id);
}

function accountAgeMinutes(user) {
  const createdAt = new Date(user.created_at || user.createdAt || '');
  if (!Number.isFinite(createdAt.getTime())) return 0;
  return (Date.now() - createdAt.getTime()) / 60000;
}

function displayName(user, profile) {
  return cleanText(profile?.full_name || user.user_metadata?.name || user.user_metadata?.full_name || '').split(/\s+/)[0] || '';
}

function unsubscribeKey(email, campaign) {
  return `${normalizeEmail(email)}:${campaign}`;
}

function lifecycleStepsForUser(user) {
  const allowlist = testRecipientSet();
  const email = normalizeEmail(user.email);
  const userId = cleanText(user.id).toLowerCase();
  const testMode = Boolean(allowlist.size && (allowlist.has(email) || allowlist.has(userId)));
  if (!testMode) return LIFECYCLE_CAMPAIGNS[CAMPAIGN_KEY].steps;

  const delays = testDelayMinutes();
  return LIFECYCLE_CAMPAIGNS[CAMPAIGN_KEY].steps.map((step, index) => ({
    ...step,
    delayMinutes: delays[index] || delays[delays.length - 1] || step.delayMinutes,
    testMode: true,
  }));
}

function stepAlreadySent(step, sentSteps) {
  return sentSteps.has(step.key) || (step.legacyKeys || []).some(key => sentSteps.has(key));
}

function chooseNextStep(user, sentSteps) {
  const age = accountAgeMinutes(user);
  return lifecycleStepsForUser(user).find(step => age >= step.delayMinutes && !stepAlreadySent(step, sentSteps)) || null;
}

function unsubscribeUrl(email, campaign = CAMPAIGN_KEY) {
  const url = new URL(`${appUrl()}/api/email/unsubscribe`);
  url.searchParams.set('email', normalizeEmail(email));
  url.searchParams.set('campaign', campaign);
  url.searchParams.set('token', tokenFor(email, campaign));
  return url.toString();
}

function freePreviewUrl() {
  return `${appUrl()}/onboarding/free-preview`;
}

function trialBroadcastUrl() {
  return `${appUrl()}/app/billing?trial=7-day`;
}

function websiteUrl() {
  return appUrl();
}

function ctaUrlForStep(step = {}) {
  if (step.template === 'seven_day_trial_broadcast') return trialBroadcastUrl();
  return freePreviewUrl();
}

function sevenDayTrialEmailHtml({ user, profile, step }) {
  const name = displayName(user, profile);
  const greeting = name ? `Hi ${htmlEscape(name)},` : 'Hi,';
  const accountLink = ctaUrlForStep(step);
  const unsubscribe = unsubscribeUrl(user.email, TRIAL_BROADCAST_CAMPAIGN_KEY);

  return `
    <div style="margin:0;padding:28px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1d1d1f;">
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${htmlEscape(step.previewText)}</div>
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e5e5ea;border-radius:18px;overflow:hidden;box-shadow:0 18px 48px rgba(0,0,0,0.08);">
        <div style="padding:28px 30px;border-bottom:1px solid #ececf0;">
          <p style="margin:0 0 10px;color:#8a6312;text-transform:uppercase;letter-spacing:.08em;font-size:12px;font-weight:800;">Website Strategy Scan</p>
          <h1 style="margin:0;color:#1d1d1f;font-size:26px;line-height:1.2;letter-spacing:0;">${htmlEscape(step.headline)}</h1>
        </div>
        <div style="padding:28px 30px;">
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;">${greeting}</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;">We've unlocked a <strong style="color:#1d1d1f;">7-day free trial</strong> on your Website Strategy Scan account.</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;">For the next seven days, you'll have full access to everything the platform offers&mdash;so you can use it exactly as you would with a paid subscription.</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;">Here's my recommendation:</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;"><strong style="color:#1d1d1f;">Don't test it on your own website.</strong></p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;">Pick a real prospect you're actively trying to close this week.</p>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.65;color:#3d3d43;">That's where Website Strategy Scan delivers the most value.</p>
          <a href="${htmlEscape(accountLink)}" style="display:inline-block;padding:13px 18px;border-radius:12px;background:#f5c842;color:#1d1d1f;text-decoration:none;font-weight:800;">${htmlEscape(step.cta)}</a>
        </div>
        <div style="padding:18px 30px;background:#fafafa;border-top:1px solid #ececf0;font-size:12px;line-height:1.6;color:#777;">
          <a href="${htmlEscape(unsubscribe)}" style="color:#6e6e73;">Unsubscribe from Website Strategy Scan emails</a>
        </div>
      </div>
    </div>
  `;
}

function sevenDayTrialEmailText({ user, profile, step }) {
  const name = displayName(user, profile);
  return [
    name ? `Hi ${name},` : 'Hi,',
    '',
    "We've unlocked a 7-day free trial on your Website Strategy Scan account.",
    '',
    "For the next seven days, you'll have full access to everything the platform offers--so you can use it exactly as you would with a paid subscription.",
    '',
    "Here's my recommendation:",
    '',
    "Don't test it on your own website.",
    '',
    "Pick a real prospect you're actively trying to close this week.",
    '',
    "That's where Website Strategy Scan delivers the most value.",
    '',
    `${step.cta}: ${ctaUrlForStep(step)}`,
    '',
    `Unsubscribe: ${unsubscribeUrl(user.email, TRIAL_BROADCAST_CAMPAIGN_KEY)}`,
  ].join('\n');
}

function emailHtml({ user, profile, step }) {
  if (step?.template === 'seven_day_trial_broadcast') {
    return sevenDayTrialEmailHtml({ user, profile, step });
  }

  const name = displayName(user, profile);
  const greeting = name ? `Hi ${htmlEscape(name)},` : 'Hi,';
  const unsubscribe = unsubscribeUrl(user.email);
  const accountLink = ctaUrlForStep(step);
  const websiteLink = websiteUrl();
  const paragraphs = Array.isArray(step.paragraphs) && step.paragraphs.length ? step.paragraphs : [step.intro || step.previewText || 'Your account is ready when you are.'];
  const bullets = Array.isArray(step.bullets) ? step.bullets.filter(Boolean) : [];
  const paragraphHtml = paragraphs.map(paragraph => (
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;">${htmlEscape(paragraph)}</p>`
  )).join('');
  const bulletHtml = bullets.length
    ? `<ul style="margin:0 0 24px;padding-left:18px;color:#3d3d43;font-size:15px;line-height:1.65;">${bullets.map(item => `<li>${htmlEscape(item)}</li>`).join('')}</ul>`
    : '';
  return `
    <div style="margin:0;padding:28px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1d1d1f;">
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${htmlEscape(step.previewText || step.subject)}</div>
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e5e5ea;border-radius:18px;overflow:hidden;box-shadow:0 18px 48px rgba(0,0,0,0.08);">
        <div style="padding:28px 30px;border-bottom:1px solid #ececf0;">
          <p style="margin:0 0 10px;color:#8a6312;text-transform:uppercase;letter-spacing:.08em;font-size:12px;font-weight:800;">Website Strategy Scan</p>
          <h1 style="margin:0;color:#1d1d1f;font-size:26px;line-height:1.2;letter-spacing:0;">${htmlEscape(step.headline)}</h1>
        </div>
        <div style="padding:28px 30px;">
          <p style="margin:0 0 14px;font-size:15px;line-height:1.65;">${greeting}</p>
          ${paragraphHtml}
          ${bulletHtml}
          <a href="${htmlEscape(accountLink)}" style="display:inline-block;padding:13px 18px;border-radius:12px;background:#f5c842;color:#1d1d1f;text-decoration:none;font-weight:800;">${htmlEscape(step.cta)}</a>
          <div style="margin:22px 0 0;padding:14px 16px;border:1px solid #ececf0;border-radius:14px;background:#fafafa;font-size:13px;line-height:1.7;color:#4a4a50;">
            <div><strong style="color:#1d1d1f;">Your account:</strong> <a href="${htmlEscape(accountLink)}" style="color:#8a6312;">${htmlEscape(accountLink)}</a></div>
            <div><strong style="color:#1d1d1f;">Website:</strong> <a href="${htmlEscape(websiteLink)}" style="color:#8a6312;">${htmlEscape(websiteLink)}</a></div>
          </div>
          <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#6e6e73;">If you already subscribed or generated your complimentary preview, you can ignore this email.</p>
        </div>
        <div style="padding:18px 30px;background:#fafafa;border-top:1px solid #ececf0;font-size:12px;line-height:1.6;color:#777;">
          <a href="${unsubscribe}" style="color:#6e6e73;">Unsubscribe from account setup reminders</a>
        </div>
      </div>
    </div>
  `;
}

function emailText({ user, profile, step }) {
  if (step?.template === 'seven_day_trial_broadcast') {
    return sevenDayTrialEmailText({ user, profile, step });
  }

  const name = displayName(user, profile);
  const paragraphs = Array.isArray(step.paragraphs) && step.paragraphs.length ? step.paragraphs : [step.intro || step.previewText || 'Your account is ready when you are.'];
  const bullets = Array.isArray(step.bullets) ? step.bullets.filter(Boolean).map(item => `- ${item}`) : [];
  return [
    name ? `Hi ${name},` : 'Hi,',
    '',
    step.headline,
    '',
    ...paragraphs,
    ...(bullets.length ? ['', ...bullets] : []),
    '',
    `${step.cta}: ${ctaUrlForStep(step)}`,
    `Your account: ${ctaUrlForStep(step)}`,
    `Website: ${websiteUrl()}`,
    '',
    `Unsubscribe: ${unsubscribeUrl(user.email)}`,
  ].join('\n');
}

async function sendLifecycleEmail({ user, profile, step, campaign = CAMPAIGN_KEY, ignorePause = false }) {
  if (outboundEmailsPaused() && !ignorePause) {
    throw billing.httpError(503, 'Outbound emails are paused.', 'emails_paused');
  }

  const apiKey = resendApiKey();
  const from = emailFrom();
  if (!apiKey || !from) {
    throw billing.httpError(503, 'Lifecycle email is not configured. Add RESEND_API_KEY and LIFECYCLE_EMAIL_FROM or SUPPORT_EMAIL_FROM in Render.', 'lifecycle_email_not_configured');
  }
  await ensureResendTrackingEnabled(apiKey);

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
      'Idempotency-Key': `${campaign}:${normalizeEmail(user.email)}:${step.key}`,
    },
    body: JSON.stringify(body),
  });

  const responseBody = parseJson(await response.text());
  if (!response.ok) {
    throw billing.httpError(response.status, responseBody?.message || responseBody?.error || 'Lifecycle email could not be sent.', 'resend_lifecycle_email_failed', responseBody);
  }
  return responseBody || {};
}

async function existingEmailEvent(email, stepKey, campaign = CAMPAIGN_KEY) {
  const rows = await supabaseRest('lifecycle_email_events', {
    query: {
      select: '*',
      email: `eq.${normalizeEmail(email)}`,
      campaign: `eq.${campaign}`,
      step: `eq.${stepKey}`,
      limit: '1',
    },
  });
  return Array.isArray(rows) ? rows[0] || null : rows || null;
}

async function updateEmailEvent({ user, step, status, providerId, errorMessage, metadata = {}, campaign = CAMPAIGN_KEY }) {
  const rows = await supabaseRest('lifecycle_email_events', {
    method: 'PATCH',
    query: {
      email: `eq.${normalizeEmail(user.email)}`,
      campaign: `eq.${campaign}`,
      step: `eq.${step.key}`,
      select: '*',
    },
    prefer: 'return=representation',
    body: {
      user_id: user.id || null,
      status,
      provider: 'resend',
      provider_message_id: cleanText(providerId),
      error: cleanText(errorMessage),
      metadata,
      sent_at: status === 'sent' ? new Date().toISOString() : null,
    },
  });
  return Array.isArray(rows) ? rows[0] || null : rows || null;
}

async function recordEmailEvent({ user, step, status = 'sent', providerId = '', errorMessage = '', metadata = {}, campaign = step?.campaign || CAMPAIGN_KEY }) {
  const cleanStatus = status === 'sent' ? 'sent' : 'failed';
  const payload = {
    id: crypto.randomUUID(),
    user_id: user.id || null,
    email: normalizeEmail(user.email),
    campaign,
    step: step.key,
    status: cleanStatus,
    provider: 'resend',
    provider_message_id: cleanText(providerId),
    error: cleanText(errorMessage),
    metadata,
    sent_at: cleanStatus === 'sent' ? new Date().toISOString() : null,
  };

  try {
    const rows = await supabaseRest('lifecycle_email_events', {
      method: 'POST',
      prefer: 'return=representation',
      body: payload,
    });
    return Array.isArray(rows) ? rows[0] || null : rows || null;
  } catch (error) {
    if (error?.details?.code === '23505') {
      const existing = await existingEmailEvent(user.email, step.key, campaign);
      if (existing?.status === 'sent' && cleanStatus !== 'sent') return existing;
      return updateEmailEvent({
        user,
        step,
        status: cleanStatus,
        providerId,
        errorMessage,
        metadata,
        campaign,
      });
    }
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
  if (outboundEmailsPaused() && !dryRun) {
    return {
      ok: true,
      dryRun,
      paused: true,
      campaign: CAMPAIGN_KEY,
      scanned_users: 0,
      eligible: 0,
      selected: 0,
      sent: 0,
      would_send: 0,
      failed: 0,
      skipped: { emails_paused: true },
      deliveries: [],
      failures: [],
    };
  }

  const users = await listAuthUsers();

  let subscriptions;
  let profiles;
  let events;
  let unsubscribes;
  try {
    [subscriptions, profiles, events, unsubscribes] = await Promise.all([
      listRestRows('subscriptions', { select: 'user_id,status,subscription_status,stripe_customer_id,stripe_subscription_id,plan,complimentary_scan_used_at,complimentary_report_id,created_at,updated_at' }),
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
    preview_completed: 0,
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
    if (subscriptionHasComplimentaryPreview(subscription)) {
      skipped.preview_completed += 1;
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
        delay_minutes: candidate.step.delayMinutes,
        test_mode: candidate.step.testMode === true,
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
          delay_minutes: candidate.step.delayMinutes,
          test_mode: candidate.step.testMode === true,
        },
      });
      sent.push({
        email: candidate.user.email,
        user_id: candidate.user.id,
        step: candidate.step.key,
        delay_minutes: candidate.step.delayMinutes,
        test_mode: candidate.step.testMode === true,
        provider_message_id: delivery.id || '',
      });
    } catch (error) {
      let failureRecorded = false;
      const failedProviderId = error?.details?.id || error?.details?.message_id || error?.details?.provider_message_id || '';
      try {
        await recordEmailEvent({
          user: candidate.user,
          step: candidate.step,
          status: 'failed',
          providerId: failedProviderId,
          errorMessage: error?.message || 'Email failed.',
          metadata: {
            signup_created_at: candidate.user.created_at || null,
            subscription_status: candidate.subscription?.status || null,
            delay_minutes: candidate.step.delayMinutes,
            test_mode: candidate.step.testMode === true,
            error_code: error?.code || 'email_failed',
          },
        });
        failureRecorded = true;
      } catch (recordError) {
        console.warn('[LeadCheck] Lifecycle email failure could not be recorded:', recordError?.message || recordError);
      }
      failed.push({
        email: candidate.user.email,
        user_id: candidate.user.id,
        step: candidate.step.key,
        delay_minutes: candidate.step.delayMinutes,
        test_mode: candidate.step.testMode === true,
        provider_message_id: failedProviderId,
        error: error?.message || 'Email failed.',
        code: error?.code || 'email_failed',
        failure_recorded: failureRecorded,
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
    sent: dryRun ? 0 : sent.length,
    would_send: dryRun ? sent.length : 0,
    failed: failed.length,
    skipped,
    deliveries: sent,
    failures: failed,
  };
}

async function loadBroadcastRecipients({ campaign = TRIAL_BROADCAST_CAMPAIGN_KEY, stepKey = TRIAL_BROADCAST_STEP_KEY } = {}) {
  const users = await listAuthUsers();

  let profiles;
  let subscriptions;
  let events;
  let unsubscribes;
  try {
    [profiles, subscriptions, events, unsubscribes] = await Promise.all([
      listRestRows('profiles', { select: 'id,email,full_name,agency_name' }),
      listRestRows('subscriptions', { select: 'user_id,status,subscription_status,stripe_customer_id,stripe_subscription_id,plan' }),
      listRestRows('lifecycle_email_events', { select: 'email,campaign,step,status', campaign: `eq.${campaign}`, step: `eq.${stepKey}`, status: 'eq.sent' }),
      listRestRows('lifecycle_email_unsubscribes', { select: 'email,campaign' }),
    ]);
  } catch (error) {
    throw lifecycleSchemaError(error);
  }

  const profileByUser = new Map((profiles || []).map(row => [row.id, row]));
  const subscriptionByUser = new Map((subscriptions || []).map(row => [row.user_id, row]));
  const sentEmails = new Set((events || []).map(row => normalizeEmail(row.email)));
  const unsubscribed = new Set((unsubscribes || []).map(row => unsubscribeKey(row.email, row.campaign)));
  const seenEmails = new Set();
  const recipients = [];
  const skipped = {
    missing_email: 0,
    deleted_user: 0,
    duplicate_email: 0,
    unsubscribed: 0,
    already_sent: 0,
    already_subscribed: 0,
  };

  users.forEach(user => {
    const email = normalizeEmail(user.email);
    if (!email) {
      skipped.missing_email += 1;
      return;
    }
    if (user.deleted_at) {
      skipped.deleted_user += 1;
      return;
    }
    if (seenEmails.has(email)) {
      skipped.duplicate_email += 1;
      return;
    }
    seenEmails.add(email);
    if (unsubscribed.has(unsubscribeKey(email, campaign)) || unsubscribed.has(unsubscribeKey(email, 'all'))) {
      skipped.unsubscribed += 1;
      return;
    }
    if (sentEmails.has(email)) {
      skipped.already_sent += 1;
      return;
    }
    if (!subscriptionLooksUnpaid(subscriptionByUser.get(user.id))) {
      skipped.already_subscribed += 1;
      return;
    }

    recipients.push({
      user: { ...user, email },
      profile: profileByUser.get(user.id) || null,
    });
  });

  recipients.sort((a, b) => new Date(a.user.created_at || 0) - new Date(b.user.created_at || 0));
  return { users, recipients, skipped };
}

function broadcastConfirmValue(value = '') {
  return cleanText(value).toLowerCase();
}

async function runSevenDayTrialBroadcast(options = {}) {
  const dryRun = options.dryRun !== false;
  const limit = broadcastMaxPerRun(options.limit);
  const campaign = TRIAL_BROADCAST_CAMPAIGN_KEY;
  const step = sevenDayTrialBroadcastStep;
  const requiredConfirm = 'send-seven-day-trial';

  if (!dryRun && broadcastConfirmValue(options.confirm) !== requiredConfirm) {
    throw billing.httpError(
      400,
      `Broadcast send requires confirm="${requiredConfirm}".`,
      'broadcast_confirmation_required'
    );
  }

  const { users, recipients, skipped } = await loadBroadcastRecipients({ campaign, stepKey: step.key });
  const selected = recipients.slice(0, limit);
  const deliveries = [];
  const failures = [];

  for (const recipient of selected) {
    if (dryRun) {
      deliveries.push({
        email: recipient.user.email,
        user_id: recipient.user.id,
        first_name: displayName(recipient.user, recipient.profile),
        step: step.key,
        dry_run: true,
      });
      continue;
    }

    try {
      const delivery = await sendLifecycleEmail({
        user: recipient.user,
        profile: recipient.profile,
        step,
        campaign,
        ignorePause: true,
      });
      await recordEmailEvent({
        user: recipient.user,
        step,
        campaign,
        providerId: delivery.id || '',
        metadata: {
          broadcast: true,
          cta_url: trialBroadcastUrl(),
          source: 'seven_day_trial_broadcast',
        },
      });
      deliveries.push({
        email: recipient.user.email,
        user_id: recipient.user.id,
        first_name: displayName(recipient.user, recipient.profile),
        step: step.key,
        provider_message_id: delivery.id || '',
      });
    } catch (error) {
      const failedProviderId = error?.details?.id || error?.details?.message_id || error?.details?.provider_message_id || '';
      let failureRecorded = false;
      try {
        await recordEmailEvent({
          user: recipient.user,
          step,
          campaign,
          status: 'failed',
          providerId: failedProviderId,
          errorMessage: error?.message || 'Email failed.',
          metadata: {
            broadcast: true,
            cta_url: trialBroadcastUrl(),
            source: 'seven_day_trial_broadcast',
            error_code: error?.code || 'email_failed',
          },
        });
        failureRecorded = true;
      } catch (recordError) {
        console.warn('[LeadCheck] Broadcast email failure could not be recorded:', recordError?.message || recordError);
      }
      failures.push({
        email: recipient.user.email,
        user_id: recipient.user.id,
        first_name: displayName(recipient.user, recipient.profile),
        step: step.key,
        provider_message_id: failedProviderId,
        error: error?.message || 'Email failed.',
        code: error?.code || 'email_failed',
        failure_recorded: failureRecorded,
      });
    }
  }

  return {
    ok: failures.length === 0,
    dryRun,
    pausedOtherEmails: outboundEmailsPaused(),
    pauseBypassedForBroadcastSend: !dryRun,
    campaign,
    step: step.key,
    subject: step.subject,
    cta_url: trialBroadcastUrl(),
    scanned_users: users.length,
    eligible: recipients.length,
    selected: selected.length,
    sent: dryRun ? 0 : deliveries.length,
    would_send: dryRun ? deliveries.length : 0,
    failed: failures.length,
    remaining_after_run: Math.max(0, recipients.length - selected.length),
    skipped,
    sample_recipients: deliveries.slice(0, 20),
    deliveries: dryRun ? [] : deliveries,
    failures,
  };
}

module.exports = {
  CAMPAIGN_KEY,
  TRIAL_BROADCAST_CAMPAIGN_KEY,
  TRIAL_BROADCAST_STEP_KEY,
  LIFECYCLE_CAMPAIGNS,
  abandonedSignupSteps,
  sevenDayTrialBroadcastStep,
  envFlag,
  runAbandonedSignupCampaign,
  runSevenDayTrialBroadcast,
  tokenFor,
  unsubscribe,
  verifyToken,
};
