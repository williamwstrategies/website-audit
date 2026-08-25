const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { analyzeWebsite } = require('./api/analyze');
const { PostHog } = require('posthog-node');
const billing = require('./lib/billing');
const lifecycleEmails = require('./lib/lifecycle-emails');
const { generateReportPdf } = require('./lib/pdf');
const { enrichReportWithAiVisibility } = require('./lib/ai-visibility');
const { runAiVisibilityPrompt } = require('./lib/dataforseo-ai-visibility');
const { runAiVisibilityAssessment } = require('./lib/ai-visibility-assessment');
const { runKeywordRankingAnalysis, keywordRankingFeatureEnabled } = require('./lib/keyword-ranking');
const { ensureResendTrackingEnabled } = require('./lib/resend-tracking');
const { outboundEmailsPaused, pausedEmailResult } = require('./lib/email-controls');
const businessSearchProvider = require('./lib/business-search-provider');
const leads = require('./lib/leads');
const emailFinder = require('./lib/email-finder');

const posthog = new PostHog(process.env.POSTHOG_API_KEY, {
  host: process.env.POSTHOG_HOST || 'https://us.i.posthog.com',
  enableExceptionAutocapture: true,
});

const app = express();
app.use(cors());

const leadSearchRateWindow = new Map();

const LEGACY_PRODUCTION_HOST = 'scanner.wstrategiescanada.ca';
const PRIMARY_PRODUCTION_ORIGIN = 'https://pitchproof.ca';

function requestHost(req) {
  const forwardedHost = String(req.get('x-forwarded-host') || '').split(',')[0].trim();
  const host = forwardedHost || String(req.get('host') || '').trim();
  return host.toLowerCase().replace(/:\d+$/, '');
}

app.use((req, res, next) => {
  const isLegacyHost = requestHost(req) === LEGACY_PRODUCTION_HOST;
  const isPageRequest = req.method === 'GET' || req.method === 'HEAD';
  const isApiRequest = req.path === '/api' || req.path.startsWith('/api/');

  if (!isLegacyHost || !isPageRequest || isApiRequest) {
    return next();
  }

  const redirectUrl = new URL(req.originalUrl || '/', PRIMARY_PRODUCTION_ORIGIN);
  return res.redirect(308, redirectUrl.toString());
});

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const result = await billing.handleStripeWebhook(req.body, req.get('stripe-signature'));
    if (result.type === 'checkout.session.completed') {
      posthog.capture({
        distinctId: result.id,
        event: 'checkout_completed',
        properties: { stripe_event_id: result.id, plan: result.subscription?.plan || '' },
      });
      posthog.capture({
        distinctId: result.id,
        event: 'subscription_started',
        properties: { stripe_event_id: result.id, plan: result.subscription?.plan || '' },
      });
    }
    if (result.planChange === 'upgraded' || result.planChange === 'downgraded') {
      posthog.capture({
        distinctId: result.id,
        event: result.planChange === 'upgraded' ? 'subscription_upgraded' : 'subscription_downgraded',
        properties: {
          stripe_event_id: result.id,
          previous_plan: result.previousPlan,
          current_plan: result.currentPlan,
        },
      });
    }
    res.json({ received: true });
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ALLOWED_CLIENT_ANALYTICS_EVENTS = new Set([
  'plan_viewed',
  'plan_selected',
  'upgrade_clicked',
  'onboarding_choice_viewed',
  'onboarding_plan_selected',
  'free_preview_selected',
  'free_assessment_cta_clicked',
  'free_assessment_url_submitted',
  'free_assessment_signup_prompt_viewed',
  'free_assessment_autostarted',
  'free_preview_viewed',
  'scan_url_focused',
  'scan_url_entered',
  'scan_started',
  'scan_processing_started',
  'scan_completed',
  'scan_failed',
  'report_preview_revealed',
  'locked_section_viewed',
  'locked_section_clicked',
  'upgrade_prompt_viewed',
  'unlock_full_report_clicked',
  'pricing_viewed_from_preview',
  'checkout_started_after_free_scan',
  'subscription_started_from_preview',
  'ai_visibility_scan_started',
  'ai_visibility_scan_completed',
  'ai_visibility_scan_failed',
  'ai_visibility_report_viewed',
  'ai_visibility_limit_reached',
  'ai_visibility_cache_hit',
]);

const SUPPORT_CATEGORIES = new Set([
  'bug',
  'billing',
  'report',
  'account',
  'feature',
  'other',
]);

const SUPPORT_URGENCIES = new Set([
  'low',
  'normal',
  'high',
  'urgent',
]);

const SUPPORT_REPLY_METHODS = new Set([
  'email',
  'text',
  'either',
]);

const RESEND_EMAIL_API_URL = 'https://api.resend.com/emails';
const STARTER_LEAD_DISCOVERY_LIMIT = 3000;

function checkLeadSearchRateLimit(userId) {
  const limit = Math.max(1, Math.min(Number(process.env.LEAD_FINDER_SEARCHES_PER_MINUTE) || 6, 60));
  const now = Date.now();
  const windowMs = 60 * 1000;
  const key = String(userId || 'anonymous');
  const current = leadSearchRateWindow.get(key) || [];
  const recent = current.filter(timestamp => now - timestamp < windowMs);
  if (recent.length >= limit) {
    throw billing.httpError(
      429,
      'Lead Finder search limit reached. Wait a minute, then search again.',
      'lead_search_rate_limited'
    );
  }
  recent.push(now);
  leadSearchRateWindow.set(key, recent);
}

function validIsoDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function leadDiscoveryPeriodStart(subscription = {}) {
  const periodStart = validIsoDate(subscription.current_period_start);
  if (periodStart) return periodStart.toISOString();

  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function leadDiscoveryAllowanceForSubscription(subscription = {}) {
  const plan = String(subscription.plan || '').toLowerCase();
  const active = ['active', 'trialing'].includes(String(subscription.status || '').toLowerCase());
  const activeHigherPlan = ['professional', 'growth', 'enterprise'].includes(plan) && active;
  if (activeHigherPlan || (subscription.unlimited === true && active)) return null;
  return STARTER_LEAD_DISCOVERY_LIMIT;
}

async function leadDiscoveryUsageForSearch(userId, subscription = {}) {
  const limit = leadDiscoveryAllowanceForSubscription(subscription);
  if (limit == null) {
    return {
      unlimited: true,
      limit: null,
      used: 0,
      remaining: null,
      period_start: leadDiscoveryPeriodStart(subscription),
    };
  }

  const periodStart = leadDiscoveryPeriodStart(subscription);
  const used = await leads.getLeadDiscoveryUsageForUser(userId, { since: periodStart });
  return {
    unlimited: false,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    period_start: periodStart,
  };
}

function requestedLeadLimit(input = {}) {
  return Math.max(1, Math.min(Number(input.limit) || 25, 50));
}

function cleanSupportText(value = '', maxLength = 1000) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizedSupportValue(value, allowed, fallback) {
  const normalized = cleanSupportText(value, 40).toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

function requestOrigin(req) {
  const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('x-forwarded-host') || req.get('host') || '';
  return host ? `${protocol}://${host}` : '';
}

function safeCompare(left = '', right = '') {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function supportEmailRecipients(value = '') {
  return String(value || '')
    .split(',')
    .map((item) => cleanSupportText(item, 320))
    .filter(Boolean)
    .slice(0, 20);
}

function singleEmailRecipient(value = '') {
  const email = cleanSupportText(value, 320);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function escapeSupportHtml(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function supportEmailSubject(payload) {
  const urgency = String(payload.urgency || 'normal').toUpperCase();
  return `[Support ${urgency}] ${payload.subject || payload.ticket_id}`;
}

function supportEmailText(payload) {
  return [
    `Ticket: ${payload.ticket_id}`,
    `Created: ${payload.created_at}`,
    `Category: ${payload.category}`,
    `Urgency: ${payload.urgency}`,
    `Subject: ${payload.subject}`,
    '',
    payload.message,
    '',
    `Affected URL: ${payload.affected_url || 'Not provided'}`,
    `Preferred reply: ${payload.preferred_reply_method || 'email'}`,
    `Reply email: ${payload.reply_email || 'Not provided'}`,
    `Reply phone: ${payload.reply_phone || 'Not provided'}`,
    '',
    `User: ${payload.user?.email || 'Unknown'} (${payload.user?.id || 'No user id'})`,
    `Agency: ${payload.agency?.name || 'Not provided'}`,
    `Page URL: ${payload.page_url || 'Not provided'}`,
    `App URL: ${payload.app_url || 'Not provided'}`,
    `User agent: ${payload.user_agent || 'Not provided'}`,
  ].join('\n');
}

function supportEmailHtml(payload) {
  const rows = [
    ['Ticket', payload.ticket_id],
    ['Created', payload.created_at],
    ['Category', payload.category],
    ['Urgency', payload.urgency],
    ['Affected URL', payload.affected_url || 'Not provided'],
    ['Preferred reply', payload.preferred_reply_method || 'email'],
    ['Reply email', payload.reply_email || 'Not provided'],
    ['Reply phone', payload.reply_phone || 'Not provided'],
    ['User', `${payload.user?.email || 'Unknown'} (${payload.user?.id || 'No user id'})`],
    ['Agency', payload.agency?.name || 'Not provided'],
    ['Page URL', payload.page_url || 'Not provided'],
    ['App URL', payload.app_url || 'Not provided'],
    ['User agent', payload.user_agent || 'Not provided'],
  ];

  const details = rows.map(([label, value]) => (
    `<tr><th>${escapeSupportHtml(label)}</th><td>${escapeSupportHtml(value)}</td></tr>`
  )).join('');

  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1d1d1f;background:#f5f5f7;padding:28px;">
      <div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #e5e5ea;border-radius:18px;overflow:hidden;box-shadow:0 18px 48px rgba(0,0,0,0.08);">
        <div style="padding:24px 28px;border-bottom:1px solid #ececf0;">
          <p style="margin:0 0 8px;color:#7a6a3a;text-transform:uppercase;letter-spacing:.08em;font-size:12px;font-weight:700;">Customer Support Request</p>
          <h1 style="margin:0;font-size:24px;line-height:1.25;color:#1d1d1f;">${escapeSupportHtml(payload.subject)}</h1>
        </div>
        <div style="padding:24px 28px;">
          <p style="white-space:pre-wrap;margin:0 0 22px;font-size:15px;line-height:1.6;color:#2f3137;">${escapeSupportHtml(payload.message)}</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px;line-height:1.45;">
            ${details}
          </table>
        </div>
      </div>
    </div>
    <style>
      th { width: 34%; text-align: left; padding: 10px 12px; color: #6e6e73; border-top: 1px solid #ececf0; vertical-align: top; }
      td { padding: 10px 12px; color: #1d1d1f; border-top: 1px solid #ececf0; word-break: break-word; }
    </style>
  `;
}

async function sendSupportEmail(payload) {
  if (outboundEmailsPaused()) {
    return pausedEmailResult();
  }

  const apiKey = cleanSupportText(process.env.RESEND_API_KEY, 1000);
  const from = cleanSupportText(process.env.SUPPORT_EMAIL_FROM, 320);
  const to = supportEmailRecipients(process.env.SUPPORT_EMAIL_TO);

  if (!apiKey && !from && !to.length) {
    return { configured: false, sent: false, error: '', id: '' };
  }

  if (!apiKey || !from || !to.length) {
    return {
      configured: true,
      sent: false,
      error: 'Direct support email is partially configured. Add RESEND_API_KEY, SUPPORT_EMAIL_TO, and SUPPORT_EMAIL_FROM.',
      id: '',
    };
  }

  const body = {
    from,
    to,
    subject: supportEmailSubject(payload),
    text: supportEmailText(payload),
    html: supportEmailHtml(payload),
  };

  if (payload.reply_email) {
    body.reply_to = payload.reply_email;
  }

  let response;
  try {
    await ensureResendTrackingEnabled(apiKey);
    response = await fetch(RESEND_EMAIL_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': payload.ticket_id,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { configured: true, sent: false, error: error?.message || 'Support email request failed.', id: '' };
  }

  if (!response.ok) {
    const responseBody = await response.text().catch(() => '');
    return {
      configured: true,
      sent: false,
      error: `Support email failed with HTTP ${response.status}${responseBody ? `: ${responseBody.slice(0, 240)}` : ''}`,
      id: '',
    };
  }

  const data = await response.json().catch(() => ({}));
  return { configured: true, sent: true, error: '', id: data?.id || '' };
}

async function sendSupportWebhook(payload) {
  const webhookUrl = cleanSupportText(process.env.SUPPORT_WEBHOOK_URL, 1000);
  if (!webhookUrl) {
    return { configured: false, sent: false, error: '' };
  }

  let response;
  try {
    response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    return { configured: true, sent: false, error: error?.message || 'Support webhook request failed.' };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return {
      configured: true,
      sent: false,
      error: `Support webhook failed with HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
    };
  }

  return { configured: true, sent: true, error: '' };
}

function supportSmsMessage(payload = {}) {
  const subject = cleanSupportText(payload.subject, 140);
  const message = cleanSupportText(payload.message, 1200);
  const phone = cleanSupportText(payload.reply_phone, 80);
  return [
    'New PitchProof support request',
    phone ? `Phone: ${phone}` : '',
    subject ? `Subject: ${subject}` : '',
    message ? `Message: ${message}` : '',
  ].filter(Boolean).join('\n');
}

function supportGhlPayload(payload = {}) {
  const supportSmsTo = cleanSupportText(process.env.SUPPORT_SMS_TO, 80);
  return {
    source: 'pitchproof_support',
    event: 'support_request_submitted',
    ticket_id: payload.ticket_id,
    ticketId: payload.ticket_id,
    category: payload.category,
    urgency: payload.urgency,
    subject: payload.subject,
    message: payload.message,
    affected_url: payload.affected_url,
    affectedUrl: payload.affected_url,
    preferred_reply_method: payload.preferred_reply_method,
    preferredReplyMethod: payload.preferred_reply_method,
    customer_email: payload.reply_email || payload.user?.email || '',
    customerEmail: payload.reply_email || payload.user?.email || '',
    customer_phone: payload.reply_phone || '',
    customerPhone: payload.reply_phone || '',
    customer_name: payload.user?.name || '',
    customerName: payload.user?.name || '',
    user_id: payload.user?.id || '',
    agency_name: payload.agency?.name || '',
    agencyName: payload.agency?.name || '',
    page_url: payload.page_url,
    pageUrl: payload.page_url,
    app_url: payload.app_url,
    appUrl: payload.app_url,
    support_sms_to: supportSmsTo,
    supportSmsTo,
    sms_to: supportSmsTo,
    smsTo: supportSmsTo,
    sms_message: supportSmsMessage(payload),
    smsMessage: supportSmsMessage(payload),
    created_at: payload.created_at,
    createdAt: payload.created_at,
  };
}

async function sendSupportGhlWebhook(payload) {
  const webhookUrl = cleanSupportText(process.env.SUPPORT_GHL_WEBHOOK_URL, 1000);
  if (!webhookUrl) {
    return { configured: false, sent: false, error: '' };
  }

  let response;
  try {
    response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(supportGhlPayload(payload)),
    });
  } catch (error) {
    return { configured: true, sent: false, error: error?.message || 'GoHighLevel support webhook request failed.' };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return {
      configured: true,
      sent: false,
      error: `GoHighLevel support webhook failed with HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
    };
  }

  return { configured: true, sent: true, error: '' };
}

async function sendSupportNotification(payload) {
  const ghlWebhook = await sendSupportGhlWebhook(payload);
  const email = { configured: false, sent: false, paused: false, error: '', id: '' };
  const webhook = { configured: false, sent: false, error: '' };
  const errors = [ghlWebhook.error].filter(Boolean);
  return {
    configured: ghlWebhook.configured,
    sent: ghlWebhook.sent,
    paused: false,
    error: errors.join(' | '),
    email,
    webhook,
    ghlWebhook,
  };
}

function emailTestRequestSecret(req) {
  const authorization = cleanSupportText(req.get('authorization'), 2000);
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || '';
  return cleanSupportText(req.get('x-email-test-secret') || req.get('x-lifecycle-secret') || bearer || req.query.secret || req.body?.secret, 2000);
}

function requireEmailTestSecret(req) {
  const configured = cleanSupportText(process.env.EMAIL_TEST_SECRET || process.env.LIFECYCLE_EMAIL_SECRET, 2000);
  if (!configured) {
    throw billing.httpError(503, 'EMAIL_TEST_SECRET or LIFECYCLE_EMAIL_SECRET is not configured.', 'email_test_secret_missing');
  }
  if (!safeCompare(emailTestRequestSecret(req), configured)) {
    throw billing.httpError(401, 'Email test access is not authorized.', 'email_test_unauthorized');
  }
}

function testEmailFrom(channel = '') {
  const normalized = cleanSupportText(channel, 40).toLowerCase();
  if (normalized === 'lifecycle') {
    return cleanSupportText(process.env.LIFECYCLE_EMAIL_FROM || process.env.SUPPORT_EMAIL_FROM, 320);
  }
  return cleanSupportText(process.env.SUPPORT_EMAIL_FROM || process.env.LIFECYCLE_EMAIL_FROM, 320);
}

function testEmailHtml({ from, to, origin, channel }) {
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1d1d1f;background:#f5f5f7;padding:28px;">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e5e5ea;border-radius:18px;overflow:hidden;box-shadow:0 18px 48px rgba(0,0,0,0.08);">
        <div style="padding:24px 28px;border-bottom:1px solid #ececf0;">
          <p style="margin:0 0 8px;color:#7a6a3a;text-transform:uppercase;letter-spacing:.08em;font-size:12px;font-weight:700;">PitchProof</p>
          <h1 style="margin:0;font-size:24px;line-height:1.25;color:#1d1d1f;">Test email delivered.</h1>
        </div>
        <div style="padding:24px 28px;">
          <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#2f3137;">This confirms Resend can send from the currently configured address.</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px;line-height:1.45;">
            <tr><th style="text-align:left;padding:10px 12px;color:#6e6e73;border-top:1px solid #ececf0;">From</th><td style="padding:10px 12px;color:#1d1d1f;border-top:1px solid #ececf0;word-break:break-word;">${escapeSupportHtml(from)}</td></tr>
            <tr><th style="text-align:left;padding:10px 12px;color:#6e6e73;border-top:1px solid #ececf0;">To</th><td style="padding:10px 12px;color:#1d1d1f;border-top:1px solid #ececf0;word-break:break-word;">${escapeSupportHtml(to)}</td></tr>
            <tr><th style="text-align:left;padding:10px 12px;color:#6e6e73;border-top:1px solid #ececf0;">Channel</th><td style="padding:10px 12px;color:#1d1d1f;border-top:1px solid #ececf0;">${escapeSupportHtml(channel || 'support')}</td></tr>
            <tr><th style="text-align:left;padding:10px 12px;color:#6e6e73;border-top:1px solid #ececf0;">Site</th><td style="padding:10px 12px;color:#1d1d1f;border-top:1px solid #ececf0;word-break:break-word;">${escapeSupportHtml(origin || 'Not provided')}</td></tr>
          </table>
        </div>
      </div>
    </div>
  `;
}

async function sendResendTestEmail({ to, channel, origin }) {
  const apiKey = cleanSupportText(process.env.RESEND_API_KEY, 1000);
  const from = testEmailFrom(channel);
  if (!apiKey || !from) {
    throw billing.httpError(503, 'Test email is not configured. Add RESEND_API_KEY and SUPPORT_EMAIL_FROM or LIFECYCLE_EMAIL_FROM in Render.', 'email_test_not_configured');
  }

  await ensureResendTrackingEnabled(apiKey);

  const body = {
    from,
    to: [to],
    subject: 'PitchProof test email',
    text: [
      'Test email delivered.',
      '',
      'This confirms Resend can send from the currently configured address.',
      '',
      `From: ${from}`,
      `To: ${to}`,
      `Channel: ${channel || 'support'}`,
      `Site: ${origin || 'Not provided'}`,
    ].join('\n'),
    html: testEmailHtml({ from, to, origin, channel }),
  };

  const replyTo = cleanSupportText(process.env.LIFECYCLE_EMAIL_REPLY_TO || process.env.SUPPORT_EMAIL_TO, 320);
  if (replyTo) body.reply_to = supportEmailRecipients(replyTo)[0] || replyTo;

  const response = await fetch(RESEND_EMAIL_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `email-test:${to}:${Date.now()}`,
    },
    body: JSON.stringify(body),
  });

  const responseBody = await response.text().catch(() => '');
  const data = (() => {
    if (!responseBody) return {};
    try {
      return JSON.parse(responseBody);
    } catch {
      return { raw: responseBody };
    }
  })();

  if (!response.ok) {
    throw billing.httpError(response.status, data?.message || data?.error || 'Test email could not be sent.', 'resend_test_email_failed', data);
  }

  return { id: data?.id || '', from, to };
}

function lifecycleRequestSecret(req) {
  const authorization = cleanSupportText(req.get('authorization'), 2000);
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || '';
  return cleanSupportText(req.get('x-lifecycle-secret') || bearer || req.query.secret || req.body?.secret, 2000);
}

function requireLifecycleSecret(req) {
  const configured = cleanSupportText(process.env.LIFECYCLE_EMAIL_SECRET, 2000);
  if (!configured) {
    throw billing.httpError(503, 'LIFECYCLE_EMAIL_SECRET is not configured.', 'lifecycle_secret_missing');
  }
  if (!safeCompare(lifecycleRequestSecret(req), configured)) {
    throw billing.httpError(401, 'Lifecycle email access is not authorized.', 'lifecycle_unauthorized');
  }
}

function requireAiVisibilityTestSecret(req) {
  const configured = cleanSupportText(process.env.AI_VISIBILITY_TEST_SECRET, 2000);
  const provided = cleanSupportText(req.get('x-ai-visibility-secret'), 2000);
  if (!configured) {
    throw billing.httpError(503, 'AI_VISIBILITY_TEST_SECRET is not configured.', 'ai_visibility_test_secret_missing');
  }
  if (!safeCompare(provided, configured)) {
    throw billing.httpError(401, 'AI visibility test access is not authorized.', 'ai_visibility_test_unauthorized');
  }
}

function requireKeywordRankingTestSecret(req) {
  const configured = cleanSupportText(process.env.KEYWORD_RANKING_TEST_SECRET, 2000);
  const provided = cleanSupportText(req.get('x-keyword-ranking-secret'), 2000);
  if (!configured) {
    throw billing.httpError(503, 'KEYWORD_RANKING_TEST_SECRET is not configured.', 'keyword_ranking_test_secret_missing');
  }
  if (!safeCompare(provided, configured)) {
    throw billing.httpError(401, 'Keyword ranking test access is not authorized.', 'keyword_ranking_test_unauthorized');
  }
}

function lifecycleDryRun(req) {
  return /^(1|true|yes)$/i.test(cleanSupportText(req.query.dryRun || req.query.dry_run || req.body?.dryRun || req.body?.dry_run, 20));
}

function broadcastDryRun(req) {
  const explicitDryRun = cleanSupportText(req.query.dryRun || req.query.dry_run || req.body?.dryRun || req.body?.dry_run, 20);
  if (explicitDryRun) return !/^(0|false|no)$/i.test(explicitDryRun);
  const sendRequested = cleanSupportText(req.query.send || req.body?.send, 20);
  return !/^(1|true|yes)$/i.test(sendRequested);
}

app.all('/api/lifecycle/abandoned-signups/run', async (req, res) => {
  try {
    requireLifecycleSecret(req);
    const result = await lifecycleEmails.runAbandonedSignupCampaign({
      dryRun: lifecycleDryRun(req),
      limit: req.query.limit || req.body?.limit,
    });
    posthog.capture({
      distinctId: 'lifecycle-email-runner',
      event: 'lifecycle_abandoned_signup_run',
      properties: {
        dry_run: result.dryRun,
        eligible: result.eligible,
        sent: result.sent,
        failed: result.failed,
      },
    });
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.all('/api/lifecycle/abandoned-carts/run', async (req, res) => {
  try {
    requireLifecycleSecret(req);
    const result = await lifecycleEmails.runAbandonedCartCampaign({
      dryRun: lifecycleDryRun(req),
      limit: req.query.limit || req.body?.limit,
    });
    posthog.capture({
      distinctId: 'lifecycle-email-runner',
      event: 'lifecycle_abandoned_cart_run',
      properties: {
        dry_run: result.dryRun,
        eligible: result.eligible,
        sent: result.sent,
        failed: result.failed,
      },
    });
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.all('/api/lifecycle/incomplete-accounts/run', async (req, res) => {
  try {
    requireLifecycleSecret(req);
    const result = await lifecycleEmails.runIncompleteAccountOfferCampaign({
      dryRun: lifecycleDryRun(req),
      limit: req.query.limit || req.body?.limit,
    });
    posthog.capture({
      distinctId: 'lifecycle-email-runner',
      event: 'lifecycle_incomplete_account_offer_run',
      properties: {
        dry_run: result.dryRun,
        eligible: result.eligible,
        sent: result.sent,
        failed: result.failed,
      },
    });
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.post('/api/email/test', async (req, res) => {
  try {
    requireEmailTestSecret(req);
    const to = singleEmailRecipient(req.body?.to || req.query.to || 'hallpwj@gmail.com');
    if (!to) {
      return res.status(400).json({ error: 'A valid test recipient email is required.', code: 'email_test_recipient_required' });
    }

    const channel = normalizedSupportValue(req.body?.channel || req.query.channel, new Set(['support', 'lifecycle']), 'support');
    const delivery = await sendResendTestEmail({
      to,
      channel,
      origin: requestOrigin(req),
    });

    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      sent: true,
      pausedBypassedForTest: outboundEmailsPaused(),
      ...delivery,
    });
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.all('/api/email/broadcast/seven-day-trial/run', async (req, res) => {
  try {
    requireEmailTestSecret(req);
    const result = await lifecycleEmails.runSevenDayTrialBroadcast({
      dryRun: broadcastDryRun(req),
      limit: req.query.limit || req.body?.limit,
      confirm: req.query.confirm || req.body?.confirm,
    });
    posthog.capture({
      distinctId: 'seven-day-trial-broadcast-runner',
      event: 'seven_day_trial_broadcast_run',
      properties: {
        dry_run: result.dryRun,
        eligible: result.eligible,
        selected: result.selected,
        sent: result.sent,
        failed: result.failed,
        remaining_after_run: result.remaining_after_run,
      },
    });
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.all('/api/email/broadcast/ai-visibility-coming-soon/run', async (req, res) => {
  try {
    requireEmailTestSecret(req);
    const result = await lifecycleEmails.runAiVisibilityComingSoonBroadcast({
      dryRun: broadcastDryRun(req),
      limit: req.query.limit || req.body?.limit,
      confirm: req.query.confirm || req.body?.confirm,
    });
    posthog.capture({
      distinctId: 'ai-visibility-coming-soon-broadcast-runner',
      event: 'ai_visibility_coming_soon_broadcast_run',
      properties: {
        dry_run: result.dryRun,
        eligible: result.eligible,
        selected: result.selected,
        sent: result.sent,
        failed: result.failed,
        remaining_after_run: result.remaining_after_run,
      },
    });
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.all('/api/email/broadcast/client-list-acquisition/run', async (req, res) => {
  try {
    requireEmailTestSecret(req);
    const result = await lifecycleEmails.runClientListAcquisitionBroadcast({
      dryRun: broadcastDryRun(req),
      limit: req.query.limit || req.body?.limit,
      confirm: req.query.confirm || req.body?.confirm,
    });
    posthog.capture({
      distinctId: 'client-list-acquisition-broadcast-runner',
      event: 'client_list_acquisition_broadcast_run',
      properties: {
        dry_run: result.dryRun,
        eligible: result.eligible,
        selected: result.selected,
        sent: result.sent,
        failed: result.failed,
        remaining_after_run: result.remaining_after_run,
      },
    });
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.all('/api/email/broadcast/first-month-discount-sequence/run', async (req, res) => {
  try {
    requireEmailTestSecret(req);
    const result = await lifecycleEmails.runFirstMonthDiscountSequenceBroadcast({
      dryRun: broadcastDryRun(req),
      limit: req.query.limit || req.body?.limit,
      confirm: req.query.confirm || req.body?.confirm,
      startAt: req.query.startAt || req.body?.startAt,
      nowMs: req.query.nowMs || req.body?.nowMs,
    });
    posthog.capture({
      distinctId: 'first-month-discount-sequence-runner',
      event: 'first_month_discount_sequence_run',
      properties: {
        dry_run: result.dryRun,
        campaign_expired: result.campaign_expired,
        step: result.step,
        eligible: result.eligible,
        selected: result.selected,
        sent: result.sent,
        failed: result.failed,
        remaining_after_run: result.remaining_after_run,
      },
    });
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.get('/api/email/unsubscribe', async (req, res) => {
  const email = cleanSupportText(req.query.email, 320);
  const campaign = cleanSupportText(req.query.campaign || lifecycleEmails.CAMPAIGN_KEY, 80);
  const token = cleanSupportText(req.query.token, 200);

  try {
    if (!lifecycleEmails.verifyToken(email, campaign, token)) {
      throw billing.httpError(400, 'This unsubscribe link is invalid or expired.', 'unsubscribe_invalid');
    }
    await lifecycleEmails.unsubscribe(email, campaign);
    res.set('Cache-Control', 'no-store');
    res.type('html').send(`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width,initial-scale=1">
          <title>Unsubscribed</title>
          <style>
            body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f5f7;color:#1d1d1f;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
            main{width:min(520px,calc(100% - 32px));padding:28px;border:1px solid #e5e5ea;border-radius:18px;background:#fff;box-shadow:0 18px 48px rgba(0,0,0,.08)}
            h1{margin:0 0 10px;font-size:28px;letter-spacing:0}
            p{margin:0;color:#6e6e73;line-height:1.6}
          </style>
        </head>
        <body><main><h1>You are unsubscribed.</h1><p>You will no longer receive account setup reminders from PitchProof.</p></main></body>
      </html>`);
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.post('/api/analytics/event', (req, res) => {
  const event = String(req.body?.event || '').trim();
  if (!ALLOWED_CLIENT_ANALYTICS_EVENTS.has(event)) {
    return res.status(400).json({ error: 'Unsupported analytics event.' });
  }

  const distinctId = String(req.body?.distinctId || req.headers['x-posthog-distinct-id'] || req.ip || 'anonymous').trim();
  posthog.capture({
    distinctId,
    event,
    properties: {
      ...(req.body?.properties && typeof req.body.properties === 'object' ? req.body.properties : {}),
      page_path: req.body?.page_path || '',
    },
  });
  res.json({ ok: true });
});

app.post('/api/support/request', async (req, res) => {
  try {
    const { user } = await billing.requireAuthenticatedUser(req);
    const body = req.body || {};
    const replyPhone = cleanSupportText(body.replyPhone || body.reply_phone || body.phone, 80);
    const subject = cleanSupportText(body.subject, 160);
    const message = cleanSupportText(body.message, 4000);

    if (!replyPhone || replyPhone.replace(/\D/g, '').length < 7) {
      return res.status(400).json({ error: 'Please add a valid phone number for text support.', code: 'support_phone_required' });
    }
    if (!subject) {
      return res.status(400).json({ error: 'Please add a short subject.', code: 'support_subject_required' });
    }
    if (!message || message.length < 10) {
      return res.status(400).json({ error: 'Please describe the issue in a little more detail.', code: 'support_message_required' });
    }

    const ticketId = `SUP-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const payload = {
      ticket_id: ticketId,
      source: 'customer_service_portal',
      category: 'support',
      urgency: 'normal',
      subject,
      message,
      affected_url: cleanSupportText(body.pageUrl || body.page_url, 1000),
      preferred_reply_method: 'text',
      reply_email: cleanSupportText(user.email, 320),
      reply_phone: replyPhone,
      page_url: cleanSupportText(body.pageUrl || body.page_url, 1000),
      user_agent: cleanSupportText(body.userAgent || body.user_agent || req.get('user-agent'), 500),
      app_url: requestOrigin(req),
      user: {
        id: user.id,
        email: user.email || '',
        name: cleanSupportText(user.user_metadata?.name || user.user_metadata?.full_name, 160),
      },
      agency: {
        name: cleanSupportText(body.agencyName || body.agency_name, 160),
      },
      created_at: new Date().toISOString(),
    };

    const notification = await sendSupportNotification(payload);
    if (notification.error) {
      console.warn('[PitchProof] Support notification failed:', notification.error);
    }

    posthog.capture({
      distinctId: user.id,
      event: 'support_request_submitted',
      properties: {
        ticket_id: ticketId,
        category: payload.category,
        urgency: payload.urgency,
        preferred_reply_method: payload.preferred_reply_method,
        notification_configured: notification.configured,
        notification_sent: notification.sent,
        email_configured: notification.email.configured,
        email_sent: notification.email.sent,
        email_paused: notification.email.paused === true,
        webhook_configured: notification.webhook.configured,
        webhook_sent: notification.webhook.sent,
        ghl_webhook_configured: notification.ghlWebhook.configured,
        ghl_webhook_sent: notification.ghlWebhook.sent,
      },
    });

    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      ticketId,
      notificationConfigured: notification.configured,
      notificationSent: notification.sent,
      notificationPaused: notification.paused === true,
      warning: notification.paused
        ? ''
        : notification.configured && !notification.sent
        ? 'Support request received, but the text message notification did not send.'
        : !notification.configured
          ? 'Support request received, but text message alerts are not configured yet.'
          : '',
    });
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

function normalizeSupabasePublicUrl(rawUrl = '') {
  return String(rawUrl || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1$/i, '')
    .replace(/\/auth\/v1$/i, '');
}

function normalizeSupabasePublicKey(rawKey = '') {
  return String(rawKey || '').replace(/\s+/g, '');
}

app.get('/api/auth-config', (req, res) => {
  const supabaseUrl = normalizeSupabasePublicUrl(process.env.SUPABASE_URL || '');
  const supabaseAnonKey = normalizeSupabasePublicKey(process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '');

  res.set('Cache-Control', 'no-store');
  res.json({
    supabaseUrl,
    supabaseAnonKey,
    configured: Boolean(supabaseUrl && supabaseAnonKey),
  });
});

app.get('/api/billing/config', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(billing.billingConfigStatus());
});

app.post('/api/internal/ai-visibility/test', async (req, res) => {
  try {
    requireAiVisibilityTestSecret(req);
    const result = await runAiVisibilityPrompt(req.body || {});
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.post('/api/internal/ai-visibility/assessment-test', async (req, res) => {
  try {
    requireAiVisibilityTestSecret(req);
    const result = await runAiVisibilityAssessment(req.body || {});
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.post('/api/internal/keyword-ranking/test', async (req, res) => {
  try {
    requireKeywordRankingTestSecret(req);
    const result = await runKeywordRankingAnalysis(req.body || {});
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.get('/api/billing/subscription', async (req, res) => {
  try {
    const { user } = await billing.requireAuthenticatedUser(req);
    const subscription = await billing.getSubscriptionStatus(user.id);
    res.set('Cache-Control', 'no-store');
    res.json({ subscription });
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.get('/api/branding', async (req, res) => {
  try {
    const { user } = await billing.requireAuthenticatedUser(req);
    const [subscription, brandingRecord] = await Promise.all([
      billing.getSubscriptionStatus(user.id),
      billing.getAgencyBrandingForUser(user.id).catch(() => null),
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({ branding: brandingRecord || null, subscription });
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.put('/api/branding', async (req, res) => {
  try {
    const { user } = await billing.requireAuthenticatedUser(req);
    let subscription = await billing.getSubscriptionStatus(user.id);
    if (!subscription.can_white_label && subscription.stripe_subscription_id) {
      subscription = await billing.refreshSubscriptionFromStripeForUser(user.id).catch(error => {
        console.warn('[PitchProof] Branding subscription refresh failed:', error?.message || error);
        return subscription;
      });
    }
    if (!subscription.can_white_label) {
      const planName = subscription.plan_name || subscription.plan || 'unknown plan';
      const status = subscription.status || 'unknown status';
      return res.status(403).json({
        error: `Branding is available on an active or trialing Professional, Growth, or Enterprise plan. Current workspace: ${planName}, ${status}.`,
        code: 'white_label_upgrade_required',
        subscription,
      });
    }

    const branding = await billing.updateAgencyBrandingForUser(user.id, req.body || {});
    res.set('Cache-Control', 'no-store');
    res.json({ branding, subscription });
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.get('/api/billing/diagnostics', async (req, res) => {
  try {
    const { user } = await billing.requireAuthenticatedUser(req);
    const diagnostics = await billing.getBillingDiagnostics(user);
    res.set('Cache-Control', 'no-store');
    res.json({ diagnostics });
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.post('/api/account/provision', async (req, res) => {
  try {
    const { user } = await billing.requireAuthenticatedUser(req);
    const account = await billing.ensureAppUser(user);
    res.set('Cache-Control', 'no-store');
    res.json({ account });
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.post('/api/billing/checkout', async (req, res) => {
  try {
    const { user } = await billing.requireAuthenticatedUser(req);
    const session = await billing.createCheckoutSession(req, user, req.body || {});
    posthog.capture({
      distinctId: user.id,
      event: 'plan_selected',
      properties: {
        plan: session.plan?.key || req.body?.plan || billing.PROFESSIONAL_PLAN.key,
        checkout_offer: session.checkout_offer || '',
        checkout_offer_label: session.checkout_offer_label || '',
      },
    });
    posthog.capture({
      distinctId: user.id,
      event: 'checkout_started',
      properties: {
        plan: session.plan?.key || req.body?.plan || billing.PROFESSIONAL_PLAN.key,
        checkout_offer: session.checkout_offer || '',
        checkout_offer_label: session.checkout_offer_label || '',
      },
    });
    res.json(session);
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.post('/api/billing/start-paid-now', async (req, res) => {
  try {
    const { user } = await billing.requireAuthenticatedUser(req);
    const result = await billing.startPaidSubscriptionNow(req, user, req.body || {});
    posthog.capture({
      distinctId: user.id,
      event: 'paid_billing_started',
      properties: { plan: req.body?.plan || billing.PROFESSIONAL_PLAN.key },
    });
    res.json(result);
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.post('/api/billing/change-plan', async (req, res) => {
  try {
    const { user } = await billing.requireAuthenticatedUser(req);
    const result = await billing.changeSubscriptionPlan(req, user, req.body || {});
    posthog.capture({
      distinctId: user.id,
      event: result.url ? 'plan_switch_started' : 'plan_changed',
      properties: {
        plan: result.currentPlan || req.body?.plan || billing.PROFESSIONAL_PLAN.key,
        previous_plan: result.previousPlan || '',
        plan_change: result.planChange || '',
      },
    });
    res.json(result);
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.post('/api/billing/portal', async (req, res) => {
  try {
    const { user } = await billing.requireAuthenticatedUser(req);
    const session = await billing.createBillingPortalSession(req, user);
    posthog.capture({
      distinctId: user.id,
      event: 'billing_portal_opened',
      properties: { plan: billing.PROFESSIONAL_PLAN.key },
    });
    res.json(session);
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

function auditBlockMessage(reason, subscription = {}) {
  if (reason === 'complimentary_scan_used') {
    return 'Your complimentary report preview has already been used. Choose a plan to generate additional reports.';
  }
  if (reason === 'complimentary_scan_in_progress') {
    return 'Your free report preview is already being prepared. Please wait for it to finish before starting another scan.';
  }
  if (reason === 'audit_limit_reached') {
    return 'You have used all of your available scans for this billing period. Upgrade your plan or wait until your next renewal date to continue generating reports.';
  }
  if (reason === 'subscription_expired') {
    return 'Your subscription period has ended. Manage billing to continue running audits.';
  }
  if (reason === 'no_subscription') {
    return 'Choose a subscription plan to start generating professional website assessments.';
  }
  return 'Choose an active subscription plan to continue generating professional website assessments.';
}

function auditBlockStatus(reason) {
  if (reason === 'audit_limit_reached') return 429;
  return 402;
}

const AI_VISIBILITY_COUNTRY_CODES = new Map([
  ['ca', 'CA'],
  ['canada', 'CA'],
  ['us', 'US'],
  ['usa', 'US'],
  ['united states', 'US'],
  ['united states of america', 'US'],
  ['gb', 'GB'],
  ['uk', 'GB'],
  ['united kingdom', 'GB'],
  ['great britain', 'GB'],
]);

function aiVisibilityCustomerFeatureEnabled() {
  return /^(1|true|yes|on)$/i.test(cleanSupportText(process.env.AI_VISIBILITY_CUSTOMER_ENABLED, 20));
}

function normalizeAiVisibilityCountry(value = '') {
  return AI_VISIBILITY_COUNTRY_CODES.get(cleanSupportText(value, 80).toLowerCase()) || '';
}

function normalizeAiVisibilityDomain(rawValue = '') {
  const raw = cleanSupportText(rawValue, 500);
  if (!raw) return '';
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withProtocol).hostname.replace(/^www\./i, '').replace(/\.$/, '').toLowerCase();
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

function customerAiVisibilityInput(body = {}) {
  const countryCode = normalizeAiVisibilityCountry(body.country || body.countryCode || body.country_code);
  const input = {
    businessName: cleanSupportText(body.businessName || body.business_name, 160),
    domain: normalizeAiVisibilityDomain(body.domain || body.website || body.websiteUrl || body.website_url),
    businessCategory: cleanSupportText(body.businessCategory || body.business_category, 120),
    primaryService: cleanSupportText(body.primaryService || body.primary_service, 120),
    city: cleanSupportText(body.city, 80),
    region: cleanSupportText(body.region, 80),
    countryCode,
  };
  const missing = [];
  if (!input.businessName) missing.push('Business Name');
  if (!input.domain) missing.push('Website URL / Domain');
  if (!input.businessCategory) missing.push('Business Category');
  if (!input.primaryService) missing.push('Primary Service');
  if (!input.city) missing.push('City');
  if (!input.region) missing.push('Region');
  if (!input.countryCode) missing.push('Country');
  if (missing.length) {
    throw billing.httpError(400, `Missing required fields: ${missing.join(', ')}.`, 'ai_visibility_invalid_input', { missing });
  }
  return input;
}

function aiVisibilityBlockStatus(reason) {
  return reason === 'ai_visibility_limit_reached' ? 429 : 402;
}

function aiVisibilityBlockMessage(reason) {
  if (reason === 'ai_visibility_limit_reached') {
    return 'You have used all of your AI Visibility reports for this billing period. Upgrade your plan or wait until the next renewal date to continue.';
  }
  if (reason === 'subscription_inactive') {
    return 'Choose an active subscription plan to run AI Visibility reports.';
  }
  return 'Choose a subscription plan to run AI Visibility reports.';
}

app.get('/api/ai-visibility/reports', async (req, res) => {
  try {
    const { user } = await billing.requireAuthenticatedUser(req);
    const reports = await billing.listAiVisibilityReportsForUser(user.id, {
      search: req.query.search,
      limit: req.query.limit,
    });
    res.set('Cache-Control', 'no-store');
    res.json({ reports });
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.get('/api/ai-visibility/reports/:reportId', async (req, res) => {
  try {
    const { user } = await billing.requireAuthenticatedUser(req);
    const report = await billing.getAiVisibilityReportForUserForClient(user.id, req.params.reportId);
    posthog.capture({
      distinctId: user.id,
      event: 'ai_visibility_report_viewed',
      properties: {
        report_id: report.id,
        score: report.score,
        status: report.status,
      },
    });
    res.set('Cache-Control', 'no-store');
    res.json({ report });
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.post('/api/ai-visibility/scans', async (req, res) => {
  let authContext = null;
  let input = null;
  let savedReport = null;
  try {
    authContext = await billing.requireAuthenticatedUser(req);

    if (!aiVisibilityCustomerFeatureEnabled()) {
      throw billing.httpError(503, 'AI Visibility reports are coming soon and are not available yet.', 'ai_visibility_disabled');
    }

    input = customerAiVisibilityInput(req.body || {});

    const access = await billing.checkAiVisibilityAccessForUser(authContext.user.id);
    if (!access.allowed) {
      const subscription = billing.normalizeSubscriptionForClient(access.subscription);
      posthog.capture({
        distinctId: authContext.user.id,
        event: 'ai_visibility_limit_reached',
        properties: {
          reason: access.reason,
          plan: subscription.plan,
          ai_scan_limit: subscription.ai_scan_limit,
          ai_scans_used: subscription.ai_scans_used,
          ai_scans_remaining: subscription.ai_scans_remaining,
        },
      });
      return res.status(aiVisibilityBlockStatus(access.reason)).json({
        error: aiVisibilityBlockMessage(access.reason),
        code: access.reason,
        subscription,
      });
    }

    posthog.capture({
      distinctId: authContext.user.id,
      event: 'ai_visibility_scan_started',
      properties: {
        business_category: input.businessCategory,
        city: input.city,
        region: input.region,
        country_code: input.countryCode,
        plan: billing.normalizeSubscriptionForClient(access.subscription).plan,
      },
    });

    const assessment = await runAiVisibilityAssessment(input);
    if (assessment.status !== 'complete' || Number(assessment.successfulRequests) < 3) {
      throw billing.httpError(
        422,
        'AI Visibility could not be completed because fewer than three searches returned usable results. No AI scan was used.',
        'ai_visibility_insufficient_data',
        {
          status: assessment.status,
          successfulRequests: assessment.successfulRequests || 0,
          failedRequests: assessment.failedRequests || 0,
        }
      );
    }

    savedReport = await billing.createAiVisibilityReportForUser(authContext.user.id, input, assessment);
    const usage = await billing.recordAiVisibilityUsage(authContext.user.id, savedReport.id);
    if (!usage?.allowed) {
      await billing.deleteAiVisibilityReportForUser(authContext.user.id, savedReport.id).catch(error => {
        console.warn('[PitchProof] AI Visibility report cleanup failed:', error?.message || error);
      });
      const subscription = billing.normalizeSubscriptionForClient(usage?.subscription || access.subscription);
      return res.status(aiVisibilityBlockStatus(usage?.reason)).json({
        error: aiVisibilityBlockMessage(usage?.reason),
        code: usage?.reason || 'ai_visibility_limit_reached',
        subscription,
      });
    }

    const report = await billing.getAiVisibilityReportForUserForClient(authContext.user.id, savedReport.id);
    console.log('[AI Visibility] report saved', {
      reportId: report.id,
      userId: authContext.user.id,
      status: report.status,
      score: report.score,
      label: report.label,
      promptsTested: report.prompts_tested,
      successfulRequests: report.successful_requests,
      failedRequests: report.failed_requests,
      mentions: report.mention_count,
      recommendations: report.recommendation_count,
      citations: report.citation_count,
      providerCost: assessment.totalCost,
    });
    const subscription = billing.normalizeSubscriptionForClient(usage.subscription);
    posthog.capture({
      distinctId: authContext.user.id,
      event: 'ai_visibility_scan_completed',
      properties: {
        report_id: report.id,
        score: report.score,
        label: report.label,
        prompts_tested: report.prompts_tested,
        successful_requests: report.successful_requests,
        failed_requests: report.failed_requests,
        plan: subscription.plan,
      },
    });

    res.set('Cache-Control', 'no-store');
    res.json({
      reportId: report.id,
      report,
      subscription,
    });
  } catch (error) {
    if (authContext?.user?.id) {
      posthog.capture({
        distinctId: authContext.user.id,
        event: 'ai_visibility_scan_failed',
        properties: {
          reason: error?.code || 'request_failed',
          status_code: error?.statusCode || 500,
          business_category: input?.businessCategory || '',
          city: input?.city || '',
          country_code: input?.countryCode || '',
        },
      });
    }
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

function normalizeLeadUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return '';
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function sanitizeLead(body = {}) {
  return {
    name: String(body.name || '').trim(),
    businessName: String(body.businessName || '').trim(),
    email: String(body.email || '').trim(),
    phone: String(body.phone || '').trim(),
    website: normalizeLeadUrl(body.website || body.url),
  };
}

function normalizeScoreValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace('%', '').trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function extractWebsiteScore(result = {}) {
  return normalizeScoreValue(
    result.total ??
    result.score ??
    result.websiteScore ??
    result.rating
  );
}

function compactServerText(value, maxLength = 1600) {
  const text = typeof value === 'string' ? value : String(value || '');
  if (/^data:image\//i.test(text) || /^data:application\//i.test(text)) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function compactServerValue(value, depth = 0, key = '') {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return compactServerText(value, depth > 1 ? 900 : 1600);
  if (depth > 5) return null;

  if (Array.isArray(value)) {
    const lowerKey = key.toLowerCase();
    const limit = /pageslist|pagesscanned|pagescrawled/.test(lowerKey) ? 60 : (depth <= 1 ? 60 : 24);
    return value
      .slice(0, limit)
      .map(item => compactServerValue(item, depth + 1, key))
      .filter(item => item !== undefined && item !== null && item !== '');
  }

  if (typeof value !== 'object') return value;

  const compact = {};
  Object.entries(value).forEach(([childKey, childValue]) => {
    const lowerKey = childKey.toLowerCase();
    const rawString = typeof childValue === 'string' ? childValue : '';
    const isHeavyKey = /screenshot|rawhtml|pagehtml|htmlcontent|base64|buffer|trace|har|snapshot|imagebuffer|imagedata|blob/.test(lowerKey);
    const isHugeString = rawString.length > 8000;
    if (isHeavyKey || isHugeString || /^data:image\//i.test(rawString)) return;

    const next = compactServerValue(childValue, depth + 1, childKey);
    if (next === undefined || next === null || next === '') return;
    if (Array.isArray(next) && !next.length) return;
    if (next && typeof next === 'object' && !Array.isArray(next) && !Object.keys(next).length) return;
    compact[childKey] = next;
  });
  return compact;
}

function reportDataForServerSave(result = {}, context = {}) {
  return {
    report: compactServerValue(result),
    context: {
      prospectName: String(context.prospectName || '').trim(),
      companyName: String(context.companyName || '').trim(),
      notes: String(context.notes || '').trim(),
      requestedWebsite: String(context.requestedWebsite || result.url || '').trim(),
      generatedAt: new Date().toISOString(),
    },
  };
}

async function optionalAiVisibility(result = {}, context = {}) {
  try {
    return await enrichReportWithAiVisibility(result, context);
  } catch (error) {
    console.warn('[PitchProof] AI visibility enrichment skipped:', error?.message || error);
    return result;
  }
}

async function optionalKeywordRanking(result = {}, context = {}) {
  if (!keywordRankingFeatureEnabled()) return result;
  try {
    const keywordRanking = await runKeywordRankingAnalysis({
      domain: context.requestedWebsite || result.url,
      countryCode: context.countryCode || context.country || result.countryCode || result.country_code,
      languageCode: context.languageCode || context.language_code || result.languageCode || result.language_code || 'en',
    });
    if (!keywordRanking || keywordRanking.status === 'disabled') return result;
    return {
      ...result,
      keywordRanking,
    };
  } catch (error) {
    console.warn('[Keyword Ranking] enrichment skipped:', error?.message || error);
    return result;
  }
}

async function sendLeadToGHL(lead, score = null, extra = {}) {
  const webhookUrl = process.env.GHL_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('[PitchProof] GHL_WEBHOOK_URL is not configured; lead webhook skipped.');
    return { skipped: true };
  }

  const normalizedScore = normalizeScoreValue(score);

  const payload = {
    name: lead.name,
    businessName: lead.businessName,
    email: lead.email,
    phone: lead.phone,
    website: lead.website,
    score: normalizedScore,
    websiteScore: normalizedScore,
    timestamp: new Date().toISOString(),
    ...extra,
  };

  console.log('[PitchProof][GHL] Sending lead to GoHighLevel');
  console.log('[PitchProof][GHL] Website score:', normalizedScore);
  console.log('[PitchProof][GHL] Payload:', JSON.stringify(payload, null, 2));

  let response;
  try {
    response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.error('[PitchProof][GHL] Webhook failed:', error.message);
    throw error;
  }

  console.log('[PitchProof][GHL] Webhook status:', response.status);

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const error = new Error(`GHL webhook failed with HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    console.error('[PitchProof][GHL] Webhook failed:', error.message);
    throw error;
  }

  return { sent: true };
}

app.post('/api/analyze', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  // Support debug mode via ?debug=1 or { debug: true } in body
  const debugMode = !!(req.query.debug || req.body.debug);
  let authContext = null;
  let auditIdempotencyKey = '';
  let auditReservation = null;
  const distinctId = req.headers['x-posthog-distinct-id'] || url;
  const sessionId = req.headers['x-posthog-session-id'];

  try {
    authContext = await billing.requireAuthenticatedUser(req);
    auditIdempotencyKey = String(req.headers['x-audit-idempotency-key'] || crypto.randomUUID());
    const reservation = await billing.reserveAuditUsage(authContext.user.id, auditIdempotencyKey);
    auditReservation = reservation;

    if (!reservation?.allowed) {
      const subscription = billing.normalizeSubscriptionForClient(reservation?.subscription);
      posthog.capture({
        distinctId: authContext.user.id,
        event: 'scan_limit_reached',
        properties: {
          reason: reservation?.reason || 'subscription_unavailable',
          plan: subscription.plan,
          audits_used: subscription.audits_used,
          audit_limit: subscription.audit_limit,
          remaining_scans: subscription.remaining_scans,
          ...(sessionId && { $session_id: sessionId }),
        },
      });
      return res.status(auditBlockStatus(reservation?.reason)).json({
        error: auditBlockMessage(reservation?.reason, subscription),
        code: reservation?.reason || 'subscription_unavailable',
        subscription,
      });
    }
    if (reservation?.complimentary) {
      posthog.capture({
        distinctId: authContext.user.id,
        event: 'free_preview_started',
        properties: {
          source: 'onboarding',
          ...(sessionId && { $session_id: sessionId }),
        },
      });
    }
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    return res.status(statusCode).json(body);
  }

  try {
    const reportContext = {
      prospectName: req.body.prospectName,
      companyName: req.body.companyName,
      notes: req.body.notes,
      requestedWebsite: url,
      countryCode: req.body.countryCode || req.body.country_code || req.body.country,
      languageCode: req.body.languageCode || req.body.language_code,
    };
    let result = await analyzeWebsite(url, { debug: debugMode });
    result = await optionalAiVisibility(result, reportContext);
    result = await optionalKeywordRanking(result, reportContext);
    const score = extractWebsiteScore(result);
    if (!auditReservation?.complimentary) {
      await billing.completeAuditUsage(authContext.user.id, auditIdempotencyKey, {
        websiteUrl: url,
        websiteScore: score,
      }).catch(error => {
        console.warn('[PitchProof] Audit usage completion failed:', error?.message || error);
      });
    }
    if (auditReservation?.complimentary) {
      const report = await billing.createReportForUser(authContext.user.id, {
        websiteUrl: url,
        websiteScore: score,
        scanStatus: 'completed',
        auditIdempotencyKey,
        reportData: reportDataForServerSave(result, {
          prospectName: req.body.prospectName,
          companyName: req.body.companyName,
          notes: req.body.notes,
          requestedWebsite: url,
        }),
      });
      const previewReport = await billing.getReportForUserForClient(authContext.user.id, report.id);
      const previewPayload = previewReport.report_data?.report || {};
      posthog.capture({
        distinctId: authContext.user.id,
        event: 'website analyzed',
        properties: {
          url,
          score,
          complimentary_preview: true,
          ...(sessionId && { $session_id: sessionId }),
        },
      });
      posthog.capture({
        distinctId: authContext.user.id,
        event: 'free_preview_completed',
        properties: {
          report_id: report?.id || '',
          website_url: url,
          score,
          ...(sessionId && { $session_id: sessionId }),
        },
      });
      return res.json({
        ...previewPayload,
        billing: {
          complimentary_scan: true,
          complimentary_preview: true,
          report_saved: true,
          audit_idempotency_key: auditIdempotencyKey,
          report_id: report?.id || '',
        },
        saved_report_id: report?.id || '',
        preview_locked: true,
        full_report_locked: true,
      });
    }
    posthog.capture({
      distinctId: authContext.user.id || distinctId,
      event: 'website analyzed',
      properties: {
        url,
        score,
        ...(sessionId && { $session_id: sessionId }),
      },
    });
    res.json(result);
  } catch (err) {
    if (authContext?.user?.id && auditIdempotencyKey) {
      await billing.refundAuditUsage(authContext.user.id, auditIdempotencyKey).catch(error => {
        console.warn('[PitchProof] Audit usage refund failed:', error?.message || error);
      });
    }
    posthog.captureException(err, authContext?.user?.id || distinctId, { url });
    posthog.capture({
      distinctId: authContext?.user?.id || distinctId,
      event: 'website analysis failed',
      properties: { url, error: err.message },
    });
    res.status(500).json({ error: err.message || 'Analysis failed' });
  }
});

app.get('/api/leads/config', async (req, res) => {
  try {
    await billing.requireAuthenticatedUser(req);
    res.set('Cache-Control', 'no-store');
    res.json({ leadFinder: businessSearchProvider.leadFinderConfigStatus() });
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.get('/api/leads/recent-searches', async (req, res) => {
  try {
    const { user } = await billing.requireAuthenticatedUser(req);
    const searches = await leads.listRecentLeadSearchesForUser(user.id, { limit: req.query.limit });
    res.set('Cache-Control', 'no-store');
    res.json({ searches });
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.post('/api/leads/search', async (req, res) => {
  try {
    const { user } = await billing.requireAuthenticatedUser(req);
    checkLeadSearchRateLimit(user.id);

    // Preflight the user-owned lead table before making a paid provider request.
    await leads.listLeadsForUser(user.id, { limit: 1 });

    const subscription = await billing.getSubscriptionStatus(user.id);
    const leadUsageBeforeSearch = await leadDiscoveryUsageForSearch(user.id, subscription);
    if (!leadUsageBeforeSearch.unlimited && leadUsageBeforeSearch.remaining <= 0) {
      throw billing.httpError(
        402,
        'Starter includes 3,000 Lead Finder results per month. Upgrade to Professional for unlimited lead discovery.',
        'lead_discovery_limit_reached',
        leadUsageBeforeSearch
      );
    }

    const providerInput = { ...(req.body || {}) };
    if (!leadUsageBeforeSearch.unlimited) {
      providerInput.limit = Math.min(requestedLeadLimit(providerInput), leadUsageBeforeSearch.remaining);
    }

    const providerResult = await businessSearchProvider.searchBusinessListings(providerInput);
    const decoratedResults = await leads.decorateBusinessResultsForUser(user.id, providerResult.results || []);
    const leadDiscoveryUsage = leadUsageBeforeSearch.unlimited
      ? leadUsageBeforeSearch
      : {
        ...leadUsageBeforeSearch,
        used: leadUsageBeforeSearch.used + decoratedResults.length,
        remaining: Math.max(0, leadUsageBeforeSearch.remaining - decoratedResults.length),
      };
    await leads.recordLeadSearchForUser(user.id, providerInput, {
      ...providerResult,
      result_count: decoratedResults.length,
    }).catch(error => {
      console.warn('[PitchProof] Lead search history could not be recorded:', error?.message || error);
    });

    posthog.capture({
      distinctId: user.id,
      event: 'lead_finder_search_completed',
      properties: {
        provider: providerResult.provider,
        cached: Boolean(providerResult.cached),
        result_count: decoratedResults.length,
        query: req.body?.businessType || req.body?.query || '',
        location: req.body?.location || '',
      },
    });

    res.set('Cache-Control', 'no-store');
    res.json({
      ...providerResult,
      lead_discovery_usage: leadDiscoveryUsage,
      result_count: decoratedResults.length,
      results: decoratedResults,
    });
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.get('/api/leads', async (req, res) => {
  try {
    const { user } = await billing.requireAuthenticatedUser(req);
    const savedLeads = await leads.listLeadsForUser(user.id, {
      search: req.query.search,
      status: req.query.status,
      sort: req.query.sort,
      limit: req.query.limit,
    });
    res.set('Cache-Control', 'no-store');
    res.json({ leads: savedLeads });
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.post('/api/leads', async (req, res) => {
  try {
    const { user } = await billing.requireAuthenticatedUser(req);
    const lead = await leads.saveLeadForUser(user.id, req.body?.lead || req.body || {});
    posthog.capture({
      distinctId: user.id,
      event: 'lead_saved',
      properties: {
        lead_id: lead?.id || '',
        duplicate: Boolean(lead?.duplicate),
        source: lead?.source || '',
      },
    });
    res.status(lead?.duplicate ? 200 : 201).json({ lead });
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.patch('/api/leads/:leadId', async (req, res) => {
  try {
    const { user } = await billing.requireAuthenticatedUser(req);
    const lead = await leads.updateLeadForUser(user.id, String(req.params.leadId || '').trim(), req.body || {});
    res.set('Cache-Control', 'no-store');
    res.json({ lead });
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.post('/api/leads/:leadId/find-email', async (req, res) => {
  try {
    const { user } = await billing.requireAuthenticatedUser(req);
    const leadId = String(req.params.leadId || '').trim();
    const lead = await leads.getLeadForUser(user.id, leadId);
    if (!lead.website_url && !lead.website_domain) {
      throw billing.httpError(
        400,
        'Add or find a website for this lead before searching for an email.',
        'lead_email_website_required'
      );
    }

    const result = await emailFinder.findPublicEmailForLead(lead);
    if (!result.email) {
      posthog.capture({
        distinctId: user.id,
        event: 'lead_email_not_found',
        properties: {
          lead_id: lead.id,
          website_domain: lead.website_domain || '',
          pages_checked: result.pagesChecked || 0,
        },
      });
      res.set('Cache-Control', 'no-store');
      return res.json({ lead, email_result: result });
    }

    const updatedLead = await leads.updateLeadForUser(user.id, lead.id, {
      email: result.email,
      emailSourceUrl: result.sourceUrl,
      emailConfidence: result.confidence,
      emailFoundAt: new Date().toISOString(),
    });
    posthog.capture({
      distinctId: user.id,
      event: 'lead_email_found',
      properties: {
        lead_id: lead.id,
        website_domain: lead.website_domain || '',
        confidence: result.confidence || '',
        pages_checked: result.pagesChecked || 0,
      },
    });
    res.set('Cache-Control', 'no-store');
    res.json({ lead: updatedLead, email_result: result });
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.delete('/api/leads/:leadId', async (req, res) => {
  try {
    const { user } = await billing.requireAuthenticatedUser(req);
    await leads.deleteLeadForUser(user.id, String(req.params.leadId || '').trim());
    res.status(204).send('');
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.get('/api/reports', async (req, res) => {
  try {
    const { user } = await billing.requireAuthenticatedUser(req);
    const reports = await billing.listReportsForUser(user.id, {
      search: req.query.search,
      sort: req.query.sort,
      limit: req.query.limit,
    });
    res.set('Cache-Control', 'no-store');
    res.json({ reports });
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.post('/api/reports', async (req, res) => {
  try {
    const { user } = await billing.requireAuthenticatedUser(req);
    const report = await billing.createReportForUser(user.id, req.body || {});
    const clientReport = await billing.getReportForUserForClient(user.id, report.id);
    posthog.capture({
      distinctId: user.id,
      event: 'report_saved',
      properties: {
        report_id: report?.id || '',
        website_url: report?.website_url || '',
      },
    });
    if (report?.complimentary_scan_completed) {
      posthog.capture({
        distinctId: user.id,
        event: 'complimentary_scan_completed',
        properties: {
          report_id: report?.id || '',
          website_url: report?.website_url || '',
        },
      });
    }
    res.status(201).json({ report: clientReport });
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.get('/api/reports/:reportId', async (req, res) => {
  try {
    const { user } = await billing.requireAuthenticatedUser(req);
    const report = await billing.getReportForUserForClient(user.id, String(req.params.reportId || '').trim());
    res.set('Cache-Control', 'no-store');
    res.json({ report });
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.post('/api/reports/:reportId/duplicate', async (req, res) => {
  try {
    const { user } = await billing.requireAuthenticatedUser(req);
    const subscription = await billing.getSubscriptionStatus(user.id);
    if (!subscription.can_duplicate_reports) {
      return res.status(402).json({
        error: 'Choose a plan to duplicate reports and generate additional assessments.',
        code: 'subscription_required',
        subscription,
      });
    }
    const report = await billing.duplicateReportForUser(user.id, String(req.params.reportId || '').trim());
    posthog.capture({
      distinctId: user.id,
      event: 'report_duplicated',
      properties: {
        source_report_id: String(req.params.reportId || '').trim(),
        report_id: report?.id || '',
      },
    });
    res.status(201).json({ report });
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.delete('/api/reports/:reportId', async (req, res) => {
  try {
    const { user } = await billing.requireAuthenticatedUser(req);
    await billing.deleteReportForUser(user.id, String(req.params.reportId || '').trim());
    posthog.capture({
      distinctId: user.id,
      event: 'report_deleted',
      properties: { report_id: String(req.params.reportId || '').trim() },
    });
    res.json({ ok: true });
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.get('/api/reports/:reportId/pdf', async (req, res) => {
  const reportId = String(req.params.reportId || '').trim();
  if (!reportId) return res.status(400).json({ error: 'Report ID is required.' });

  let user = null;
  try {
    ({ user } = await billing.requireAuthenticatedUser(req));
    const subscription = await billing.getSubscriptionStatus(user.id);
    if (!subscription.can_export_pdf) {
      return res.status(402).json({
        error: 'Choose an active subscription plan to export branded PDFs.',
        code: 'subscription_required',
        subscription,
      });
    }

    posthog.capture({
      distinctId: user.id,
      event: 'pdf_export_started',
      properties: { report_id: reportId },
    });

    const [report, brandingRecord] = await Promise.all([
      billing.getReportForUser(user.id, reportId),
      billing.getAgencyBrandingForUser(user.id).catch(() => null),
    ]);
    const effectiveBranding = billing.reportBrandingForSubscription(brandingRecord || {}, subscription);
    const pdf = await generateReportPdf({
      report,
      branding: effectiveBranding,
      showPoweredBy: subscription.platform_branding_required,
    });

    posthog.capture({
      distinctId: user.id,
      event: 'pdf_export_completed',
      properties: { report_id: reportId },
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${pdf.fileName}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(pdf.buffer);
  } catch (error) {
    if (user?.id) {
      posthog.capture({
        distinctId: user.id,
        event: 'pdf_export_failed',
        properties: { report_id: reportId, code: error?.code || 'pdf_failed' },
      });
    }
    const { statusCode, body } = billing.publicError(error);
    res.status(statusCode).json(body);
  }
});

app.post('/api/lead-capture', async (req, res) => {
  const lead = sanitizeLead(req.body);
  const reportRequested = req.body.reportRequested === true;
  const captureOnly = !!req.body.leadOnly || reportRequested;

  if (!lead.email) return res.status(400).json({ error: 'Email is required' });
  if (!lead.website) return res.status(400).json({ error: 'Website URL is required' });
  if (captureOnly && !lead.name) return res.status(400).json({ error: 'Name is required' });
  if (captureOnly && !lead.phone) return res.status(400).json({ error: 'Phone is required' });

  try {
    new URL(lead.website);
  } catch {
    return res.status(400).json({ error: 'Please enter a valid website URL' });
  }

  const distinctId = lead.email;
  const sessionId = req.headers['x-posthog-session-id'];
  const anonDistinctId = req.headers['x-posthog-distinct-id'];

  posthog.identify({
    distinctId,
    properties: {
      email: lead.email,
      name: lead.name,
      phone: lead.phone,
      business_name: lead.businessName,
      website: lead.website,
      ...(anonDistinctId && { $anon_distinct_id: anonDistinctId }),
    },
  });

  if (captureOnly) {
    const score = normalizeScoreValue(req.body.score ?? req.body.websiteScore);
    const reportData = req.body.reportData && typeof req.body.reportData === 'object'
      ? req.body.reportData
      : null;
    try {
      await sendLeadToGHL(lead, score, {
        reportRequested,
        ...(reportData && { reportData }),
      });
    } catch (err) {
      console.error('[PitchProof] GHL webhook error:', err.message);
      posthog.captureException(err, distinctId, { website: lead.website, score });
      posthog.capture({
        distinctId,
        event: reportRequested ? 'LeadSubmitted failed' : 'lead capture failed',
        properties: {
          website: lead.website,
          score,
          report_requested: reportRequested,
          error: err.message,
          ...(sessionId && { $session_id: sessionId }),
        },
      });
      posthog.capture({
        distinctId,
        event: reportRequested ? 'LeadSubmitted' : 'lead captured',
        properties: {
          website: lead.website,
          score,
          lead_only: !!req.body.leadOnly,
          report_requested: reportRequested,
          webhook_sent: false,
          webhook_error: err.message,
          ...(reportData && { report_data: reportData }),
          ...(sessionId && { $session_id: sessionId }),
        },
      });
      return res.json({ ok: true, reportRequested, webhookSent: false, warning: 'Lead captured, but webhook failed' });
    }
    posthog.capture({
      distinctId,
      event: reportRequested ? 'LeadSubmitted' : 'lead captured',
      properties: {
        website: lead.website,
        score,
        lead_only: !!req.body.leadOnly,
        report_requested: reportRequested,
        webhook_sent: true,
        ...(reportData && { report_data: reportData }),
        ...(sessionId && { $session_id: sessionId }),
      },
    });
    return res.json({ ok: true, reportRequested });
  }

  const debugMode = !!(req.query.debug || req.body.debug);

  // Save the lead before scanning so failed/slow scans do not lose campaign leads.
  try {
    await sendLeadToGHL(lead, null);
  } catch (err) {
    console.error('[PitchProof] GHL webhook error:', err.message);
  }

  try {
    let result = await analyzeWebsite(lead.website, { debug: debugMode });
    result = await optionalAiVisibility(result, {
      prospectName: lead.name,
      companyName: lead.businessName,
      requestedWebsite: lead.website,
    });
    const score = extractWebsiteScore(result);
    try {
      await sendLeadToGHL(lead, score);
    } catch (err) {
      console.error('[PitchProof] GHL webhook score update error:', err.message);
    }
    posthog.capture({
      distinctId,
      event: 'lead captured',
      properties: {
        website: lead.website,
        score,
        lead_only: false,
        ...(sessionId && { $session_id: sessionId }),
      },
    });
    res.json(result);
  } catch (err) {
    posthog.captureException(err, distinctId, { website: lead.website });
    posthog.capture({
      distinctId,
      event: 'lead capture failed',
      properties: {
        website: lead.website,
        error: err.message,
        ...(sessionId && { $session_id: sessionId }),
      },
    });
    res.status(500).json({ error: err.message || 'Analysis failed' });
  }
});

const BLOG_SUPPORT_PATHS = [
  '/blog/how-web-design-agencies-get-clients',
  '/blog/find-web-design-clients-consistently',
  '/blog/best-way-to-get-web-design-clients',
  '/blog/get-high-paying-web-design-clients',
  '/blog/get-local-businesses-web-design-clients',
  '/blog/get-website-clients-without-referrals',
  '/blog/small-web-design-agency-generate-more-leads',
  '/blog/build-predictable-pipeline-web-design-agency',
  '/blog/get-first-10-web-design-clients',
  '/blog/grow-a-web-design-agency',
  '/blog/sell-websites-to-small-businesses',
  '/blog/sell-websites-to-local-businesses',
  '/blog/convince-businesses-they-need-new-website',
  '/blog/prospect-for-web-design-clients',
  '/blog/identify-businesses-with-bad-websites',
  '/blog/find-outdated-business-websites',
  '/blog/find-companies-that-need-website-redesigns',
  '/blog/qualify-web-design-prospect',
  '/blog/what-to-look-for-on-prospect-website',
  '/blog/research-prospect-before-web-design-sales-call',
];

const SITEMAP_PATHS = [
  '/',
  '/product',
  '/how-it-works',
  '/sample-report',
  '/free-assessment',
  '/pricing',
  '/pricing/starter',
  '/pricing/professional',
  '/pricing/growth',
  '/blog',
  '/blog/how-to-get-more-web-design-clients',
  '/blog/find-businesses-that-need-a-new-website',
  '/blog/cold-email-web-design-clients',
  '/blog/website-audit-for-sales',
  '/blog/loom-website-audit-outreach',
  '/blog/web-design-discovery-call',
  '/blog/web-design-proposal-that-closes',
  '/blog/best-website-audit-sales-tools-agencies',
  ...BLOG_SUPPORT_PATHS,
  '/faq',
  '/contact',
  '/about',
  '/privacy',
  '/terms',
  '/website-audit-software',
  '/resources',
  '/industries',
  '/industries/web-design-agencies',
  '/industries/marketing-agencies',
  '/industries/seo-agencies',
  '/industries/freelance-web-designers',
  '/industries/digital-consultants',
  '/industries/wordpress-agencies',
  '/industries/webflow-agencies',
  '/industries/shopify-agencies',
  '/features',
  '/features/white-label-website-audit-reports',
  '/features/website-audit-pdf-generator',
  '/features/ai-website-audit-reports',
  '/features/website-audit-executive-summary',
  '/features/website-conversion-analysis',
  '/features/website-trust-analysis',
  '/features/website-technical-health-reports',
  '/features/website-visual-design-analysis',
  '/features/website-opportunity-cost-calculator',
  '/features/website-lead-loss-estimator',
  '/use-cases',
  '/use-cases/how-to-sell-more-website-projects',
  '/use-cases/website-audit-before-a-redesign',
  '/use-cases/website-audit-discovery-calls',
  '/use-cases/website-audit-cold-email',
  '/use-cases/website-audit-website-proposals',
  '/use-cases/website-audit-sales-presentations',
  '/use-cases/website-audit-lead-generation',
  '/use-cases/website-audit-client-onboarding',
  '/comparisons',
  '/comparisons/semrush-alternative-for-agencies',
  '/comparisons/ahrefs-alternative-for-agencies',
  '/comparisons/screaming-frog-alternative',
  '/comparisons/gtmetrix-alternative',
  '/comparisons/agencyanalytics-alternative',
  '/templates',
  '/templates/website-audit-template',
  '/templates/website-audit-checklist',
  '/templates/website-proposal-template',
  '/templates/website-discovery-questionnaire',
  '/templates/website-redesign-proposal-template',
  '/templates/website-consultation-checklist',
  '/templates/website-sales-presentation-template',
  '/templates/website-launch-checklist',
  '/tools',
  '/tools/website-roi-calculator',
  '/tools/website-redesign-calculator',
  '/tools/lead-loss-calculator',
  '/tools/website-pricing-calculator',
  '/tools/homepage-checklist-generator',
];

function publicSiteOrigin(req) {
  return cleanSupportText(process.env.PUBLIC_SITE_URL, 2000).replace(/\/+$/, '') || requestOrigin(req) || 'https://pitchproof.ca';
}

function escapeXml(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

app.get('/sitemap.xml', (req, res) => {
  const origin = publicSiteOrigin(req);
  const lastmod = '2026-08-10';
  const urls = SITEMAP_PATHS.map((pathName) => `
  <url>
    <loc>${escapeXml(`${origin}${pathName}`)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${pathName === '/' ? 'weekly' : 'monthly'}</changefreq>
    <priority>${pathName === '/' ? '1.0' : pathName.split('/').length <= 2 ? '0.8' : '0.7'}</priority>
  </url>`).join('');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}
</urlset>
`);
});

app.get('/robots.txt', (req, res) => {
  const origin = publicSiteOrigin(req);
  res.type('text/plain').send(`User-agent: *
Allow: /

Sitemap: ${origin}/sitemap.xml
`);
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let lifecycleEmailRunInProgress = false;

function lifecycleEmailIntervalMs() {
  const minutes = Number(process.env.LIFECYCLE_EMAIL_INTERVAL_MINUTES || 15);
  const safeMinutes = Number.isFinite(minutes) && minutes >= 15 ? minutes : 15;
  return safeMinutes * 60 * 1000;
}

async function runScheduledLifecycleEmails() {
  if (lifecycleEmailRunInProgress) return;
  lifecycleEmailRunInProgress = true;
  try {
    const signupResult = await lifecycleEmails.runAbandonedSignupCampaign({ dryRun: false });
    const cartResult = await lifecycleEmails.runAbandonedCartCampaign({ dryRun: false });
    const incompleteAccountResult = await lifecycleEmails.runIncompleteAccountOfferCampaign({ dryRun: false });
    const discountSequenceResult = await lifecycleEmails.runFirstMonthDiscountSequenceBroadcast({
      dryRun: false,
      confirm: 'send-first-month-discount-sequence',
    });
    console.log('[PitchProof] Lifecycle email run complete:', {
      abandoned_signup: {
        eligible: signupResult.eligible,
        sent: signupResult.sent,
        failed: signupResult.failed,
      },
      abandoned_cart: {
        eligible: cartResult.eligible,
        sent: cartResult.sent,
        failed: cartResult.failed,
      },
      incomplete_account_offer: {
        eligible: incompleteAccountResult.eligible,
        sent: incompleteAccountResult.sent,
        failed: incompleteAccountResult.failed,
      },
      first_month_discount_sequence: {
        step: discountSequenceResult.step,
        eligible: discountSequenceResult.eligible,
        sent: discountSequenceResult.sent,
        failed: discountSequenceResult.failed,
        expired: discountSequenceResult.campaign_expired,
      },
    });
  } catch (error) {
    console.warn('[PitchProof] Lifecycle email run failed:', error?.message || error);
  } finally {
    lifecycleEmailRunInProgress = false;
  }
}

function startLifecycleEmailScheduler() {
  if (!lifecycleEmails.envFlag('LIFECYCLE_EMAILS_ENABLED')) return;
  const firstRunDelayMs = Number(process.env.NODE_ENV === 'production' ? 120000 : 15000);
  setTimeout(runScheduledLifecycleEmails, firstRunDelayMs);
  setInterval(runScheduledLifecycleEmails, lifecycleEmailIntervalMs());
  console.log('[PitchProof] Lifecycle email scheduler enabled.');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PitchProof running on http://localhost:${PORT}`);
  startLifecycleEmailScheduler();
});

process.on('SIGINT', async () => {
  await posthog.shutdown();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await posthog.shutdown();
  process.exit(0);
});
