const express = require('express');
const cors = require('cors');
const path = require('path');
const { analyzeWebsite } = require('./api/analyze');

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

async function sendLeadToGHL(lead, score = null) {
  const webhookUrl = process.env.GHL_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('[LeadCheck] GHL_WEBHOOK_URL is not configured; lead webhook skipped.');
    return { skipped: true };
  }

  const payload = {
    name: lead.name,
    businessName: lead.businessName,
    email: lead.email,
    phone: lead.phone,
    website: lead.website,
    score,
    timestamp: new Date().toISOString(),
  };

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GHL webhook failed with HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }

  return { sent: true };
}

app.post('/api/analyze', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  // Support debug mode via ?debug=1 or { debug: true } in body
  const debugMode = !!(req.query.debug || req.body.debug);

  try {
    const result = await analyzeWebsite(url, { debug: debugMode });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Analysis failed' });
  }
});

app.post('/api/lead-capture', async (req, res) => {
  const lead = sanitizeLead(req.body);

  if (!lead.email) return res.status(400).json({ error: 'Email is required' });
  if (!lead.website) return res.status(400).json({ error: 'Website URL is required' });

  try {
    new URL(lead.website);
  } catch {
    return res.status(400).json({ error: 'Please enter a valid website URL' });
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
    const score = Number.isFinite(Number(result.total)) ? Number(result.total) : null;
    try {
      await sendLeadToGHL(lead, score);
    } catch (err) {
      console.error('[LeadCheck] GHL webhook score update error:', err.message);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Analysis failed' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`LeadCheck running on http://localhost:${PORT}`));
