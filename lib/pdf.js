const { chromium } = require('playwright');
const {
  cleanText,
  supabaseBaseUrl,
  supabaseServiceRoleKey,
} = require('./billing');

const BRANDING_BUCKET = 'agency-branding';

const CHECK_LABELS = {
  headline: 'Clear Headline',
  cta: 'Strong CTA Button',
  mobileResponsive: 'Mobile Responsive',
  clickToCall: 'Click-to-Call',
  pageSpeed: 'Page Speed',
  https: 'HTTPS Security',
  localKeywords: 'Local Keywords',
  localPresence: 'Local Presence Signals',
  trustSignals: 'Trust Signals',
  contactOptions: 'Contact Options',
  leadForm: 'Lead Form',
  serviceClarity: 'Service Clarity',
  servicePageLinks: 'Service Page Links',
  navigation: 'Clean Navigation',
  titleTag: 'SEO Title Tag',
  metaDescription: 'Meta Description',
  headingStructure: 'Heading Structure',
  imageAltText: 'Image Alt Text',
  readability: 'Readability',
  socialProof: 'Social Proof',
};

function escHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function objectEntries(value) {
  return Object.entries(asRecord(value));
}

function asText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    if ('evidence' in value) return asText(value.evidence);
    if ('snippet' in value) return asText(value.snippet);
    return objectEntries(value)
      .filter(([, item]) => item !== null && item !== undefined && item !== false && item !== '')
      .map(([key, item]) => `${key}: ${asText(item)}`)
      .join(', ');
  }
  return String(value);
}

function firstDefinedValue(...values) {
  for (const value of values) {
    if (value == null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && objectEntries(value).length === 0) continue;
    return value;
  }
  return null;
}

