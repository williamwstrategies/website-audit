const dns = require('node:dns').promises;
const net = require('node:net');

const DEFAULT_TIMEOUT_MS = 7000;
const DEFAULT_MAX_PAGES = 5;
const MAX_HTML_LENGTH = 500000;

const CONTACT_PATHS = [
  '/',
  '/contact',
  '/contact-us',
  '/about',
  '/about-us',
  '/team',
];

const CONTACT_LINK_TERMS = [
  'contact',
  'about',
  'team',
  'staff',
  'people',
  'company',
];

const EMAIL_BLOCKLIST_PREFIXES = new Set([
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
  'example',
  'test',
]);

const EMAIL_REGEX = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;
const EMAIL_SINGLE_REGEX = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/i;
const MAILTO_REGEX = /mailto:([^"'?\s#<>]+)/gi;
const HREF_REGEX = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;

function cleanText(value = '', maxLength = 2000) {
  return String(value || '').trim().slice(0, maxLength);
}

function clampInt(value, fallback, min, max) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function configuredTimeoutMs() {
  return clampInt(process.env.LEAD_EMAIL_FINDER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 2500, 30000);
}

function configuredMaxPages() {
  return clampInt(process.env.LEAD_EMAIL_FINDER_MAX_PAGES, DEFAULT_MAX_PAGES, 1, 10);
}

function normalizeUrl(rawValue = '') {
  const raw = cleanText(rawValue, 1000);
  if (!raw) return '';
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withProtocol);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.username = '';
    url.password = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function normalizeDomain(rawValue = '') {
  const url = normalizeUrl(rawValue);
  if (url) {
    try {
      return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
      return '';
    }
  }
  return cleanText(rawValue, 300)
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .split('?')[0]
    .toLowerCase();
}

function decodeEntities(value = '') {
  return cleanText(value, MAX_HTML_LENGTH)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&commat;/gi, '@')
    .replace(/&period;/gi, '.')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function normalizeEmail(value = '') {
  const decoded = decodeEntities(value)
    .replace(/^mailto:/i, '')
    .split('?')[0]
    .trim()
    .toLowerCase();
  const match = decoded.match(EMAIL_SINGLE_REGEX);
  return match ? match[0] : '';
}

function emailDomain(email = '') {
  return cleanText(email, 320).split('@')[1] || '';
}

function isBlockedEmail(email = '') {
  const normalized = normalizeEmail(email);
  if (!normalized) return true;
  const [local, domain = ''] = normalized.split('@');
  if (EMAIL_BLOCKLIST_PREFIXES.has(local)) return true;
  if (!domain.includes('.') || domain.endsWith('.example')) return true;
  if (/^(example|domain|email|yourdomain)\./i.test(domain)) return true;
  if (/\.(png|jpg|jpeg|gif|webp|svg|css|js)$/i.test(domain)) return true;
  return false;
}

function isPrivateIp(address = '') {
  const version = net.isIP(address);
  if (!version) return false;
  if (version === 4) {
    const parts = address.split('.').map(Number);
    return parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254) ||
      parts[0] === 0;
  }
  const lower = address.toLowerCase();
  return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
}

async function assertPublicUrl(rawUrl = '') {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) throw new Error('A valid public website URL is required.');
  const url = new URL(normalized);
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || isPrivateIp(hostname)) {
    throw new Error('Email Finder can only check public business websites.');
  }
  const records = await dns.lookup(hostname, { all: true }).catch(() => []);
  if (records.some(record => isPrivateIp(record.address))) {
    throw new Error('Email Finder can only check public business websites.');
  }
  return normalized;
}

async function fetchPage(rawUrl = '', redirectsRemaining = 2) {
  const url = await assertPublicUrl(rawUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), configuredTimeoutMs());
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5',
        'user-agent': 'PitchProofEmailFinder/1.0 (+https://pitchproof.ca)',
      },
    });

    if ([301, 302, 303, 307, 308].includes(response.status) && redirectsRemaining > 0) {
      const location = response.headers.get('location');
      if (location) return fetchPage(new URL(location, url).toString(), redirectsRemaining - 1);
    }

    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') || '';
    if (contentType && !/html|text/i.test(contentType)) return null;
    const text = (await response.text()).slice(0, MAX_HTML_LENGTH);
    return { url, html: text };
  } finally {
    clearTimeout(timeout);
  }
}

