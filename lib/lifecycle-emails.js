const crypto = require('crypto');
const billing = require('./billing');
const { ensureResendTrackingEnabled } = require('./resend-tracking');
const { outboundEmailsPaused } = require('./email-controls');

const RESEND_EMAIL_API_URL = 'https://api.resend.com/emails';
const CAMPAIGN_KEY = 'abandoned_signup';
const ABANDONED_CART_CAMPAIGN_KEY = 'abandoned_cart';
const INCOMPLETE_ACCOUNT_OFFER_CAMPAIGN_KEY = 'incomplete_account_offer';
const ABANDONED_CART_OFFER_KEY = 'abandoned_cart_50_first_month';
const TRIAL_BROADCAST_CAMPAIGN_KEY = 'seven_day_trial_broadcast';
const TRIAL_BROADCAST_STEP_KEY = 'seven_day_trial_offer_2026_08';
const AI_VISIBILITY_BROADCAST_CAMPAIGN_KEY = 'ai_visibility_coming_soon_broadcast';
const AI_VISIBILITY_BROADCAST_STEP_KEY = 'ai_visibility_coming_soon_2026_08';
const CLIENT_LIST_ACQUISITION_BROADCAST_CAMPAIGN_KEY = 'client_list_acquisition_broadcast';
const CLIENT_LIST_ACQUISITION_BROADCAST_STEP_KEY = 'client_list_acquisition_2026_08';
const LEAD_FINDER_BROADCAST_CAMPAIGN_KEY = 'lead_finder_launch_broadcast';
const LEAD_FINDER_BROADCAST_STEP_KEY = 'lead_finder_launch_2026_08';
const FIRST_MONTH_DISCOUNT_CAMPAIGN_KEY = 'first_month_discount_sequence_2026_08';
const FIRST_MONTH_DISCOUNT_DEFAULT_START_AT = '2026-08-22T00:00:00-04:00';
const FIRST_MONTH_DISCOUNT_SEND_WINDOW_DAYS = 8;
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
      'PitchProof turns a website into a professional client-facing assessment your prospect can actually understand.',
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
    subject: 'How agencies are using PitchProof',
    previewText: 'Use reports in sales calls, outreach, proposals, follow-up, and more.',
    headline: 'How agencies are using PitchProof.',
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
      'PitchProof helps bridge that gap with clear evidence and business-focused findings.',
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
      'PitchProof is not SEMrush, GTmetrix, or PageSpeed.',
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

const abandonedCartSteps = [
  {
    key: 'checkout_1h',
    delayMinutes: 60,
    subject: 'Still want to unlock PitchProof?',
    previewText: 'Come back and get 50% off your first month.',
    headline: 'Get 50% off your first month.',
    paragraphs: [
      'You started choosing a PitchProof plan, but checkout was not completed.',
      'Come back through this link and your first paid month will be 50% off when you finish checkout.',
      'Your account is still ready, and you can continue from billing when you return.',
    ],
    cta: 'Claim 50% Off',
    template: 'abandoned_cart',
    campaign: ABANDONED_CART_CAMPAIGN_KEY,
    offer: ABANDONED_CART_OFFER_KEY,
  },
];

const incompleteAccountOfferSteps = [
  {
    key: 'first_month_50_after_signup',
    delayMinutes: 60,
    subject: '50% off your first month of PitchProof',
    previewText: 'Finish setting up PitchProof and get your first month half off.',
    headline: 'Get 50% off your first month.',
    paragraphs: [
      'You created a PitchProof account, but setup was not completed.',
      'If you still want to generate client-ready website reports, come back through this link and your first paid month will be 50% off.',
      'Your account is still ready when you are.',
    ],
    cta: 'Claim 50% Off',
    template: 'incomplete_account_offer',
    campaign: INCOMPLETE_ACCOUNT_OFFER_CAMPAIGN_KEY,
    offer: ABANDONED_CART_OFFER_KEY,
  },
];

const LIFECYCLE_CAMPAIGNS = {
  [CAMPAIGN_KEY]: {
    key: CAMPAIGN_KEY,
    steps: abandonedSignupSteps,
  },
  [ABANDONED_CART_CAMPAIGN_KEY]: {
    key: ABANDONED_CART_CAMPAIGN_KEY,
    steps: abandonedCartSteps,
  },
  [INCOMPLETE_ACCOUNT_OFFER_CAMPAIGN_KEY]: {
    key: INCOMPLETE_ACCOUNT_OFFER_CAMPAIGN_KEY,
    steps: incompleteAccountOfferSteps,
  },
};

const sevenDayTrialBroadcastStep = {
  key: TRIAL_BROADCAST_STEP_KEY,
  campaign: TRIAL_BROADCAST_CAMPAIGN_KEY,
  subject: 'PitchProof Subscription Update',
  previewText: 'PitchProof no longer offers a free trial.',
  headline: 'This trial offer has ended.',
  cta: 'Choose a Plan',
  template: 'seven_day_trial_broadcast',
};

const aiVisibilityComingSoonBroadcastStep = {
  key: AI_VISIBILITY_BROADCAST_STEP_KEY,
  campaign: AI_VISIBILITY_BROADCAST_CAMPAIGN_KEY,
  subject: 'Coming Soon: AI Visibility Reports in PitchProof',
  previewText: 'See whether AI tools are recommending your prospects or their competitors.',
  headline: 'AI Visibility Reports are coming soon.',
  cta: 'Log In to PitchProof',
  template: 'ai_visibility_coming_soon_broadcast',
};

const clientListAcquisitionBroadcastStep = {
  key: CLIENT_LIST_ACQUISITION_BROADCAST_STEP_KEY,
  campaign: CLIENT_LIST_ACQUISITION_BROADCAST_CAMPAIGN_KEY,
  subject: 'Would you ever sell your client list?',
  previewText: 'Quick question about your existing agency client list.',
  template: 'client_list_acquisition_broadcast',
};

const leadFinderBroadcastStep = {
  key: LEAD_FINDER_BROADCAST_STEP_KEY,
  campaign: LEAD_FINDER_BROADCAST_CAMPAIGN_KEY,
  subject: 'New in PitchProof: Find Better Website Prospects Faster',
  previewText: 'Lead Finder helps you search local businesses, score opportunities, save prospects, and find public contact emails.',
  headline: 'Lead Finder is now inside PitchProof.',
  cta: 'Open Lead Finder',
  template: 'lead_finder_launch_broadcast',
};

