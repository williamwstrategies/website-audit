const crypto = require('crypto');
const billing = require('./billing');
const lifecycleEmails = require('./lifecycle-emails');

const EXPERIMENT_KEY = 'pitchproof_reactivation_2026_09';
const VARIANT_FREE_SCANS = 'reactivation_free_scans';
const VARIANT_DISCOUNT_MONTH = 'reactivation_discount_month';
const VARIANTS = [VARIANT_FREE_SCANS, VARIANT_DISCOUNT_MONTH];
const FREE_SCAN_GRANT_SIZE = 10;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 1000;

const REACTIVATION_STEPS = {
  [VARIANT_FREE_SCANS]: [
    {
      key: 'free_scans_1_intro',
      delayMinutes: 0,
      subject: 'I added 10 free prospect scans to your account',
      previewText: 'No card needed. Use them on real prospects when you are ready.',
      headline: '10 free prospect scans are waiting.',
      paragraphs: [
        'I added 10 free PitchProof prospect scans to your account. No card is required.',
        'Use them on real businesses you would actually want to pitch, then turn the findings into a stronger reason to start the conversation.',
        'The scans are tracked separately from paid monthly credits, and this is a one-time reactivation offer.',
      ],
      bullets: [
        'Run 10 website assessments without subscribing',
        'Save reports in your workspace',
        'Find clearer sales talking points before outreach',
        'Upgrade later only when you are ready',
      ],
      cta: 'Use My 10 Free Scans',
    },
    {
      key: 'free_scans_2_prospect',
      delayMinutes: 4320,
      subject: 'Use the free scans on prospects, not your own website',
      previewText: 'PitchProof is strongest when it gives you a reason to reach out.',
      headline: 'The value is in the sales conversation.',
      paragraphs: [
        'Quick suggestion: do not burn your free scans on your own website.',
        'Pick a prospect from your pipeline. The report is much more useful when it helps you show a business where their website is leaking trust, leads, or conversion opportunities.',
        'That gives you a practical reason to follow up without sounding generic.',
      ],
      bullets: [
        'Website score out of 100',
        'Priority fixes',
        'Conversion recommendations',
        'Client-ready report structure',
      ],
      cta: 'Scan a Prospect',
    },
    {
      key: 'free_scans_3_sales_call',
      delayMinutes: 10080,
      subject: 'One scan can change the sales call',
      previewText: 'Open the conversation with evidence instead of opinion.',
      headline: 'Show the problem before pitching the fix.',
      paragraphs: [
        'The strongest website sales conversations usually start with evidence.',
        'PitchProof gives you a clean assessment you can use before a call, during a proposal, or as a follow-up after outreach.',
        'You still have the free prospect scan offer available in your account.',
      ],
      bullets: [
        'Look more prepared',
        'Create better follow-up',
        'Give prospects a clearer reason to act',
        'Spend less time manually reviewing websites',
      ],
      cta: 'Run a Free Prospect Scan',
    },
    {
      key: 'free_scans_4_waiting',
      delayMinutes: 20160,
      subject: 'Your 10 free PitchProof scans are still there',
      previewText: 'A simple way to restart outreach with better proof.',
      headline: 'Your prospect scans are still available.',
      paragraphs: [
        'If timing was the issue, no problem. Your one-time 10-scan reactivation offer is still attached to your account.',
        'Use it when you want to build a better reason to email, call, or follow up with a business whose website has obvious room to improve.',
      ],
      bullets: [
        'No subscription required for the 10 promotional scans',
        'No card required',
        'Separate from paid monthly scan credits',
        'Built for agency prospecting',
      ],
      cta: 'Open My Free Scans',
    },
    {
      key: 'free_scans_5_final',
      delayMinutes: 30240,
      subject: 'Final nudge on the 10 free scans',
      previewText: 'Use them to find your next website project.',
      headline: 'Last nudge on the free scan offer.',
      paragraphs: [
        'This is the last note I will send about the 10 free reactivation scans.',
        'If you want a simple way to restart prospecting, use them on businesses you could realistically contact this month.',
        'The goal is not to run more audits. The goal is to create better sales conversations.',
      ],
      bullets: [
        '10 one-time promotional scans',
        'Professional reports',
        'Clear website opportunities',
        'Upgrade only when the workflow makes sense',
      ],
      cta: 'Use the Free Scans',
    },
  ],
  [VARIANT_DISCOUNT_MONTH]: [
    {
      key: 'discount_1_intro',
      delayMinutes: 0,
      subject: 'Try PitchProof for $10 this month',
      previewText: 'Get your first month for $10, then continue at normal pricing.',
      headline: 'Your first month is $10.',
      paragraphs: [
        'I opened a reactivation offer for your PitchProof account: your first month is $10, then your plan renews at normal pricing.',
        'There is no trial and no delayed billing. If you choose the offer, Stripe charges the discounted first month immediately.',
        'Use the month to build reports for real prospects and see whether it helps you create stronger website sales conversations.',
      ],
      bullets: [
        '$10 first month',
        'Professional plan access',
        'Website reports and PDF exports',
        'Lead Finder and saved reports',
      ],
      cta: 'Start for $10',
    },
    {
      key: 'discount_2_one_project',
      delayMinutes: 4320,
      subject: 'One website project more than covers this',
      previewText: 'Use PitchProof to make the problem easier for prospects to understand.',
      headline: 'One closed project changes the math.',
      paragraphs: [
        'If PitchProof helps you close even one website project, the $10 first month is a tiny test.',
        'The reports make it easier to show why a website needs work, where the biggest issues are, and what should happen next.',
        'That is a much stronger follow-up than a generic "your website needs improvement" message.',
      ],
      bullets: [
        'Show website health clearly',
        'Turn issues into recommendations',
        'Use reports in outreach and proposals',
        'Look more prepared before every call',
      ],
      cta: 'Claim the $10 Month',
    },
    {
      key: 'discount_3_proposal',
      delayMinutes: 10080,
      subject: 'Use a report before your next proposal',
      previewText: 'Give prospects context before you ask them to buy.',
      headline: 'Make the proposal easier to believe.',
      paragraphs: [
        'A prospect is more likely to understand your proposal when they can see the website problems first.',
        'PitchProof helps frame those problems in plain language with scores, priorities, recommendations, and a client-ready structure.',
        'Your $10 first-month offer is still available.',
      ],
      bullets: [
        'Professional website assessments',
        'PDF exports',
        'Shareable report links',
        'White-label branding on eligible plans',
      ],
      cta: 'Start for $10',
    },
    {
      key: 'discount_4_push',
      delayMinutes: 20160,
      subject: 'The $10 PitchProof offer is still open',
      previewText: 'A lower-friction way to try the full workflow.',
      headline: 'Use the full workflow for $10.',
      paragraphs: [
        'The point of PitchProof is simple: help agencies make website problems visible before pitching the solution.',
        'For this reactivation offer, you can use your first month for $10 and decide from real prospect reports whether it belongs in your sales process.',
        'After the first month, your subscription continues at normal pricing unless you cancel.',
      ],
      bullets: [
        'Run real website reports',
        'Save and share assessments',
        'Export PDFs',
        'Use agency-ready report structure',
      ],
      cta: 'Use the $10 Offer',
    },
    {
      key: 'discount_5_final',
      delayMinutes: 30240,
      subject: 'Final call: your $10 first month',
      previewText: 'Last reminder for the reactivation discount.',
      headline: 'Last reminder for the $10 month.',
      paragraphs: [
        'This is my final reminder about the $10 first-month reactivation offer.',
        'If you want to test PitchProof properly, use it on a few real prospects and see whether the reports help you start better conversations.',
        'The software is built for agencies that want to show proof, not just opinions.',
      ],
      bullets: [
        '$10 first month',
        'No free trial delay',
        'Normal pricing after the first month',
        'Cancel from billing if it is not useful',
      ],
      cta: 'Claim the $10 Month',
    },
  ],
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

function envFlag(name, defaultValue = false) {
  const raw = cleanText(process.env[name]);
  if (!raw) return defaultValue;
  return /^(1|true|yes|on)$/i.test(raw);
}

function dryRunDefault() {
  const raw = cleanText(process.env.REACTIVATION_AB_TEST_DRY_RUN);
  if (!raw) return true;
  return !/^(0|false|no|off)$/i.test(raw);
}

function experimentEnabled() {
  return envFlag('REACTIVATION_AB_TEST_ENABLED', false);
}

function limitFrom(value, fallback = DEFAULT_LIMIT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(MAX_LIMIT, Math.floor(parsed));
}

function appUrl() {
  return cleanText(process.env.APP_URL || process.env.PUBLIC_APP_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

function tokenFor(email) {
  return lifecycleEmails.tokenFor(email, EXPERIMENT_KEY);
}

function clickUrlForStep(user, step) {
  const url = new URL(`${appUrl()}/api/reactivation/click`);
  url.searchParams.set('email', normalizeEmail(user.email));
  url.searchParams.set('step', step.key);
  url.searchParams.set('token', tokenFor(user.email));
  return url.toString();
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

function deterministicVariantForUser(userId, experimentKey = EXPERIMENT_KEY) {
  const hash = crypto.createHash('sha256').update(`${experimentKey}:${cleanText(userId)}`).digest();
  return hash.readUInt32BE(0) % 2 === 0 ? VARIANT_FREE_SCANS : VARIANT_DISCOUNT_MONTH;
}

function variantSteps(variant) {
  return REACTIVATION_STEPS[variant] || [];
}

function plannedActionForVariant(variant) {
  if (variant === VARIANT_FREE_SCANS) {
    return {
      type: 'grant_promotional_scans',
      scans: FREE_SCAN_GRANT_SIZE,
      card_required: false,
      charged_immediately: false,
    };
  }
  return {
    type: 'stripe_checkout_discount',
    plan: billing.PROFESSIONAL_PLAN.key,
    first_month_price: '$10',
    trial: false,
    charged_immediately: true,
  };
}

function subscriptionEligible(subscription) {
  if (!subscription) return true;
  const status = cleanText(subscription.status || subscription.subscription_status).toLowerCase();
  if (subscription.stripe_subscription_id) return false;
  return !status || ['incomplete', 'incomplete_expired', 'cancelled', 'canceled'].includes(status);
}

function splitList(value = '') {
  return cleanText(value)
    .split(/[\s,]+/)
    .map(item => cleanText(item).toLowerCase())
    .filter(Boolean);
}

function excludedEmailSet() {
  return new Set([
    'hallpwj@gmail.com',
    ...splitList(process.env.REACTIVATION_AB_TEST_EXCLUDED_EMAILS),
  ]);
}

function incompatibleCampaignSet() {
  return new Set(splitList(process.env.REACTIVATION_AB_TEST_INCOMPATIBLE_CAMPAIGNS));
}

function emailLooksInternalOrTest(email) {
  const clean = normalizeEmail(email);
  if (!clean) return true;
  if (excludedEmailSet().has(clean)) return true;
  const [local = '', domain = ''] = clean.split('@');
  if (domain === 'pitchproof.ca' || domain === 'wstrategiescanada.ca' || domain === 'wstrategies.ca') return true;
  return /(^|[.+_-])test([.+_-]|$)/i.test(local);
}

function unsubscribeKey(email, campaign) {
  return `${normalizeEmail(email)}:${campaign}`;
}

function campaignAgeMinutes(enrollment) {
  const assignedAt = new Date(enrollment.assigned_at || enrollment.created_at || '');
  if (!Number.isFinite(assignedAt.getTime())) return 0;
  return (Date.now() - assignedAt.getTime()) / 60000;
}

function stepAlreadySent(step, sentSteps) {
  return sentSteps.has(step.key);
}

function chooseNextEmailStep(enrollment, sentSteps) {
  const age = campaignAgeMinutes(enrollment);
  return variantSteps(enrollment.variant).find(step => age >= step.delayMinutes && !stepAlreadySent(step, sentSteps)) || null;
}

async function loadExperimentDataset() {
  const users = await listAuthUsers();
  const incompatibleCampaigns = incompatibleCampaignSet();
  let subscriptions;
  let profiles;
  let enrollments;
  let unsubscribes;
  let suppressions;
  let incompatibleEvents;
  try {
    [subscriptions, profiles, enrollments, unsubscribes, suppressions, incompatibleEvents] = await Promise.all([
      listRestRows('subscriptions', { select: 'user_id,email,status,subscription_status,stripe_customer_id,stripe_subscription_id,plan,created_at,updated_at' }),
      listRestRows('profiles', { select: 'id,email,full_name,agency_name' }),
      listRestRows('reactivation_experiment_enrollments', { select: '*' }),
      listRestRows('lifecycle_email_unsubscribes', { select: 'email,campaign' }),
      listRestRows('reactivation_experiment_suppressions', { select: 'user_id,email,experiment_key,reason' }),
      incompatibleCampaigns.size
        ? listRestRows('lifecycle_email_events', { select: 'user_id,email,campaign,status', status: 'eq.sent' })
        : Promise.resolve([]),
    ]);
  } catch (error) {
    if (error?.details?.code === '42P01' || /reactivation_/i.test(error?.message || '')) {
      throw billing.httpError(
        503,
        'Reactivation experiment tables are not installed yet. Run supabase/reactivation-ab-test.sql in Supabase SQL Editor.',
        'reactivation_schema_missing',
        error.details || null
      );
    }
    throw error;
  }

  return {
    users,
    subscriptionByUser: new Map((subscriptions || []).map(row => [row.user_id, row])),
    profileByUser: new Map((profiles || []).map(row => [row.id, row])),
    enrollmentByUser: new Map((enrollments || [])
      .filter(row => row.experiment_key === EXPERIMENT_KEY)
      .map(row => [row.user_id, row])),
    unsubscribed: new Set((unsubscribes || []).map(row => unsubscribeKey(row.email, row.campaign))),
    suppressedUserIds: new Set((suppressions || [])
      .filter(row => row.experiment_key === EXPERIMENT_KEY)
      .map(row => cleanText(row.user_id))
      .filter(Boolean)),
    suppressedEmails: new Set((suppressions || [])
      .filter(row => row.experiment_key === EXPERIMENT_KEY)
      .map(row => normalizeEmail(row.email))
      .filter(Boolean)),
    incompatibleUserIds: new Set((incompatibleEvents || [])
      .filter(row => incompatibleCampaigns.has(row.campaign))
      .map(row => cleanText(row.user_id))
      .filter(Boolean)),
    incompatibleEmails: new Set((incompatibleEvents || [])
      .filter(row => incompatibleCampaigns.has(row.campaign))
      .map(row => normalizeEmail(row.email))
      .filter(Boolean)),
  };
}

async function eligibleUsers(options = {}) {
  const dataset = await loadExperimentDataset();
  const requestedUserId = cleanText(options.userId || options.user_id);
  const requestedEmail = normalizeEmail(options.email);
  const seenEmails = new Set();
  const skipped = {
    missing_email: 0,
    deleted_user: 0,
    duplicate_email: 0,
    already_subscribed: 0,
    already_enrolled: 0,
    unsubscribed: 0,
    suppressed: 0,
    internal_or_test: 0,
    incompatible_campaign: 0,
    not_requested_user: 0,
  };
  const candidates = [];

  dataset.users.forEach(user => {
    const profile = dataset.profileByUser.get(user.id) || {};
    const email = normalizeEmail(user.email || profile.email);

    if (requestedUserId && user.id !== requestedUserId) {
      skipped.not_requested_user += 1;
      return;
    }
    if (requestedEmail && email !== requestedEmail) {
      skipped.not_requested_user += 1;
      return;
    }
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
    if (!options.allowInternal && emailLooksInternalOrTest(email)) {
      skipped.internal_or_test += 1;
      return;
    }
    if (dataset.unsubscribed.has(unsubscribeKey(email, EXPERIMENT_KEY)) || dataset.unsubscribed.has(unsubscribeKey(email, 'all'))) {
      skipped.unsubscribed += 1;
      return;
    }
    if (dataset.suppressedUserIds.has(user.id) || dataset.suppressedEmails.has(email)) {
      skipped.suppressed += 1;
      return;
    }
    if (dataset.incompatibleUserIds.has(user.id) || dataset.incompatibleEmails.has(email)) {
      skipped.incompatible_campaign += 1;
      return;
    }
    const subscription = dataset.subscriptionByUser.get(user.id);
    if (!subscriptionEligible(subscription)) {
      skipped.already_subscribed += 1;
      return;
    }
    if (dataset.enrollmentByUser.has(user.id)) {
      skipped.already_enrolled += 1;
      return;
    }

    const variant = VARIANTS.includes(options.forceVariant) ? options.forceVariant : deterministicVariantForUser(user.id);
    candidates.push({
      user: { ...user, email },
      profile,
      subscription: subscription || null,
      variant,
      planned_promotional_action: plannedActionForVariant(variant),
    });
  });

  candidates.sort((a, b) => new Date(a.user.created_at || 0) - new Date(b.user.created_at || 0));
  return {
    users: dataset.users,
    candidates,
    skipped,
  };
}

function selectEnrollmentCandidates(candidates, options = {}) {
  if (options.userId || options.user_id || options.email) return candidates.slice(0, 1);

  const explicitTargetPerVariant = Number(options.targetPerVariant || options.target_per_variant);
  const phase = cleanText(options.phase);
  const targetPerVariant = Number.isFinite(explicitTargetPerVariant) && explicitTargetPerVariant > 0
    ? Math.floor(explicitTargetPerVariant)
    : phase === '1'
      ? 10
      : phase === '2'
        ? 50
        : 0;

  if (targetPerVariant > 0) {
    return VARIANTS.flatMap(variant => candidates
      .filter(candidate => candidate.variant === variant)
      .slice(0, targetPerVariant));
  }

  const limit = limitFrom(options.limit, DEFAULT_LIMIT);
  return candidates.slice(0, limit);
}

async function existingEnrollmentForUser(userId) {
  const rows = await supabaseRest('reactivation_experiment_enrollments', {
    query: {
      select: '*',
      user_id: `eq.${userId}`,
      experiment_key: `eq.${EXPERIMENT_KEY}`,
      limit: '1',
    },
  });
  return Array.isArray(rows) ? rows[0] || null : rows || null;
}

async function insertEnrollment(candidate) {
  const existing = await existingEnrollmentForUser(candidate.user.id);
  if (existing) return { enrollment: existing, created: false };

  const rows = await supabaseRest('reactivation_experiment_enrollments', {
    method: 'POST',
    prefer: 'return=representation',
    body: {
      id: crypto.randomUUID(),
      user_id: candidate.user.id,
      email: candidate.user.email,
      experiment_key: EXPERIMENT_KEY,
      variant: candidate.variant,
      status: 'assigned',
      metadata: {
        source: 'reactivation_ab_test',
        user_created_at: candidate.user.created_at || null,
        planned_promotional_action: candidate.planned_promotional_action,
      },
    },
  });
  return { enrollment: Array.isArray(rows) ? rows[0] || null : rows || null, created: true };
}

async function grantFreeScans(candidate, enrollment) {
  if (candidate.variant !== VARIANT_FREE_SCANS || !enrollment?.id) return null;
  try {
    const rows = await supabaseRest('reactivation_promotional_credit_grants', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        id: crypto.randomUUID(),
        user_id: candidate.user.id,
        enrollment_id: enrollment.id,
        experiment_key: EXPERIMENT_KEY,
        variant: VARIANT_FREE_SCANS,
        credits_granted: FREE_SCAN_GRANT_SIZE,
        credits_remaining: FREE_SCAN_GRANT_SIZE,
        status: 'active',
        metadata: {
          source: 'reactivation_ab_test',
        },
      },
    });
    return Array.isArray(rows) ? rows[0] || null : rows || null;
  } catch (error) {
    if (error?.details?.code !== '23505') throw error;
    const rows = await supabaseRest('reactivation_promotional_credit_grants', {
      query: {
        select: '*',
        user_id: `eq.${candidate.user.id}`,
        experiment_key: `eq.${EXPERIMENT_KEY}`,
        limit: '1',
      },
    });
    return Array.isArray(rows) ? rows[0] || null : rows || null;
  }
}

async function enrollUsers(options = {}) {
  const requestedDryRun = options.dryRun ?? options.dry_run;
  const dryRun = requestedDryRun === undefined ? dryRunDefault() : requestedDryRun === true || /^(1|true|yes)$/i.test(cleanText(requestedDryRun));
  const mutatingTest = Boolean((options.userId || options.user_id || options.email) && options.forceVariant);

  if (!dryRun && !experimentEnabled() && !mutatingTest) {
    throw billing.httpError(
      403,
      'Reactivation A/B test is disabled. Set REACTIVATION_AB_TEST_ENABLED=true before enrolling users.',
      'reactivation_ab_test_disabled'
    );
  }

  const loaded = await eligibleUsers(options);
  const selected = selectEnrollmentCandidates(loaded.candidates, options);
  const assignments = [];

  for (const candidate of selected) {
    const base = {
      email: candidate.user.email,
      user_id: candidate.user.id,
      variant: candidate.variant,
      planned_promotional_action: candidate.planned_promotional_action,
      dry_run: dryRun,
    };

    if (dryRun) {
      assignments.push(base);
      continue;
    }

    const { enrollment, created } = await insertEnrollment(candidate);
    const grant = await grantFreeScans(candidate, enrollment);
    assignments.push({
      ...base,
      enrollment_id: enrollment?.id || '',
      enrollment_created: created,
      promotional_credit_grant_id: grant?.id || '',
      promotional_scans_remaining: grant?.credits_remaining ?? null,
    });
  }

  return {
    ok: true,
    dryRun,
    enabled: experimentEnabled(),
    experiment_key: EXPERIMENT_KEY,
    scanned_users: loaded.users.length,
    eligible: loaded.candidates.length,
    selected: selected.length,
    enrolled: dryRun ? 0 : assignments.length,
    would_enroll: dryRun ? assignments.length : 0,
    skipped: loaded.skipped,
    assignments,
  };
}

async function enrolledUsers() {
  let enrollments;
  let grants;
  let events;
  let subscriptions;
  let profiles;
  let emailEvents;
  let unsubscribes;
  try {
    [enrollments, grants, events, subscriptions, profiles, emailEvents, unsubscribes] = await Promise.all([
      listRestRows('reactivation_experiment_enrollments', { select: '*', experiment_key: `eq.${EXPERIMENT_KEY}` }),
      listRestRows('reactivation_promotional_credit_grants', { select: '*', experiment_key: `eq.${EXPERIMENT_KEY}` }),
      listRestRows('reactivation_promotional_credit_events', { select: '*', experiment_key: `eq.${EXPERIMENT_KEY}` }),
      listRestRows('subscriptions', { select: 'user_id,status,subscription_status,stripe_subscription_id,plan,created_at,updated_at' }),
      listRestRows('profiles', { select: 'id,email,full_name,agency_name' }),
      listRestRows('lifecycle_email_events', { select: '*', campaign: `eq.${EXPERIMENT_KEY}` }),
      listRestRows('lifecycle_email_unsubscribes', { select: 'email,campaign' }),
    ]);
  } catch (error) {
    if (error?.details?.code === '42P01' || /reactivation_/i.test(error?.message || '')) {
      throw billing.httpError(
        503,
        'Reactivation experiment tables are not installed yet. Run supabase/reactivation-ab-test.sql in Supabase SQL Editor.',
        'reactivation_schema_missing',
        error.details || null
      );
    }
    throw error;
  }

  return {
    enrollments: enrollments || [],
    grantByUser: new Map((grants || []).map(row => [row.user_id, row])),
    eventsByUser: (events || []).reduce((map, row) => {
      if (!map.has(row.user_id)) map.set(row.user_id, []);
      map.get(row.user_id).push(row);
      return map;
    }, new Map()),
    subscriptionByUser: new Map((subscriptions || []).map(row => [row.user_id, row])),
    profileByUser: new Map((profiles || []).map(row => [row.id, row])),
    emailEvents: emailEvents || [],
    unsubscribed: new Set((unsubscribes || []).map(row => unsubscribeKey(row.email, row.campaign))),
  };
}

async function runEmailSequence(options = {}) {
  const requestedDryRun = options.dryRun ?? options.dry_run;
  const dryRun = requestedDryRun === undefined ? dryRunDefault() : requestedDryRun === true || /^(1|true|yes)$/i.test(cleanText(requestedDryRun));
  if (!dryRun && (!experimentEnabled() || dryRunDefault())) {
    throw billing.httpError(
      403,
      'Reactivation email sending is disabled. Set REACTIVATION_AB_TEST_ENABLED=true and REACTIVATION_AB_TEST_DRY_RUN=false before sending.',
      'reactivation_ab_test_send_disabled'
    );
  }

  const limit = limitFrom(options.limit, DEFAULT_LIMIT);
  const data = await enrolledUsers();
  const sentByUser = new Map();
  data.emailEvents
    .filter(row => row.status === 'sent')
    .forEach(row => {
      const key = cleanText(row.user_id);
      if (!sentByUser.has(key)) sentByUser.set(key, new Set());
      sentByUser.get(key).add(row.step);
    });

  const candidates = [];
  const skipped = {
    missing_email: 0,
    already_subscribed: 0,
    unsubscribed: 0,
    inactive_status: 0,
    no_step_due: 0,
  };

  data.enrollments.forEach(enrollment => {
    const email = normalizeEmail(enrollment.email);
    if (!email) {
      skipped.missing_email += 1;
      return;
    }
    if (!['assigned', 'activated'].includes(cleanText(enrollment.status))) {
      skipped.inactive_status += 1;
      return;
    }
    if (data.unsubscribed.has(unsubscribeKey(email, EXPERIMENT_KEY)) || data.unsubscribed.has(unsubscribeKey(email, 'all'))) {
      skipped.unsubscribed += 1;
      return;
    }
    if (!subscriptionEligible(data.subscriptionByUser.get(enrollment.user_id))) {
      skipped.already_subscribed += 1;
      return;
    }
    const step = chooseNextEmailStep(enrollment, sentByUser.get(enrollment.user_id) || new Set());
    if (!step) {
      skipped.no_step_due += 1;
      return;
    }
    candidates.push({
      enrollment,
      step,
      user: {
        id: enrollment.user_id,
        email,
      },
      profile: data.profileByUser.get(enrollment.user_id) || null,
    });
  });

  candidates.sort((a, b) => new Date(a.enrollment.assigned_at || 0) - new Date(b.enrollment.assigned_at || 0));
  const selected = candidates.slice(0, limit);
  const deliveries = [];
  const failures = [];

  for (const candidate of selected) {
    const step = {
      ...candidate.step,
      campaign: EXPERIMENT_KEY,
      ctaUrl: clickUrlForStep(candidate.user, candidate.step),
    };
    const deliveryBase = {
      email: candidate.user.email,
      user_id: candidate.user.id,
      enrollment_id: candidate.enrollment.id,
      variant: candidate.enrollment.variant,
      step: step.key,
      subject: step.subject,
      planned_email: {
        subject: step.subject,
        preview_text: step.previewText,
        headline: step.headline,
        paragraphs: step.paragraphs || [],
        bullets: step.bullets || [],
        cta: step.cta,
      },
      cta_url: step.ctaUrl,
      planned_promotional_action: plannedActionForVariant(candidate.enrollment.variant),
      dry_run: dryRun,
    };

    if (dryRun) {
      deliveries.push(deliveryBase);
      continue;
    }

    try {
      const delivery = await lifecycleEmails.sendLifecycleEmail({
        user: candidate.user,
        profile: candidate.profile,
        step,
        campaign: EXPERIMENT_KEY,
      });
      await lifecycleEmails.recordEmailEvent({
        user: candidate.user,
        step,
        campaign: EXPERIMENT_KEY,
        providerId: delivery.id || '',
        metadata: {
          experiment_key: EXPERIMENT_KEY,
          variant: candidate.enrollment.variant,
          enrollment_id: candidate.enrollment.id,
          cta_url: step.ctaUrl,
          event: 'reactivation_email_sent',
        },
      });
      deliveries.push({
        ...deliveryBase,
        provider_message_id: delivery.id || '',
        dry_run: false,
      });
    } catch (error) {
      try {
        await lifecycleEmails.recordEmailEvent({
          user: candidate.user,
          step,
          campaign: EXPERIMENT_KEY,
          status: 'failed',
          providerId: error?.details?.id || '',
          errorMessage: error?.message || 'Email failed.',
          metadata: {
            experiment_key: EXPERIMENT_KEY,
            variant: candidate.enrollment.variant,
            enrollment_id: candidate.enrollment.id,
            event: 'reactivation_email_failed',
            error_code: error?.code || 'email_failed',
          },
        });
      } catch (recordError) {
        console.warn('[PitchProof] Reactivation email failure could not be recorded:', recordError?.message || recordError);
      }
      failures.push({
        ...deliveryBase,
        error: error?.message || 'Email failed.',
        code: error?.code || 'email_failed',
      });
    }
  }

  return {
    ok: failures.length === 0,
    dryRun,
    enabled: experimentEnabled(),
    campaign: EXPERIMENT_KEY,
    eligible: candidates.length,
    selected: selected.length,
    sent: dryRun ? 0 : deliveries.length,
    would_send: dryRun ? deliveries.length : 0,
    failed: failures.length,
    skipped,
    sample_recipients: deliveries.slice(0, 20),
    deliveries: dryRun ? [] : deliveries,
    failures,
  };
}

async function recordEmailClick({ email, token, step }) {
  const normalized = normalizeEmail(email);
  if (!lifecycleEmails.verifyToken(normalized, EXPERIMENT_KEY, token)) {
    throw billing.httpError(401, 'Reactivation link is invalid or expired.', 'reactivation_link_invalid');
  }
  const rows = await supabaseRest('reactivation_experiment_enrollments', {
    query: {
      select: '*',
      email: `eq.${normalized}`,
      experiment_key: `eq.${EXPERIMENT_KEY}`,
      limit: '1',
    },
  });
  const enrollment = Array.isArray(rows) ? rows[0] || null : rows || null;
  if (!enrollment) {
    throw billing.httpError(404, 'Reactivation enrollment was not found.', 'reactivation_enrollment_missing');
  }
  const metadata = enrollment.metadata && typeof enrollment.metadata === 'object' && !Array.isArray(enrollment.metadata)
    ? enrollment.metadata
    : {};
  const clickCount = Math.max(0, Number(metadata.email_click_count) || 0) + 1;
  const updatedRows = await supabaseRest('reactivation_experiment_enrollments', {
    method: 'PATCH',
    prefer: 'return=representation',
    query: {
      id: `eq.${enrollment.id}`,
      select: '*',
    },
    body: {
      activated_at: enrollment.activated_at || new Date().toISOString(),
      status: enrollment.status === 'assigned' ? 'activated' : enrollment.status,
      metadata: {
        ...metadata,
        email_click_count: clickCount,
        last_email_click_at: new Date().toISOString(),
        last_email_click_step: cleanText(step),
      },
    },
  });
  const updated = Array.isArray(updatedRows) ? updatedRows[0] || enrollment : updatedRows || enrollment;
  const redirectUrl = updated.variant === VARIANT_FREE_SCANS
    ? `${appUrl()}/app/scan?source=reactivation&experiment_key=${encodeURIComponent(EXPERIMENT_KEY)}`
    : `${appUrl()}/app/billing?resume=checkout&offer=reactivation_discount_month&source=reactivation&experiment_key=${encodeURIComponent(EXPERIMENT_KEY)}`;
  return {
    enrollment: updated,
    redirectUrl,
    event: 'reactivation_email_clicked',
  };
}

async function markCheckoutStarted(userId, metadata = {}) {
  const enrollment = await existingEnrollmentForUser(userId);
  if (!enrollment || enrollment.variant !== VARIANT_DISCOUNT_MONTH) return null;
  const existingMetadata = enrollment.metadata && typeof enrollment.metadata === 'object' && !Array.isArray(enrollment.metadata)
    ? enrollment.metadata
    : {};
  const rows = await supabaseRest('reactivation_experiment_enrollments', {
    method: 'PATCH',
    prefer: 'return=representation',
    query: { id: `eq.${enrollment.id}`, select: '*' },
    body: {
      activated_at: enrollment.activated_at || new Date().toISOString(),
      status: enrollment.status === 'assigned' ? 'activated' : enrollment.status,
      metadata: {
        ...existingMetadata,
        checkout_started_count: Math.max(0, Number(existingMetadata.checkout_started_count) || 0) + 1,
        last_checkout_started_at: new Date().toISOString(),
        ...metadata,
      },
    },
  });
  return Array.isArray(rows) ? rows[0] || null : rows || null;
}

function summarizeVariant(variant, data) {
  const enrollments = data.enrollments.filter(row => row.variant === variant);
  const userIds = new Set(enrollments.map(row => row.user_id));
  const emailSent = data.emailEvents.filter(row => userIds.has(row.user_id) && row.status === 'sent').length;
  const activated = enrollments.filter(row => row.activated_at || ['activated', 'converted'].includes(row.status)).length;
  const paidSubscribers = enrollments.filter(row => row.converted_at || row.status === 'converted').length;
  const scansCompleted = [...data.eventsByUser.entries()]
    .filter(([userId]) => userIds.has(userId))
    .flatMap(([, events]) => events)
    .filter(row => row.status === 'completed')
    .length;
  const checkoutsStarted = enrollments.reduce((total, row) => total + Math.max(0, Number(row.metadata?.checkout_started_count) || 0), 0);
  const revenueCents = enrollments.reduce((total, row) => total + Math.max(0, Number(row.first_payment_amount_cents) || 0), 0);
  const firstFullPriceRenewals = enrollments.filter(row => row.first_full_price_renewal_at).length;

  return {
    variant,
    assigned: enrollments.length,
    emails_sent: emailSent,
    activated,
    scans_completed: scansCompleted,
    checkouts_started: checkoutsStarted,
    paid_subscribers: paidSubscribers,
    conversion_rate: enrollments.length ? Number((paidSubscribers / enrollments.length).toFixed(4)) : 0,
    revenue_cents: revenueCents,
    revenue: `$${(revenueCents / 100).toFixed(2)}`,
    first_full_price_renewals: firstFullPriceRenewals,
  };
}

async function experimentSummary() {
  const data = await enrolledUsers();
  return {
    ok: true,
    enabled: experimentEnabled(),
    dry_run_default: dryRunDefault(),
    experiment_key: EXPERIMENT_KEY,
    variants: VARIANTS.map(variant => summarizeVariant(variant, data)),
  };
}

async function experimentState(options = {}) {
  const userId = cleanText(options.userId || options.user_id);
  const email = normalizeEmail(options.email);
  const query = {
    select: '*',
    experiment_key: `eq.${EXPERIMENT_KEY}`,
    limit: '1',
  };
  if (userId) query.user_id = `eq.${userId}`;
  else if (email) query.email = `eq.${email}`;
  else {
    throw billing.httpError(400, 'Provide userId or email to inspect reactivation state.', 'reactivation_state_target_required');
  }

  const enrollmentRows = await supabaseRest('reactivation_experiment_enrollments', { query });
  const enrollment = Array.isArray(enrollmentRows) ? enrollmentRows[0] || null : enrollmentRows || null;
  if (!enrollment) {
    return {
      ok: true,
      experiment_key: EXPERIMENT_KEY,
      found: false,
      enrollment: null,
      grant: null,
      promotional_scan_events: [],
      email_events: [],
    };
  }

  const [grantRows, scanEvents, emailEvents] = await Promise.all([
    supabaseRest('reactivation_promotional_credit_grants', {
      query: {
        select: '*',
        user_id: `eq.${enrollment.user_id}`,
        experiment_key: `eq.${EXPERIMENT_KEY}`,
        limit: '1',
      },
    }),
    listRestRows('reactivation_promotional_credit_events', {
      select: '*',
      user_id: `eq.${enrollment.user_id}`,
      experiment_key: `eq.${EXPERIMENT_KEY}`,
      order: 'created_at.desc',
    }),
    listRestRows('lifecycle_email_events', {
      select: '*',
      user_id: `eq.${enrollment.user_id}`,
      campaign: `eq.${EXPERIMENT_KEY}`,
      order: 'created_at.desc',
    }),
  ]);

  return {
    ok: true,
    experiment_key: EXPERIMENT_KEY,
    found: true,
    enrollment,
    grant: Array.isArray(grantRows) ? grantRows[0] || null : grantRows || null,
    promotional_scan_events: scanEvents,
    email_events: emailEvents,
  };
}

module.exports = {
  EXPERIMENT_KEY,
  FREE_SCAN_GRANT_SIZE,
  VARIANT_DISCOUNT_MONTH,
  VARIANT_FREE_SCANS,
  VARIANTS,
  REACTIVATION_STEPS,
  chooseNextEmailStep,
  deterministicVariantForUser,
  dryRunDefault,
  enrollUsers,
  experimentEnabled,
  experimentSummary,
  experimentState,
  plannedActionForVariant,
  recordEmailClick,
  runEmailSequence,
  markCheckoutStarted,
  variantSteps,
};