function stripNoise(html = '') {
  return decodeEntities(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

function pageKind(url = '') {
  const path = (() => {
    try { return new URL(url).pathname.toLowerCase(); } catch { return ''; }
  })();
  if (path.includes('contact')) return 'contact';
  if (path.includes('about')) return 'about';
  if (path.includes('team') || path.includes('staff') || path.includes('people')) return 'team';
  return 'homepage';
}

function candidateScore(candidate, websiteDomain = '') {
  const domain = emailDomain(candidate.email);
  const local = candidate.email.split('@')[0] || '';
  let score = 0;
  if (websiteDomain && (domain === websiteDomain || domain.endsWith(`.${websiteDomain}`))) score += 60;
  if (candidate.source === 'mailto') score += 18;
  if (candidate.kind === 'contact') score += 14;
  if (['info', 'hello', 'sales', 'contact', 'office', 'admin'].includes(local)) score += 8;
  if (candidate.kind === 'homepage') score += 3;
  return score;
}

function confidenceForScore(score) {
  if (score >= 70) return 'high';
  if (score >= 45) return 'medium';
  return 'low';
}

function extractEmailsFromPage(page, websiteDomain = '') {
  const cleanHtml = stripNoise(page.html || '');
  const kind = pageKind(page.url);
  const candidates = [];
  let match;

  while ((match = MAILTO_REGEX.exec(cleanHtml))) {
    const email = normalizeEmail(match[1]);
    if (!isBlockedEmail(email)) candidates.push({ email, sourceUrl: page.url, source: 'mailto', kind });
  }

  while ((match = EMAIL_REGEX.exec(cleanHtml))) {
    const email = normalizeEmail(match[0]);
    if (!isBlockedEmail(email)) candidates.push({ email, sourceUrl: page.url, source: 'visible', kind });
  }

  const deduped = new Map();
  candidates.forEach(candidate => {
    const score = candidateScore(candidate, websiteDomain);
    const existing = deduped.get(candidate.email);
    if (!existing || score > existing.score) {
      deduped.set(candidate.email, {
        ...candidate,
        score,
        confidence: confidenceForScore(score),
      });
    }
  });
  return Array.from(deduped.values()).sort((a, b) => b.score - a.score);
}

function extractCandidateLinks(page, baseUrl) {
  const links = [];
  let match;
  while ((match = HREF_REGEX.exec(page.html || ''))) {
    const href = decodeEntities(match[1]);
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    let url;
    try {
      url = new URL(href, baseUrl);
    } catch {
      continue;
    }
    const haystack = `${url.pathname} ${href}`.toLowerCase();
    if (!CONTACT_LINK_TERMS.some(term => haystack.includes(term))) continue;
    links.push(url.toString());
  }
  return links;
}

function pageUrlsForWebsite(websiteUrl = '', homepage = null) {
  const normalized = normalizeUrl(websiteUrl);
  if (!normalized) return [];
  const root = new URL(normalized);
  root.pathname = '/';
  root.search = '';
  root.hash = '';
  const base = root.toString().replace(/\/$/, '');
  const urls = CONTACT_PATHS.map(path => `${base}${path === '/' ? '/' : path}`);
  if (homepage) urls.push(...extractCandidateLinks(homepage, root.toString()));
  return Array.from(new Set(urls)).slice(0, configuredMaxPages());
}

async function findPublicEmailForLead(lead = {}) {
  const websiteUrl = normalizeUrl(lead.website_url || lead.websiteUrl || lead.website || lead.url || lead.domain);
  const websiteDomain = normalizeDomain(lead.website_domain || lead.websiteDomain || websiteUrl);
  if (!websiteUrl) {
    return { email: '', status: 'no_website', pagesChecked: 0, candidates: [] };
  }

  const pages = [];
  const errors = [];
  const homepage = await fetchPage(websiteUrl).catch(error => {
    errors.push(error.message || 'Homepage could not be checked.');
    return null;
  });
  if (homepage) pages.push(homepage);

  const pageUrls = pageUrlsForWebsite(websiteUrl, homepage)
    .filter(url => !homepage || url !== homepage.url);

  for (const url of pageUrls) {
    if (pages.length >= configuredMaxPages()) break;
    const page = await fetchPage(url).catch(error => {
      errors.push(error.message || `Could not check ${url}.`);
      return null;
    });
    if (page) pages.push(page);
  }

  const candidates = pages.flatMap(page => extractEmailsFromPage(page, websiteDomain))
    .sort((a, b) => b.score - a.score);
  const best = candidates[0] || null;
  if (!best) {
    return {
      email: '',
      status: 'not_found',
      pagesChecked: pages.length,
      errors: errors.slice(0, 3),
      candidates: [],
    };
  }

  return {
    email: best.email,
    sourceUrl: best.sourceUrl,
    confidence: best.confidence,
    status: 'found',
    pagesChecked: pages.length,
    candidates: candidates.slice(0, 5).map(candidate => ({
      email: candidate.email,
      sourceUrl: candidate.sourceUrl,
      confidence: candidate.confidence,
    })),
  };
}

module.exports = {
  extractEmailsFromPage,
  findPublicEmailForLead,
  normalizeEmail,
  normalizeUrl,
};
