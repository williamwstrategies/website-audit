'use strict';
console.log('[LeadCheck] analyze.js loaded');
const https = require('https');
const http  = require('http');
const { URL } = require('url');

// ═══════════════════════════════════════════════════════════════════════
// PLAYWRIGHT — lazy-loaded so the app still starts if it's not installed
// ═══════════════════════════════════════════════════════════════════════

let playwrightAvailable = false;
let chromium;

try {
  ({ chromium } = require('playwright'));
  playwrightAvailable = true;
} catch {
  // Playwright not installed — HTTP fallback will be used automatically
}

// ═══════════════════════════════════════════════════════════════════════
// TEXT UTILITIES
// ═══════════════════════════════════════════════════════════════════════

function normalizeText(raw) {
  return (raw || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi,   ' ')
    .replace(/<!--[\s\S]*?-->/g,            ' ')
    .replace(/<[^>]+>/g,                    ' ')
    .replace(/[^\w\s@.]/g,                  ' ')
    .replace(/\s+/g,                        ' ')
    .toLowerCase()
    .trim();
}

function containsAny(text, needles) {
  const norm = text.includes('<') ? normalizeText(text) : text.toLowerCase();
  return needles.some(n => norm.includes(n.toLowerCase()));
}

// ═══════════════════════════════════════════════════════════════════════
// HTTP FALLBACK — used when Playwright is unavailable or fails
// ═══════════════════════════════════════════════════════════════════════