const firstMonthDiscountSequenceSteps = [
  {
    key: 'first_month_50_day_0',
    delayMinutes: 0,
    campaign: FIRST_MONTH_DISCOUNT_CAMPAIGN_KEY,
    subject: '50% Off PitchProof for the Next 7 Days',
    previewText: 'For the next seven days only, get 50% off your first month of PitchProof.',
    headline: '50% off your first month for the next 7 days.',
    intro: 'For the next 7 days only, you can get 50% off your first month of PitchProof.',
    paragraphs: [
      'PitchProof helps agencies turn any prospect website into a clear, professional sales conversation.',
      'Instead of trying to explain why a prospect needs a new website, you can show them the website health score, trust issues, conversion problems, SEO gaps, technical issues, and a client-ready report they can actually understand.',
      'Use this for sales calls, proposals, follow-up, or prospecting when you need a stronger reason for a business owner to take action.',
    ],
    bullets: [
      'Website health scoring',
      'Trust and credibility findings',
      'Conversion and CTA issues',
      'SEO and visibility gaps',
      'PDF reports and saved report links',
      'White-label branding on eligible plans',
    ],
    cta: 'Get 50% Off Your First Month',
    template: 'first_month_discount_sequence',
  },
  {
    key: 'first_month_50_day_3',
    delayMinutes: 4320,
    campaign: FIRST_MONTH_DISCOUNT_CAMPAIGN_KEY,
    subject: 'Most Agencies Know the Website Is the Problem. PitchProof Helps Prove It.',
    previewText: 'Your 50% off PitchProof offer is still available, but only for a few more days.',
    headline: 'Show prospects exactly why their website needs work.',
    intro: 'Quick reminder: your 50% off PitchProof offer is still available, but only for a few more days.',
    paragraphs: [
      'A lot of agencies already know when a prospect website is holding the business back. The harder part is proving it clearly.',
      'PitchProof gives you a polished website assessment report that helps you show a prospect where their site is losing trust, clarity, leads, and sales opportunities.',
      'You can use it before a call, after a discovery meeting, inside a proposal, or as a follow-up asset when the prospect needs something concrete to review.',
    ],
    bullets: [
      'Create client-ready website assessments in minutes',
      'Save and reopen reports from your dashboard',
      'Send shareable report links after sales calls',
      'Export PDFs for proposals and follow-up',
      'Present under your agency brand on eligible plans',
      'Make website problems easier for prospects to understand',
    ],
    cta: 'Start Using PitchProof Today',
    template: 'first_month_discount_sequence',
  },
  {
    key: 'first_month_50_day_7',
    delayMinutes: 10080,
    campaign: FIRST_MONTH_DISCOUNT_CAMPAIGN_KEY,
    subject: 'Last Day: 50% Off PitchProof Ends Tonight',
    previewText: 'This is the final day to claim 50% off your first month of PitchProof.',
    headline: 'Last day to claim 50% off.',
    intro: 'This is the final reminder. Your 50% off first month offer for PitchProof ends today.',
    paragraphs: [
      'If you sell websites, SEO, design, marketing, or digital strategy, PitchProof gives you a faster way to show prospects why their website needs work.',
      'Instead of sending generic advice or hoping they understand the problem, you can show them a professional report with clear scoring, issues, and recommendations.',
      'Use the report to look more professional, create stronger proposals, save time reviewing websites manually, and turn website problems into a business case for hiring your agency.',
    ],
    bullets: [
      'Look more professional on sales calls',
      'Give prospects a clear reason to act',
      'Turn weak websites into stronger proposals',
      'Generate reports faster than manual audits',
      'Use white-label presentation on eligible plans',
      'Build better follow-up after every discovery call',
    ],
    cta: 'Claim 50% Off Before It Ends',
    template: 'first_month_discount_sequence',
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

function subscriptionLooksAbandonedCart(subscription) {
  if (!subscription) return false;
  const status = cleanText(subscription.status || subscription.subscription_status).toLowerCase();
  const normalizedStatus = status === 'incomplete_expired' ? 'incomplete' : status;
  return Boolean(
    subscription.stripe_customer_id &&
    !subscription.stripe_subscription_id &&
    (!normalizedStatus || normalizedStatus === 'incomplete')
  );
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

function lifecycleStepsForUser(user, campaign = CAMPAIGN_KEY) {
  const allowlist = testRecipientSet();
  const email = normalizeEmail(user.email);
  const userId = cleanText(user.id).toLowerCase();
  const testMode = Boolean(allowlist.size && (allowlist.has(email) || allowlist.has(userId)));
  const campaignSteps = LIFECYCLE_CAMPAIGNS[campaign]?.steps || [];
  if (!testMode) return campaignSteps;

  const delays = testDelayMinutes();
  return campaignSteps.map((step, index) => ({
    ...step,
    delayMinutes: delays[index] || delays[delays.length - 1] || step.delayMinutes,
    testMode: true,
  }));
}

function stepAlreadySent(step, sentSteps) {
  return sentSteps.has(step.key) || (step.legacyKeys || []).some(key => sentSteps.has(key));
}

function chooseNextStep(user, sentSteps, campaign = CAMPAIGN_KEY) {
  const age = accountAgeMinutes(user);
  return lifecycleStepsForUser(user, campaign).find(step => age >= step.delayMinutes && !stepAlreadySent(step, sentSteps)) || null;
}

function minutesSince(value) {
  const date = new Date(value || '');
  if (!Number.isFinite(date.getTime())) return 0;
  return (Date.now() - date.getTime()) / 60000;
}

function chooseNextCartStep(subscription, sentSteps, user) {
  const age = minutesSince(subscription.updated_at || subscription.created_at || user.created_at);
  return lifecycleStepsForUser(user, ABANDONED_CART_CAMPAIGN_KEY).find(step => age >= step.delayMinutes && !stepAlreadySent(step, sentSteps)) || null;
}

function chooseNextIncompleteAccountOfferStep(user, sentSteps) {
  const age = accountAgeMinutes(user);
  return lifecycleStepsForUser(user, INCOMPLETE_ACCOUNT_OFFER_CAMPAIGN_KEY).find(step => age >= step.delayMinutes && !stepAlreadySent(step, sentSteps)) || null;
}

function pausedCampaignResult({ dryRun, campaign, skipped }) {
  return {
    ok: true,
    dryRun,
    paused: true,
    campaign,
    scanned_users: 0,
    eligible: 0,
    selected: 0,
    sent: 0,
    would_send: 0,
    failed: 0,
    skipped,
    deliveries: [],
    failures: [],
  };
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
  return `${appUrl()}/app/billing`;
}

function loginUrl() {
  return `${appUrl()}/login`;
}

function leadFinderUrl() {
  return `${appUrl()}/app/leads?source=lead_finder_email`;
}

function aiVisibilitySignupOfferUrl() {
  return abandonedCartOfferUrl();
}

function billingUrl() {
  return `${appUrl()}/app/billing?resume=checkout`;
}

function abandonedCartOfferUrl() {
  const url = new URL(`${appUrl()}/app/billing`);
  url.searchParams.set('resume', 'checkout');
  url.searchParams.set('offer', ABANDONED_CART_OFFER_KEY);
  return url.toString();
}

function firstMonthDiscountOfferUrl() {
  const url = new URL(`${appUrl()}/app/billing`);
  url.searchParams.set('resume', 'checkout');
  url.searchParams.set('offer', ABANDONED_CART_OFFER_KEY);
  url.searchParams.set('source', 'first_month_50_sequence');
  return url.toString();
}

function firstMonthDiscountImageUrl() {
  return `${appUrl()}/assets/pitchproof-scan-link-preview.png`;
}

function firstMonthDiscountStartMs(value = process.env.FIRST_MONTH_DISCOUNT_CAMPAIGN_START_AT) {
  const parsed = Date.parse(cleanText(value) || FIRST_MONTH_DISCOUNT_DEFAULT_START_AT);
  return Number.isFinite(parsed) ? parsed : Date.parse(FIRST_MONTH_DISCOUNT_DEFAULT_START_AT);
}

function firstMonthDiscountOfferEndMs(startMs = firstMonthDiscountStartMs()) {
  return startMs + (7 * 24 * 60 * 60 * 1000);
}

function firstMonthDiscountSendUntilMs(startMs = firstMonthDiscountStartMs()) {
  return startMs + (FIRST_MONTH_DISCOUNT_SEND_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

function formatCampaignDate(timestamp) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/Toronto',
  }).format(new Date(timestamp));
}

function websiteUrl() {
  return appUrl();
}

function ctaUrlForStep(step = {}) {
  if (step.ctaUrl) return step.ctaUrl;
  if (step.template === 'seven_day_trial_broadcast') return trialBroadcastUrl();
  if (step.template === 'ai_visibility_coming_soon_broadcast') return loginUrl();
  if (step.template === 'lead_finder_launch_broadcast') return leadFinderUrl();
  if (step.template === 'first_month_discount_sequence') return firstMonthDiscountOfferUrl();
  if (
    step.template === 'abandoned_cart' ||
    step.template === 'incomplete_account_offer' ||
    step.campaign === ABANDONED_CART_CAMPAIGN_KEY ||
    step.campaign === INCOMPLETE_ACCOUNT_OFFER_CAMPAIGN_KEY
  ) return abandonedCartOfferUrl();
  return freePreviewUrl();
}

function aiVisibilityBroadcastStepForSubscription(subscription) {
  if (!subscriptionLooksUnpaid(subscription)) return aiVisibilityComingSoonBroadcastStep;
  return {
    ...aiVisibilityComingSoonBroadcastStep,
    previewText: 'AI Visibility Reports are coming soon. Sign up now and get 50% off your first month.',
    cta: "Sign up now so you don't miss out",
    ctaUrl: aiVisibilitySignupOfferUrl(),
    showNonSubscriberOffer: true,
  };
}

function aiVisibilityComingSoonEmailHtml({ user, profile, step }) {
  const name = displayName(user, profile);
  const greeting = name ? `Hi ${htmlEscape(name)},` : 'Hi,';
  const accountLink = ctaUrlForStep(step);
  const unsubscribe = unsubscribeUrl(user.email, AI_VISIBILITY_BROADCAST_CAMPAIGN_KEY);
  const showOffer = step.showNonSubscriberOffer === true;

  return `
    <div style="margin:0;padding:28px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1d1d1f;">
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${htmlEscape(step.previewText)}</div>
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e5e5ea;border-radius:18px;overflow:hidden;box-shadow:0 18px 48px rgba(0,0,0,0.08);">
        <div style="padding:28px 30px;border-bottom:1px solid #ececf0;">
          <p style="margin:0 0 10px;color:#8a6312;text-transform:uppercase;letter-spacing:.08em;font-size:12px;font-weight:800;">PitchProof</p>
          <h1 style="margin:0;color:#1d1d1f;font-size:26px;line-height:1.2;letter-spacing:0;">${htmlEscape(step.headline)}</h1>
        </div>
        <div style="padding:28px 30px;">
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;">${greeting}</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;">We're adding something new to PitchProof: <strong style="color:#1d1d1f;">AI Visibility Reports</strong>.</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;">This new report will help you see whether a business is being surfaced in AI recommendation-style searches, the kind of searches people are starting to use when deciding who to contact.</p>
          <div style="margin:0 0 18px;padding:16px 18px;border:1px solid #ececf0;border-radius:14px;background:#fafafa;color:#3d3d43;font-size:14px;line-height:1.65;">
            <div style="margin:0 0 8px;">"Who are the best roofers in Ottawa?"</div>
            <div style="margin:0 0 8px;">"Who should I hire for web design in Toronto?"</div>
            <div>"What are the most reputable contractors near me?"</div>
          </div>
          <p style="margin:0 0 12px;font-size:15px;line-height:1.65;color:#3d3d43;">The AI Visibility Report will show:</p>
          <ul style="margin:0 0 22px;padding-left:18px;font-size:15px;line-height:1.65;color:#3d3d43;">
            <li>Whether the business was recommended</li>
            <li>How many AI searches it appeared in</li>
            <li>Which competitors were surfaced instead</li>
            <li>Whether the website was cited</li>
            <li>Where the business is missing visibility</li>
            <li>A simple visibility level like Not Mentioned, Low Visibility, Some Visibility, or Strong Visibility</li>
          </ul>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;">The goal is simple: give agencies another way to show prospects where they may be losing attention before the prospect ever reaches Google or fills out a form.</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;">This is designed to work alongside the existing Website Report, not replace it.</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;">The Website Report shows what needs to be improved on the site.</p>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.65;color:#3d3d43;">The AI Visibility Report shows whether AI tools are actually surfacing the business when buyers ask for recommendations.</p>
          ${showOffer ? `
          <div style="margin:0 0 22px;padding:16px 18px;border:1px solid #f0d47a;border-radius:14px;background:#fff8df;color:#3d3d43;font-size:14px;line-height:1.65;">
            <p style="margin:0 0 8px;font-weight:800;color:#1d1d1f;">Sign up now so you don't miss out.</p>
            <p style="margin:0;">Get <strong style="color:#1d1d1f;">50% off your first month</strong> and be ready when AI Visibility Reports roll out.</p>
          </div>
          ` : ''}
          <a href="${htmlEscape(accountLink)}" style="display:inline-block;padding:13px 18px;border-radius:12px;background:#f5c842;color:#1d1d1f;text-decoration:none;font-weight:800;">${htmlEscape(step.cta)}</a>
          <p style="margin:24px 0 0;font-size:15px;line-height:1.65;color:#3d3d43;">More updates soon.</p>
          <p style="margin:16px 0 0;font-size:15px;line-height:1.65;color:#3d3d43;">William<br>PitchProof</p>
        </div>
        <div style="padding:18px 30px;background:#fafafa;border-top:1px solid #ececf0;font-size:12px;line-height:1.6;color:#777;">
          <a href="${htmlEscape(unsubscribe)}" style="color:#6e6e73;">Unsubscribe from PitchProof emails</a>
        </div>
      </div>
    </div>
  `;
}

function aiVisibilityComingSoonEmailText({ user, profile, step }) {
  const name = displayName(user, profile);
  const showOffer = step.showNonSubscriberOffer === true;
  const lines = [
    name ? `Hi ${name},` : 'Hi,',
    '',
    "We're adding something new to PitchProof: AI Visibility Reports.",
    '',
    'This new report will help you see whether a business is being surfaced in AI recommendation-style searches, the kind of searches people are starting to use when deciding who to contact.',
    '',
    'For example:',
    '',
    '"Who are the best roofers in Ottawa?"',
    '"Who should I hire for web design in Toronto?"',
    '"What are the most reputable contractors near me?"',
    '',
    'The AI Visibility Report will show:',
    '',
    '- Whether the business was recommended',
    '- How many AI searches it appeared in',
    '- Which competitors were surfaced instead',
    '- Whether the website was cited',
    '- Where the business is missing visibility',
    '- A simple visibility level like Not Mentioned, Low Visibility, Some Visibility, or Strong Visibility',
    '',
    'The goal is simple:',
    '',
    'Give agencies another way to show prospects where they may be losing attention before the prospect ever reaches Google or fills out a form.',
    '',
    'This is designed to work alongside the existing Website Report, not replace it.',
    '',
    'The Website Report shows what needs to be improved on the site.',
    '',
    'The AI Visibility Report shows whether AI tools are actually surfacing the business when buyers ask for recommendations.',
    '',
    'This feature is coming soon inside PitchProof.',
    '',
  ];

  if (showOffer) {
    lines.push(
      'Sign up now so you don\'t miss out.',
      '',
      'Get 50% off your first month and be ready when AI Visibility Reports roll out.',
      ''
    );
  }

  lines.push(
    'More updates soon.',
    '',
    'William',
    'PitchProof',
    '',
    `${step.cta}: ${ctaUrlForStep(step)}`,
    '',
    `Unsubscribe: ${unsubscribeUrl(user.email, AI_VISIBILITY_BROADCAST_CAMPAIGN_KEY)}`
  );

  return lines.join('\n');
}

function clientListAcquisitionEmailHtml({ user, profile, step }) {
  const name = displayName(user, profile);
  const greeting = name ? `Hey ${htmlEscape(name)},` : 'Hey,';
  const unsubscribe = unsubscribeUrl(user.email, CLIENT_LIST_ACQUISITION_BROADCAST_CAMPAIGN_KEY);

  return `
    <div style="margin:0;padding:28px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1d1d1f;">
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${htmlEscape(step.previewText)}</div>
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e5e5ea;border-radius:18px;overflow:hidden;box-shadow:0 18px 48px rgba(0,0,0,0.08);">
        <div style="padding:28px 30px;">
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;">${greeting}</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;">Random question &mdash; would you ever consider selling your existing client list?</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;">I'm looking to acquire a few small agency client lists, particularly from owners who have a handful of clients they're still servicing but aren't really interested in chasing new business anymore.</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;">I'd take over the clients and fulfillment, and you'd get paid for handing off the recurring revenue.</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;">Not looking for a huge agency or some complicated acquisition. Even 3&ndash;10 active clients could be interesting.</p>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.65;color:#3d3d43;">If you'd consider something like that, respond <strong style="color:#1d1d1f;">"yes"</strong> to this email and I'll send over some more details.</p>
          <p style="margin:0;font-size:15px;line-height:1.65;color:#3d3d43;">&mdash; William</p>
        </div>
        <div style="padding:18px 30px;background:#fafafa;border-top:1px solid #ececf0;font-size:12px;line-height:1.6;color:#777;">
          <a href="${htmlEscape(unsubscribe)}" style="color:#6e6e73;">Unsubscribe from PitchProof emails</a>
        </div>
      </div>
    </div>
  `;
}

function clientListAcquisitionEmailText({ user, profile }) {
  const name = displayName(user, profile);
  return [
    name ? `Hey ${name},` : 'Hey,',
    '',
    'Random question -- would you ever consider selling your existing client list?',
    '',
    "I'm looking to acquire a few small agency client lists, particularly from owners who have a handful of clients they're still servicing but aren't really interested in chasing new business anymore.",
    '',
    "I'd take over the clients and fulfillment, and you'd get paid for handing off the recurring revenue.",
    '',
    'Not looking for a huge agency or some complicated acquisition. Even 3-10 active clients could be interesting.',
    '',
    'If you\'d consider something like that, respond "yes" to this email and I\'ll send over some more details.',
    '',
    '-- William',
    '',
    `Unsubscribe: ${unsubscribeUrl(user.email, CLIENT_LIST_ACQUISITION_BROADCAST_CAMPAIGN_KEY)}`,
  ].join('\n');
}

function leadFinderLaunchEmailHtml({ user, profile, step }) {
  const name = displayName(user, profile);
  const greeting = name ? `Hi ${htmlEscape(name)},` : 'Hi,';
  const accountLink = ctaUrlForStep(step);
  const unsubscribe = unsubscribeUrl(user.email, LEAD_FINDER_BROADCAST_CAMPAIGN_KEY);

  return `
    <div style="margin:0;padding:28px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1d1d1f;">
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${htmlEscape(step.previewText)}</div>
      <div style="max-width:660px;margin:0 auto;background:#ffffff;border:1px solid #e5e5ea;border-radius:18px;overflow:hidden;box-shadow:0 18px 48px rgba(0,0,0,0.08);">
        <div style="padding:28px 30px;border-bottom:1px solid #ececf0;">
          <p style="margin:0 0 10px;color:#8a6312;text-transform:uppercase;letter-spacing:.08em;font-size:12px;font-weight:800;">PitchProof</p>
          <h1 style="margin:0;color:#1d1d1f;font-size:26px;line-height:1.2;letter-spacing:0;">${htmlEscape(step.headline)}</h1>
        </div>
        <div style="padding:28px 30px;">
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;">${greeting}</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;">I added a new <strong style="color:#1d1d1f;">Lead Finder</strong> section inside PitchProof to help agencies find better website prospects faster.</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;">Instead of guessing who to reach out to, you can search by business type and location, review the results, and prioritize companies that look like stronger website opportunities.</p>
          <div style="margin:0 0 20px;padding:16px 18px;border:1px solid #ececf0;border-radius:14px;background:#fafafa;color:#3d3d43;font-size:14px;line-height:1.65;">
            <p style="margin:0 0 10px;font-weight:800;color:#1d1d1f;">What you can do with Lead Finder:</p>
            <ul style="margin:0;padding-left:18px;">
              <li>Search real local businesses by niche and location</li>
              <li>See an opportunity score out of 10</li>
              <li>See website scan scores out of 100 after scanning</li>
              <li>Save prospects into your PitchProof workspace</li>
              <li>Find public contact emails from company websites</li>
              <li>Run the website scan and turn strong prospects into client-ready reports</li>
            </ul>
          </div>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;">The goal is simple: help you spend less time building prospect lists and more time starting sales conversations with businesses that have a clearer reason to care.</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;">Starter includes 3,000 Lead Finder results per month. Professional and Growth include unlimited Lead Finder results.</p>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.65;color:#3d3d43;">Open it from the left sidebar in your PitchProof account, or use the button below.</p>
          <a href="${htmlEscape(accountLink)}" style="display:inline-block;padding:13px 18px;border-radius:12px;background:#f5c842;color:#1d1d1f;text-decoration:none;font-weight:800;">${htmlEscape(step.cta)}</a>
          <p style="margin:24px 0 0;font-size:15px;line-height:1.65;color:#3d3d43;">William<br>PitchProof</p>
        </div>
        <div style="padding:18px 30px;background:#fafafa;border-top:1px solid #ececf0;font-size:12px;line-height:1.6;color:#777;">
          <a href="${htmlEscape(unsubscribe)}" style="color:#6e6e73;">Unsubscribe from PitchProof emails</a>
        </div>
      </div>
    </div>
  `;
}

function leadFinderLaunchEmailText({ user, profile, step }) {
  const name = displayName(user, profile);
  return [
    name ? `Hi ${name},` : 'Hi,',
    '',
    'I added a new Lead Finder section inside PitchProof to help agencies find better website prospects faster.',
    '',
    'Instead of guessing who to reach out to, you can search by business type and location, review the results, and prioritize companies that look like stronger website opportunities.',
    '',
    'What you can do with Lead Finder:',
    '',
    '- Search real local businesses by niche and location',
    '- See an opportunity score out of 10',
    '- See website scan scores out of 100 after scanning',
    '- Save prospects into your PitchProof workspace',
    '- Find public contact emails from company websites',
    '- Run the website scan and turn strong prospects into client-ready reports',
    '',
    'The goal is simple: help you spend less time building prospect lists and more time starting sales conversations with businesses that have a clearer reason to care.',
    '',
    'Starter includes 3,000 Lead Finder results per month. Professional and Growth include unlimited Lead Finder results.',
    '',
    'Open it from the left sidebar in your PitchProof account, or use the link below.',
    '',
    `${step.cta}: ${ctaUrlForStep(step)}`,
    '',
    'William',
    'PitchProof',
    '',
    `Unsubscribe: ${unsubscribeUrl(user.email, LEAD_FINDER_BROADCAST_CAMPAIGN_KEY)}`,
  ].join('\n');
}

function firstMonthDiscountEmailHtml({ user, profile, step }) {
  const name = displayName(user, profile);
  const greeting = name ? `Hi ${htmlEscape(name)},` : 'Hi,';
  const accountLink = ctaUrlForStep(step);
  const unsubscribe = unsubscribeUrl(user.email, FIRST_MONTH_DISCOUNT_CAMPAIGN_KEY);
  const offerEnd = formatCampaignDate(firstMonthDiscountOfferEndMs());
  const paragraphs = [step.intro, ...(step.paragraphs || [])].filter(Boolean);
  const bullets = Array.isArray(step.bullets) ? step.bullets.filter(Boolean) : [];
  const paragraphHtml = paragraphs.map(paragraph => (
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;">${htmlEscape(paragraph)}</p>`
  )).join('');
  const bulletHtml = bullets.length
    ? `<ul style="margin:0 0 22px;padding-left:18px;font-size:15px;line-height:1.65;color:#3d3d43;">${bullets.map(item => `<li>${htmlEscape(item)}</li>`).join('')}</ul>`
    : '';

  return `
    <div style="margin:0;padding:28px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1d1d1f;">
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${htmlEscape(step.previewText)}</div>
      <div style="max-width:660px;margin:0 auto;background:#ffffff;border:1px solid #e5e5ea;border-radius:18px;overflow:hidden;box-shadow:0 18px 48px rgba(0,0,0,0.08);">
        <div style="padding:28px 30px;border-bottom:1px solid #ececf0;">
          <p style="margin:0 0 10px;color:#8a6312;text-transform:uppercase;letter-spacing:.08em;font-size:12px;font-weight:800;">PitchProof</p>
          <h1 style="margin:0;color:#1d1d1f;font-size:27px;line-height:1.18;letter-spacing:0;">${htmlEscape(step.headline)}</h1>
          <p style="margin:12px 0 0;font-size:14px;line-height:1.55;color:#6e6e73;">Only available until ${htmlEscape(offerEnd)}.</p>
        </div>
        <div style="padding:26px 30px 0;">
          <img src="${htmlEscape(firstMonthDiscountImageUrl())}" width="600" alt="PitchProof report preview showing a website assessment score and report workflow" style="display:block;width:100%;max-width:600px;height:auto;border:1px solid #e5e5ea;border-radius:16px;margin:0 auto 24px;background:#06111f;">
        </div>
        <div style="padding:0 30px 30px;">
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;">${greeting}</p>
          ${paragraphHtml}
          <div style="margin:0 0 20px;padding:16px 18px;border:1px solid #f0d47a;border-radius:14px;background:#fff8df;color:#3d3d43;font-size:14px;line-height:1.65;">
            <p style="margin:0 0 8px;font-weight:800;color:#1d1d1f;">50% off your first month</p>
            <p style="margin:0;">Use coupon code <strong style="color:#1d1d1f;">50OFFFIRSTMONTH</strong>. This offer is only available during this 7-day window.</p>
          </div>
          ${bulletHtml}
          <a href="${htmlEscape(accountLink)}" style="display:inline-block;padding:13px 18px;border-radius:12px;background:#f5c842;color:#1d1d1f;text-decoration:none;font-weight:800;">${htmlEscape(step.cta)}</a>
          <p style="margin:22px 0 0;font-size:13px;line-height:1.6;color:#6e6e73;">Offer ends ${htmlEscape(offerEnd)}. If you are already subscribed, you can ignore this email.</p>
          <p style="margin:20px 0 0;font-size:15px;line-height:1.65;color:#3d3d43;">William<br>PitchProof</p>
        </div>
        <div style="padding:18px 30px;background:#fafafa;border-top:1px solid #ececf0;font-size:12px;line-height:1.6;color:#777;">
          <a href="${htmlEscape(unsubscribe)}" style="color:#6e6e73;">Unsubscribe from PitchProof emails</a>
        </div>
      </div>
    </div>
  `;
}

function firstMonthDiscountEmailText({ user, profile, step }) {
  const name = displayName(user, profile);
  const offerEnd = formatCampaignDate(firstMonthDiscountOfferEndMs());
  const lines = [
    name ? `Hi ${name},` : 'Hi,',
    '',
    step.headline,
    '',
    step.intro,
    '',
    ...(step.paragraphs || []).flatMap(paragraph => [paragraph, '']),
    '50% off your first month',
    'Coupon code: 50OFFFIRSTMONTH',
    `Only available until ${offerEnd}.`,
    '',
  ];

  if (Array.isArray(step.bullets) && step.bullets.length) {
    lines.push(...step.bullets.map(item => `- ${item}`), '');
  }

  lines.push(
    `${step.cta}: ${ctaUrlForStep(step)}`,
    '',
    'William',
    'PitchProof',
    '',
    `Unsubscribe: ${unsubscribeUrl(user.email, FIRST_MONTH_DISCOUNT_CAMPAIGN_KEY)}`
  );

  return lines.join('\n');
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
          <p style="margin:0 0 10px;color:#8a6312;text-transform:uppercase;letter-spacing:.08em;font-size:12px;font-weight:800;">PitchProof</p>
          <h1 style="margin:0;color:#1d1d1f;font-size:26px;line-height:1.2;letter-spacing:0;">${htmlEscape(step.headline)}</h1>
        </div>
        <div style="padding:28px 30px;">
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;">${greeting}</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;">PitchProof no longer offers a free trial.</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;">You can choose a monthly plan from billing whenever you are ready.</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;">Here's my recommendation:</p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;"><strong style="color:#1d1d1f;">Don't test it on your own website.</strong></p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#3d3d43;">Pick a real prospect you're actively trying to close this week.</p>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.65;color:#3d3d43;">That's where PitchProof delivers the most value.</p>
          <a href="${htmlEscape(accountLink)}" style="display:inline-block;padding:13px 18px;border-radius:12px;background:#f5c842;color:#1d1d1f;text-decoration:none;font-weight:800;">${htmlEscape(step.cta)}</a>
        </div>
        <div style="padding:18px 30px;background:#fafafa;border-top:1px solid #ececf0;font-size:12px;line-height:1.6;color:#777;">
          <a href="${htmlEscape(unsubscribe)}" style="color:#6e6e73;">Unsubscribe from PitchProof emails</a>
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
    'PitchProof no longer offers a free trial.',
    '',
    'You can choose a monthly plan from billing whenever you are ready.',
    '',
    "Here's my recommendation:",
    '',
    "Don't test it on your own website.",
    '',
    "Pick a real prospect you're actively trying to close this week.",
    '',
    "That's where PitchProof delivers the most value.",
    '',
    `${step.cta}: ${ctaUrlForStep(step)}`,
    '',
    `Unsubscribe: ${unsubscribeUrl(user.email, TRIAL_BROADCAST_CAMPAIGN_KEY)}`,
  ].join('\n');
}

function emailHtml({ user, profile, step, campaign = step?.campaign || CAMPAIGN_KEY }) {
  if (step?.template === 'seven_day_trial_broadcast') {
    return sevenDayTrialEmailHtml({ user, profile, step });
  }
  if (step?.template === 'ai_visibility_coming_soon_broadcast') {
    return aiVisibilityComingSoonEmailHtml({ user, profile, step });
  }
  if (step?.template === 'client_list_acquisition_broadcast') {
    return clientListAcquisitionEmailHtml({ user, profile, step });
  }
  if (step?.template === 'lead_finder_launch_broadcast') {
    return leadFinderLaunchEmailHtml({ user, profile, step });
  }
  if (step?.template === 'first_month_discount_sequence') {
    return firstMonthDiscountEmailHtml({ user, profile, step });
  }

  const name = displayName(user, profile);
  const greeting = name ? `Hi ${htmlEscape(name)},` : 'Hi,';
  const unsubscribe = unsubscribeUrl(user.email, campaign);
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
          <p style="margin:0 0 10px;color:#8a6312;text-transform:uppercase;letter-spacing:.08em;font-size:12px;font-weight:800;">PitchProof</p>
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
          <a href="${unsubscribe}" style="color:#6e6e73;">Unsubscribe from PitchProof emails</a>
        </div>
      </div>
    </div>
  `;
}

function emailText({ user, profile, step, campaign = step?.campaign || CAMPAIGN_KEY }) {
  if (step?.template === 'seven_day_trial_broadcast') {
    return sevenDayTrialEmailText({ user, profile, step });
  }
  if (step?.template === 'ai_visibility_coming_soon_broadcast') {
    return aiVisibilityComingSoonEmailText({ user, profile, step });
  }
  if (step?.template === 'client_list_acquisition_broadcast') {
    return clientListAcquisitionEmailText({ user, profile, step });
  }
  if (step?.template === 'lead_finder_launch_broadcast') {
    return leadFinderLaunchEmailText({ user, profile, step });
  }
  if (step?.template === 'first_month_discount_sequence') {
    return firstMonthDiscountEmailText({ user, profile, step });
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
    `Unsubscribe: ${unsubscribeUrl(user.email, campaign)}`,
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
    html: emailHtml({ user, profile, step, campaign }),
    text: emailText({ user, profile, step, campaign }),
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
        console.warn('[PitchProof] Lifecycle email failure could not be recorded:', recordError?.message || recordError);
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

async function runAbandonedCartCampaign(options = {}) {
  const dryRun = options.dryRun === true;
  const limit = maxPerRun(options.limit);
  const campaign = ABANDONED_CART_CAMPAIGN_KEY;
  if (outboundEmailsPaused() && !dryRun) {
    return pausedCampaignResult({ dryRun, campaign, skipped: { emails_paused: true } });
  }

  if (!billing.abandonedCartDiscountConfigured() && !dryRun) {
    return pausedCampaignResult({ dryRun, campaign, skipped: { abandoned_cart_discount_not_configured: true } });
  }

  const users = await listAuthUsers();

  let subscriptions;
  let profiles;
  let events;
  let unsubscribes;
  try {
    [subscriptions, profiles, events, unsubscribes] = await Promise.all([
      listRestRows('subscriptions', { select: 'user_id,status,subscription_status,stripe_customer_id,stripe_subscription_id,plan,created_at,updated_at' }),
      listRestRows('profiles', { select: 'id,email,full_name,agency_name' }),
      listRestRows('lifecycle_email_events', { select: 'email,campaign,step,status', campaign: `eq.${campaign}`, status: 'eq.sent' }),
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
    deleted_user: 0,
    no_subscription: 0,
    not_checkout_started: 0,
    already_subscribed: 0,
    unsubscribed: 0,
    no_step_due: 0,
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
    if (unsubscribed.has(unsubscribeKey(email, campaign)) || unsubscribed.has(unsubscribeKey(email, 'all'))) {
      skipped.unsubscribed += 1;
      return;
    }

    const subscription = subscriptionByUser.get(user.id);
    if (!subscription) {
      skipped.no_subscription += 1;
      return;
    }
    if (!subscriptionLooksUnpaid(subscription)) {
      skipped.already_subscribed += 1;
      return;
    }
    if (!subscriptionLooksAbandonedCart(subscription)) {
      skipped.not_checkout_started += 1;
      return;
    }

    const sentSteps = sentByEmail.get(email) || new Set();
    const step = chooseNextCartStep(subscription, sentSteps, user);
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

  candidates.sort((a, b) => new Date(a.subscription.updated_at || a.subscription.created_at || 0) - new Date(b.subscription.updated_at || b.subscription.created_at || 0));
  const selected = candidates.slice(0, limit);
  const sent = [];
  const failed = [];

  for (const candidate of selected) {
    if (dryRun) {
      sent.push({
        email: candidate.user.email,
        user_id: candidate.user.id,
        plan: candidate.subscription?.plan || '',
        step: candidate.step.key,
        delay_minutes: candidate.step.delayMinutes,
        checkout_updated_at: candidate.subscription?.updated_at || null,
        test_mode: candidate.step.testMode === true,
        dry_run: true,
      });
      continue;
    }

    try {
      const delivery = await sendLifecycleEmail({
        user: candidate.user,
        profile: candidate.profile,
        step: candidate.step,
        campaign,
      });
      await recordEmailEvent({
        user: candidate.user,
        step: candidate.step,
        campaign,
        providerId: delivery.id || '',
        metadata: {
          plan: candidate.subscription?.plan || '',
          checkout_updated_at: candidate.subscription?.updated_at || null,
          subscription_status: candidate.subscription?.status || null,
          delay_minutes: candidate.step.delayMinutes,
          test_mode: candidate.step.testMode === true,
          cta_url: ctaUrlForStep(candidate.step),
        },
      });
      sent.push({
        email: candidate.user.email,
        user_id: candidate.user.id,
        plan: candidate.subscription?.plan || '',
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
          campaign,
          status: 'failed',
          providerId: failedProviderId,
          errorMessage: error?.message || 'Email failed.',
          metadata: {
            plan: candidate.subscription?.plan || '',
            checkout_updated_at: candidate.subscription?.updated_at || null,
            subscription_status: candidate.subscription?.status || null,
            delay_minutes: candidate.step.delayMinutes,
            test_mode: candidate.step.testMode === true,
            error_code: error?.code || 'email_failed',
          },
        });
        failureRecorded = true;
      } catch (recordError) {
        console.warn('[PitchProof] Abandoned cart email failure could not be recorded:', recordError?.message || recordError);
      }
      failed.push({
        email: candidate.user.email,
        user_id: candidate.user.id,
        plan: candidate.subscription?.plan || '',
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
    campaign,
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

async function runIncompleteAccountOfferCampaign(options = {}) {
  const dryRun = options.dryRun === true;
  const limit = maxPerRun(options.limit);
  const campaign = INCOMPLETE_ACCOUNT_OFFER_CAMPAIGN_KEY;
  if (outboundEmailsPaused() && !dryRun) {
    return pausedCampaignResult({ dryRun, campaign, skipped: { emails_paused: true } });
  }

  if (!billing.abandonedCartDiscountConfigured() && !dryRun) {
    return pausedCampaignResult({ dryRun, campaign, skipped: { abandoned_cart_discount_not_configured: true } });
  }

  const users = await listAuthUsers();

  let subscriptions;
  let profiles;
  let events;
  let unsubscribes;
  try {
    [subscriptions, profiles, events, unsubscribes] = await Promise.all([
      listRestRows('subscriptions', { select: 'user_id,status,subscription_status,stripe_customer_id,stripe_subscription_id,plan,created_at,updated_at' }),
      listRestRows('profiles', { select: 'id,email,full_name,agency_name' }),
      listRestRows('lifecycle_email_events', { select: 'email,campaign,step,status', campaign: `eq.${campaign}`, status: 'eq.sent' }),
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
    deleted_user: 0,
    checkout_started: 0,
    already_subscribed: 0,
    unsubscribed: 0,
    no_step_due: 0,
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
    if (unsubscribed.has(unsubscribeKey(email, campaign)) || unsubscribed.has(unsubscribeKey(email, 'all'))) {
      skipped.unsubscribed += 1;
      return;
    }

    const subscription = subscriptionByUser.get(user.id);
    if (subscriptionLooksAbandonedCart(subscription)) {
      skipped.checkout_started += 1;
      return;
    }
    if (!subscriptionLooksUnpaid(subscription)) {
      skipped.already_subscribed += 1;
      return;
    }

    const sentSteps = sentByEmail.get(email) || new Set();
    const step = chooseNextIncompleteAccountOfferStep(user, sentSteps);
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
        plan: candidate.subscription?.plan || '',
        step: candidate.step.key,
        delay_minutes: candidate.step.delayMinutes,
        signup_created_at: candidate.user.created_at || null,
        test_mode: candidate.step.testMode === true,
        dry_run: true,
      });
      continue;
    }

    try {
      const delivery = await sendLifecycleEmail({
        user: candidate.user,
        profile: candidate.profile,
        step: candidate.step,
        campaign,
      });
      await recordEmailEvent({
        user: candidate.user,
        step: candidate.step,
        campaign,
        providerId: delivery.id || '',
        metadata: {
          plan: candidate.subscription?.plan || '',
          signup_created_at: candidate.user.created_at || null,
          subscription_status: candidate.subscription?.status || null,
          delay_minutes: candidate.step.delayMinutes,
          test_mode: candidate.step.testMode === true,
          cta_url: ctaUrlForStep(candidate.step),
        },
      });
      sent.push({
        email: candidate.user.email,
        user_id: candidate.user.id,
        plan: candidate.subscription?.plan || '',
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
          campaign,
          status: 'failed',
          providerId: failedProviderId,
          errorMessage: error?.message || 'Email failed.',
          metadata: {
            plan: candidate.subscription?.plan || '',
            signup_created_at: candidate.user.created_at || null,
            subscription_status: candidate.subscription?.status || null,
            delay_minutes: candidate.step.delayMinutes,
            test_mode: candidate.step.testMode === true,
            error_code: error?.code || 'email_failed',
          },
        });
        failureRecorded = true;
      } catch (recordError) {
        console.warn('[PitchProof] Incomplete account offer failure could not be recorded:', recordError?.message || recordError);
      }
      failed.push({
        email: candidate.user.email,
        user_id: candidate.user.id,
        plan: candidate.subscription?.plan || '',
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
    campaign,
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

async function loadBroadcastRecipients({ campaign = TRIAL_BROADCAST_CAMPAIGN_KEY, stepKey = TRIAL_BROADCAST_STEP_KEY, includeSubscribed = false } = {}) {
  const users = await listAuthUsers();

  let profiles;
  let subscriptions;
  let events;
  let unsubscribes;
  try {
    [profiles, subscriptions, events, unsubscribes] = await Promise.all([
      listRestRows('profiles', { select: 'id,email,full_name,agency_name' }),
      listRestRows('subscriptions', { select: 'user_id,status,subscription_status,stripe_customer_id,stripe_subscription_id,plan' }),
      listRestRows('lifecycle_email_events', { select: 'email,campaign,step,status', campaign: `eq.${campaign}`, step: `eq.${stepKey}`, status: 'in.(sent,failed)' }),
      listRestRows('lifecycle_email_unsubscribes', { select: 'email,campaign' }),
    ]);
  } catch (error) {
    throw lifecycleSchemaError(error);
  }

  const profileByUser = new Map((profiles || []).map(row => [row.id, row]));
  const subscriptionByUser = new Map((subscriptions || []).map(row => [row.user_id, row]));
  const sentEmails = new Set((events || []).filter(row => row.status === 'sent').map(row => normalizeEmail(row.email)));
  const failedEmails = new Set((events || []).filter(row => row.status === 'failed').map(row => normalizeEmail(row.email)));
  const unsubscribed = new Set((unsubscribes || []).map(row => unsubscribeKey(row.email, row.campaign)));
  const seenEmails = new Set();
  const recipients = [];
  const skipped = {
    missing_email: 0,
    deleted_user: 0,
    duplicate_email: 0,
    unsubscribed: 0,
    already_sent: 0,
    already_failed: 0,
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
    if (failedEmails.has(email)) {
      skipped.already_failed += 1;
      return;
    }
    if (!includeSubscribed && !subscriptionLooksUnpaid(subscriptionByUser.get(user.id))) {
      skipped.already_subscribed += 1;
      return;
    }

    recipients.push({
      user: { ...user, email },
      profile: profileByUser.get(user.id) || null,
      subscription: subscriptionByUser.get(user.id) || null,
    });
  });

  recipients.sort((a, b) => new Date(a.user.created_at || 0) - new Date(b.user.created_at || 0));
  return { users, recipients, skipped };
}

function broadcastConfirmValue(value = '') {
  return cleanText(value).toLowerCase();
}

async function runSevenDayTrialBroadcast(options = {}) {
  throw billing.httpError(
    410,
    'Seven-day trial broadcasts are disabled because PitchProof no longer offers a free trial.',
    'trial_broadcast_disabled'
  );

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
        console.warn('[PitchProof] Broadcast email failure could not be recorded:', recordError?.message || recordError);
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

async function runAiVisibilityComingSoonBroadcast(options = {}) {
  const dryRun = options.dryRun !== false;
  const limit = broadcastMaxPerRun(options.limit);
  const campaign = AI_VISIBILITY_BROADCAST_CAMPAIGN_KEY;
  const step = aiVisibilityComingSoonBroadcastStep;
  const requiredConfirm = 'send-ai-visibility-coming-soon';

  if (!dryRun && broadcastConfirmValue(options.confirm) !== requiredConfirm) {
    throw billing.httpError(
      400,
      `Broadcast send requires confirm="${requiredConfirm}".`,
      'broadcast_confirmation_required'
    );
  }

  const { users, recipients, skipped } = await loadBroadcastRecipients({
    campaign,
    stepKey: step.key,
    includeSubscribed: true,
  });
  const selected = recipients.slice(0, limit);
  const deliveries = [];
  const failures = [];

  for (const recipient of selected) {
    const emailStep = aiVisibilityBroadcastStepForSubscription(recipient.subscription);
    const ctaUrl = ctaUrlForStep(emailStep);

    if (dryRun) {
      deliveries.push({
        email: recipient.user.email,
        user_id: recipient.user.id,
        first_name: displayName(recipient.user, recipient.profile),
        step: emailStep.key,
        cta_url: ctaUrl,
        offer_included: emailStep.showNonSubscriberOffer === true,
        dry_run: true,
      });
      continue;
    }

    try {
      const delivery = await sendLifecycleEmail({
        user: recipient.user,
        profile: recipient.profile,
        step: emailStep,
        campaign,
        ignorePause: true,
      });
      await recordEmailEvent({
        user: recipient.user,
        step: emailStep,
        campaign,
        providerId: delivery.id || '',
        metadata: {
          broadcast: true,
          cta_url: ctaUrl,
          offer_included: emailStep.showNonSubscriberOffer === true,
          source: 'ai_visibility_coming_soon_broadcast',
        },
      });
      deliveries.push({
        email: recipient.user.email,
        user_id: recipient.user.id,
        first_name: displayName(recipient.user, recipient.profile),
        step: emailStep.key,
        cta_url: ctaUrl,
        offer_included: emailStep.showNonSubscriberOffer === true,
        provider_message_id: delivery.id || '',
      });
    } catch (error) {
      const failedProviderId = error?.details?.id || error?.details?.message_id || error?.details?.provider_message_id || '';
      let failureRecorded = false;
      try {
        await recordEmailEvent({
          user: recipient.user,
          step: emailStep,
          campaign,
          status: 'failed',
          providerId: failedProviderId,
          errorMessage: error?.message || 'Email failed.',
          metadata: {
            broadcast: true,
            cta_url: ctaUrl,
            offer_included: emailStep.showNonSubscriberOffer === true,
            source: 'ai_visibility_coming_soon_broadcast',
            error_code: error?.code || 'email_failed',
          },
        });
        failureRecorded = true;
      } catch (recordError) {
        console.warn('[PitchProof] AI Visibility broadcast failure could not be recorded:', recordError?.message || recordError);
      }
      failures.push({
        email: recipient.user.email,
        user_id: recipient.user.id,
        first_name: displayName(recipient.user, recipient.profile),
        step: emailStep.key,
        cta_url: ctaUrl,
        offer_included: emailStep.showNonSubscriberOffer === true,
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
    cta_url: ctaUrlForStep(step),
    non_subscriber_cta_url: aiVisibilitySignupOfferUrl(),
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

async function runClientListAcquisitionBroadcast(options = {}) {
  const dryRun = options.dryRun !== false;
  const limit = broadcastMaxPerRun(options.limit);
  const campaign = CLIENT_LIST_ACQUISITION_BROADCAST_CAMPAIGN_KEY;
  const step = clientListAcquisitionBroadcastStep;
  const requiredConfirm = 'send-client-list-acquisition';

  if (!dryRun && broadcastConfirmValue(options.confirm) !== requiredConfirm) {
    throw billing.httpError(
      400,
      `Broadcast send requires confirm="${requiredConfirm}".`,
      'broadcast_confirmation_required'
    );
  }

  const { users, recipients, skipped } = await loadBroadcastRecipients({
    campaign,
    stepKey: step.key,
    includeSubscribed: true,
  });
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
          source: 'client_list_acquisition_broadcast',
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
            source: 'client_list_acquisition_broadcast',
            error_code: error?.code || 'email_failed',
          },
        });
        failureRecorded = true;
      } catch (recordError) {
        console.warn('[PitchProof] Client list acquisition broadcast failure could not be recorded:', recordError?.message || recordError);
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

async function runLeadFinderLaunchBroadcast(options = {}) {
  const dryRun = options.dryRun !== false;
  const limit = broadcastMaxPerRun(options.limit);
  const campaign = LEAD_FINDER_BROADCAST_CAMPAIGN_KEY;
  const step = leadFinderBroadcastStep;
  const requiredConfirm = 'send-lead-finder-launch';
  const ctaUrl = leadFinderUrl();

  if (!dryRun && broadcastConfirmValue(options.confirm) !== requiredConfirm) {
    throw billing.httpError(
      400,
      `Broadcast send requires confirm="${requiredConfirm}".`,
      'broadcast_confirmation_required'
    );
  }

  const { users, recipients, skipped } = await loadBroadcastRecipients({
    campaign,
    stepKey: step.key,
    includeSubscribed: true,
  });
  const selected = recipients.slice(0, limit);
  const { deliveries, failures } = await deliverBroadcastStep({
    dryRun,
    selected,
    step,
    campaign,
    source: 'lead_finder_launch_broadcast',
    ctaUrl,
  });

  return {
    ok: failures.length === 0,
    dryRun,
    pausedOtherEmails: outboundEmailsPaused(),
    pauseBypassedForBroadcastSend: !dryRun,
    campaign,
    step: step.key,
    subject: step.subject,
    cta_url: ctaUrl,
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

function firstMonthDiscountDueSteps(options = {}) {
  const startMs = firstMonthDiscountStartMs(options.startAt);
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const sendUntilMs = firstMonthDiscountSendUntilMs(startMs);
  if (nowMs > sendUntilMs) return { startMs, nowMs, sendUntilMs, dueSteps: [], campaignExpired: true };

  return {
    startMs,
    nowMs,
    sendUntilMs,
    campaignExpired: false,
    dueSteps: firstMonthDiscountSequenceSteps.filter(step => nowMs >= startMs + (Number(step.delayMinutes) || 0) * 60 * 1000),
  };
}

async function deliverBroadcastStep({ dryRun, selected, step, campaign, source, ctaUrl }) {
  const deliveries = [];
  const failures = [];

  for (const recipient of selected) {
    if (dryRun) {
      deliveries.push({
        email: recipient.user.email,
        user_id: recipient.user.id,
        first_name: displayName(recipient.user, recipient.profile),
        step: step.key,
        cta_url: ctaUrl,
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
          cta_url: ctaUrl,
          source,
        },
      });
      deliveries.push({
        email: recipient.user.email,
        user_id: recipient.user.id,
        first_name: displayName(recipient.user, recipient.profile),
        step: step.key,
        cta_url: ctaUrl,
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
            cta_url: ctaUrl,
            source,
            error_code: error?.code || 'email_failed',
          },
        });
        failureRecorded = true;
      } catch (recordError) {
        console.warn('[PitchProof] Discount sequence failure could not be recorded:', recordError?.message || recordError);
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

  return { deliveries, failures };
}

async function runFirstMonthDiscountSequenceBroadcast(options = {}) {
  const dryRun = options.dryRun !== false;
  const limit = broadcastMaxPerRun(options.limit);
  const campaign = FIRST_MONTH_DISCOUNT_CAMPAIGN_KEY;
  const requiredConfirm = 'send-first-month-discount-sequence';
  const ctaUrl = firstMonthDiscountOfferUrl();
  const { startMs, nowMs, sendUntilMs, dueSteps, campaignExpired } = firstMonthDiscountDueSteps(options);

  if (!dryRun && broadcastConfirmValue(options.confirm) !== requiredConfirm) {
    throw billing.httpError(
      400,
      `Broadcast send requires confirm="${requiredConfirm}".`,
      'broadcast_confirmation_required'
    );
  }

  const notDueSteps = firstMonthDiscountSequenceSteps
    .filter(step => !dueSteps.some(dueStep => dueStep.key === step.key))
    .map(step => ({
      step: step.key,
      subject: step.subject,
      due_at: new Date(startMs + (Number(step.delayMinutes) || 0) * 60 * 1000).toISOString(),
    }));

  let users = [];
  let skipped = {};
  let processedStep = null;
  let recipients = [];
  const stepSummaries = [];

  if (!campaignExpired) {
    for (const step of dueSteps) {
      const loaded = await loadBroadcastRecipients({ campaign, stepKey: step.key });
      users = loaded.users;
      skipped = loaded.skipped;
      recipients = loaded.recipients;
      stepSummaries.push({
        step: step.key,
        subject: step.subject,
        eligible: recipients.length,
        due_at: new Date(startMs + (Number(step.delayMinutes) || 0) * 60 * 1000).toISOString(),
      });
      if (recipients.length > 0) {
        processedStep = step;
        break;
      }
    }
  }

  const selected = processedStep ? recipients.slice(0, limit) : [];
  const { deliveries, failures } = processedStep
    ? await deliverBroadcastStep({
        dryRun,
        selected,
        step: processedStep,
        campaign,
        source: 'first_month_50_sequence',
        ctaUrl,
      })
    : { deliveries: [], failures: [] };

  return {
    ok: failures.length === 0,
    dryRun,
    pausedOtherEmails: outboundEmailsPaused(),
    pauseBypassedForBroadcastSend: !dryRun && selected.length > 0,
    campaign,
    step: processedStep?.key || '',
    subject: processedStep?.subject || '',
    cta_url: ctaUrl,
    coupon_code: '50OFFFIRSTMONTH',
    offer_ends_at: new Date(firstMonthDiscountOfferEndMs(startMs)).toISOString(),
    campaign_start_at: new Date(startMs).toISOString(),
    campaign_send_until: new Date(sendUntilMs).toISOString(),
    campaign_expired: campaignExpired,
    scanned_users: users.length,
    eligible: recipients.length,
    selected: selected.length,
    sent: dryRun ? 0 : deliveries.length,
    would_send: dryRun ? deliveries.length : 0,
    failed: failures.length,
    remaining_after_run: Math.max(0, recipients.length - selected.length),
    skipped,
    due_steps: stepSummaries,
    not_due_steps: notDueSteps,
    sample_recipients: deliveries.slice(0, 20),
    deliveries: dryRun ? [] : deliveries,
    failures,
  };
}

module.exports = {
  CAMPAIGN_KEY,
  ABANDONED_CART_CAMPAIGN_KEY,
  INCOMPLETE_ACCOUNT_OFFER_CAMPAIGN_KEY,
  TRIAL_BROADCAST_CAMPAIGN_KEY,
  TRIAL_BROADCAST_STEP_KEY,
  AI_VISIBILITY_BROADCAST_CAMPAIGN_KEY,
  AI_VISIBILITY_BROADCAST_STEP_KEY,
  CLIENT_LIST_ACQUISITION_BROADCAST_CAMPAIGN_KEY,
  CLIENT_LIST_ACQUISITION_BROADCAST_STEP_KEY,
  LEAD_FINDER_BROADCAST_CAMPAIGN_KEY,
  LEAD_FINDER_BROADCAST_STEP_KEY,
  FIRST_MONTH_DISCOUNT_CAMPAIGN_KEY,
  LIFECYCLE_CAMPAIGNS,
  abandonedSignupSteps,
  abandonedCartSteps,
  incompleteAccountOfferSteps,
  sevenDayTrialBroadcastStep,
  aiVisibilityComingSoonBroadcastStep,
  clientListAcquisitionBroadcastStep,
  leadFinderBroadcastStep,
  firstMonthDiscountSequenceSteps,
  envFlag,
  runAbandonedSignupCampaign,
  runAbandonedCartCampaign,
  runIncompleteAccountOfferCampaign,
  runSevenDayTrialBroadcast,
  runAiVisibilityComingSoonBroadcast,
  runClientListAcquisitionBroadcast,
  runLeadFinderLaunchBroadcast,
  runFirstMonthDiscountSequenceBroadcast,
  tokenFor,
  unsubscribe,
  verifyToken,
};