function normalizeScore(score) {
  if (typeof score === 'number' && Number.isFinite(score)) return score;
  if (typeof score === 'string') {
    const parsed = Number(score.replace('%', '').trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function formatPercent(value) {
  return `${Math.round(Number(value || 0) * 10) / 10}%`;
}

function titleCase(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\w\S*/g, word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

function hostFromWebsite(website) {
  try {
    return new URL(website).hostname.replace(/^www\./i, '');
  } catch {
    return cleanText(website).replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./i, '') || 'website';
  }
}

function formatDate(value) {
  const date = value ? new Date(value) : new Date();
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  return safe.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function isoDate(value) {
  const date = value ? new Date(value) : new Date();
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  return safe.toISOString().slice(0, 10);
}

function colorForScore(score, maxScore = 100) {
  const pct = maxScore ? score / maxScore : 0;
  if (pct >= 0.81) return '#1f8f5f';
  if (pct >= 0.61) return '#a76f14';
  return '#b42318';
}

function normalizeHex(value, fallback) {
  const raw = cleanText(value);
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : fallback;
}

function reportPayload(report) {
  const data = asRecord(report.report_data);
  return asRecord(data.report || data);
}

function reportContext(report) {
  return asRecord(asRecord(report.report_data).context);
}

function reportWebsite(report, payload) {
  return cleanText(report.website_url || report.website || payload.url || payload.websiteUrl);
}

function reportTitle(report, payload) {
  return cleanText(report.website_name) || titleCase(hostFromWebsite(reportWebsite(report, payload)).split('.')[0]);
}

function statusFromValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (value.status) return titleCase(value.status);
    if (typeof value.detected === 'boolean') return value.detected ? 'Yes' : 'No';
    if (typeof value.result === 'boolean') return value.result ? 'Yes' : 'No';
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const text = asText(value).trim();
  if (!text || /^no\b|not detected|false/i.test(text)) return 'No';
  if (/partial|weak/i.test(text)) return 'Partial';
  return 'Yes';
}

function categoryRows(payload) {
  return objectEntries(payload.categories).map(([key, rawCategory]) => {
    const category = asRecord(rawCategory);
    const score = Number.isFinite(Number(category.score)) ? Number(category.score) : 0;
    const max = Number(category.max) || 1;
    return {
      label: asText(category.label) || titleCase(key),
      score,
      max,
      pct: Math.max(0, Math.min(100, (score / max) * 100)),
      color: colorForScore(score, max),
    };
  });
}

function findingRows(payload) {
  return [
    ...asArray(payload.criticalFlags),
    ...asArray(payload.issues),
  ].map((rawIssue, index) => {
    const issue = asRecord(rawIssue);
    return {
      title: asText(issue.label) || asText(issue.title) || asText(issue.key) || asText(rawIssue) || `Finding ${index + 1}`,
      description: asText(issue.description) || asText(issue.details) || asText(issue.evidence) || asText(issue.reason),
      priority: asText(issue.priority) || (index < 3 ? 'High' : 'Medium'),
    };
  });
}

function recommendationRows(payload) {
  return asArray(payload.recommendations).map((rawRecommendation, index) => {
    const recommendation = asRecord(rawRecommendation);
    return {
      title: asText(recommendation.label) || asText(recommendation.title) || asText(recommendation.key) || `Recommendation ${index + 1}`,
      body: asText(recommendation.fix) || asText(recommendation.recommendation) || asText(rawRecommendation),
      impact: asText(recommendation.impact),
    };
  });
}

function positiveRows(payload) {
  return asArray(payload.positives).map(asText).filter(Boolean);
}

function passedRows(payload) {
  return objectEntries(payload.checks)
    .filter(([, value]) => value === true || (value && typeof value === 'object' && value.result === true))
    .map(([key]) => CHECK_LABELS[key] || titleCase(key));
}

function evidenceRows(payload) {
  const evidence = asRecord(firstDefinedValue(payload.evidenceFound, payload.evidence));
  const checkEvidence = asRecord(evidence.checkEvidence);
  const methods = asRecord(evidence.contactMethodsDetected);
  const detection = asRecord(payload.detectionSummary);
  const signals = {
    phone: firstDefinedValue(methods.phone, checkEvidence.phone),
    callToAction: firstDefinedValue(evidence.ctasDetected, checkEvidence.cta),
    reviews: firstDefinedValue(evidence.reviewsDetected, evidence.reviewEvidence, payload.reviewEvidence),
    services: firstDefinedValue(evidence.servicesDetected, checkEvidence.servicesListed),
    contactForm: firstDefinedValue(evidence.formsDetected, methods.form),
    booking: firstDefinedValue(methods.booking, detection.bookingDetected),
    email: firstDefinedValue(methods.email),
    address: firstDefinedValue(methods.address),
    trustSignals: firstDefinedValue(evidence.trustSignalsDetected, checkEvidence.trustSignals),
  };

  return objectEntries(signals)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => ({
      label: CHECK_LABELS[key] || titleCase(key),
      status: statusFromValue(value),
      evidence: asText(firstDefinedValue(asRecord(value).snippet, asRecord(value).evidence, value)),
    }));
}

function pageRows(payload) {
  const evidence = asRecord(firstDefinedValue(payload.evidenceFound, payload.evidence));
  return asArray(firstDefinedValue(evidence.pagesList, evidence.pagesScanned, payload.pagesScanned, payload.pagesCrawled))
    .map(page => {
      const record = asRecord(page);
      return {
        path: asText(record.path) || asText(record.url) || asText(page),
        type: asText(record.type) || 'page',
      };
    });
}

function mimeTypeForPath(path) {
  const ext = cleanText(path).split('.').pop().toLowerCase();
  return {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
  }[ext] || 'image/png';
}

function isExternalUrl(value) {
  return /^https?:\/\//i.test(cleanText(value));
}

async function resolveLogoUrl(branding = {}) {
  const value = cleanText(branding.logo_url);
  if (!value || isExternalUrl(value)) return value;

  const encodedPath = value.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`${supabaseBaseUrl()}/storage/v1/object/${BRANDING_BUCKET}/${encodedPath}`, {
    headers: {
      apikey: supabaseServiceRoleKey(),
      authorization: `Bearer ${supabaseServiceRoleKey()}`,
    },
  }).catch(() => null);

  if (!response?.ok) return '';
  const buffer = Buffer.from(await response.arrayBuffer());
  const type = response.headers.get('content-type') || mimeTypeForPath(value);
  return `data:${type};base64,${buffer.toString('base64')}`;
}

function sanitizePdfFileName(report, branding = {}) {
  const payload = reportPayload(report);
  const context = reportContext(report);
  const name = cleanText(context.companyName || context.prospectName || reportTitle(report, payload) || branding.agency_name || 'website');
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'website';
  return `${slug}-website-assessment-${isoDate(report.created_at)}.pdf`;
}

function contactLine(branding = {}) {
  return [
    cleanText(branding.email),
    cleanText(branding.phone),
    cleanText(branding.website),
  ].filter(Boolean).join(' | ');
}

async function formatReportForPrint(report, branding = {}) {
  const payload = reportPayload(report);
  const context = reportContext(report);
  const website = reportWebsite(report, payload);
  const title = reportTitle(report, payload);
  const agencyName = cleanText(branding.agency_name) || 'Website Assessment Platform';
  const tagline = cleanText(branding.tagline) || 'Website Assessment';
  const primary = normalizeHex(branding.primary_color, '#f5c842');
  const secondary = normalizeHex(branding.secondary_color, '#1d1d1f');
  const score = normalizeScore(firstDefinedValue(report.website_score, payload.total, payload.score, payload.websiteScore, payload.rating));
  const maxScore = Number(payload.maxScore) || 100;
  const scoreColor = colorForScore(score, maxScore);
  const logoUrl = await resolveLogoUrl(branding);
  const categories = categoryRows(payload);
  const findings = findingRows(payload);
  const recommendations = recommendationRows(payload);
  const positives = positiveRows(payload);
  const passed = passedRows(payload);
  const evidence = evidenceRows(payload);
  const pages = pageRows(payload);
  const preparedFor = cleanText(context.prospectName || context.companyName) || 'Prospect';
  const disclaimer = cleanText(branding.disclaimer) || 'This assessment is based on observable website signals at the time of review.';
  const finalAssessment = cleanText(payload.finalAssessment || payload.summary || payload.executiveSummary);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escHtml(agencyName)} Website Assessment</title>
<style>
  @page { size: Letter; margin: 0.62in 0.5in 0.72in; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #f5f5f7;
    color: #1d1d1f;
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif;
    font-size: 12px;
    line-height: 1.48;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .document { background: #fff; }
  .hero {
    border-bottom: 1px solid #ececf0;
    padding: 0 0 24px;
    break-inside: avoid;
  }
  .brand-row, .meta-grid, .score-grid, .section-head, .footer-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
  }
  .brand-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .logo {
    width: 46px;
    height: 46px;
    border-radius: 13px;
    object-fit: contain;
    background: #f5f5f7;
    border: 1px solid #ececf0;
  }
  .logo-fallback {
    width: 46px;
    height: 46px;
    border-radius: 13px;
    display: grid;
    place-items: center;
    color: #1d1d1f;
    background: ${primary};
    font-weight: 800;
  }
  .agency { font-size: 17px; font-weight: 750; }
  .tagline, .muted { color: #6e6e73; }
  .label { color: #86868b; font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  h1 {
    margin: 28px 0 8px;
    font-size: 34px;
    line-height: 1.06;
    letter-spacing: 0;
  }
  h2 { margin: 0; font-size: 18px; letter-spacing: 0; }
  h3 { margin: 0 0 6px; font-size: 13px; }
  .website { color: #515154; overflow-wrap: anywhere; }
  .meta-grid {
    align-items: stretch;
    margin-top: 22px;
  }
  .meta-card, .score-card, .section {
    border: 1px solid #ececf0;
    border-radius: 16px;
    background: #fff;
    box-shadow: 0 12px 34px rgba(29, 29, 31, .06);
  }
  .meta-card { flex: 1; padding: 14px; }
  .meta-card strong { display: block; margin-top: 4px; overflow-wrap: anywhere; }
  .score-grid { align-items: stretch; margin: 22px 0; }
  .score-card { flex: 1; padding: 18px; break-inside: avoid; }
  .score-value { color: ${scoreColor}; font-size: 40px; font-weight: 800; line-height: 1; }
  .score-bar { height: 8px; border-radius: 999px; background: #ececf0; overflow: hidden; margin-top: 14px; }
  .score-fill { height: 100%; width: ${Math.max(0, Math.min(100, (score / maxScore) * 100))}%; background: ${scoreColor}; }
  .section { margin-top: 18px; padding: 18px; break-inside: avoid; }
  .section.allow-break { break-inside: auto; }
  .section-head { margin-bottom: 14px; align-items: flex-start; }
  .pill { display: inline-flex; align-items: center; border-radius: 999px; padding: 4px 8px; font-size: 10px; font-weight: 700; background: rgba(245, 200, 66, .18); color: ${secondary}; }
  .category { margin: 0 0 13px; break-inside: avoid; }
  .category-top { display: flex; justify-content: space-between; gap: 12px; font-weight: 700; }
  .category-bar { height: 7px; border-radius: 999px; background: #f1f1f4; overflow: hidden; margin-top: 6px; }
  .category-fill { height: 100%; }
  .list { display: grid; gap: 10px; }
  .item { padding: 12px; border: 1px solid #eeeeef; border-radius: 12px; break-inside: avoid; }
  .item-meta { margin-top: 6px; color: #6e6e73; }
  .two-column { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .chip-list { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { border: 1px solid #ececf0; border-radius: 999px; padding: 6px 9px; background: #fafafa; }
  .evidence-table { width: 100%; border-collapse: collapse; }
  .evidence-table th, .evidence-table td { text-align: left; border-bottom: 1px solid #eeeeef; padding: 8px 6px; vertical-align: top; }
  .evidence-table th { color: #86868b; font-size: 10px; text-transform: uppercase; letter-spacing: .08em; }
  .footer-row { margin-top: 22px; padding-top: 14px; border-top: 1px solid #ececf0; align-items: flex-start; }
  .disclaimer { max-width: 540px; color: #6e6e73; font-size: 10px; }
  a { color: #1d1d1f; text-decoration: none; }
  .page-break { break-before: page; }
</style>
</head>
<body>
  <main class="document">
    <section class="hero">
      <div class="brand-row">
        <div class="brand-left">
          ${logoUrl ? `<img class="logo" src="${escHtml(logoUrl)}" alt="${escHtml(agencyName)} logo">` : `<div class="logo-fallback">${escHtml(agencyName.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || 'WA')}</div>`}
          <div>
            <div class="agency">${escHtml(agencyName)}</div>
            <div class="tagline">${escHtml(tagline)}</div>
          </div>
        </div>
        <div class="muted">${escHtml(formatDate(report.created_at))}</div>
      </div>
      <h1>Website Assessment</h1>
      <div class="website">${escHtml(website)}</div>
      <div class="meta-grid">
        <div class="meta-card"><span class="label">Prepared For</span><strong>${escHtml(preparedFor)}</strong></div>
        <div class="meta-card"><span class="label">Website</span><strong>${escHtml(hostFromWebsite(website))}</strong></div>
        <div class="meta-card"><span class="label">Prepared By</span><strong>${escHtml(agencyName)}</strong></div>
      </div>
    </section>

    <section class="score-grid">
      <div class="score-card">
        <span class="label">Website Score</span>
        <div class="score-value">${escHtml(Math.round(score))}<span style="font-size:18px;color:#86868b;"> / ${escHtml(maxScore)}</span></div>
        <div class="score-bar"><div class="score-fill"></div></div>
      </div>
      <div class="score-card">
        <span class="label">Assessment Summary</span>
        <p>${escHtml(finalAssessment || `The assessment surfaced ${findings.length} findings and ${recommendations.length} recommendations for review.`)}</p>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Performance Overview</h2><span class="pill">${escHtml(categories.length)} categories</span></div>
      ${categories.map(category => `
        <div class="category">
          <div class="category-top"><span>${escHtml(category.label)}</span><span>${escHtml(category.score)} / ${escHtml(category.max)}</span></div>
          <div class="category-bar"><div class="category-fill" style="width:${category.pct}%;background:${category.color};"></div></div>
        </div>
      `).join('') || '<p class="muted">No category scores were returned for this assessment.</p>'}
    </section>

    <section class="section allow-break">
      <div class="section-head"><h2>Detailed Findings</h2><span class="pill">${escHtml(findings.length)} findings</span></div>
      <div class="list">
        ${findings.map(finding => `
          <article class="item">
            <h3>${escHtml(finding.title)}</h3>
            <div>${escHtml(finding.description || 'Review this area for potential improvement.')}</div>
            <div class="item-meta">${escHtml(finding.priority)} priority</div>
          </article>
        `).join('') || '<p class="muted">No major findings were returned.</p>'}
      </div>
    </section>

    <section class="section allow-break">
      <div class="section-head"><h2>Recommendations</h2><span class="pill">${escHtml(recommendations.length)} actions</span></div>
      <div class="list">
        ${recommendations.map(recommendation => `
          <article class="item">
            <h3>${escHtml(recommendation.title)}</h3>
            <div>${escHtml(recommendation.body || 'Review this recommendation in context with the rest of the assessment.')}</div>
            ${recommendation.impact ? `<div class="item-meta">${escHtml(recommendation.impact)}</div>` : ''}
          </article>
        `).join('') || '<p class="muted">No recommendations were returned.</p>'}
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Positive Signals</h2></div>
      <div class="chip-list">
        ${positives.map(item => `<span class="chip">${escHtml(item)}</span>`).join('') || '<span class="muted">No positive signals were returned.</span>'}
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Passed Checks</h2></div>
      <div class="chip-list">
        ${passed.map(item => `<span class="chip">${escHtml(item)}</span>`).join('') || '<span class="muted">No checks fully passed.</span>'}
      </div>
    </section>

    <section class="section allow-break">
      <div class="section-head"><h2>Evidence</h2><span class="pill">${escHtml(evidence.length)} signals</span></div>
      <table class="evidence-table">
        <thead><tr><th>Signal</th><th>Status</th><th>Evidence</th></tr></thead>
        <tbody>
          ${evidence.map(row => `
            <tr>
              <td>${escHtml(row.label)}</td>
              <td>${escHtml(row.status)}</td>
              <td>${escHtml(row.evidence || '-')}</td>
            </tr>
          `).join('') || '<tr><td colspan="3" class="muted">No evidence signals were returned.</td></tr>'}
        </tbody>
      </table>
    </section>

    <section class="section allow-break">
      <div class="section-head"><h2>Pages Reviewed</h2><span class="pill">${escHtml(pages.length)} pages</span></div>
      <table class="evidence-table">
        <thead><tr><th>Page</th><th>Type</th></tr></thead>
        <tbody>
          ${pages.map(row => `<tr><td>${escHtml(row.path)}</td><td>${escHtml(row.type)}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">No page list was returned.</td></tr>'}
        </tbody>
      </table>
    </section>

    <footer class="footer-row">
      <div>
        <strong>${escHtml(agencyName)}</strong>
        <div class="muted">${escHtml(contactLine(branding) || 'Contact information not set')}</div>
        ${branding.booking_link ? `<div><a href="${escHtml(branding.booking_link)}">${escHtml(branding.booking_link)}</a></div>` : ''}
      </div>
      <div class="disclaimer">${escHtml(disclaimer)}</div>
    </footer>
  </main>
</body>
</html>`;
}

async function generateReportPdf({ report, branding }) {
  const html = await formatReportForPrint(report, branding);
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 1680 },
      deviceScaleFactor: 1,
    });
    await page.setContent(html, { waitUntil: 'networkidle' });
    const agencyName = cleanText(branding?.agency_name) || 'Website Assessment Platform';
    const buffer = await page.pdf({
      format: 'Letter',
      printBackground: true,
      displayHeaderFooter: true,
      margin: {
        top: '0.64in',
        right: '0.5in',
        bottom: '0.68in',
        left: '0.5in',
      },
      headerTemplate: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:8px;color:#86868b;width:100%;padding:0 0.5in;">${escHtml(agencyName)} | Website Assessment</div>`,
      footerTemplate: '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;font-size:8px;color:#86868b;width:100%;padding:0 0.5in;display:flex;justify-content:space-between;"><span>Confidential assessment</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
      preferCSSPageSize: true,
    });

    return {
      buffer,
      fileName: sanitizePdfFileName(report, branding),
    };
  } finally {
    await browser.close();
  }
}

module.exports = {
  formatReportForPrint,
  generateReportPdf,
  sanitizePdfFileName,
};
