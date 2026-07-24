const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { analyzeWebsite } = require('./api/analyze');
const { PostHog } = require('posthog-node');
const billing = require('./lib/billing');
const { generateReportPdf } = require('./lib/pdf');

const posthog = new PostHog(process.env.POSTHOG_API_KEY, {
  host: process.env.POSTHOG_HOST || 'https://us.i.posthog.com',
  enableExceptionAutocapture: true,
});

const app = express();
app.use(cors());

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

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ALLOWED_CLIENT_ANALYTICS_EVENTS = new Set([
  'plan_viewed',
  'plan_selected',
  'upgrade_clicked',
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

function supportEmailRecipients(value = '') {
  return String(value || '')
    .split(',')
    .map((item) => cleanSupportText(item, 320))
    .filter(Boolean)
    .slice(0, 20);
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

async function sendSupportNotification(payload) {
  const [email, webhook] = await Promise.all([
    sendSupportEmail(payload),
    sendSupportWebhook(payload),
  ]);
  const errors = [email.error, webhook.error].filter(Boolean);
  return {
    configured: email.configured || webhook.configured,
    sent: email.sent || webhook.sent,
    error: errors.join(' | '),
    email,
    webhook,
  };
}

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
    const subject = cleanSupportText(body.subject, 160);
    const message = cleanSupportText(body.message, 4000);

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
      category: normalizedSupportValue(body.category, SUPPORT_CATEGORIES, 'other'),
      urgency: normalizedSupportValue(body.urgency, SUPPORT_URGENCIES, 'normal'),
      subject,
      message,
      affected_url: cleanSupportText(body.affectedUrl || body.affected_url, 1000),
      preferred_reply_method: normalizedSupportValue(body.preferredReply || body.preferred_reply_method, SUPPORT_REPLY_METHODS, 'email'),
      reply_email: cleanSupportText(body.replyEmail || body.reply_email || user.email, 320),
      reply_phone: cleanSupportText(body.replyPhone || body.reply_phone, 80),
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
      console.warn('[LeadCheck] Support notification failed:', notification.error);
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
        webhook_configured: notification.webhook.configured,
        webhook_sent: notification.webhook.sent,
      },
    });

    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      ticketId,
      notificationConfigured: notification.configured,
      notificationSent: notification.sent,
      warning: notification.configured && !notification.sent
        ? 'Support request received, but the configured notification did not send.'
        : !notification.configured
          ? 'Support request received, but support email is not configured yet.'
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
    const subscription = await billing.getSubscriptionStatus(user.id);
    if (!subscription.can_white_label) {
      return res.status(403).json({
        error: 'Upgrade to Professional to remove Website Strategy Scan branding and present reports under your own agency.',
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
      properties: { plan: session.plan?.key || req.body?.plan || billing.PROFESSIONAL_PLAN.key },
    });
    posthog.capture({
      distinctId: user.id,
      event: 'checkout_started',
      properties: { plan: session.plan?.key || req.body?.plan || billing.PROFESSIONAL_PLAN.key },
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
      event: 'trial_started_paid_now',
      properties: { plan: req.body?.plan || billing.PROFESSIONAL_PLAN.key },
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

async function sendLeadToGHL(lead, score = null, extra = {}) {
  const webhookUrl = process.env.GHL_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('[LeadCheck] GHL_WEBHOOK_URL is not configured; lead webhook skipped.');
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

  console.log('[LeadCheck][GHL] Sending lead to GoHighLevel');
  console.log('[LeadCheck][GHL] Website score:', normalizedScore);
  console.log('[LeadCheck][GHL] Payload:', JSON.stringify(payload, null, 2));

  let response;
  try {
    response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.error('[LeadCheck][GHL] Webhook failed:', error.message);
    throw error;
  }

  console.log('[LeadCheck][GHL] Webhook status:', response.status);

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const error = new Error(`GHL webhook failed with HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    console.error('[LeadCheck][GHL] Webhook failed:', error.message);
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
  const distinctId = req.headers['x-posthog-distinct-id'] || url;
  const sessionId = req.headers['x-posthog-session-id'];

  try {
    authContext = await billing.requireAuthenticatedUser(req);
    auditIdempotencyKey = String(req.headers['x-audit-idempotency-key'] || crypto.randomUUID());
    const reservation = await billing.reserveAuditUsage(authContext.user.id, auditIdempotencyKey);

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
  } catch (error) {
    const { statusCode, body } = billing.publicError(error);
    return res.status(statusCode).json(body);
  }

  try {
    const result = await analyzeWebsite(url, { debug: debugMode });
    const score = extractWebsiteScore(result);
    await billing.completeAuditUsage(authContext.user.id, auditIdempotencyKey, {
      websiteUrl: url,
      websiteScore: score,
    }).catch(error => {
      console.warn('[LeadCheck] Audit usage completion failed:', error?.message || error);
    });
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
        console.warn('[LeadCheck] Audit usage refund failed:', error?.message || error);
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
      console.error('[LeadCheck] GHL webhook error:', err.message);
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
    console.error('[LeadCheck] GHL webhook error:', err.message);
  }

  try {
    const result = await analyzeWebsite(lead.website, { debug: debugMode });
    const score = extractWebsiteScore(result);
    try {
      await sendLeadToGHL(lead, score);
    } catch (err) {
      console.error('[LeadCheck] GHL webhook score update error:', err.message);
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LeadCheck running on http://localhost:${PORT}`));

process.on('SIGINT', async () => {
  await posthog.shutdown();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await posthog.shutdown();
  process.exit(0);
});