function fetchPage(rawUrl, timeout = 7000) {
  return new Promise((resolve, reject) => {
    let urlObj;
    try { urlObj = new URL(rawUrl); }
    catch { return reject(new Error('Invalid URL: ' + rawUrl)); }

    const lib = urlObj.protocol === 'https:' ? https : http;
    const req = lib.get({
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      headers: {
        'User-Agent':      'Mozilla/5.0 (compatible; LeadCheckBot/1.0)',
        'Accept':          'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
      },
      timeout,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc  = res.headers.location;
        const next = loc.startsWith('http')
          ? loc
          : `${urlObj.protocol}//${urlObj.hostname}${loc}`;
        res.resume();
        return fetchPage(next, timeout).then(resolve).catch(reject);
      }
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => {
        body += c;
        if (body.length > 600_000) { res.destroy(); resolve({ html: body, finalUrl: rawUrl }); }
      });
      res.on('end', () => resolve({ html: body, finalUrl: rawUrl }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timed out')); });
    req.on('error',   reject);
  });
}

// ═══════════════════════════════════════════════════════════════════════
// PLAYWRIGHT PAGE EXTRACTION
// Extracts the fully-rendered DOM as HTML plus a rich signals object.
// This runs inside a single shared browser to minimise launch overhead.
// ═══════════════════════════════════════════════════════════════════════

/**
 * In-page extraction script evaluated via page.evaluate().
 * Returns a rich signals object directly from the live DOM.
 * Runs in the browser context — no Node.js APIs available here.
 */
const DOM_EXTRACTOR = () => {
  const getText = el => (el.innerText || el.textContent || '').trim();

  // ── Rendered visible text ──────────────────────────────────────────
  const visibleText = document.body ? getText(document.body).toLowerCase() : '';

  // ── Headings ───────────────────────────────────────────────────────
  const headings = [...document.querySelectorAll('h1,h2,h3')].map(h => ({
    tag: h.tagName.toLowerCase(),
    text: getText(h),
  }));

  // ── Buttons ───────────────────────────────────────────────────────
  const buttons = [...document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')]
    .map(b => getText(b) || b.value || b.getAttribute('aria-label') || '')
    .filter(Boolean);

  // ── Links ─────────────────────────────────────────────────────────
  const links = [...document.querySelectorAll('a[href]')].map(a => ({
    href: a.getAttribute('href') || '',
    text: getText(a),
  }));

  // ── Phone numbers ─────────────────────────────────────────────────
  const telLinks = [...document.querySelectorAll('a[href^="tel:"]')].map(a => a.getAttribute('href'));
  const phoneRegex = /\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/g;
  const phoneMatches = visibleText.match(phoneRegex) || [];

  // ── Emails ────────────────────────────────────────────────────────
  const mailtoLinks = [...document.querySelectorAll('a[href^="mailto:"]')].map(a => a.getAttribute('href'));
  const emailRegex  = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi;
  const emailMatches = visibleText.match(emailRegex) || [];

  // ── Forms ─────────────────────────────────────────────────────────
  const forms = [...document.querySelectorAll('form')].map(f => {
    const inputs    = [...f.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"])')];
    const textareas = [...f.querySelectorAll('textarea')];
    const submitBtn = f.querySelector('[type="submit"], button[type="submit"], button:not([type])');
    return {
      fieldCount: inputs.length + textareas.length,
      hasSubmit:  !!submitBtn,
      submitText: submitBtn ? getText(submitBtn) : '',
    };
  });

  // ── Iframes ───────────────────────────────────────────────────────
  const iframes = [...document.querySelectorAll('iframe')].map(f => ({
    src:   f.getAttribute('src') || '',
    title: f.getAttribute('title') || '',
  }));

  // ── Images + alt text ─────────────────────────────────────────────
  const images = [...document.querySelectorAll('img')].map(i => ({
    src: i.getAttribute('src') || '',
    alt: i.getAttribute('alt') || '',
  }));
  const imagesWithAlt    = images.filter(i => i.alt.trim().length > 2).length;
  const imagesWithoutAlt = images.filter(i => !i.alt.trim()).length;

  // ── Scripts (src only) ────────────────────────────────────────────
  const scripts = [...document.querySelectorAll('script[src]')].map(s => s.getAttribute('src') || '');

  // ── GoHighLevel / funnel / chat / booking detection ───────────────
  const allSrcs   = [...scripts, ...iframes.map(f => f.src)].join(' ').toLowerCase();
  const pageHtml  = document.documentElement.outerHTML.toLowerCase();

  const isGHL         = /gohighlevel|leadconnector|lc_chat|forms\.leadconnectorhq|msgsndr|highlevel\.com/i.test(pageHtml);
  const hasCalendly   = /calendly\.com/i.test(pageHtml);
  const hasAcuity     = /acuityscheduling|squareup\.com\/appointments/i.test(pageHtml);
  const hasTawk       = /tawk\.to\b/i.test(pageHtml);
  const hasIntercom   = /intercom\.io|widget\.intercom/i.test(pageHtml);
  const hasDrift      = /drift\.com\/widget|js\.drift\.com/i.test(pageHtml);
  const hasCrisp      = /crisp\.chat|client\.crisp\.chat/i.test(pageHtml);
  const hasFreshchat  = /freshchat|freshworks\.com/i.test(pageHtml);
  const hasZendesk    = /zopim|ze\.zdn\.net|zendesk\.com\/embeddable/i.test(pageHtml);
  const hasIframeForm = iframes.some(f => /form|booking|appointment|quote|estimate|calendar|widget|funnel|leadconnector|gohighlevel/i.test(f.src));

  // ── Review widget detection ────────────────────────────────────────
  const hasElfsight   = /elfsight\.com|apps\.elfsight/i.test(pageHtml);
  const hasBirdeye    = /birdeye\.com|birdeyereviews/i.test(pageHtml);
  const hasPodium     = /podium\.com|reviews\.podium/i.test(pageHtml);
  const hasNiceJob    = /nicejob\.com|widget\.nicejob/i.test(pageHtml);
  const hasGrade      = /grade\.us|gradeus/i.test(pageHtml);
  const hasReviewsIo  = /reviews\.io|widget\.reviews\.io/i.test(pageHtml);
  const reviewWidgetDetected = hasElfsight || hasBirdeye || hasPodium || hasNiceJob || hasGrade || hasReviewsIo;

  // ── Newsletter-only form detection (should NOT count as lead form) ─
  const formElements = [...document.querySelectorAll('form')];
  const hasNewsletterOnlyForm = formElements.length > 0 && formElements.every(f => {
    const inputs = [...f.querySelectorAll('input')];
    const hasNameOrPhone = inputs.some(i => {
      const n = (i.name || i.placeholder || i.id || '').toLowerCase();
      return /name|phone|tel|service|message|subject/.test(n);
    });
    const hasEmailOnly = inputs.some(i => i.type === 'email' || (i.name||'').toLowerCase() === 'email');
    return !hasNameOrPhone && hasEmailOnly;
  });

  // ── CTA phrases found in visible text ─────────────────────────────
  const CTA_PHRASES = [
    'free quote','get a free quote','request a quote','get quote',
    'free estimate','get a free estimate','request estimate',
    'schedule estimate','book estimate','call for quote',
    'quote today','no obligation quote','no-obligation quote',
    'start your project','schedule service','book service',
    'call now','call today','get started','get started today',
    'request service','schedule consultation','book consultation',
    'request appointment','book appointment','book now',
    'schedule now','schedule today','claim your quote',
    'get my free estimate','get my free quote',
  ];
  const ctaFound = CTA_PHRASES.filter(p => visibleText.includes(p));

  // ── Address ───────────────────────────────────────────────────────
  const addressMatch = visibleText.match(
    /\d{2,5}\s+[a-z]+\s+(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|lane|ln|way|court|ct)\b[^,\n]*/i
  );

  // ── Schema.org markup ─────────────────────────────────────────────
  const hasLocalBusinessSchema = /"@type"\s*:\s*"[A-Za-z]*(Contractor|LocalBusiness|Service)/i.test(pageHtml);

  // ── Google signals ─────────────────────────────────────────────────
  const hasGoogleMap     = /google\.com\/maps|maps\.google|goo\.gl\/maps|maps\.app\.goo/i.test(pageHtml);
  const hasGoogleReviews = /google.*review|review.*google/i.test(pageHtml);
  const hasGoogleBiz     = /google.*business|gbp\.google/i.test(pageHtml);
  const hasEmbeddedMap   = iframes.some(f => /maps\.google|google\.com\/maps/i.test(f.src));

  return {
    visibleText,
    headings,
    buttons,
    links,
    telLinks,
    phoneMatches: [...new Set(phoneMatches)],
    mailtoLinks,
    emailMatches: [...new Set(emailMatches)],
    forms,
    iframes,
    images: { total: images.length, withAlt: imagesWithAlt, withoutAlt: imagesWithoutAlt },
    scripts: scripts.slice(0, 30),  // cap to avoid huge payloads
    widgets: {
      isGHL, hasCalendly, hasAcuity, hasTawk, hasIntercom,
      hasDrift, hasCrisp, hasFreshchat, hasZendesk, hasIframeForm,
      hasChat:    hasTawk || hasIntercom || hasDrift || hasCrisp || hasFreshchat || hasZendesk,
      hasBooking: hasCalendly || hasAcuity || isGHL || hasIframeForm,
      reviewWidgetDetected, hasElfsight, hasBirdeye, hasPodium, hasNiceJob, hasGrade, hasReviewsIo,
      hasNewsletterOnlyForm,
    },
    ctaFound,
    addressMatch: addressMatch ? addressMatch[0].trim() : null,
    seo: {
      title:       document.title || '',
      metaDesc:    document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
      h1s:         [...document.querySelectorAll('h1')].map(getText),
      canonical:   document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '',
      hasViewport: !!document.querySelector('meta[name="viewport"]'),
    },
    google: { hasGoogleMap, hasGoogleReviews, hasGoogleBiz, hasEmbeddedMap, hasLocalBusinessSchema },
    outerHtml: document.documentElement.outerHTML,
  };
};

/**
 * Use Playwright to fetch a single page.
 * Returns { html, finalUrl, domData } where domData is the rich extraction.
 */
async function playwrightFetchPage(page, rawUrl, pageTimeoutMs = 12000) {
  try {
    await page.goto(rawUrl, {
      waitUntil: 'domcontentloaded',
      timeout:   pageTimeoutMs,
    });

    // Wait for JS widgets to fully mount (GHL, chat, booking, review widgets)
    await page.waitForTimeout(2500);

    const finalUrl = page.url();
    const domData  = await page.evaluate(DOM_EXTRACTOR);
    const html     = domData.outerHtml || '';

    return { html, finalUrl, domData };
  } catch (err) {
    throw new Error(`Playwright fetch failed for ${rawUrl}: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// HYBRID PRIORITY-PAGE SCANNER
// Tries Playwright first. Falls back to HTTP fetch if Playwright
// is unavailable, fails to launch, or times out.
// ═══════════════════════════════════════════════════════════════════════

const MAX_PAGES    = 5;    // homepage + up to 4 priority pages
const PAGE_TIMEOUT = 15000;  // per-page timeout for Playwright (longer for GHL/heavy sites)
const HTTP_TIMEOUT = 8000;   // per-page timeout for HTTP fallback
const CRAWL_BUDGET = 45000;  // total ms budget — accuracy > speed

const PRIORITY_SLUGS = [
  '/services', '/service', '/contact', '/about',
  '/reviews', '/testimonials', '/gallery', '/projects', '/portfolio',
];

const PRIORITY_LINK_KEYWORDS = [
  'service', 'contact', 'about', 'review', 'testimonial',
  'gallery', 'project', 'portfolio',
];

function classifyPage(url) {
  const p = new URL(url).pathname.toLowerCase();
  if (/\/service/.test(p))                          return 'services';
  if (/\/contact/.test(p))                          return 'contact';
  if (/\/about/.test(p))                            return 'about';
  if (/\/review|\/testimonial/.test(p))             return 'reviews';
  if (/\/gallerr?y|\/project|\/portfolio/.test(p))  return 'gallery';
  return 'other';
}

function urlKey(url) {
  try {
    const u = new URL(url);
    u.hash   = '';
    u.search = '';
    return u.toString().replace(/\/$/, '') || u.origin;
  } catch { return url; }
}

function extractInternalLinks(html, baseUrl) {
  const base  = new URL(baseUrl);
  const links = new Set();
  const re    = /href=["']([^"'\s]+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw || raw.startsWith('#') || raw.startsWith('mailto:') || raw.startsWith('tel:')) continue;
    if (/\.(pdf|jpe?g|png|gif|webp|svg|mp4|mp3|zip|doc[x]?|xls[x]?|css|js|ico|xml|txt|woff2?)(\?.*)?$/i.test(raw)) continue;
    try {
      const resolved = new URL(raw, baseUrl);
      if (resolved.hostname !== base.hostname) continue;
      links.add(urlKey(resolved.toString()));
    } catch { /* skip */ }
  }
  return [...links];
}

// ── Playwright crawler ────────────────────────────────────────────────

async function crawlWithPlaywright(startUrl) {
  const deadline = Date.now() + CRAWL_BUDGET;
  let browser = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
      ],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport:  { width: 1280, height: 800 },
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });

    // Block heavy resources we don't need
    await context.route('**/*', route => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
        return route.abort();
      }
      return route.continue();
    });

    // page is created here and ONLY passed as an argument to playwrightFetchPage —
    // it is never used globally and never accessed after browser.close()
    const page = await context.newPage();

    // ── Homepage ──────────────────────────────────────────────────
    let homepageResult = null;
    for (const attempt of [startUrl, startUrl.replace(/^https:/, 'http:')]) {
      try {
        homepageResult = await Promise.race([
          playwrightFetchPage(page, attempt, PAGE_TIMEOUT),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), PAGE_TIMEOUT + 500)),
        ]);
        break;
      } catch { /* try http fallback protocol */ }
    }

    if (!homepageResult) {
      // Homepage unreachable — signal caller to fall back to HTTP
      return null;
    }

    const finalHomeUrl = homepageResult.finalUrl;
    const origin       = new URL(finalHomeUrl).origin;
    const pages        = [{
      url:     finalHomeUrl,
      html:    homepageResult.html,
      domData: homepageResult.domData,
      type:    'homepage',
      source:  'homepage',
    }];
    const visited = new Set([urlKey(finalHomeUrl)]);

    // ── Build candidate list ──────────────────────────────────────
    const slugCandidates = PRIORITY_SLUGS.map(s => ({ url: origin + s, source: 'slug-guess' }));
    const homepageLinks  = extractInternalLinks(homepageResult.html, finalHomeUrl);
    const keywordLinks   = homepageLinks
      .filter(link => PRIORITY_LINK_KEYWORDS.some(kw => new URL(link).pathname.toLowerCase().includes(kw)))
      .map(url => ({ url, source: 'homepage-link' }));

    const seen       = new Set(visited);
    const candidates = [];
    for (const item of [...keywordLinks, ...slugCandidates]) {
      const key = urlKey(item.url);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(item);
    }

    // ── Crawl priority pages ──────────────────────────────────────
    for (const candidate of candidates) {
      if (pages.length >= MAX_PAGES || Date.now() >= deadline) break;

      try {
        const result = await Promise.race([
          playwrightFetchPage(page, candidate.url, PAGE_TIMEOUT),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), PAGE_TIMEOUT + 500)),
        ]);

        const key = urlKey(result.finalUrl);
        if (visited.has(key)) continue;
        visited.add(key);

        pages.push({
          url:     result.finalUrl,
          html:    result.html,
          domData: result.domData,
          type:    classifyPage(candidate.url),
          source:  candidate.source,
        });
      } catch { /* skip page, continue to next candidate */ }
    }

    return { pages, finalHomeUrl, method: 'playwright' };

  } catch (err) {
    console.error('[LeadCheck] Playwright crawl error:', err.message);
    return null;   // signal caller to fall back to HTTP

  } finally {
    // Guaranteed close — runs whether we succeeded, failed, or threw.
    // page is already out of scope here; we only close the browser handle.
    if (browser) {
      try { await browser.close(); } catch { /* ignore close errors */ }
    }
  }
}

// ── HTTP fallback crawler ─────────────────────────────────────────────

async function crawlWithHttp(startUrl) {
  const deadline = Date.now() + CRAWL_BUDGET;
  let finalHomeUrl = startUrl;
  let homepageHtml = null;

  for (const attempt of [startUrl, startUrl.replace(/^https:/, 'http:')]) {
    try {
      const r = await fetchPage(attempt, HTTP_TIMEOUT);
      homepageHtml = r.html;
      finalHomeUrl = r.finalUrl;
      break;
    } catch { /* try next */ }
  }

  if (!homepageHtml) {
    throw new Error(
      `Could not reach ${startUrl}. The site may be blocking automated requests or is currently unavailable.`
    );
  }

  const pages   = [{ url: finalHomeUrl, html: homepageHtml, domData: null, type: 'homepage', source: 'homepage' }];
  const visited = new Set([urlKey(finalHomeUrl)]);
  const origin  = new URL(finalHomeUrl).origin;

  const slugCandidates = PRIORITY_SLUGS.map(s => ({ url: origin + s, source: 'slug-guess' }));
  const homepageLinks  = extractInternalLinks(homepageHtml, finalHomeUrl);
  const keywordLinks   = homepageLinks
    .filter(link => PRIORITY_LINK_KEYWORDS.some(kw => new URL(link).pathname.toLowerCase().includes(kw)))
    .map(url => ({ url, source: 'homepage-link' }));

  const seen       = new Set(visited);
  const candidates = [];
  for (const item of [...keywordLinks, ...slugCandidates]) {
    const key = urlKey(item.url);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(item);
  }

  // Batch 3 at a time
  for (let i = 0; i < candidates.length && pages.length < MAX_PAGES && Date.now() < deadline; i += 3) {
    const batch   = candidates.slice(i, i + 3);
    const results = await Promise.allSettled(
      batch.map(({ url }) =>
        Promise.race([
          fetchPage(url, HTTP_TIMEOUT),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), HTTP_TIMEOUT + 300)),
        ])
      )
    );

    for (let j = 0; j < results.length; j++) {
      if (pages.length >= MAX_PAGES || Date.now() >= deadline) break;
      const r = results[j];
      if (r.status !== 'fulfilled') continue;
      const key = urlKey(r.value.finalUrl);
      if (visited.has(key)) continue;
      visited.add(key);
      pages.push({
        url:     r.value.finalUrl,
        html:    r.value.html,
        domData: null,
        type:    classifyPage(batch[j].url),
        source:  batch[j].source,
      });
    }
  }

  return { pages, finalHomeUrl, method: 'http' };
}

// ── Public crawl entry point ──────────────────────────────────────────

async function crawlSite(startUrl) {
  // Try Playwright first if available
  if (playwrightAvailable) {
    try {
      const result = await crawlWithPlaywright(startUrl);
      if (result) return result;
      // null = launch failed — fall through to HTTP
    } catch { /* fall through */ }
  }
  // HTTP fallback (always works)
  return crawlWithHttp(startUrl);
}

// ═══════════════════════════════════════════════════════════════════════
// PAGESPEED
// ═══════════════════════════════════════════════════════════════════════

async function fetchPageSpeed(url) {
  const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile`;
  try {
    return await new Promise((resolve, reject) => {
      const req = https.get(api, { timeout: 10000 }, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(); } });
      });
      req.on('error',   reject);
      req.on('timeout', () => { req.destroy(); reject(); });
    });
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════════
// MERGED CORPUS
// Produces a single HTML blob + normalised text from all crawled pages.
// When Playwright domData is available, visibleText is merged in too.
// ═══════════════════════════════════════════════════════════════════════

function mergePages(pages) {
  const allHtml      = pages.map(p => p.html).join('\n<!-- PAGE_BREAK -->\n');
  // Supplement with Playwright visible text (catches JS-rendered content)
  const pwTexts      = pages
    .filter(p => p.domData?.visibleText)
    .map(p => p.domData.visibleText)
    .join(' ');
  const allText      = normalizeText(allHtml) + ' ' + pwTexts.toLowerCase();
  const homepagePage = pages.find(p => p.type === 'homepage') || pages[0] || {};
  const homepageHtml = homepagePage.html || '';
  const homepageText = normalizeText(homepageHtml) + ' ' + (homepagePage.domData?.visibleText || '').toLowerCase();
  return { allHtml, allText, homepageHtml, homepageText };
}

// ═══════════════════════════════════════════════════════════════════════
// EMBEDDED WIDGET DETECTION
// Checks both static HTML and Playwright domData.widgets when available.
// ═══════════════════════════════════════════════════════════════════════

function detectEmbeddedWidgets(allHtml, pages) {
  const html  = allHtml.toLowerCase();
  // Merge any Playwright widget detections across all pages
  const pwWidgets = pages
    .filter(p => p.domData?.widgets)
    .map(p => p.domData.widgets)
    .reduce((acc, w) => ({
      isGHL:         acc.isGHL         || w.isGHL,
      hasChat:       acc.hasChat       || w.hasChat,
      hasBooking:    acc.hasBooking    || w.hasBooking,
      hasIframeForm: acc.hasIframeForm || w.hasIframeForm,
      hasCalendly:   acc.hasCalendly   || w.hasCalendly,
      hasAcuity:     acc.hasAcuity     || w.hasAcuity,
      hasTawk:       acc.hasTawk       || w.hasTawk,
      hasIntercom:   acc.hasIntercom   || w.hasIntercom,
      hasDrift:      acc.hasDrift      || w.hasDrift,
      hasCrisp:      acc.hasCrisp      || w.hasCrisp,
      hasFreshchat:  acc.hasFreshchat  || w.hasFreshchat,
      hasZendesk:    acc.hasZendesk    || w.hasZendesk,
    }), {
      isGHL: false, hasChat: false, hasBooking: false, hasIframeForm: false,
      hasCalendly: false, hasAcuity: false, hasTawk: false, hasIntercom: false,
      hasDrift: false, hasCrisp: false, hasFreshchat: false, hasZendesk: false,
    });

  // Static HTML checks as baseline
  const staticGHL     = /gohighlevel|leadconnector|lc_chat|forms\.leadconnectorhq|msgsndr\.com|highlevel\.com/i.test(html);
  const staticCalendly = /calendly\.com/i.test(html);
  const iframeSrcs    = [...html.matchAll(/iframe[^>]*src=["']([^"']+)["']/g)].map(m => m[1]);
  const staticIframe  = iframeSrcs.some(s => /form|booking|appointment|quote|calendar|widget|funnel/i.test(s));
  const staticChat    = /tawk\.to\b|intercom\.io|drift\.com\/widget|crisp\.chat|freshchat|freshworks|zopim|zendesk\.com\/embeddable/i.test(html);

  return {
    isGHL:         pwWidgets.isGHL         || staticGHL,
    hasChat:       pwWidgets.hasChat       || staticChat,
    hasBooking:    pwWidgets.hasBooking    || staticCalendly || (pwWidgets.isGHL || staticGHL),
    hasIframeForm: pwWidgets.hasIframeForm || staticIframe,
    hasCalendly:   pwWidgets.hasCalendly   || staticCalendly,
    hasAcuity:     pwWidgets.hasAcuity,
    hasTawk:       pwWidgets.hasTawk       || /tawk\.to/i.test(html),
    hasIntercom:   pwWidgets.hasIntercom   || /intercom\.io/i.test(html),
    hasDrift:      pwWidgets.hasDrift      || /drift\.com\/widget/i.test(html),
    hasCrisp:      pwWidgets.hasCrisp      || /crisp\.chat/i.test(html),
    hasFreshchat:  pwWidgets.hasFreshchat  || /freshchat/i.test(html),
    hasZendesk:    pwWidgets.hasZendesk    || /zopim|zendesk\.com\/embeddable/i.test(html),
    iframeCount:   iframeSrcs.length,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CONTACT METHOD DETECTION
// ═══════════════════════════════════════════════════════════════════════

function detectContactMethods(allHtml, allText, widgets, pages) {
  // Collect tel: links from both HTML and Playwright
  const pwTelLinks = pages.flatMap(p => p.domData?.telLinks || []);
  const phone   = /\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/.test(allText)
    || /href=["']tel:/i.test(allHtml) || pwTelLinks.length > 0;
  const telLink = /href=["']tel:/i.test(allHtml) || pwTelLinks.length > 0;

  // Collect emails
  const pwEmails = pages.flatMap(p => p.domData?.emailMatches || []);
  const email   = /href=["']mailto:/i.test(allHtml)
    || /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(allText)
    || pwEmails.length > 0;

  const form    = /<form\b/i.test(allHtml) || widgets.hasIframeForm || widgets.isGHL
    || pages.some(p => (p.domData?.forms || []).length > 0);

  const chat    = widgets.hasChat;
  const booking = widgets.hasBooking
    || /book\s*(now|online|appointment|a\s+call)|calendly|acuity|scheduling/i.test(allText);

  const address = /\d{2,5}\s+[a-z]+\s+(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|lane|ln|way|court|ct)\b/i.test(allText)
    || pages.some(p => !!p.domData?.addressMatch);

  const count = [phone, email, form, chat, booking, address].filter(Boolean).length;
  return { phone, telLink, email, form, chat, booking, address, count,
    firstTelLink: pwTelLinks[0] || (allHtml.match(/href=["'](tel:[^"']+)["']/i) || [])[1] || null,
    firstEmail:   pwEmails[0]   || (allHtml.match(/href=["']mailto:([^"'?]+)/i) || [])[1] || null,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CTA DETECTION
// ═══════════════════════════════════════════════════════════════════════

const STRONG_CTA = [
  'free quote','get a free quote','request a quote','get quote',
  'free estimate','get a free estimate','request estimate',
  'schedule estimate','book estimate','call for quote',
  'quote today','no obligation quote','no-obligation quote',
  'contact us for a quote','start your project',
  'schedule service','book service','call now','call today',
  'get started','get started today','request service',
  'schedule consultation','book consultation','request appointment',
  'book appointment','book now','schedule now','schedule today',
  'claim your quote','get my free estimate','get my free quote',
];

const WEAK_CTA = [
  'contact us','reach out','get in touch','call us','email us',
  'learn more','send message','submit','contact',
];

function detectCTA(homepageHtml, homepageText, widgets, pages) {
  // 1. Playwright buttons/links (most reliable — rendered DOM)
  const homepageDom = pages.find(p => p.type === 'homepage')?.domData;
  if (homepageDom) {
    const allInteractive = [
      ...homepageDom.buttons,
      ...homepageDom.links.map(l => l.text),
      ...homepageDom.headings.map(h => h.text),
    ].map(t => t.toLowerCase());

    for (const phrase of STRONG_CTA) {
      if (allInteractive.some(t => t.includes(phrase))) return { result: 'strong', phrase };
    }
    // Also check ctaFound array from extractor
    if (homepageDom.ctaFound?.length > 0) return { result: 'strong', phrase: homepageDom.ctaFound[0] };
  }

  // 2. HTML interactive elements
  const interactive = homepageHtml.match(/<(button|a|input)\b[^>]*>([\s\S]*?)<\/(button|a)>|<input\b[^>]+>/gi) || [];
  for (const el of interactive) {
    const t = normalizeText(el);
    for (const phrase of STRONG_CTA) {
      if (t.includes(phrase)) return { result: 'strong', phrase };
    }
  }

  // 3. Text corpus
  for (const phrase of STRONG_CTA) {
    if (homepageText.includes(phrase)) return { result: 'strong', phrase };
  }

  // 4. GHL / booking widget
  if (widgets.isGHL || widgets.hasBooking) return { result: 'partial', phrase: null };

  // 5. tel: link
  if (/href=["']tel:/i.test(homepageHtml)) return { result: 'weak', phrase: null };

  // 6. Weak CTA
  if (WEAK_CTA.some(p => homepageText.includes(p))) return { result: 'weak', phrase: null };

  return { result: false, phrase: null };
}

// ═══════════════════════════════════════════════════════════════════════
// SCORING HELPERS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Score a check result against its max points.
 * true = full, 'partial' = half, false/undefined = 0.
 * Fractional partials are supported: pass e.g. 'partial:0.67' for 2/3.
 */
function weightedScore(result, max) {
  // Accept either raw booleans/strings or EvidenceResult objects { result, evidence, confidence }
  const r = (result && typeof result === 'object') ? result.result : result;
  if (r === true)              return max;
  if (r === 'partial')         return +(max / 2).toFixed(4);
  if (typeof r === 'string' && r.startsWith('partial:')) {
    const frac = parseFloat(r.slice(8));
    return isNaN(frac) ? +(max / 2).toFixed(4) : +(max * frac).toFixed(4);
  }
  return 0;
}
function round2(n) { return Math.round(n * 100) / 100; }

/** Wrap a check result with evidence + confidence. Every check function returns one of these. */
function ev(result, evidence, confidence = 'High') {
  return { result, evidence: evidence || 'No evidence found', confidence };
}

// ═══════════════════════════════════════════════════════════════════════
// ── CATEGORY 1: SEO VISIBILITY (30 pts) ─────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

// 1a. Title tag includes service + local intent (6 pts)
function checkTitleTag(homepageHtml, pages) {
  const domPage = pages.find(p => p.type === 'homepage')?.domData;
  const title   = domPage?.seo?.title
    || (homepageHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim()
    || '';

  if (!title || title.length < 5)
    return ev(false, 'No title tag found or title is too short');

  const TRADE_RE = /roof|plumb|hvac|heat|cool|air.?condition|landscap|electric|contractor|remodel|renovati|paint|siding|gutter|deck|fence|drywall|flooring|tile|handyman|home.?service|home.?improvement/i;
  const LOCAL_RE = /\b(in|near|serving|for)\s+[A-Za-z]{3,}|[A-Za-z]{3,},\s*[A-Z]{2}\b|local|service\s+area/i;

  const hasTrade = TRADE_RE.test(title);
  const hasLocal = LOCAL_RE.test(title);

  if (hasTrade && hasLocal && title.length >= 20)
    return ev(true,      `Title: "${title.slice(0,80)}" — trade + location`);
  if (hasTrade)
    return ev('partial', `Title: "${title.slice(0,80)}" — trade term but no location`, 'Medium');
  if (hasLocal)
    return ev('partial', `Title: "${title.slice(0,80)}" — location but no trade term`, 'Medium');
  return ev(false, `Title tag ("${title.slice(0,60)}") has no trade or local keywords`);
}

// 1b. H1/H2/H3 includes service or local intent (5 pts)
function checkHeadingKeywords(homepageHtml, homepageText, pages) {
  const domPage  = pages.find(p => p.type === 'homepage')?.domData;
  const headings = domPage
    ? domPage.headings
    : (homepageHtml.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi) || [])
        .map(h => ({ tag: (h.match(/<(h[1-3])/i)||[])[1]?.toLowerCase()||'h1', text: normalizeText(h) }));

  if (!headings.length)
    return ev(false, 'No H1, H2, or H3 headings found on the page');

  const TRADE = ['roof','plumb','hvac','heat','cool','air condition','landscap','electric','contractor','remodel','paint','siding','gutter','deck','fence','flooring','tile','handyman','home service','home improvement','repair','install','renovati'];
  const LOCAL = [' in ',' near ','serving ','local','service area','your area'];

  const matched = headings.filter(h => {
    const t = h.text.toLowerCase();
    return TRADE.some(k => t.includes(k)) || LOCAL.some(l => t.includes(l)) || /[a-z]{3,},\s*[a-z]{2}\b/i.test(t);
  });

  if (!matched.length) {
    const sample = headings.slice(0,2).map(h => `"${h.text.slice(0,40)}"`).join(', ');
    return ev(false, `${headings.length} heading(s) found (${sample}) but none include a trade term or location`);
  }

  const best = matched[0];
  const txt  = matched.map(h => h.text.toLowerCase()).join(' ');
  const hasTrade = TRADE.some(k => txt.includes(k));
  const hasLocal = LOCAL.some(l => txt.includes(l)) || /[a-z]{3,},\s*[a-z]{2}\b/i.test(txt);

  if (hasTrade && hasLocal) return ev(true,      `Heading: "${best.text.slice(0,80)}" — trade + location`);
  if (hasTrade)             return ev('partial', `Heading: "${best.text.slice(0,80)}" — trade term, no location`, 'Medium');
  return                           ev('partial', `Heading: "${best.text.slice(0,80)}" — location, no trade term`, 'Medium');
}

// 1c. Meta description exists and is relevant (4 pts)
function checkMetaDescription(homepageHtml, pages) {
  const domPage = pages.find(p => p.type === 'homepage')?.domData;
  const meta    = domPage?.seo?.metaDesc
    || (homepageHtml.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
       || homepageHtml.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i))?.[1]?.trim()
    || '';

  if (!meta || meta.length < 20)
    return ev(false, meta ? `Meta description too short (${meta.length} chars): "${meta}"` : 'No meta description found');

  const TRADE_RE = /roof|plumb|hvac|landscap|electric|contractor|remodel|paint|siding|gutter|deck|repair|install/i;
  const hasTrade = TRADE_RE.test(meta);
  const isLong   = meta.length >= 80;

  if (isLong && hasTrade) return ev(true,          `Meta (${meta.length} chars): "${meta.slice(0,100)}"`);
  if (hasTrade)           return ev('partial',     `Meta has trade keywords but is short (${meta.length} chars)`, 'Medium');
  if (isLong)             return ev('partial',     `Meta is long but lacks trade/service keywords`, 'Medium');
  return                         ev('partial:0.25',`Meta exists (${meta.length} chars) but is generic`, 'Low');
}

// 1d. Services clearly listed (5 pts)
function detectServices(allHtml, allText) {
  const matched = SERVICE_TERMS.filter(t => allText.includes(t));
  const unique  = [...new Set(matched)];

  if (!unique.length)
    return ev(false, 'No specific contractor service terms found (roofing, plumbing, HVAC, etc.)');

  const SECTION_HEADS = [
    'our services','what we do','what we offer','services we offer',
    'services include','services we provide','we specialize in',
    'we install','we repair','we replace','what we handle',
  ];
  const hasSection = containsAny(allText, SECTION_HEADS);
  const hasList    = /<(ul|ol)[^>]*>[\s\S]{10,3000}?<\/(ul|ol)>/i.test(allHtml) && unique.length > 0;
  const sample     = unique.slice(0,5).join(', ');

  if ((hasSection || hasList) && unique.length >= 3) return ev(true,          `${unique.length} services in section: ${sample}`);
  if ((hasSection || hasList) && unique.length >= 1) return ev('partial',     `Services section with ${unique.length}: ${sample}`, 'Medium');
  if (unique.length >= 4)                            return ev('partial',     `${unique.length} service terms (no section): ${sample}`, 'Medium');
  if (unique.length >= 2)                            return ev('partial:0.4', `${unique.length} service terms: ${sample}`, 'Low');
  return                                                    ev('partial:0.2', `Only 1 service term: "${unique[0]}" — insufficient`, 'Low');
}

// 1e. Dedicated service pages or strong service sections (4 pts)
function checkServicePageDepth(pages, allHtml) {
  const crawledSvc = pages.filter(p =>
    p.type === 'services'
    || SERVICE_TERMS.some(t => p.url.toLowerCase().includes(t.split(' ')[0]))
  );

  const linkRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set();
  const svcLinks = [];
  let m;
  while ((m = linkRe.exec(allHtml)) !== null) {
    const href = m[1].toLowerCase();
    const txt  = normalizeText(m[0]);
    const key  = href.split(/[?#]/)[0];
    if (seen.has(key)) continue;
    if (/blog|news|post|article|press/i.test(href)) continue;
    if (SERVICE_TERMS.some(t => href.includes(t.split(' ')[0]) || txt.includes(t))) {
      seen.add(key);
      svcLinks.push(txt.slice(0,40) || href.slice(0,40));
    }
  }

  if (!crawledSvc.length && !svcLinks.length)
    return ev(false, 'No dedicated service pages crawled and no service-specific links found');
  if (crawledSvc.length >= 3 || svcLinks.length >= 5)
    return ev(true,    `${crawledSvc.length} service page(s) crawled; ${svcLinks.length} link(s): ${svcLinks.slice(0,3).join(', ')}`);
  return ev('partial', `${crawledSvc.length} service page(s) crawled; ${svcLinks.length} service link(s)`, 'Medium');
}

// 1f. Location / service area content (4 pts)
function detectLocalSEO(allText) {
  const PHRASES = ['service area','areas we serve','serving ','cities we serve','proudly serving','coverage area','we serve ','areas served','serving the','we service ','locations we serve'];
  const MULTI_CITY = /([A-Z][a-z]{2,},\s*){2,}/;
  const POSTAL     = /[a-z]\d[a-z]\s*\d[a-z]\d/i;
  const ZIP_PAIR   = /\b\d{5}\b.{0,30}\b\d{5}\b/;
  const CITY_STATE = /[a-z]{3,},\s*[a-z]{2}\b/;

  const mPhrases = PHRASES.filter(p => allText.includes(p));
  const hasMulti  = MULTI_CITY.test(allText);
  const hasPostal = POSTAL.test(allText) || ZIP_PAIR.test(allText);
  const hasCitySt = CITY_STATE.test(allText);

  let s = 0;
  const evidence = [];
  if (mPhrases.length) { s += 2; evidence.push(`phrase: "${mPhrases[0]}"`); }
  if (hasMulti)        { s += 2; evidence.push('multiple cities listed'); }
  if (hasPostal)       { s += 1; evidence.push('postal/zip codes found'); }
  if (hasCitySt)       { s += 1; evidence.push('city, state pattern'); }

  if (!evidence.length)
    return ev(false, 'No service area phrases, city names, or postal codes found');
  if (s >= 4) return ev(true,          `Location: ${evidence.join('; ')}`);
  if (s >= 2) return ev('partial',     `Partial location: ${evidence.join('; ')}`, 'Medium');
  return       ev('partial:0.25',      `Weak location signal: ${evidence.join('; ')}`, 'Low');
}

// 1g. Internal links to key pages (2 pts)
function checkInternalLinks(pages, allHtml) {
  const KEY = ['service','contact','about','review','testimonial','gallery','project','portfolio'];
  const found = new Set();
  const re = /<a\b[^>]*href=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(allHtml)) !== null) {
    const h = m[1].toLowerCase();
    if (h.startsWith('http') || h.startsWith('#') || h.startsWith('mailto') || h.startsWith('tel')) continue;
    for (const k of KEY) { if (h.includes(k)) { found.add(k); break; } }
  }
  const pwLinks = pages.flatMap(p => (p.domData?.links || []).map(l => l.href.toLowerCase()));
  for (const h of pwLinks) {
    if (!h.startsWith('http')) for (const k of KEY) { if (h.includes(k)) { found.add(k); break; } }
  }

  if (!found.size)     return ev(false,         'No internal links to services, contact, about, or key pages found');
  if (found.size >= 4) return ev(true,           `Internal links to: ${[...found].join(', ')}`);
  if (found.size >= 2) return ev('partial',      `Links to: ${[...found].join(', ')} (need 4+ for full credit)`, 'Medium');
  return                      ev('partial:0.25', `Only 1 key internal link: ${[...found].join(', ')}`, 'Low');
}

// ═══════════════════════════════════════════════════════════════════════
// ── CATEGORY 2: LOCAL TRUST (25 pts) ────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

// 2a. Reviews / testimonials visible (7 pts)
// STRICT: "trusted", "quality", "satisfaction", "professional" do NOT score
function detectTrustSignals(allHtml, allText) {
  const evidence = [];
  let s = 0;

  const starM = allHtml.match(/(\d[\d.]*)\s*(out of\s*\d+\s*)?stars?/i) || allHtml.match(/[\u2605\u2606\u2B50]/u);
  if (starM) { s += 3; evidence.push(`star rating: "${(starM[0]||'★').slice(0,30)}"`); }

  const cntM = allText.match(/(\d{2,})\s+reviews?/i);
  if (cntM)  { s += 3; evidence.push(`review count: "${cntM[0]}"`); }

  const quotedM = allHtml.match(/"([^"]{25,120})"[\s\S]{0,80}[-\u2013\u2014]\s*([A-Z][a-z]+)/);
  if (quotedM) { s += 3; evidence.push(`quoted review: "${quotedM[1].slice(0,60)}"`); }

  if (/\btestimonial/i.test(allText)) { s += 2; evidence.push('"testimonial" section detected'); }
  if (/google\s*review|reviewed on google/i.test(allText)) { s += 2; evidence.push('Google reviews mentioned'); }
  if (/rated\s+[\d.]+\s*(\/\s*\d+)?|average\s+rating/i.test(allText)) { s += 2; evidence.push('rating average detected'); }
  if (/houzz|angi\b|homeadvisor|bbb\.org|yelp\.com|trustpilot/i.test(allText)) { s += 1; evidence.push('review platform mentioned'); }
  if (/what.{0,15}customers?.{0,15}say|hear from our|client.{0,5}feedback|customer.{0,5}review/i.test(allText)) { s += 1; evidence.push('customer feedback section'); }

  // Review widgets (Elfsight, Birdeye, Podium, NiceJob, etc.)
  const pwWidgets = allHtml; // allHtml includes all pages' HTML
  if (/elfsight\.com|apps\.elfsight/i.test(pwWidgets))        { s += 3; evidence.push('Elfsight review widget detected'); }
  if (/birdeye\.com|birdeyereviews/i.test(pwWidgets))          { s += 3; evidence.push('Birdeye review widget detected'); }
  if (/podium\.com|reviews\.podium/i.test(pwWidgets))          { s += 3; evidence.push('Podium review widget detected'); }
  if (/nicejob\.com|widget\.nicejob/i.test(pwWidgets))         { s += 3; evidence.push('NiceJob review widget detected'); }
  if (/grade\.us|gradeus/i.test(pwWidgets))                    { s += 2; evidence.push('Grade.us review widget detected'); }
  if (/reviews\.io|widget\.reviews\.io/i.test(pwWidgets))      { s += 2; evidence.push('Reviews.io widget detected'); }

  // "review" word alone = 0. "trusted/quality/satisfied/professional" = explicitly NOT scored.

  if (!evidence.length)
    return ev(false, 'No reviews, star ratings, testimonials, or quoted customer feedback found. Generic words like "trusted" or "quality" do not count.');
  if (s >= 7) return ev(true,          `Reviews: ${evidence.join('; ')}`);
  if (s >= 4) return ev('partial',     `Partial reviews: ${evidence.join('; ')}`, 'Medium');
  return       ev('partial:0.25',      `Weak review signal: ${evidence.join('; ')}`, 'Low');
}

// 2b. Google signals (5 pts)
function checkGoogleSignals(allHtml, pages) {
  const evidence = [];
  let s = 0;

  if (/google\.com\/maps|maps\.google|goo\.gl\/maps|maps\.app\.goo/i.test(allHtml))  { s += 2; evidence.push('Google Maps link'); }
  if (/iframe[^>]*(google.*maps|maps\.google)/i.test(allHtml))                        { s += 2; evidence.push('Google Map embed'); }
  if (/google.*review|review.*google/i.test(allHtml))                                 { s += 2; evidence.push('Google reviews link'); }
  if (/google.*business|business\.google|gbp\.google/i.test(allHtml))                 { s += 1; evidence.push('Google Business link'); }
  if (/"@type"\s*:\s*"[A-Za-z]*(Contractor|LocalBusiness|Service)/i.test(allHtml))    { s += 2; evidence.push('LocalBusiness schema'); }

  const addrM = allHtml.match(/\d{2,5}\s+[a-z]+\s+(street|st\.?|avenue|ave\.?|road|rd\.?|blvd|drive|dr\.?|lane|ln\.?|way|court|ct\.?)\b[^<\n]{0,60}/i);
  if (addrM) { s += 2; evidence.push(`address: "${addrM[0].slice(0,50)}"`); }

  const pwG = pages.filter(p => p.domData?.google).map(p => p.domData.google);
  if (pwG.some(g => g.hasGoogleMap || g.hasEmbeddedMap) && !evidence.includes('Google Maps link')) { s += 2; evidence.push('Google Map (Playwright)'); }
  if (pwG.some(g => g.hasGoogleReviews) && s < 5)   { s += 1; evidence.push('Google reviews (Playwright)'); }
  if (pwG.some(g => g.hasLocalBusinessSchema))       { s += 1; evidence.push('Schema (Playwright)'); }

  if (!evidence.length)
    return ev(false, 'No Google Maps, address, Google Business link, or schema markup found');
  if (s >= 6) return ev(true,          `Google signals: ${evidence.join('; ')}`);
  if (s >= 3) return ev('partial',     `Partial Google signals: ${evidence.join('; ')}`, 'Medium');
  return       ev('partial:0.25',      `Weak Google signal: ${evidence.join('; ')}`, 'Low');
}

// 2c. Proof of work (5 pts)
function checkProofOfWork(pages, allHtml, allText) {
  const GALLERY = ['gallery','portfolio','our work','past projects','before and after','before after','completed jobs','completed projects','work showcase','recent projects','our projects','photo gallery'];
  const matched      = GALLERY.filter(w => allText.includes(w));
  const hasGalleryPg = pages.some(p => p.type === 'gallery');
  const hasCarousel  = /swiper|splide|slick|owl.carousel|glide|lightbox|fancybox|isotope/i.test(allHtml);
  const pwImgCount   = pages.reduce((n, p) => n + (p.domData?.images?.total || 0), 0);
  const imgCount     = pwImgCount || (allHtml.match(/<img\b[^>]+>/gi) || []).length;

  const evidence = [];
  if (hasGalleryPg)   evidence.push('gallery page crawled');
  if (matched.length) evidence.push(`keywords: ${matched.slice(0,3).join(', ')}`);
  if (hasCarousel)    evidence.push('carousel/lightbox markup');
  if (imgCount > 0)   evidence.push(`${imgCount} image(s)`);

  if (!matched.length && !hasGalleryPg && imgCount < 4)
    return ev(false, `No gallery/portfolio/before-after found. ${imgCount} image(s) detected (need 4+ for weak credit)`);
  if (hasGalleryPg && matched.length)
    return ev(true,          evidence.join('; '));
  if (matched.length && (hasCarousel || imgCount >= 6))
    return ev(true,          evidence.join('; '));
  if (matched.length || (hasCarousel && imgCount >= 4))
    return ev('partial',     evidence.join('; '), 'Medium');
  if (imgCount >= 10)
    return ev('partial:0.3', `${imgCount} images but no gallery labelling`, 'Low');
  return ev(false, `Insufficient: ${evidence.join('; ') || 'none'}`);
}

// 2d. Licensed / insured / certified (4 pts)
// STRICT: "professional", "experienced", "reliable", "trusted" do NOT count
function checkProfessionalSignals(allText) {
  const SPECIFIC = [
    'licensed','fully insured','insured','certified','bonded',
    'accredited','bbb accredited','years of experience','years experience',
    'years in business','years serving','trade member','member of ',
    'nrca','phcc','acca','neca','nalp','cfma','nari','nahb',
  ];
  const GENERIC = ['professional','experienced','reliable','trusted','quality','affordable','best','expert'];
  const found = SPECIFIC.filter(c => allText.includes(c));

  if (!found.length) {
    const hasGeneric = GENERIC.some(g => allText.includes(g));
    return ev(false, hasGeneric
      ? 'Only generic words found (professional/experienced/trusted) — do not count as credentials'
      : 'No license, insurance, certification, or trade association credentials found');
  }
  if (found.length >= 3) return ev(true,          `Credentials: ${found.slice(0,4).join(', ')}`);
  if (found.length >= 2) return ev('partial',      `Credentials: ${found.join(', ')}`, 'Medium');
  return                   ev('partial:0.25',      `Single credential: "${found[0]}"`, 'Low');
}

// 2e. Guarantees / free estimates / warranties (4 pts)
function checkRiskReversal(allText) {
  const PHRASES = [
    'free estimate','free quote','free consultation','free inspection',
    'no obligation','no-obligation','no cost estimate',
    'satisfaction guaranteed','100% satisfied','100% guarantee',
    'money back','warranty','warranted',
    'same day service','same-day service',
    'emergency service','emergency response','emergency repair',
  ];
  const found = PHRASES.filter(p => allText.includes(p));

  if (!found.length)
    return ev(false, 'No free estimate, guarantee, warranty, or risk-reversal language found');
  if (found.length >= 3) return ev(true,          `Risk reversal: ${found.slice(0,4).join(', ')}`);
  if (found.length >= 2) return ev('partial',     `Risk reversal: ${found.join(', ')}`, 'Medium');
  return                   ev('partial:0.25',     `Single phrase: "${found[0]}"`, 'Low');
}

// ═══════════════════════════════════════════════════════════════════════
// ── CATEGORY 3: LEAD CONVERSION (30 pts) ────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

// 3a. Strong CTA (7 pts)
function checkCTA(homepageHtml, homepageText, widgets, pages) {
  const { result, phrase } = detectCTA(homepageHtml, homepageText, widgets, pages);
  if (result === 'strong' && phrase) return ev(true,          `Strong CTA: "${phrase}"`);
  if (result === 'strong')           return ev(true,          'Strong CTA in rendered content');
  if (widgets.isGHL)                 return ev('partial',     'GoHighLevel funnel — CTA likely in widget', 'Medium');
  if (widgets.hasBooking)            return ev('partial',     'Booking/calendar widget detected', 'Medium');
  if (result === 'weak')             return ev('partial:0.3', 'Only weak CTA (e.g. "Contact Us") — not a strong action phrase', 'Low');
  return ev(false, 'No CTA found. No "Free Quote", "Call Now", "Book Service", or similar phrase detected.');
}

// 3b. Phone number visible or clickable (6 pts)
// STRICT: actual digits or tel: link required
function checkPhone(methods) {
  if (methods.telLink && methods.phone)
    return ev(true,      `Click-to-call + visible number: ${methods.firstTelLink || 'detected'}`);
  if (methods.telLink)
    return ev('partial', `Tel: link (${methods.firstTelLink || 'detected'}) but no visible number in text`, 'Medium');
  if (methods.phone)
    return ev('partial', `Phone number in text but no tap-to-call tel: link`, 'Medium');
  return ev(false, 'No phone number or tel: link found anywhere on the site');
}

// 3c. Contact form / booking / widget (6 pts)
// STRICT: real form markup or widget script required — "contact us" text = 0
// Newsletter-only (email-only) forms get partial credit only
function checkContactForm(allHtml, widgets, pages) {
  const evidence = [];

  if (widgets.isGHL)         evidence.push('GoHighLevel embedded form');
  if (widgets.hasIframeForm) evidence.push('iframe form detected');
  if (widgets.hasBooking && !widgets.isGHL) evidence.push(
    widgets.hasCalendly ? 'Calendly' : widgets.hasAcuity ? 'Acuity' : 'booking widget'
  );
  // STRICT chatbot: only known vendors — NOT generic "help/support/contact" text
  if (widgets.hasTawk)        evidence.push('Tawk.to chat');
  else if (widgets.hasIntercom) evidence.push('Intercom chat');
  else if (widgets.hasDrift)    evidence.push('Drift chat');
  else if (widgets.hasCrisp)    evidence.push('Crisp chat');
  else if (widgets.hasFreshchat) evidence.push('Freshchat');
  else if (widgets.hasZendesk)  evidence.push('Zendesk chat');
  else if (widgets.hasChat)     evidence.push('live chat widget');

  const pwForms = pages.flatMap(p => p.domData?.forms || []);
  const pwNewsletterOnly = pages.some(p => p.domData?.widgets?.hasNewsletterOnlyForm);

  if (pwForms.length > 0) {
    if (pwNewsletterOnly && pwForms.every(f => f.fieldCount <= 1)) {
      // Email-only form — partial credit, not a full lead form
      evidence.push(`Email/newsletter form only (${pwForms[0].fieldCount} field) — not a lead form`);
    } else {
      evidence.push(`HTML form: ${pwForms[0].fieldCount} field(s), submit: "${pwForms[0].submitText || 'yes'}"`);
    }
  } else if (/<form\b/i.test(allHtml)) {
    const allInputs = allHtml.match(/<input\b[^>]+>/gi) || [];
    const hidden    = allInputs.filter(i => /type=["'](hidden|submit|button|reset|checkbox|radio|image)["']/i.test(i)).length;
    const vis       = Math.max(0, allInputs.length - hidden) + (allHtml.match(/<textarea\b/gi) || []).length;
    if (vis > 0) evidence.push(`HTML form with ${vis} visible field(s)`);
  }

  if (!evidence.length)
    return ev(false, 'No contact form, booking widget, or chat widget found. "Contact Us" text does NOT count.');

  // Newsletter-only downgrade
  if (pwNewsletterOnly && pwForms.length > 0 && pwForms.every(f => f.fieldCount <= 1) && !widgets.isGHL && !widgets.hasBooking)
    return ev('partial:0.3', `Newsletter/email-only form: ${evidence.join('; ')}`, 'Low');

  if (evidence.length >= 2 || (evidence.length >= 1 && (widgets.isGHL || pwForms.length > 0)))
    return ev(true,    `Form/widget: ${evidence.join('; ')}`);
  return ev('partial', `Partial contact option: ${evidence.join('; ')}`, 'Medium');
}

// 3d. 3+ contact methods (5 pts)
// STRICT: only real detected signals — not CTA text
function checkContactMethods(methods) {
  const found = [];
  if (methods.phone)   found.push('phone');
  if (methods.email)   found.push('email');
  if (methods.form)    found.push('contact form');
  if (methods.chat)    found.push('live chat');
  if (methods.booking) found.push('booking/calendar');
  if (methods.address) found.push('address');

  if (!found.length)
    return ev(false, 'No real contact methods detected (phone/email/form/chat/booking/address)');
  if (found.length >= 3) return ev(true,          `${found.length} methods: ${found.join(', ')}`);
  if (found.length === 2) return ev('partial',    `2 methods: ${found.join(', ')} — need 3+`, 'Medium');
  return ev('partial:0.2', `1 method only: ${found.join(', ')}`, 'Low');
}

// 3e. Above-the-fold clarity (4 pts)
function checkAboveFold(homepageHtml, homepageText, pages) {
  const foldHtml = homepageHtml.slice(0, 6000);
  const foldText = normalizeText(foldHtml);
  const domPage  = pages.find(p => p.type === 'homepage')?.domData;
  const h1Text   = (domPage?.seo?.h1s || []).join(' ').toLowerCase();

  const TRADE = ['roof','plumb','hvac','heat','cool','landscap','electric','contractor','remodel','paint','siding','repair','install','home service'];
  const LOCAL = [' in ',' near ','serving ','local'];
  const combined = foldText + ' ' + h1Text;

  const tradeM = TRADE.find(k => combined.includes(k));
  const localM = LOCAL.find(l => combined.includes(l)) || (/[a-z]{3,},\s*[a-z]{2}\b/i.test(foldHtml) ? 'city+state' : null);
  const ctaM   = STRONG_CTA.find(p => foldText.includes(p));
  const hasTel = /href=["']tel:/i.test(foldHtml);
  const hasCTA = ctaM || hasTel || domPage?.ctaFound?.length > 0;

  const signals = [];
  if (tradeM) signals.push(`trade: "${tradeM}"`);
  if (localM) signals.push(`location: "${localM}"`);
  if (hasCTA) signals.push(ctaM ? `CTA: "${ctaM}"` : 'tel: link or CTA widget');

  if (!signals.length) return ev(false,         'Above-the-fold has no trade term, location, or CTA');
  if (signals.length >= 3) return ev(true,      `Above fold: ${signals.join('; ')}`);
  if (signals.length >= 2) return ev('partial', `Partial above-fold: ${signals.join('; ')}`, 'Medium');
  return                    ev('partial:0.25',  `1 above-fold signal only: ${signals.join('; ')}`, 'Low');
}

// 3f. Low-friction conversion path (2 pts)
function checkConversionPath(allHtml, widgets, pages) {
  if (widgets.isGHL) return ev(true, 'GoHighLevel funnel — optimised lead flow');

  const pwForms = pages.flatMap(p => p.domData?.forms || []);
  const hasTel  = /href=["']tel:/i.test(allHtml);

  if (pwForms.length > 0) {
    const min = Math.min(...pwForms.map(f => f.fieldCount));
    if (min <= 3 && hasTel) return ev(true,          `Short form (${min} field(s)) + click-to-call`);
    if (min <= 4)            return ev(true,          `Short form (${min} field(s))`);
    if (min <= 7)            return ev('partial',     `Form has ${min} field(s) — slightly long`, 'Medium');
    return ev(false, `Form has ${min} field(s) — too much friction`);
  }

  const allInputs = allHtml.match(/<input\b[^>]+>/gi) || [];
  const hidden    = allInputs.filter(i => /type=["'](hidden|submit|button|reset|checkbox|radio|image)["']/i.test(i)).length;
  const vis       = Math.max(0, allInputs.length - hidden) + (allHtml.match(/<textarea\b/gi) || []).length;

  if (vis > 0 && vis <= 4 && hasTel) return ev(true,          `Short form (${vis} field(s)) + tel: link`);
  if (vis > 0 && vis <= 4)            return ev('partial',     `Form (${vis} field(s))`, 'Medium');
  if (vis > 4 && vis <= 7)            return ev('partial:0.3', `Form (${vis} field(s)) — borderline`, 'Low');
  if (hasTel && vis === 0)            return ev('partial:0.3', 'Click-to-call only — no form', 'Low');
  return ev(false, 'No short form or clear conversion path');
}

// ═══════════════════════════════════════════════════════════════════════
// ── CATEGORY 4: TECHNICAL HEALTH (15 pts) ───────────────────────────
// ═══════════════════════════════════════════════════════════════════════

// 4a. HTTPS (3 pts)
function checkHttps(finalUrl) {
  if (finalUrl.startsWith('https://')) return ev(true,  `HTTPS confirmed: ${finalUrl}`);
  return                                       ev(false, `HTTP only (not secure): ${finalUrl}`);
}

// 4b. Mobile PageSpeed (6 pts)
function checkMobileSpeed(psData) {
  if (!psData)      return ev('partial', 'PageSpeed API unavailable — estimated', 'Low');
  const perf = psData?.lighthouseResult?.categories?.performance?.score;
  if (perf == null) return ev('partial', 'PageSpeed returned no score', 'Low');
  const score = Math.round(perf * 100);
  if (perf >= 0.9)  return ev(true,           `Mobile PageSpeed: ${score}/100 — Excellent`);
  if (perf >= 0.75) return ev('partial:0.75', `Mobile PageSpeed: ${score}/100 — Good`, 'Medium');
  if (perf >= 0.50) return ev('partial',      `Mobile PageSpeed: ${score}/100 — Needs work`, 'Medium');
  if (perf >= 0.25) return ev('partial:0.25', `Mobile PageSpeed: ${score}/100 — Poor`, 'Low');
  return              ev(false,               `Mobile PageSpeed: ${score}/100 — Very slow`);
}

// 4c. Mobile usability (3 pts)
function checkMobileUsability(homepageHtml, pages) {
  const domPage      = pages.find(p => p.type === 'homepage')?.domData;
  const hasViewport  = domPage?.seo?.hasViewport
    || /name=["']viewport["'][^>]+content=["'][^"']*width=device-width/i.test(homepageHtml)
    || /content=["'][^"']*width=device-width[^"']*["'][^>]+name=["']viewport["']/i.test(homepageHtml);
  const hasFramework = /bootstrap|tailwind|bulma|foundation|@media\s*\(/i.test(homepageHtml);
  const hasLayout    = /class=["'][^"']*(row|col-|flex|grid-col|container)/i.test(homepageHtml);

  if (!hasViewport)  return ev(false,    'No mobile viewport meta tag — site likely not responsive');
  if (hasFramework || hasLayout) return ev(true, `Viewport + ${hasFramework ? 'CSS framework' : 'flex/grid layout'} detected`);
  return                                ev('partial', 'Viewport meta tag present but no responsive framework detected', 'Medium');
}

// 4d. Crawl health (3 pts)
function checkCrawlHealth(pages, method) {
  const total   = pages.length;
  const pwPages = pages.filter(p => p.domData !== null).length;
  if (method === 'playwright' && pwPages >= 1)
    return ev(true,           `Playwright: ${pwPages} page(s) rendered of ${total} crawled`);
  if (total >= 3)
    return ev('partial',      `HTTP: ${total} pages fetched (no JS rendering)`, 'Medium');
  if (total >= 1)
    return ev('partial:0.33', `HTTP: ${total} page(s) only`, 'Low');
  return ev(false, 'No pages successfully crawled');
}


// ═══════════════════════════════════════════════════════════════════════
// MASTER SCORING TABLE
// Maps each check key to { category, label, max, issue, fix, impact }
// ═══════════════════════════════════════════════════════════════════════

const SERVICE_TERMS = [
  'roofing','roof replacement','roof repair','plumbing','hvac','heating',
  'cooling','air conditioning','landscaping','lawn care','electrical',
  'remodeling','renovation','painting','siding','gutters','gutter installation',
  'windows','doors','decking','deck building','fencing','drywall','flooring',
  'tile','concrete','masonry','waterproofing','insulation','pressure washing',
  'power washing','snow removal','tree service','stump removal','excavation',
  'demolition','framing','carpentry','kitchen remodel','bathroom remodel',
];

const SCORE_TABLE = {
  // ── SEO Visibility (30) ───────────────────────────────────────
  titleTag: {
    cat: 'seoVisibility', max: 6, label: 'Title Tag (Service + Location)',
    issue:  "Title tag is missing or doesn't include your trade and service area.",
    fix:    'Format: "[Service] in [City] | [Business Name]" — keep it under 60 characters.',
    impact: 'The title tag is Google\'s #1 on-page ranking signal. A local-optimised title directly increases clicks from search results.',
  },
  headingKeywords: {
    cat: 'seoVisibility', max: 5, label: 'Heading Keywords (H1/H2/H3)',
    issue:  'Page headings don\'t include your trade or local keywords.',
    fix:    'Your H1 should state what you do and where: "Expert Roof Repair in [City]". Use H2s for service sections.',
    impact: 'Google reads headings to understand page content. Missing keywords here weakens both rankings and visitor clarity.',
  },
  metaDescription: {
    cat: 'seoVisibility', max: 4, label: 'Meta Description',
    issue:  'Meta description is missing or too short to be useful.',
    fix:    'Write 140–160 chars: "[Service] in [City]. Licensed & insured. Free estimates. Call [phone] or request a quote online."',
    impact: 'A strong meta description improves click-through rate from Google even when rankings are the same.',
  },
  servicesListed: {
    cat: 'seoVisibility', max: 5, label: 'Services Clearly Listed',
    issue:  'Your specific services are not clearly named on the site.',
    fix:    'Add a Services section listing each offering by name: Roof Replacement, Emergency Plumbing, AC Installation, etc.',
    impact: 'Visitors confirm within seconds whether you offer what they need. Unclear services cause immediate bounces.',
  },
  servicePageDepth: {
    cat: 'seoVisibility', max: 4, label: 'Dedicated Service Pages',
    issue:  'No individual pages targeting specific services were found.',
    fix:    'Create one page per core service: "/roof-replacement-[city]", "/emergency-plumber-[city]".',
    impact: 'Each service page is an additional Google ranking opportunity for high-intent searches.',
  },
  locationContent: {
    cat: 'seoVisibility', max: 4, label: 'Location & Service Area Content',
    issue:  'The site doesn\'t clearly list your city, region, or areas served.',
    fix:    '"Proudly serving [City], [Nearby Town], and surrounding areas." Add this to homepage and footer.',
    impact: 'Without location content, Google cannot rank you in local searches.',
  },
  internalLinks: {
    cat: 'seoVisibility', max: 2, label: 'Internal Links to Key Pages',
    issue:  'The site lacks clear internal links between homepage, services, and contact pages.',
    fix:    'Link your homepage to each service page and to your contact page from the nav and body copy.',
    impact: 'Internal links help Google discover and index your most important pages, improving rankings.',
  },

  // ── Local Trust (25) ─────────────────────────────────────────
  reviewsVisible: {
    cat: 'localTrust', max: 7, label: 'Reviews & Testimonials Visible',
    issue:  'No customer reviews, star ratings, or testimonials found on the site.',
    fix:    'Embed your Google star rating widget. Add 3–5 named customer quotes. Link to your Google Business reviews.',
    impact: 'Over 80% of homeowners check reviews before hiring. No visible social proof = no trust = no calls.',
  },
  googleSignals: {
    cat: 'localTrust', max: 5, label: 'Google Signals (Map, Address, Reviews)',
    issue:  'No Google Maps embed, street address, or Google Business link found.',
    fix:    'Add your full address in the footer. Embed a Google Map on the contact page. Link to your Google Business Profile.',
    impact: 'Google uses these signals to place you in the local map pack — the top 3 results that generate most contractor leads.',
  },
  proofOfWork: {
    cat: 'localTrust', max: 5, label: 'Proof of Work (Gallery / Before & After)',
    issue:  'No project photos, before/after images, or portfolio found.',
    fix:    'Add a Gallery page with real job photos. Before/after shots are the most persuasive content for contractors.',
    impact: 'Showing your work builds instant visual trust. Contractors with photo galleries convert significantly better.',
  },
  professionalSignals: {
    cat: 'localTrust', max: 4, label: 'Licensed / Insured / Certified',
    issue:  'No visible credentials — no mention of being licensed, insured, bonded, or certified.',
    fix:    '"Licensed & Insured | [X] Years Experience | [Trade Certification]" — display this near the top of every page.',
    impact: 'Homeowners\' top fear is hiring someone unqualified. Visible credentials remove this barrier immediately.',
  },
  riskReversal: {
    cat: 'localTrust', max: 4, label: 'Guarantees / Free Estimates / Warranties',
    issue:  'No free estimate offer, satisfaction guarantee, or warranty language found.',
    fix:    '"Free Estimates | 100% Satisfaction Guaranteed | 5-Year Workmanship Warranty" — place near every CTA.',
    impact: 'Risk-reduction language directly lowers the hesitation that stops customers from submitting a form.',
  },

  // ── Lead Conversion (30) ─────────────────────────────────────
  cta: {
    cat: 'leadConversion', max: 7, label: 'Strong Call-to-Action',
    issue:  'No prominent CTA found — visitors have no clear next step to get a quote or call.',
    fix:    'Add a large, high-contrast button above the fold: "Get My Free Estimate", "Call Now", or "Book a Service".',
    impact: 'A missing or weak CTA is the #1 reason contractor websites generate few leads despite decent traffic.',
  },
  phone: {
    cat: 'leadConversion', max: 6, label: 'Phone Number (Visible & Clickable)',
    issue:  'Phone number is not visible, not tap-to-call on mobile, or missing entirely.',
    fix:    'Place a <a href="tel:+1..."> phone number in the header of every page. Make it large and immediately visible.',
    impact: 'Most contractor leads come from phone calls. Any friction between a visitor and your number costs you the job.',
  },
  contactForm: {
    cat: 'leadConversion', max: 6, label: 'Contact Form / Booking / Widget',
    issue:  'No contact form, booking widget, or lead capture mechanism found.',
    fix:    'Add a short 3–4 field form: Name, Phone, Service, Message. Or embed a Calendly/GHL booking widget.',
    impact: 'Not everyone will call. A form or booking option captures leads who prefer not to call immediately.',
  },
  contactMethods: {
    cat: 'leadConversion', max: 5, label: '3+ Contact Methods Present',
    issue:  'Fewer than 3 ways to contact you were found.',
    fix:    'Offer at minimum: clickable phone + contact form + email or booking link.',
    impact: 'Different people prefer different contact methods. One option means you\'re invisible to everyone who prefers another.',
  },
  aboveFold: {
    cat: 'leadConversion', max: 4, label: 'Above-the-Fold Clarity',
    issue:  'The top of the homepage doesn\'t immediately communicate what you do, where you serve, or what to do next.',
    fix:    'Your hero section must answer 3 questions instantly: What do you do? Where? What should I do now? (CTA)',
    impact: 'Visitors decide to stay or leave in 3 seconds. Without immediate clarity, most leave without ever scrolling.',
  },
  conversionPath: {
    cat: 'leadConversion', max: 2, label: 'Low-Friction Conversion Path',
    issue:  'The path from visitor to lead has too many steps or asks for too much information.',
    fix:    'Keep forms to 3–4 fields. Offer click-to-call as an alternative. Remove unnecessary form fields.',
    impact: 'Every extra step or field reduces form completions. Simple paths convert 2–3× better.',
  },

  // ── Technical Health (15) ────────────────────────────────────
  https: {
    cat: 'technical', max: 3, label: 'HTTPS / Security',
    issue:  'The site uses HTTP — browsers display a "Not Secure" warning.',
    fix:    'Install a free SSL certificate via your host (Let\'s Encrypt). Takes under 10 minutes.',
    impact: 'An insecure warning instantly destroys trust and prevents many customers from submitting a form.',
  },
  mobileSpeed: {
    cat: 'technical', max: 6, label: 'Mobile Page Speed',
    issue:  'The site loads too slowly on mobile devices.',
    fix:    'Compress images to WebP format. Remove unused JavaScript. Consider faster hosting or a CDN. Audit: pagespeed.web.dev.',
    impact: 'Most contractor searches happen on mobile. Sites under 3 seconds retain most visitors; slow sites lose 40–60% of them.',
  },
  mobileUsability: {
    cat: 'technical', max: 3, label: 'Mobile Usability / Responsiveness',
    issue:  'The site may not be fully responsive — no mobile viewport configuration detected.',
    fix:    'Use a mobile-responsive theme. Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
    impact: 'A broken mobile layout sends leads directly to competitors — the majority of your potential customers are on phones.',
  },
  crawlHealth: {
    cat: 'technical', max: 3, label: 'Site Crawlability',
    issue:  'The site may be blocking bots, loading slowly, or rendering content entirely in JavaScript.',
    fix:    'Ensure key content is in the HTML source, not just rendered by JavaScript. Test with Google Search Console.',
    impact: 'If Google can\'t crawl your site properly, it won\'t rank it. Crawl issues silently suppress all your SEO effort.',
  },
};

// ═══════════════════════════════════════════════════════════════════════
// CRITICAL FLAGS
// ═══════════════════════════════════════════════════════════════════════

function buildCriticalFlags(checks, psData) {
  const flags = [];

  if (!checks.phone || checks.phone === false) {
    flags.push({ key: 'noPhone', label: 'No Phone Number Found',
      detail: 'Contractor customers expect to call. No visible, clickable phone number is the fastest way to lose leads.' });
  }
  if (checks.contactForm === false && checks.contactMethods === false) {
    flags.push({ key: 'noContactMethod', label: 'No Contact Form or Booking Option',
      detail: "Customers who won't call need another way to reach you. No form = lost quote requests." });
  }
  if (checks.cta === false) {
    flags.push({ key: 'noCTA', label: 'No Call-to-Action Found',
      detail: 'Without a CTA button, visitors have no clear next step and leave without contacting you.' });
  }
  if (checks.servicesListed === false) {
    flags.push({ key: 'noServices', label: 'No Services Clearly Listed',
      detail: "If visitors can't immediately see what you offer, they'll find a competitor who makes it obvious." });
  }
  if (checks.reviewsVisible === false) {
    flags.push({ key: 'noReviews', label: 'No Reviews or Testimonials Found',
      detail: 'Over 80% of homeowners check reviews before hiring. No social proof = no trust = no calls.' });
  }
  if (checks.https === false) {
    flags.push({ key: 'notHttps', label: 'Site Not Secured with HTTPS',
      detail: 'Browsers show "Not Secure" on HTTP sites. This stops many customers from submitting a form.' });
  }
  const psScore = psData?.lighthouseResult?.categories?.performance?.score;
  if (psScore != null && psScore < 0.35) {
    flags.push({ key: 'slowSpeed', label: 'Very Slow Mobile Speed',
      detail: `Mobile PageSpeed: ${Math.round(psScore * 100)}/100. Sites this slow lose most mobile visitors before loading.` });
  }
  if (checks.locationContent === false && checks.titleTag === false) {
    flags.push({ key: 'noLocationClarity', label: 'No Service/Location Clarity',
      detail: "The site doesn't mention a city, region, or service area. Google cannot rank you in local searches." });
  }

  return flags;
}

// ═══════════════════════════════════════════════════════════════════════
// CALCULATE FINAL SCORE
// ═══════════════════════════════════════════════════════════════════════

function calculateScore(checks) {
  const getR = v => (v && typeof v === 'object') ? v.result : v;
  const scores = {};
  let total = 0;

  for (const [key, meta] of Object.entries(SCORE_TABLE)) {
    const pts   = weightedScore(checks[key], meta.max);
    scores[key] = pts;
    total      += pts;
  }

  // ── Score cap: missing critical lead-gen signals ─────────────────
  // Spec: missing ALL core → max 40; missing 3+ → max 65
  const CRITICAL = ['phone','cta','servicesListed','reviewsVisible','contactForm','locationContent'];
  const missing  = CRITICAL.filter(k => getR(checks[k]) === false).length;
  let cappedTotal = Math.round(total * 10) / 10;
  let capApplied  = null;

  if (missing >= 5 && cappedTotal > 40) {
    cappedTotal = 40;
    capApplied  = `Score capped at 40 — ${missing} of 6 critical signals missing`;
  } else if (missing >= 3 && cappedTotal > 65) {
    cappedTotal = 65;
    capApplied  = `Score capped at 65 — ${missing} of 6 critical signals missing`;
  }

  // ── Single-page SEO penalty ────────────────────────────────────────
  // Applied AFTER cap — reduces SEO category points for single-page sites
  const singlePagePenalty = checks._isSinglePage ? 5 : 0;
  if (singlePagePenalty > 0) {
    cappedTotal = Math.max(0, cappedTotal - singlePagePenalty);
    capApplied  = (capApplied ? capApplied + '; ' : '') + `SEO -${singlePagePenalty}pts (single-page site)`;
  }

  return { scores, total: cappedTotal, rawTotal: Math.round(total * 10) / 10, capApplied, missingCritical: missing };
}

// ═══════════════════════════════════════════════════════════════════════
// BUILD OUTPUT STRUCTURES
// ═══════════════════════════════════════════════════════════════════════

function buildCategories(scores) {
  const cats = {
    seoVisibility:  { label: 'SEO Visibility',    max: 30, keys: ['titleTag','headingKeywords','metaDescription','servicesListed','servicePageDepth','locationContent','internalLinks'] },
    localTrust:     { label: 'Local Trust',        max: 25, keys: ['reviewsVisible','googleSignals','proofOfWork','professionalSignals','riskReversal'] },
    leadConversion: { label: 'Lead Conversion',    max: 30, keys: ['cta','phone','contactForm','contactMethods','aboveFold','conversionPath'] },
    technical:      { label: 'Technical Health',   max: 15, keys: ['https','mobileSpeed','mobileUsability','crawlHealth'] },
  };

  const result = {};
  for (const [id, cat] of Object.entries(cats)) {
    const score = round2(cat.keys.reduce((sum, k) => sum + (scores[k] || 0), 0));
    result[id]  = { label: cat.label, score, max: cat.max };
  }
  return result;
}

function buildIssues(checks) {
  const getR = v => (v && typeof v === 'object') ? v.result : v;
  return Object.entries(SCORE_TABLE)
    .filter(([key]) => getR(checks[key]) !== true)
    .map(([key]) => ({
      key,
      label:      SCORE_TABLE[key].label,
      severity:   getR(checks[key]) === false ? 'fail' : 'partial',
      issue:      SCORE_TABLE[key].issue,
      category:   SCORE_TABLE[key].cat,
      maxPoints:  SCORE_TABLE[key].max,
      evidence:   (checks[key] && typeof checks[key] === 'object') ? checks[key].evidence  : null,
      confidence: (checks[key] && typeof checks[key] === 'object') ? checks[key].confidence : 'High',
    }))
    .sort((a, b) => a.severity !== b.severity ? (a.severity === 'fail' ? -1 : 1) : b.maxPoints - a.maxPoints);
}

function buildRecommendations(checks) {
  const getR = v => (v && typeof v === 'object') ? v.result : v;
  return Object.entries(SCORE_TABLE)
    .filter(([key]) => getR(checks[key]) !== true)
    .map(([key]) => ({
      key,
      label:     SCORE_TABLE[key].label,
      fix:       SCORE_TABLE[key].fix,
      impact:    SCORE_TABLE[key].impact,
      category:  SCORE_TABLE[key].cat,
      maxPoints: SCORE_TABLE[key].max,
    }))
    .sort((a, b) => b.maxPoints - a.maxPoints);
}

// ═══════════════════════════════════════════════════════════════════════
// EVIDENCE FOUND — structured audit trail from actual scan data
// ═══════════════════════════════════════════════════════════════════════

function buildEvidenceFound(pages, methods, widgets, checks) {
  const getR   = v => (v && typeof v === 'object') ? v.result   : v;
  const getEv  = v => (v && typeof v === 'object') ? v.evidence  : null;
  const getC   = v => (v && typeof v === 'object') ? v.confidence : 'High';
  const status = v => getR(v) === true ? 'yes' : getR(v) === false ? 'no' : 'partial';

  const pagesScanned = pages.map(p => {
    let path; try { path = new URL(p.url).pathname || '/'; } catch { path = p.url; }
    return { path, url: p.url, type: p.type, source: p.source || 'unknown', rendered: !!p.domData };
  });

  return {
    pagesScanned,
    scanMethod: pages[0]?.domData ? 'playwright' : 'http-fallback',
    contactMethodsDetected: {
      phone:   { detected: methods.phone,   clickable: methods.telLink, value: methods.firstTelLink || null },
      email:   { detected: methods.email,   value: methods.firstEmail  || null },
      form:    { detected: methods.form   },
      chat:    { detected: methods.chat,    vendor: widgets.hasTawk ? 'Tawk' : widgets.hasIntercom ? 'Intercom' : widgets.hasDrift ? 'Drift' : widgets.hasCrisp ? 'Crisp' : widgets.hasChat ? 'unknown' : null },
      booking: { detected: methods.booking, vendor: widgets.hasCalendly ? 'Calendly' : widgets.hasAcuity ? 'Acuity' : widgets.isGHL ? 'GHL' : null },
      address: { detected: methods.address },
      total:   methods.count,
    },
    formsDetected:        getEv(checks.contactForm)  || (methods.form ? 'Form detected' : 'No form found'),
    chatWidgetsDetected:  widgets.isGHL ? 'GoHighLevel' : widgets.hasTawk ? 'Tawk.to' : widgets.hasIntercom ? 'Intercom' : widgets.hasDrift ? 'Drift' : widgets.hasCrisp ? 'Crisp' : widgets.hasChat ? 'Chat widget' : 'None',
    reviewsDetected:      getEv(checks.reviewsVisible)   || 'None',
    ctasDetected:         getEv(checks.cta)               || 'None',
    servicesDetected:     getEv(checks.servicesListed)    || 'None',
    trustSignalsDetected: [getEv(checks.professionalSignals), getEv(checks.riskReversal), getEv(checks.reviewsVisible)].filter(Boolean).join(' | ') || 'None',
    seoEvidence: {
      titleTag:        getEv(checks.titleTag),
      headings:        getEv(checks.headingKeywords),
      metaDescription: getEv(checks.metaDescription),
      locationContent: getEv(checks.locationContent),
      servicesListed:  getEv(checks.servicesListed),
    },
    checkEvidence: Object.fromEntries(
      Object.keys(SCORE_TABLE).map(key => [key, {
        status:     status(checks[key]),
        evidence:   getEv(checks[key])  || 'No evidence found',
        confidence: getC(checks[key]),
      }])
    ),
  };
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════

async function analyzeWebsite(rawUrl, opts = {}) {
  // ── Validate & normalise URL ─────────────────────────────────────
  const debugMode = !!(opts.debug);
  let startUrl = (rawUrl || '').trim();
  if (!startUrl) throw new Error('URL is required');
  if (!/^https?:\/\//i.test(startUrl)) startUrl = 'https://' + startUrl;

  console.log(`[LeadCheck] Scan started: ${startUrl}`);

  // ── LAYER 1: Crawl (Playwright → HTTP fallback) ──────────────────
  // crawlSite() manages all browser/page lifecycle internally.
  // No `page` object ever escapes into this scope.
  const { pages, finalHomeUrl, method } = await crawlSite(startUrl);

  console.log(`[LeadCheck] Pages scanned (${pages.length}): ` +
    pages.map(p => { try { return new URL(p.url).pathname || '/'; } catch { return p.url; } }).join(', '));

  // ── Build corpora ────────────────────────────────────────────────
  const { allHtml, allText, homepageHtml, homepageText } = mergePages(pages);
  const widgets = detectEmbeddedWidgets(allHtml, pages);
  const methods = detectContactMethods(allHtml, allText, widgets, pages);

  // ── Log raw evidence before scoring ─────────────────────────────
  const allPwForms = pages.flatMap(p => p.domData?.forms   || []);
  const allIframes = pages.flatMap(p => p.domData?.iframes || []);
  const allScripts = pages.flatMap(p => p.domData?.scripts || []);

  const homeDom    = pages.find(p => p.type === 'homepage')?.domData;
  const titleTag   = homeDom?.seo?.title
    || (homepageHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim()
    || '(none)';
  const metaDesc   = homeDom?.seo?.metaDesc || '(none)';
  const h1s        = homeDom?.seo?.h1s
    || (homepageHtml.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi) || []).map(h => normalizeText(h));

  console.log('[LeadCheck] Evidence found:');
  console.log(`  Scan method   : ${method}`);
  console.log(`  Visible text  : ${allText.length} chars`);
  console.log(`  Title tag     : "${titleTag.slice(0, 70)}"`);
  console.log(`  Meta desc     : ${metaDesc.length > 1 ? metaDesc.length + ' chars' : 'NONE'}`);
  console.log(`  H1s           : ${h1s.length ? h1s.slice(0,2).map(h=>`"${h.slice(0,50)}"`).join(', ') : 'NONE'}`);
  console.log(`  Headings      : ${(homeDom?.headings || []).length} heading(s)`);
  console.log(`  Forms         : ${allPwForms.length} (Playwright) | HTML <form>: ${/<form\b/i.test(allHtml)}`);
  console.log(`  Iframes       : ${allIframes.length}`);
  console.log(`  Scripts       : ${allScripts.length}`);
  console.log(`  Phone         : ${methods.phone ? (methods.firstTelLink || 'found') : 'NONE'} | tel: link: ${methods.telLink}`);
  console.log(`  Email         : ${methods.email ? (methods.firstEmail || 'found') : 'NONE'}`);
  console.log(`  Chat          : ${widgets.isGHL?'GHL ':''} ${widgets.hasTawk?'Tawk ':''} ${widgets.hasIntercom?'Intercom ':''} ${widgets.hasDrift?'Drift ':''} ${widgets.hasCrisp?'Crisp ':''} ${widgets.hasChat&&!widgets.isGHL?'(chat)':''} ${!widgets.hasChat&&!widgets.isGHL?'NONE':''}`);
  console.log(`  Booking       : ${widgets.hasBooking ? (widgets.hasCalendly?'Calendly':widgets.hasAcuity?'Acuity':'GHL/iframe') : 'NONE'}`);
  console.log(`  Reviews       : star=${!!(allHtml.match(/\d[\d.]*\s*stars?/i)||allHtml.match(/[\u2605\u2606]/u))} | count=${!!(allText.match(/\d{2,}\s+reviews?/i))} | testimonial=${/\btestimonial/i.test(allText)}`);
  console.log(`  CTA phrases   : ${(homeDom?.ctaFound||[]).slice(0,3).join(', ') || 'NONE (Playwright)'}`);
  console.log(`  Service terms : ${SERVICE_TERMS.filter(t=>allText.includes(t)).slice(0,5).join(', ') || 'NONE'}`);
  console.log(`  HTTPS         : ${startUrl.startsWith('https://')}`);

  // ── Single-page detection ────────────────────────────────────────
  const isSinglePage = pages.length === 1 && !widgets.isGHL;

  // ── PageSpeed (non-blocking, 9 s cap) ────────────────────────────
  let psData = null;
  try {
    psData = await Promise.race([
      fetchPageSpeed(finalHomeUrl),
      new Promise(resolve => setTimeout(() => resolve(null), 9000)),
    ]);
  } catch { psData = null; }

  // ── LAYER 2: Run all checks ──────────────────────────────────────
  // Every function below is a pure helper — none of them reference
  // `page` or `browser`. All Playwright data was already extracted
  // during the crawl phase and is in each page's `domData` object.
  const checks = {
    titleTag:            checkTitleTag(homepageHtml, pages),
    headingKeywords:     checkHeadingKeywords(homepageHtml, homepageText, pages),
    metaDescription:     checkMetaDescription(homepageHtml, pages),
    servicesListed:      detectServices(allHtml, allText),
    servicePageDepth:    checkServicePageDepth(pages, allHtml),
    locationContent:     detectLocalSEO(allText),
    internalLinks:       checkInternalLinks(pages, allHtml),
    reviewsVisible:      detectTrustSignals(allHtml, allText),
    googleSignals:       checkGoogleSignals(allHtml, pages),
    proofOfWork:         checkProofOfWork(pages, allHtml, allText),
    professionalSignals: checkProfessionalSignals(allText),
    riskReversal:        checkRiskReversal(allText),
    cta:                 checkCTA(homepageHtml, homepageText, widgets, pages),
    phone:               checkPhone(methods),
    contactForm:         checkContactForm(allHtml, widgets, pages),
    contactMethods:      checkContactMethods(methods),
    aboveFold:           checkAboveFold(homepageHtml, homepageText, pages),
    conversionPath:      checkConversionPath(allHtml, widgets, pages),
    https:               checkHttps(finalHomeUrl),
    mobileSpeed:         checkMobileSpeed(psData),
    mobileUsability:     checkMobileUsability(homepageHtml, pages),
    crawlHealth:         checkCrawlHealth(pages, method),
    _isSinglePage:       isSinglePage,   // consumed by calculateScore, stripped before response
  };

  // ── LAYER 3: Score + build report ───────────────────────────────
  const { scores, total, rawTotal, capApplied, missingCritical } = calculateScore(checks);
  const categories = buildCategories(scores);
  const psScore    = psData?.lighthouseResult?.categories?.performance?.score;

  // Log final score
  const getEv = v => (v && typeof v === 'object') ? v.evidence : '—';
  console.log('\n[LeadCheck] Final score:');
  for (const [, cat] of Object.entries(categories)) {
    const bar = '█'.repeat(Math.round(cat.score / cat.max * 10)).padEnd(10, '░');
    console.log(`  ${(cat.label + '              ').slice(0, 22)} ${bar} ${cat.score}/${cat.max}`);
  }
  console.log(`  ${'TOTAL'.padEnd(22)} ${total}/100 (raw: ${rawTotal})${capApplied ? ' ⚠ ' + capApplied : ''}\n`);

  const evidenceFound = buildEvidenceFound(pages, methods, widgets, checks);
  const publicChecks  = Object.fromEntries(Object.entries(checks).filter(([k]) => !k.startsWith('_')));

  const response = {
    url:             finalHomeUrl,
    total,
    maxScore:        100,
    rawTotal,
    capApplied,
    missingCritical,
    isSinglePage,
    totalLegacy:     Math.round(total / 5 * 10) / 10,
    maxScoreLegacy:  20,
    pagesAnalyzed:   pages.length,
    pagesCrawled:    pages.map(p => ({ url: p.url, type: p.type, source: p.source })),
    scanMethod:      method,
    checks:          publicChecks,
    scores,
    pageSpeedScore:  psScore != null ? Math.round(psScore * 100) : null,
    categories,
    issues:          buildIssues(publicChecks),
    recommendations: buildRecommendations(publicChecks),
    criticalFlags:   buildCriticalFlags(publicChecks, psData),
    evidenceFound,
    evidence:        evidenceFound,
    disclaimer:      'This score is based on automated checks of visible website elements and is designed to highlight likely opportunities to improve contractor lead generation. It is not a replacement for a full manual audit.',
  };

  if (debugMode) {
    response._debug = {
      allIframes:   allIframes.slice(0, 20),
      allScripts:   allScripts.slice(0, 20),
      allForms:     allPwForms,
      widgets,
      methods,
      pwTextLength: pages.filter(p => p.domData?.visibleText).map(p => ({ url: p.url, len: p.domData.visibleText.length })),
      rawChecks:    Object.fromEntries(
        Object.entries(checks)
          .filter(([k]) => !k.startsWith('_'))
          .map(([k, v]) => [k, typeof v === 'object' ? v : { result: v }])
      ),
    };
  }

  return response;
}

module.exports = {
  analyzeWebsite,
  normalizeText,
  containsAny,
  detectCTA,
  detectContactMethods,
  detectEmbeddedWidgets,
  extractInternalLinks,
  detectServices,
  detectTrustSignals,
  detectLocalSEO,
  calculateScore,
};