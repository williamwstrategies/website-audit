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
        properties: { stripe_event_id: result.id },
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
    const session = await billing.createCheckoutSession(req, user);
    posthog.capture({
      distinctId: user.id,
      event: 'checkout_started',
      properties: { plan: billing.PROFESSIONAL_PLAN.key },
    });
    res.json(session);
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
    return `Monthly audit limit reached. You have used ${subscription.audits_used || 0} of ${subscription.audit_limit || 0} audits in your current billing period.`;
  }
  if (reason === 'subscription_expired') {
    return 'Your subscription period has ended. Manage billing to continue running audits.';
  }
  if (reason === 'no_subscription') {
    return 'An active Professional subscription is required to run audits.';
  }
  return 'An active Professional subscription is required to run audits.';
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
        event: 'audit_limit_reached',
        properties: {
          reason: reservation?.reason || 'subscription_unavailable',
          audits_used: subscription.audits_used,
          audit_limit: subscription.audit_limit,
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
        error: 'An active Professional subscription is required to export PDFs.',
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
    const pdf = await generateReportPdf({ report, branding: brandingRecord || {} });

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
