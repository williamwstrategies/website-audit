const express = require('express');
const cors = require('cors');
const path = require('path');
const { analyzeWebsite } = require('./api/analyze');
const { PostHog } = require('posthog-node');

const posthog = new PostHog(process.env.POSTHOG_API_KEY, {
  host: process.env.POSTHOG_HOST || 'https://us.i.posthog.com',
  enableExceptionAutocapture: true,
});

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  const distinctId = req.headers['x-posthog-distinct-id'] || url;
  const sessionId = req.headers['x-posthog-session-id'];

  try {
    const result = await analyzeWebsite(url, { debug: debugMode });
    const score = extractWebsiteScore(result);
    posthog.capture({
      distinctId,
      event: 'website analyzed',
      properties: {
        url,
        score,
        ...(sessionId && { $session_id: sessionId }),
      },
    });
    res.json(result);
  } catch (err) {
    posthog.captureException(err, distinctId, { url });
    posthog.capture({
      distinctId,
      event: 'website analysis failed',
      properties: { url, error: err.message },
    });
    res.status(500).json({ error: err.message || 'Analysis failed' });
  }
});

app.post('/api/lead-capture', async (req, res) => {
  const lead = sanitizeLead(req.body);
  const reportRequested = req.body.reportRequested === true;
  const captureOnly = !!req.body.leadOnly || reportRequested;

  if (!lead.email) return res.status(400).json({ error: 'Email is required' });
  if (!lead.website) return res.status(400).json({ error: 'Website URL is required' });
  if (req.body.leadOnly && !reportRequested && !lead.name) return res.status(400).json({ error: 'Name is required' });
  if (req.body.leadOnly && !reportRequested && !lead.phone) return res.status(400).json({ error: 'Phone is required' });

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
        event: reportRequested ? 'ReportPDFRequested failed' : 'lead capture failed',
        properties: {
          website: lead.website,
          score,
          report_requested: reportRequested,
          error: err.message,
          ...(sessionId && { $session_id: sessionId }),
        },
      });
      if (reportRequested) {
        return res.json({ ok: true, webhookSent: false, warning: 'Report request received, but webhook failed' });
      }
      return res.status(502).json({ error: 'Lead capture webhook failed' });
    }
    posthog.capture({
      distinctId,
      event: reportRequested ? 'ReportPDFRequested' : 'lead captured',
      properties: {
        website: lead.website,
        score,
        lead_only: !!req.body.leadOnly,
        report_requested: reportRequested,
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
