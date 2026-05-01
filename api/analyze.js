'use strict';
console.log('[LeadCheck] analyze.js loaded');
const https = require('https');
const http  = require('http');
const { URL } = require('url');

// ═══════════════════════════════════════════════════════════════════════
// PLAYWRIGHT — lazy-loaded so the app still starts if it's not installed
// ═══════════════════════════════════════════════════════════════════════

let playwrightAvailable = false;
let playwrightLoadError = null;
let chromium;

try {
  ({ chromium } = require('playwright'));
  playwrightAvailable = !!chromium;
} catch (err) {
  playwrightLoadError = err;
  playwrightAvailable = false;
}

console.log('[LeadCheck] Playwright available:', playwrightAvailable);
if (!playwrightAvailable) {
  console.error('[LeadCheck] Playwright import failed:', playwrightLoadError?.message || playwrightLoadError);
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
    .replace(/[^\w\s@.\u2605\u2606\u2B50★☆⭐]/g, ' ')   // preserve star chars
    .replace(/\s+/g,                        ' ')
    .toLowerCase()
    .trim();
}

function containsAny(text, needles) {
  const norm = text.includes('<') ? normalizeText(text) : text.toLowerCase();
  return needles.some(n => norm.includes(n.toLowerCase()));
}

const ADDRESS_RE = /\b\d{2,6}\s+(?:[a-z0-9#.'-]+\s+){1,6}(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct|crescent|cres|circle|cir|trail|trl|parkway|pkwy|terrace|ter|highway|hwy|line|sideroad)\.?\b(?:\s+(?:north|south|east|west|n|s|e|w))?(?:\s*(?:,|#|unit|suite|ste|apt)\s*[a-z0-9 .#-]{0,30})?(?:\s*,?\s*[a-z .'-]{2,30}\s*,?\s*(?:al|ak|az|ar|ca|co|ct|de|fl|ga|hi|ia|id|il|in|ks|ky|la|ma|md|me|mi|mn|mo|ms|mt|nc|nd|ne|nh|nj|nm|nv|ny|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|va|vt|wa|wi|wv|wy|ab|bc|mb|nb|nl|ns|nt|nu|on|pe|qc|sk|yt|ontario|quebec|alberta|british columbia)\b)?(?:\s+[a-z]\d[a-z]\s*\d[a-z]\d|\s+\d{5}(?:-\d{4})?)?/i;

function findAddress(text) {
  const match = String(text || '').match(ADDRESS_RE);
  return match ? match[0].replace(/\s+/g, ' ').trim() : null;
}

function findStructuredAddress(html) {
  const source = String(html || '');
  const pick = name => {
    const jsonMatch = source.match(new RegExp('"' + name + '"\\s*:\\s*"([^"]+)"', 'i'));
    if (jsonMatch) return jsonMatch[1];
    const itempropMatch = source.match(new RegExp("itemprop=[\"']" + name + "[\"'][^>]*>([^<]+)<", "i"));
    return itempropMatch ? itempropMatch[1] : '';
  };

  const street = pick('streetAddress');
  if (!street) return null;

  const parts = [
    street,
    pick('addressLocality'),
    pick('addressRegion'),
    pick('postalCode'),
  ].filter(Boolean);

  return parts.join(', ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
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
  const isVisible = el => {
    const r  = el.getBoundingClientRect();
    const cs = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 &&
      cs.display !== 'none' &&
      cs.visibility !== 'hidden' &&
      Number(cs.opacity || 1) > 0;
  };
  const px = value => Number.parseFloat(String(value || '').replace('px', '')) || 0;
  const colorKey = value => String(value || '').replace(/\s+/g, '').toLowerCase();

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

  // ── Review signal extraction ──────────────────────────────────────
  // Checks rendered DOM for review/testimonial evidence from every source.
  // This runs in the browser so it sees JS-rendered content.

  // 1. Section headings that indicate a reviews/testimonial area
  const REVIEW_HEADING_RE = /review|testimonial|what.{0,20}(customer|client|say)|feedback|happy customer|client.{0,10}say|what people say/i;
  const reviewHeadings = [...document.querySelectorAll('h1,h2,h3,h4,section,article')]
    .filter(el => REVIEW_HEADING_RE.test(getText(el).slice(0, 120)))
    .map(el => getText(el).slice(0, 100));

  // 2. Star symbols in any element (rendered — catches CSS icons too)
  const starElements = [...document.querySelectorAll('*')].filter(el => {
    const t = el.childNodes.length === 1 && el.childNodes[0].nodeType === 3
      ? el.textContent : '';
    return /[\u2605\u2606\u2B50]|★|☆/.test(t) || /star.?(rating|icon|filled|empty)/i.test(el.className || '');
  }).length;

  // 3. Review-like quoted text patterns in visible text
  const REVIEW_QUOTE_RE = /"[^"]{20,200}"/g;
  const visibleQuotes   = (visibleText.match(REVIEW_QUOTE_RE) || []).slice(0, 5);
  // Praise phrases common in genuine reviews
  const PRAISE_RE = /great service|highly recommend|professional team|excellent work|on time|amazing job|would recommend|very happy|best .{0,20}(company|contractor|team|service)|exceeded expectations|5 stars|five stars|couldn.t be happier/i;
  const praiseMatches = (visibleText.match(new RegExp(PRAISE_RE.source, 'gi')) || []).slice(0, 5);

  // 4. Review widgets — check class, id, data attributes, and src of iframes/scripts
  const allEls = [...document.querySelectorAll('[class],[id],[data-widget]')];
  const WIDGET_CLASS_RE = /review|testimonial|rating|elfsight|birdeye|podium|nicejob|trustindex|reviewtrackers|reputation|grade.us|yotpo|sociablekit|embedreviews|tagembed|widg\.io|google.?review|review.?widget/i;
  const reviewWidgetClasses = allEls
    .filter(el => WIDGET_CLASS_RE.test(el.className || '') || WIDGET_CLASS_RE.test(el.id || ''))
    .map(el => (el.className || el.id || '').slice(0, 60))
    .slice(0, 5);

  const REVIEW_SRC_RE = /elfsight|birdeye|podium|nicejob|trustindex|reviewtrackers|reputation|grade\.us|yotpo|sociablekit|embedreviews|tagembed|widg\.io|google.*review|review.*widget|testimonial.*widget/i;
  const reviewIframeSrcs  = iframes.filter(f => REVIEW_SRC_RE.test(f.src || '') || REVIEW_SRC_RE.test(f.title || '')).map(f => f.src || f.title);
  const reviewScriptSrcs  = scripts.filter(s => REVIEW_SRC_RE.test(s)).slice(0, 3);

  // 5. Alt text on images containing review keywords
  const reviewImageAlts = images.filter(i => /review|testimonial|customer|star.?rating/i.test(i.alt)).map(i => i.alt).slice(0, 3);

  // 6. Links/buttons pointing to review pages or platforms
  const REVIEW_LINK_RE = /google.*review|yelp\.com|houzz\.com|angi\.com|homeadvisor|bbb\.org|trustpilot|review|testimonial/i;
  const reviewLinks = [...document.querySelectorAll('a[href]')]
    .filter(a => REVIEW_LINK_RE.test(a.href || '') || REVIEW_LINK_RE.test(getText(a)))
    .map(a => getText(a).slice(0, 50) || a.href.slice(0, 60))
    .slice(0, 5);

  // 7. Visible text keyword matches (broad — scored carefully in Node.js)
  const REVIEW_KEYWORD_RE = /\b(reviews?|testimonials?|customer reviews?|client reviews?|google reviews?|verified reviews?|5.?star|five.?star|star rating|rated [45][\d.]|what our customers say|what clients say|happy customers|customer feedback|client feedback)\b/gi;
  const reviewKeywordsFound = [...new Set((visibleText.match(REVIEW_KEYWORD_RE) || []).map(k => k.toLowerCase()))].slice(0, 10);

  const reviewSignals = {
    reviewHeadings,
    starElements,
    visibleQuotes,
    praiseMatches,
    reviewWidgetClasses,
    reviewIframeSrcs,
    reviewScriptSrcs,
    reviewImageAlts,
    reviewLinks,
    reviewKeywordsFound,
  };
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

  // ── Visual trust / design quality signals ────────────────────────
  const visibleBlocks = [...document.querySelectorAll('p,li,span,div,a,button,h1,h2,h3')]
    .filter(el => isVisible(el) && getText(el).length >= 8)
    .slice(0, 250);

  const readableSamples = visibleBlocks.map(el => {
    const r  = el.getBoundingClientRect();
    const cs = window.getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      textLength: getText(el).length,
      fontSize: px(cs.fontSize),
      lineHeight: px(cs.lineHeight),
      width: Math.round(r.width),
      top: Math.round(r.top),
      color: colorKey(cs.color),
      backgroundColor: colorKey(cs.backgroundColor),
      fontFamily: (cs.fontFamily || '').split(',')[0].replace(/["']/g, '').trim(),
    };
  });

  const interactiveVisuals = [...document.querySelectorAll('a[href],button,[role="button"],input[type="submit"],input[type="button"]')]
    .filter(isVisible)
    .map(el => {
      const r  = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el);
      const text = getText(el) || el.value || el.getAttribute('aria-label') || '';
      const isCta = CTA_PHRASES.some(p => text.toLowerCase().includes(p));
      return {
        text: text.slice(0, 80),
        tag: el.tagName.toLowerCase(),
        top: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
        area: Math.round(r.width * r.height),
        fontSize: px(cs.fontSize),
        backgroundColor: colorKey(cs.backgroundColor),
        color: colorKey(cs.color),
        borderRadius: cs.borderRadius || '',
        isAboveFold: r.top >= 0 && r.top < Math.min(window.innerHeight || 800, 800),
        isCta,
      };
    });

  const visibleHeadings = [...document.querySelectorAll('h1,h2,h3,h4')]
    .filter(h => isVisible(h) && getText(h).length > 0)
    .map(h => {
      const r  = h.getBoundingClientRect();
      const cs = window.getComputedStyle(h);
      return {
        tag: h.tagName.toLowerCase(),
        text: getText(h).slice(0, 100),
        top: Math.round(r.top),
        fontSize: px(cs.fontSize),
      };
    });

  const sectionLike = [...document.querySelectorAll('section,article,main,aside,[class*="section"],[class*="card"],[class*="service"],[class*="feature"],[class*="gallery"],[class*="project"],[class*="testimonial"]')]
    .filter(el => isVisible(el) && getText(el).length >= 20);

  const visualImages = [...document.querySelectorAll('img')].map(i => {
    const r = i.getBoundingClientRect();
    return {
      src: i.getAttribute('src') || '',
      alt: i.getAttribute('alt') || '',
      width: Math.round(r.width),
      height: Math.round(r.height),
      isVisible: isVisible(i),
      isLikelyPlaceholder: /placeholder|dummy|blank|spacer|transparent/i.test((i.getAttribute('src') || '') + ' ' + (i.getAttribute('alt') || '')),
    };
  });

  const uniqueTextColors = [...new Set(readableSamples.map(s => s.color).filter(Boolean))].slice(0, 12);
  const uniqueButtonColors = [...new Set(interactiveVisuals.map(b => b.backgroundColor).filter(c => c && c !== 'rgba(0,0,0,0)' && c !== 'transparent'))].slice(0, 12);
  const uniqueFonts = [...new Set(readableSamples.map(s => s.fontFamily).filter(Boolean))].slice(0, 8);
  const aboveFoldCtas = interactiveVisuals.filter(b => b.isAboveFold && b.isCta);

  const visualTrust = {
    viewport: { width: window.innerWidth || 0, height: window.innerHeight || 0 },
    visibleHeadings: visibleHeadings.slice(0, 12),
    headingCount: visibleHeadings.length,
    sectionLikeCount: sectionLike.length,
    readableSamples: readableSamples.slice(0, 120),
    smallTextCount: readableSamples.filter(s => s.fontSize > 0 && s.fontSize < 14).length,
    paragraphCount: readableSamples.filter(s => s.tag === 'p').length,
    longLineCount: readableSamples.filter(s => s.width > 760 && s.textLength > 100).length,
    buttonCount: interactiveVisuals.length,
    visibleButtonCount: interactiveVisuals.length,
    aboveFoldButtonCount: interactiveVisuals.filter(b => b.isAboveFold).length,
    aboveFoldCtaCount: aboveFoldCtas.length,
    ctaTextsAboveFold: aboveFoldCtas.map(b => b.text).filter(Boolean).slice(0, 5),
    prominentCtaCount: aboveFoldCtas.filter(b => b.area >= 1800 && b.fontSize >= 14).length,
    imageCount: visualImages.filter(i => i.isVisible).length,
    imagesWithAlt: visualImages.filter(i => i.isVisible && i.alt.trim().length > 2).length,
    imagesWithoutAlt: visualImages.filter(i => i.isVisible && !i.alt.trim()).length,
    likelyPlaceholderImages: visualImages.filter(i => i.isVisible && i.isLikelyPlaceholder).length,
    uniqueTextColors,
    uniqueButtonColors,
    uniqueFonts,
  };

  // ── Address ───────────────────────────────────────────────────────
  const addressMatch = (() => {
    const re = /\b\d{2,6}\s+(?:[a-z0-9#.'-]+\s+){1,6}(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct|crescent|cres|circle|cir|trail|trl|parkway|pkwy|terrace|ter|highway|hwy|line|sideroad)\.?\b(?:\s+(?:north|south|east|west|n|s|e|w))?(?:\s*(?:,|#|unit|suite|ste|apt)\s*[a-z0-9 .#-]{0,30})?(?:\s*,?\s*[a-z .'-]{2,30}\s*,?\s*(?:al|ak|az|ar|ca|co|ct|de|fl|ga|hi|ia|id|il|in|ks|ky|la|ma|md|me|mi|mn|mo|ms|mt|nc|nd|ne|nh|nj|nm|nv|ny|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|va|vt|wa|wi|wv|wy|ab|bc|mb|nb|nl|ns|nt|nu|on|pe|qc|sk|yt|ontario|quebec|alberta|british columbia)\b)?(?:\s+[a-z]\d[a-z]\s*\d[a-z]\d|\s+\d{5}(?:-\d{4})?)?/i;
    const match = visibleText.match(re);
    return match ? match[0].replace(/\s+/g, ' ').trim() : null;
  })();

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
    addressMatch: addressMatch || null,
    reviewSignals,
    seo: {
      title:       document.title || '',
      metaDesc:    document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
      h1s:         [...document.querySelectorAll('h1')].map(getText),
      canonical:   document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '',
      hasViewport: !!document.querySelector('meta[name="viewport"]'),
    },
    google: { hasGoogleMap, hasGoogleReviews, hasGoogleBiz, hasEmbeddedMap, hasLocalBusinessSchema },
    visualTrust,
    outerHtml: document.documentElement.outerHTML,
  };
};

/**
 * Use Playwright to fetch a single page.
 * Returns { html, finalUrl, domData } where domData is the rich extraction.
 */
/**
 * Use Playwright to fetch a single page.
 * Returns { html, finalUrl, domData } where domData is the rich extraction.
 *
 * Wait strategy (accuracy > speed):
 *   1. goto() with waitUntil:'domcontentloaded' — page HTML is parsed
 *   2. waitForLoadState('networkidle') with a graceful timeout — JS widgets finish loading
 *   3. waitForTimeout(8000) — review embeds (Elfsight, Google Reviews) need time to render
 */
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let totalHeight = 0;
      const distance = 300;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
    });
  });
}

async function playwrightFetchPage(page, rawUrl, pageTimeoutMs = PAGE_TIMEOUT) {
  try {
    // Step 1: navigate and wait for DOM to be ready
    await page.goto(rawUrl, {
      waitUntil: 'domcontentloaded',
      timeout:   pageTimeoutMs,
    });

    // Step 2: try networkidle — catches async widget loads (Elfsight, etc.)
    // If the page never reaches networkidle, continue anyway after 8 s
    try {
      await page.waitForLoadState('networkidle', { timeout: 8000 });
    } catch {
      // networkidle timed out — common on pages with tracking pixels or chat widgets.
      // Not an error; we already have DOM content.
    }

    // Step 3: flat wait to let JS-rendered review widgets fully paint their content
    // (Google Reviews embeds, Elfsight widgets, etc. inject content after network is idle)
    await page.waitForTimeout(2000);

    // Step 4: scroll like a real visitor so lazy-loaded sections, images,
    // animations, CTAs, reviews, and service blocks enter the rendered DOM.
    await autoScroll(page);

    // Step 5: allow scroll-triggered JavaScript/lazy loading to finish,
    // then return to the top before extracting above-the-fold and full-page signals.
    await page.waitForTimeout(2000);
    await page.evaluate(() => window.scrollTo(0, 0));

    const finalUrl = page.url();
    const domData  = await page.evaluate(DOM_EXTRACTOR);
    const html     = domData.outerHtml || '';

    // ── Per-page debug logging ─────────────────────────────────────
    const vt  = domData.visibleText || '';
    const sig = domData.reviewSignals || {};

    const REVIEW_SNIP_RE = /\b(review|reviews|testimonial|testimonials|star|5.?star|five.?star|rated|recommend|google|feedback)\b/gi;
    const reviewSnippets = [];
    let snipM;
    const vtLow = vt.toLowerCase();
    REVIEW_SNIP_RE.lastIndex = 0;
    while ((snipM = REVIEW_SNIP_RE.exec(vtLow)) !== null && reviewSnippets.length < 8) {
      const s = Math.max(0, snipM.index - 40);
      const e = Math.min(vtLow.length, snipM.index + 80);
      reviewSnippets.push('…' + vt.slice(s, e).replace(/\s+/g, ' ').trim() + '…');
      REVIEW_SNIP_RE.lastIndex = snipM.index + snipM[0].length;
    }

    const reviewIframeSrcs = (domData.iframes || []).map(f => f.src).filter(s =>
      /review|google|elfsight|trustindex|birdeye|podium|nicejob|sociablekit|embedreviews|tagembed|reputation/i.test(s)
    );
    const reviewScriptSrcs = (domData.scripts || []).filter(s =>
      /review|elfsight|trustindex|birdeye|podium|nicejob|sociablekit|embedreviews|tagembed|reputation/i.test(s)
    );

    console.log(`\n[LeadCheck][PW] PAGE SCANNED: ${finalUrl}`);
    console.log(`[LeadCheck][PW]   VISIBLE TEXT LENGTH     : ${vt.length} chars`);
    console.log(`[LeadCheck][PW]   REVIEW KEYWORD MATCHES  : ${(sig.reviewKeywordsFound||[]).slice(0,8).join(', ') || 'none'}`);
    console.log(`[LeadCheck][PW]   REVIEW WIDGET MATCHES   : iframe=${reviewIframeSrcs.slice(0,3).join(',')||'none'} | script=${reviewScriptSrcs.slice(0,2).join(',')||'none'} | class=${(sig.reviewWidgetClasses||[]).slice(0,3).join(',')||'none'}`);
    console.log(`[LeadCheck][PW]   REVIEW SNIPPETS FOUND   : ${reviewSnippets.slice(0,4).join(' // ') || 'none'}`);
    console.log(`[LeadCheck][PW]   headings                : ${(domData.headings||[]).map(h=>`[${h.tag}]"${h.text.slice(0,50)}"`).join(' | ') || 'none'}`);
    console.log(`[LeadCheck][PW]   review headings (PW)    : ${(sig.reviewHeadings||[]).slice(0,3).join(' | ') || 'none'}`);
    console.log(`[LeadCheck][PW]   star elements (PW)      : ${sig.starElements || 0}`);
    console.log(`[LeadCheck][PW]   quoted reviews (PW)     : ${(sig.visibleQuotes||[]).slice(0,2).map(q=>q.slice(0,60)).join(' | ') || 'none'}`);
    console.log(`[LeadCheck][PW]   praise phrases (PW)     : ${(sig.praiseMatches||[]).slice(0,4).join(', ') || 'none'}`);
    console.log(`[LeadCheck][PW]   all iframes             : ${(domData.iframes||[]).map(f=>f.src.slice(0,80)).join(' | ') || 'none'}`);

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

const MAX_PAGES    = 10;     // homepage + up to 9 priority pages
const PAGE_TIMEOUT = 20000;  // per-page Playwright timeout (review widgets need time)
const HTTP_TIMEOUT = 8000;   // per-page timeout for HTTP fallback
const CRAWL_BUDGET = 120000; // total ms — higher accuracy for service/review pages

// Review/testimonial slugs come FIRST — they are the highest-priority pages
// for review detection. Service/contact pages follow.
const PRIORITY_SLUGS = [
  '/reviews', '/testimonials', '/customer-reviews', '/client-reviews',
  '/feedback', '/what-our-customers-say', '/our-reviews',
  '/services', '/service', '/contact', '/about',
  '/gallery', '/projects', '/portfolio',
];

// Keyword list for filtering homepage links.
// Review-related keywords are listed first so they win the crawl budget.
const PRIORITY_LINK_KEYWORDS = [
  'review', 'testimonial', 'feedback', 'customer-review', 'client-review',
  'service', 'contact', 'about', 'gallery', 'project', 'portfolio',
];

function classifyPage(url) {
  const p = new URL(url).pathname.toLowerCase();
  if (/\/service/.test(p) || SERVICE_TERMS.some(t => p.includes(t.split(' ')[0]))) return 'services';
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
    console.log('[LeadCheck] Using Playwright scan');
    console.log('[LeadCheck][PW] Launching Chromium...');
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
    console.log('[LeadCheck][PW] Chromium launched');

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport:  { width: 1280, height: 800 },
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });

    // Block only heavy binary resources.
    // Stylesheets are ALLOWED because review widgets (Elfsight, etc.)
    // use CSS to render star icons — blocking styles breaks their detection.
    await context.route('**/*', route => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font'].includes(type)) return route.abort();
      return route.continue();
    });

    // page is created here and ONLY passed as an argument to playwrightFetchPage —
    // it is never used globally and never accessed after browser.close()
    const page = await context.newPage();

    // ── Homepage ──────────────────────────────────────────────────
    let homepageResult = null;
    const homepageErrors = [];
    for (const attempt of [startUrl, startUrl.replace(/^https:/, 'http:')]) {
      try {
        console.log(`[LeadCheck][PW] Fetching homepage attempt: ${attempt}`);
        homepageResult = await Promise.race([
          playwrightFetchPage(page, attempt, PAGE_TIMEOUT),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), PAGE_TIMEOUT + 500)),
        ]);
        break;
      } catch (err) {
        homepageErrors.push(`${attempt}: ${err.message}`);
        console.error(`[LeadCheck][PW] Homepage attempt failed: ${attempt} — ${err.message}`);
      }
    }

    if (!homepageResult) {
      throw new Error(`Playwright could not render homepage. ${homepageErrors.join(' | ')}`);
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
      .filter(link => {
        const path = new URL(link).pathname.toLowerCase();
        return PRIORITY_LINK_KEYWORDS.some(kw => path.includes(kw))
          || SERVICE_TERMS.some(t => path.includes(t.split(' ')[0]));
      })
      .map(url => ({ url, source: 'homepage-link' }));

    const seen       = new Set(visited);
    const candidates = [];
    for (const item of [...keywordLinks, ...slugCandidates]) {
      const key = urlKey(item.url);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(item);
    }

    // Sort: review/testimonial pages first — they are most likely to have review evidence.
    // If the crawl budget runs out, we want to have seen the review page before service/contact.
    const REVIEW_URL_RE = /review|testimonial|feedback|customer-review|client-review/i;
    candidates.sort((a, b) => {
      const aReal = a.source === 'homepage-link' ? 0 : 1;
      const bReal = b.source === 'homepage-link' ? 0 : 1;
      if (aReal !== bReal) return aReal - bReal;
      const aRev = REVIEW_URL_RE.test(a.url) ? 0 : 1;
      const bRev = REVIEW_URL_RE.test(b.url) ? 0 : 1;
      if (aRev !== bRev) return aRev - bRev;
      const aSvc = classifyPage(a.url) === 'services' ? 0 : 1;
      const bSvc = classifyPage(b.url) === 'services' ? 0 : 1;
      return aSvc - bSvc;
    });

    // ── Crawl priority pages ──────────────────────────────────────
    for (const candidate of candidates) {
      if (pages.length >= MAX_PAGES || Date.now() >= deadline) break;

      try {
        console.log(`[LeadCheck][PW] Fetching priority page: ${candidate.url}`);
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
      } catch (err) {
        console.warn(`[LeadCheck][PW] Skipping priority page: ${candidate.url} — ${err.message}`);
      }
    }

    console.log(`[LeadCheck][PW] Completed Playwright scan: ${pages.length} page(s)`);
    return { pages, finalHomeUrl, method: 'playwright' };

  } catch (err) {
    console.error('[LeadCheck][PW] Playwright scan failed:', err.stack || err.message);
    throw err;

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
    .filter(link => {
        const path = new URL(link).pathname.toLowerCase();
        return PRIORITY_LINK_KEYWORDS.some(kw => path.includes(kw))
          || SERVICE_TERMS.some(t => path.includes(t.split(' ')[0]));
      })
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
  console.log('[LeadCheck] Playwright available:', playwrightAvailable);

  // Try Playwright first whenever the package imported successfully.
  if (playwrightAvailable) {
    try {
      const result = await crawlWithPlaywright(startUrl);
      console.log('[LeadCheck] Scan method selected: Playwright');
      return result;
    } catch (err) {
      console.error('[LeadCheck] Playwright runtime failed; using HTTP fallback:', err.message);
    }
  } else {
    console.error('[LeadCheck] Playwright unavailable; using HTTP fallback:', playwrightLoadError?.message || 'module not loaded');
  }

  console.log('[LeadCheck] Using HTTP fallback scan');
  return crawlWithHttp(startUrl);
}

// ═══════════════════════════════════════════════════════════════════════
// PAGESPEED
// ═══════════════════════════════════════════════════════════════════════

async function fetchPageSpeed(url) {
  const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile`;
  try {
    if (typeof fetch === 'function') {
      const res = await fetch(api);
      if (!res.ok) return null;
      return await res.json();
    }

    return await new Promise((resolve, reject) => {
      const req = https.get(api, { timeout: 10000 }, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(); } });
      });
      req.on('error',   reject);
      req.on('timeout', () => { req.destroy(); reject(); });
    });
  } catch {
    return null;
  }
}
// ═══════════════════════════════════════════════════════════════════════
// MERGED CORPUS
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

// Keywords that unambiguously identify an embedded booking/form widget.
// A match in ANY iframe src, script src, or inline HTML counts.
const EMBEDDED_FORM_PATTERNS = /gohighlevel|ghl\b|leadconnector|forms\.leadconnectorhq|msgsndr|highlevel\.com|booking|calendar|appointment|schedule|book-now|booknow|bookings\.|calendly|acuity|squareup\.com\/appointments|jotform|typeform|gravity.?form|wpforms|contactform7|formstack|cognito.?form|formidable/i;

function detectEmbeddedWidgets(allHtml, pages) {
  const html = allHtml.toLowerCase();

  // Merge Playwright widget detections from all pages
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

  // Static HTML baseline
  const staticGHL      = /gohighlevel|leadconnector|lc_chat|forms\.leadconnectorhq|msgsndr\.com|highlevel\.com/i.test(html);
  const staticCalendly = /calendly\.com/i.test(html);
  const iframeSrcs     = [...html.matchAll(/iframe[^>]*src=["']([^"']+)["']/g)].map(m => m[1]);
  const scriptSrcs     = [...html.matchAll(/script[^>]*src=["']([^"']+)["']/g)].map(m => m[1]);
  const staticIframe   = iframeSrcs.some(s => /form|booking|appointment|quote|calendar|widget|funnel/i.test(s));
  const staticChat     = /tawk\.to\b|intercom\.io|drift\.com\/widget|crisp\.chat|freshchat|freshworks|zopim|zendesk\.com\/embeddable/i.test(html);

  // ── Enhanced chat detection ──────────────────────────────────────
  // Scan scripts, iframes, visible text, and button labels for known chat vendors.
  // Do NOT count generic words like "contact", "support", "help".
  const CHAT_VENDOR_RE = /tawk\.to\b|intercom\.io|widget\.intercom|drift\.com\/widget|js\.drift\.com|crisp\.chat|client\.crisp\.chat|freshchat|freshworks\.com\/live-chat|zopim|ze\.zdn\.net|zendesk\.com\/embeddable|lc_chat|leadconnector.*chat|chat-widget/i;
  const enhancedChat = CHAT_VENDOR_RE.test(html)
    || pages.some(p => (p.domData?.scripts || []).some(s => CHAT_VENDOR_RE.test(s)))
    || pages.some(p => (p.domData?.iframes || []).some(f => CHAT_VENDOR_RE.test(f.src)));
  // Also check rendered buttons/visible text for chat widget indicators (not generic words)
  const chatTextRE = /\blive\s*chat\b|\bchat\s*now\b|\bchat\s*with\s*us\b|\blc_chat\b|\bchat-widget\b/i;
  const chatInButtons = pages.some(p =>
    (p.domData?.buttons || []).some(b => chatTextRE.test(b)) ||
    chatTextRE.test(p.domData?.visibleText || '')
  );

  // ── Broad embedded form/booking detection ────────────────────────
  // Counts iframes, scripts, and raw HTML containing booking/form keywords.
  // This is the fix for GHL/iframe booking not counting as a form.
  const allSrcs        = [...iframeSrcs, ...scriptSrcs];
  const embeddedMatch  = allSrcs.find(s => EMBEDDED_FORM_PATTERNS.test(s))
    || (EMBEDDED_FORM_PATTERNS.test(html) ? 'inline-html' : null);

  let embeddedFormEvidence = null;
  if (staticGHL || pwWidgets.isGHL) {
    embeddedFormEvidence = 'GoHighLevel / LeadConnector embedded form';
  } else if (pwWidgets.hasBooking || pwWidgets.hasIframeForm) {
    embeddedFormEvidence = 'Embedded booking/form widget (Playwright detected)';
  } else if (embeddedMatch && embeddedMatch !== 'inline-html') {
    embeddedFormEvidence = `Embedded widget: ${embeddedMatch.slice(0, 80)}`;
  } else if (staticCalendly || pwWidgets.hasCalendly) {
    embeddedFormEvidence = 'Calendly booking widget';
  } else if (staticIframe) {
    embeddedFormEvidence = 'Iframe form/booking widget detected';
  } else if (embeddedMatch === 'inline-html') {
    embeddedFormEvidence = 'Booking/form keyword found in page source';
  }

  const embeddedFormDetected = !!embeddedFormEvidence;

  return {
    isGHL:                pwWidgets.isGHL         || staticGHL,
    hasChat:              pwWidgets.hasChat       || staticChat || enhancedChat || chatInButtons,
    hasBooking:           pwWidgets.hasBooking    || staticCalendly || pwWidgets.isGHL || staticGHL || embeddedFormDetected,
    hasIframeForm:        pwWidgets.hasIframeForm || staticIframe || embeddedFormDetected,
    hasCalendly:          pwWidgets.hasCalendly   || staticCalendly,
    hasAcuity:            pwWidgets.hasAcuity,
    hasTawk:              pwWidgets.hasTawk       || /tawk\.to/i.test(html),
    hasIntercom:          pwWidgets.hasIntercom   || /intercom\.io/i.test(html),
    hasDrift:             pwWidgets.hasDrift      || /drift\.com\/widget/i.test(html),
    hasCrisp:             pwWidgets.hasCrisp      || /crisp\.chat/i.test(html),
    hasFreshchat:         pwWidgets.hasFreshchat  || /freshchat/i.test(html),
    hasZendesk:           pwWidgets.hasZendesk    || /zopim|zendesk\.com\/embeddable/i.test(html),
    iframeCount:          iframeSrcs.length,
    embeddedFormDetected,
    embeddedFormEvidence,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CONTACT METHOD DETECTION
// ═══════════════════════════════════════════════════════════════════════

function detectContactMethods(allHtml, allText, widgets, pages) {
  // Phone
  const pwTelLinks = pages.flatMap(p => p.domData?.telLinks || []);
  const phone   = /\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/.test(allText)
    || /href=["']tel:/i.test(allHtml) || pwTelLinks.length > 0;
  const telLink = /href=["']tel:/i.test(allHtml) || pwTelLinks.length > 0;

  // Email
  const pwEmails = pages.flatMap(p => p.domData?.emailMatches || []);
  const email   = /href=["']mailto:/i.test(allHtml)
    || /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(allText)
    || pwEmails.length > 0;

  // Form — include embedded booking/form widgets even without a literal <form> tag
  const pwFormCount = pages.flatMap(p => p.domData?.forms || []).length;
  const form = /<form\b/i.test(allHtml)
    || pwFormCount > 0
    || widgets.hasIframeForm
    || widgets.isGHL
    || widgets.embeddedFormDetected;   // ← key fix: GHL/booking iframe counts as a form

  // Chat — strict vendor-only (enhanced by detectEmbeddedWidgets)
  const chat = widgets.hasChat;

  // Booking
  const booking = widgets.hasBooking || widgets.embeddedFormDetected;

  // Address
  const addressValue = findAddress(allText)
    || findStructuredAddress(allHtml)
    || pages.map(p => p.domData?.addressMatch).find(Boolean)
    || null;
  const address = !!addressValue;

  const count = [phone, email, form, chat, booking, address].filter(Boolean).length;
  return {
    phone, telLink, email, form, chat, booking, address, addressValue, count,
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
 * true = full, 'partial' = 60%, false/undefined = 0.
 * Fractional partials are supported but capped at 60% so weak evidence cannot over-score.
 */
function weightedScore(result, max) {
  // Accept either raw booleans/strings or EvidenceResult objects { result, evidence, confidence }
  const r = (result && typeof result === 'object') ? result.result : result;
  if (r === true)              return max;
  if (r === 'partial')         return +(max * 0.6).toFixed(4);
  if (typeof r === 'string' && r.startsWith('partial:')) {
    const frac = parseFloat(r.slice(8));
    const cappedFrac = isNaN(frac) ? 0.6 : Math.min(frac, 0.6);
    return +(max * cappedFrac).toFixed(4);
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
function getIndustryServiceTerms(industryType) {
  const pack = INDUSTRY_KEYWORDS[industryType] || [];
  return [...new Set([...SERVICE_TERMS, ...pack])];
}

function detectIndustry(text) {
  const normalized = normalizeText(text || '');
  const scores = {};
  const matchesByIndustry = {};

  for (const [industry, keywords] of Object.entries(INDUSTRY_KEYWORDS)) {
    if (industry === 'general') continue;
    const matched = keywords.filter(keyword => normalized.includes(keyword.toLowerCase()));
    matchesByIndustry[industry] = [...new Set(matched)];
    scores[industry] = matchesByIndustry[industry].reduce((score, keyword) => score + (keyword.includes(' ') ? 2 : 1), 0);
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topType, topScore] = ranked[0] || ['general', 0];
  const nextScore = ranked[1]?.[1] || 0;

  if (!topScore || topScore < 2 || topScore === nextScore) {
    return { type: 'general', confidence: 'Low', matchedKeywords: [] };
  }

  return {
    type: topType,
    confidence: topScore >= 5 || topScore - nextScore >= 3 ? 'High' : 'Medium',
    matchedKeywords: matchesByIndustry[topType].slice(0, 8),
  };
}

function detectServices(allHtml, allText, industry = { type: 'general' }) {
  const serviceTerms = getIndustryServiceTerms(industry.type);
  const matched = serviceTerms.filter(t => allText.includes(t));
  const unique  = [...new Set(matched)];

  if (!unique.length)
    return ev(false, 'No specific service terms found for the detected industry');

  const SECTION_HEADS = [
    'our services','what we do','what we offer','services we offer',
    'services include','services we provide','we specialize in',
    'we install','we repair','we replace','what we handle',
    'detailing services','packages','service packages','protection packages',
  ];
  const hasSection = containsAny(allText, SECTION_HEADS);
  const hasList    = /<(ul|ol)[^>]*>[\s\S]{10,3000}?<\/(ul|ol)>/i.test(allHtml) && unique.length > 0;
  const sample     = unique.slice(0,5).join(', ');
  const industryLabel = industry.type === 'detailing' ? 'auto detailing' : industry.type === 'contractor' ? 'contractor/home services' : 'local business';

  if ((hasSection || hasList) && unique.length >= 3) return ev(true,          `${unique.length} ${industryLabel} services in section: ${sample}`);
  if ((hasSection || hasList) && unique.length >= 1) return ev('partial',     `Services section with ${unique.length}: ${sample}`, 'Medium');
  if (unique.length >= 4)                            return ev('partial',     `${unique.length} service terms (no section): ${sample}`, 'Medium');
  if (unique.length >= 2)                            return ev('partial:0.4', `${unique.length} service terms: ${sample}`, 'Low');
  return                                                    ev('partial:0.2', `Only 1 service term: "${unique[0]}" - insufficient`, 'Low');
}

// 1e. Dedicated service pages or strong service sections (4 pts)
function checkServicePageDepth(pages, allHtml, industry = { type: 'general' }) {
  const serviceTerms = getIndustryServiceTerms(industry.type);
  const crawledSvc = pages.filter(p =>
    p.type === 'services'
    || serviceTerms.some(t => p.url.toLowerCase().includes(t.split(' ')[0]))
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
    if (serviceTerms.some(t => href.includes(t.split(' ')[0]) || txt.includes(t))) {
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
function detectLocalSEO(allText, pages = []) {
  const PHRASES = ['service area','areas we serve','serving ','cities we serve','proudly serving','coverage area','we serve ','areas served','serving the','we service ','locations we serve'];
  const POSTAL     = /[a-z]\d[a-z]\s*\d[a-z]\d/i;
  const ZIP_PAIR   = /\b\d{5}(?:-\d{4})?\b.{0,30}\b\d{5}(?:-\d{4})?\b/;
  const CITY_REGION = /\b[a-z][a-z .'-]{2,},?\s+(?:al|ak|az|ar|ca|co|ct|de|fl|ga|hi|ia|id|il|in|ks|ky|la|ma|md|me|mi|mn|mo|ms|mt|nc|nd|ne|nh|nj|nm|nv|ny|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|va|vt|wa|wi|wv|wy|ab|bc|mb|nb|nl|ns|nt|nu|on|pe|qc|sk|yt|ontario|quebec|alberta|british columbia)\b/i;

  const mPhrases = PHRASES.filter(p => allText.includes(p));
  const hasPostal = POSTAL.test(allText) || ZIP_PAIR.test(allText);
  const hasCityRegion = CITY_REGION.test(allText);
  const address = findAddress(allText) || findStructuredAddress(allText) || pages.map(p => p.domData?.addressMatch).find(Boolean);

  let s = 0;
  const evidence = [];
  if (mPhrases.length)   { s += 2; evidence.push(`phrase: "${mPhrases[0]}"`); }
  if (address)           { s += 3; evidence.push(`address: "${String(address).slice(0, 70)}"`); }
  if (hasPostal)         { s += 1; evidence.push('postal/zip code found'); }
  if (hasCityRegion)     { s += 1; evidence.push('city/region pattern'); }

  if (!evidence.length)
    return ev(false, 'No service area phrases, address, city/region, or postal codes found');
  if (s >= 3) return ev(true,          `Location: ${evidence.join('; ')}`);
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
//
// Bug fixes applied:
//   • normalizeText now preserves ★/☆/⭐ so allText star checks work
//   • Thresholds lowered: true at s>=6 (was 8), partial at s>=3 (was 4)
//   • Playwright reviewSignals.praiseMatches now score from allText too
//   • Iframe/script review-vendor matching now checks the broader IFRAME_REVIEW_RE
//   • reviewDebug object built and returned inside the ev() evidence
//
// NOT SCORED: trusted, quality, reliable, professional, satisfied, happy customers (alone)
function detectTrustSignals(allHtml, allText, pages) {
  const found = [];
  let   s     = 0;
  const hit   = (pts, label) => { s += pts; found.push(label); };

  // ── Collect all srcs for widget detection ──────────────────────────
  const scriptSrcs = [
    ...[...allHtml.matchAll(/script[^>]*\bsrc=["']([^"']+)["']/gi)].map(m => m[1]),
    ...pages.flatMap(p => p.domData?.scripts || []),
    ...pages.flatMap(p => p.domData?.reviewSignals?.reviewScriptSrcs || []),
  ];
  const iframeSrcs = [
    ...[...allHtml.matchAll(/iframe[^>]*\bsrc=["']([^"']+)["']/gi)].map(m => m[1]),
    ...pages.flatMap(p => (p.domData?.iframes || []).map(f => f.src)),
    ...pages.flatMap(p => p.domData?.reviewSignals?.reviewIframeSrcs || []),
  ];
  const allSrcs = [...scriptSrcs, ...iframeSrcs].join('\n');

  const pwWidgetClasses = pages.flatMap(p => p.domData?.reviewSignals?.reviewWidgetClasses || []).join(' ');
  const classIds        = [...allHtml.matchAll(/(?:class|id)=["']([^"']+)["']/gi)].map(m => m[1]).join(' ') + ' ' + pwWidgetClasses;

  // Playwright visible text (all pages merged)
  const pwVisText = pages.flatMap(p => [p.domData?.visibleText || '']).join(' ');

  // ── 1. Named review platform widgets ────────────────────────────────
  // Check script src, iframe src, class/id — definitive proof (4 pts each)
  const IFRAME_REVIEW_RE = /review|google\.com\/maps.*review|elfsight|birdeye|podium|nicejob|trustindex|reviewtrackers|reputation\.com|yotpo|sociablekit|embedreviews|tagembed|widg\.io|grade\.us|reviews\.io/i;

  const WIDGET_VENDORS = [
    [/elfsight\.com|apps\.elfsight/i,          'Elfsight'],
    [/birdeye\.com|birdeyereviews/i,            'Birdeye'],
    [/podium\.com|reviews\.podium/i,            'Podium'],
    [/nicejob\.com|widget\.nicejob/i,           'NiceJob'],
    [/trustindex\.io|trustindex-widget/i,       'Trustindex'],
    [/reviewtrackers\.com/i,                    'ReviewTrackers'],
    [/reputation\.com|repmanager/i,             'Reputation.com'],
    [/yotpo\.com|yotpo-widget/i,               'Yotpo'],
    [/sociablekit\.com/i,                       'SociableKit'],
    [/embedreviews\.com/i,                      'EmbedReviews'],
    [/tagembed\.com/i,                          'Tagembed'],
    [/widg\.io/i,                              'Widg.io'],
    [/grade\.us|gradeus/i,                      'Grade.us'],
    [/reviews\.io|widget\.reviews\.io/i,        'Reviews.io'],
  ];

  for (const [re, name] of WIDGET_VENDORS) {
    if (re.test(allSrcs) || re.test(allHtml)) {
      const src = [...scriptSrcs, ...iframeSrcs].find(s => re.test(s));
      hit(4, src
        ? `${name} review widget via script/iframe: "${src.slice(0, 80)}"`
        : `${name} review widget detected in page source`);
    }
  }

  // Generic review iframe (not a named vendor but clearly a review embed)
  if (!found.length) {
    const reviewIframe = iframeSrcs.find(s => IFRAME_REVIEW_RE.test(s));
    if (reviewIframe) hit(3, `Review-related iframe detected: "${reviewIframe.slice(0, 80)}"`);
  }

  // Generic review widget class/id (div.review-widget, div.reviews-section, etc.)
  if (!found.length) {
    const GENERIC_WIDGET_RE = /review-widget|reviews-widget|google-review|google_review|review[-_]?card|testimonial[-_]?widget|review[-_]?section|customer[-_]?review|star[-_]?rating[-_]?widget/i;
    if (GENERIC_WIDGET_RE.test(classIds)) {
      const m = classIds.match(GENERIC_WIDGET_RE);
      hit(3, `Generic review widget element detected: "${m[0]}"`);
    }
  }

  // ── 2. Google review signals ─────────────────────────────────────────
  const pwGoogle = pages.filter(p => p.domData?.google).map(p => p.domData.google);
  if (/google\s*reviews?(?:\s*widget)?|reviewed\s+on\s+google/i.test(allText + pwVisText)
      || pwGoogle.some(g => g.hasGoogleReviews)) {
    hit(3, 'Google reviews mentioned/linked');
  }

  // ── 3. Star rating signals ───────────────────────────────────────────
  // allText now preserves ★ chars (normalizeText fix), so both checks work.
  const starCharMatch = (allText + pwVisText).match(/[★☆⭐\u2605\u2606\u2B50]{2,}/u)
    || allHtml.match(/[\u2605\u2606\u2B50★]{2,}/u);
  if (starCharMatch) hit(4, `Star characters detected: "${starCharMatch[0].slice(0,10)}"`);

  const starTextMatch = (allText + ' ' + pwVisText).match(
    /(?:rated?\s+)?([45][\d.]*)\s*(?:out of\s*\d+\s*)?stars?|five.?star|5.?star\s+(?:rating|review|service)/i
  );
  if (starTextMatch && !found.some(f => f.includes('star')))
    hit(4, `Star rating in text: "${starTextMatch[0].slice(0, 40)}"`);

  // rating fraction 4.9/5, 5/5
  const ratingFraction = (allText + pwVisText).match(/\b[45][\d.]*\s*\/\s*5\b|average\s+rating[:\s]+[\d.]+/i);
  if (ratingFraction && !found.some(f => f.includes('star') || f.includes('rating')))
    hit(3, `Rating score: "${ratingFraction[0].slice(0, 30)}"`);

  // Playwright DOM star elements
  const pwStarEls = pages.flatMap(p => [p.domData?.reviewSignals?.starElements || 0]).reduce((a,b)=>a+b,0);
  if (pwStarEls > 0 && !found.some(f => f.includes('star')))
    hit(4, `Star elements in rendered DOM: ${pwStarEls}`);

  // ── 4. Review count ──────────────────────────────────────────────────
  const reviewCountMatch = (allText + ' ' + pwVisText).match(
    /(\d+\+?)\s+(?:verified\s+)?(?:customer\s+|google\s+|5.?star\s+)?reviews?/i
  ) || (allText + ' ' + pwVisText).match(
    /(?:over|more than)\s+(\d[\d,]+)\s+(?:happy\s+)?customers?\s+(?:served|helped|satisfied)/i
  );
  if (reviewCountMatch) hit(4, `Review count: "${reviewCountMatch[0].slice(0, 50)}"`);

  // ── 5. Quoted testimonials ───────────────────────────────────────────
  // Classic HTML pattern: "quote text" — Name  (strict attribution)
  const quotedHtml = allHtml.match(/"([^"]{20,150})"[\s\S]{0,100}[-\u2013\u2014]\s*([A-Z][a-z]{2,})/);
  if (quotedHtml) hit(4, `Quoted testimonial: "${quotedHtml[1].slice(0, 60)}…"`);

  // Looser: quoted text 20+ chars anywhere (no attribution required — contractor sites
  // often show testimonials as bare quotes without a dash-name)
  if (!found.some(f => f.includes('Quoted'))) {
    const looseQuote = allHtml.match(/"([^"]{20,200})"/);
    if (looseQuote) hit(3, `Testimonial quote in page: "${looseQuote[1].slice(0, 60)}…"`);
  }

  // Playwright visible text: same pattern
  if (!found.some(f => f.includes('Quoted') || f.includes('quote'))) {
    const pwQuote = pwVisText.match(/"([^"]{20,150})"\s*[-–—]\s*([A-Z][a-z]+)/);
    if (pwQuote) hit(4, `Quoted review in rendered text: "${pwQuote[1].slice(0, 60)}…"`);
  }

  // ── 6. Section headings (Playwright rendered + HTML fallback) ────────
  const REVIEW_HEADING_RE = /reviews?|testimonials?|what\s+(?:our|clients?|customers?)\s+say|customer\s+(?:reviews?|feedback|stories?)|client\s+(?:reviews?|feedback)|happy\s+customers?|hear\s+from/i;

  const pwHeadings = pages.flatMap(p => (p.domData?.headings || []).map(h => h.text));
  const pwRevSigHeadings = pages.flatMap(p => p.domData?.reviewSignals?.reviewHeadings || []);
  const allHeadingText   = [...pwHeadings, ...pwRevSigHeadings];

  const matchedHeading = allHeadingText.find(h => REVIEW_HEADING_RE.test(h));
  if (matchedHeading) hit(3, `Review heading in DOM: "${matchedHeading.slice(0, 60)}"`);

  // HTML heading fallback
  if (!matchedHeading) {
    const htmlHeadingMatch = allHtml.match(/<h[1-4][^>]*>([\s\S]{0,200}?)<\/h[1-4]>/gi);
    const reviewHtmlHeading = (htmlHeadingMatch||[]).find(h => REVIEW_HEADING_RE.test(normalizeText(h)));
    if (reviewHtmlHeading) hit(3, `Review heading in HTML: "${normalizeText(reviewHtmlHeading).slice(0, 60)}"`);
  }

  // ── 7. Playwright review links / buttons ────────────────────────────
  const pwButtons  = pages.flatMap(p => p.domData?.buttons || []);
  const pwLinks    = pages.flatMap(p => (p.domData?.links || []).map(l => l.text));
  const pwRevLinks = pages.flatMap(p => p.domData?.reviewSignals?.reviewLinks || []);
  const interactive = [...pwButtons, ...pwLinks, ...pwRevLinks].map(t => t.toLowerCase());

  const reviewBtn = interactive.find(t =>
    /read\s+(?:our\s+)?reviews?|see\s+(?:our\s+)?testimonials?|view\s+(?:our\s+)?reviews?|customer\s+reviews?|google\s+reviews?/i.test(t)
  );
  if (reviewBtn) hit(2, `Review link/button in DOM: "${reviewBtn.slice(0, 50)}"`);

  // Image alt text
  const altTexts = pages.flatMap(p => Array.isArray(p.domData?.images)
    ? p.domData.images.map(i => (i.alt || '')).filter(Boolean)
    : (p.domData?.reviewSignals?.reviewImageAlts || []));
  const reviewAlt = altTexts.find(a => /review|testimonial|star\s+rating|customer\s+quote/i.test(a));
  if (reviewAlt) hit(2, `Review alt text: "${reviewAlt.slice(0, 50)}"`);

  // ── 8. Visible text keyword phrases ─────────────────────────────────
  const corpus = allText + ' ' + pwVisText;

  const SECTION_PHRASES = [
    ['what our customers say',   3, 'Visible review section: "what our customers say"'],
    ['what clients say',         3, 'Visible review section: "what clients say"'],
    ['what our clients say',     3, 'Visible review section: "what our clients say"'],
    ['customer feedback',        2, 'Visible phrase: "customer feedback"'],
    ['client feedback',          2, 'Visible phrase: "client feedback"'],
    ['customer reviews',         3, 'Visible phrase: "customer reviews"'],
    ['client reviews',           3, 'Visible phrase: "client reviews"'],
    ['verified reviews',         3, 'Visible phrase: "verified reviews"'],
    ['happy customers',          2, 'Visible phrase: "happy customers"'],
    ['happy clients',            2, 'Visible phrase: "happy clients"'],
    ['hear from our customers',  3, 'Visible phrase: "hear from our customers"'],
    ['hear from our clients',    3, 'Visible phrase: "hear from our clients"'],
    ['see what others say',      2, 'Visible phrase: "see what others say"'],
    ['real customer stories',    3, 'Visible phrase: "real customer stories"'],
  ];
  for (const [phrase, pts, label] of SECTION_PHRASES) {
    if (corpus.includes(phrase)) hit(pts, label);
  }

  // ── 9. Praise phrases ─────────────────────────────────────────────────
  // Score from BOTH Playwright praise matches AND raw corpus text.
  // Praise phrases in corpus are reliable review indicators on contractor sites
  // that don't use structured review markup.
  const PRAISE_RE = /highly recommend|great service|excellent work|would recommend|on time and|amazing job|very happy|best .{0,20}(?:company|contractor|team|service)|exceeded expectations|couldn.t be happier/gi;
  const pwPraiseAll    = pages.flatMap(p => p.domData?.reviewSignals?.praiseMatches || []);
  const corpusPraise   = (corpus.match(PRAISE_RE) || []);
  const allPraise      = [...new Set([...pwPraiseAll, ...corpusPraise.map(p => p.toLowerCase())])];

  if (allPraise.length >= 2) {
    hit(3, `Review praise phrases: ${allPraise.slice(0,3).join('; ')}`);
  } else if (allPraise.length === 1) {
    hit(1, `Review praise phrase: "${allPraise[0]}"`);
  }

  // ── 10. Plain "review" and "testimonial" keywords ──────────────────
  const reviewKeywordInCorpus  = /\breviews?\b/i.test(corpus);
  const testimonialKeyword      = /\btestimonials?\b/i.test(corpus);

  if (testimonialKeyword) {
    if (s === 0) {
      return ev('partial:0.25',
        'Visible review section: "testimonial" keyword found — but no review content, star ratings, or quotes confirmed',
        'Low');
    }
    if (!found.some(f => f.toLowerCase().includes('testimonial')))
      hit(1, '"testimonial" keyword detected');
  }

  if (reviewKeywordInCorpus && s === 0) {
    return ev('partial:0.25',
      'Visible text: "review" keyword found — but no review content, star ratings, or section detected',
      'Low');
  }

  // ── NOT SCORED ──────────────────────────────────────────────────────
  // "trusted", "quality", "reliable", "professional", "satisfied" alone = 0

  // ── Final verdict ────────────────────────────────────────────────────
  //
  // STRONG (true) when ANY of:
  //   A. s >= 6  — multiple signals (star+count, widget, etc.)
  //   B. Dedicated review/testimonial page crawled AND s >= 2
  //   C. "What our customers say" / section phrase alone (rule 2 in spec)
  //   D. Any 2 of: review heading, praise phrase, section phrase, Google mention
  //   E. Review heading + any praise phrase
  //
  // PARTIAL — 1 weak signal present, no dedicated section
  // NONE    — nothing at all

  if (s === 0)
    return ev(false,
      'No reviews, star ratings, testimonials, review widgets, or quoted customer feedback found. '
      + 'Generic trust words ("trusted", "quality", "professional") do not count.',
      'High');

  const evidenceStr = found.slice(0, 8).join('; ');

  // A. Point threshold
  if (s >= 6) return ev(true, `Reviews: ${evidenceStr}`, 'High');

  // B. Dedicated reviews page with any content
  const hasReviewPage = pages.some(p =>
    p.type === 'reviews' || /\/review|\/testimonial/i.test(p.url)
  );
  if (hasReviewPage && s >= 2)
    return ev(true, `Reviews: Dedicated review/testimonial page — ${evidenceStr}`, 'High');

  // Classify signals present
  const hasReviewHeading = found.some(f => /heading/i.test(f));
  const hasSectionPhrase = found.some(f =>
    /customers? say|clients? say|customer feedback|client feedback|customer reviews|client reviews|hear from|happy customers?/i.test(f)
  );
  const hasPraisePhrase  = allPraise.length >= 1;
  const hasGoogleMention = found.some(f => /google/i.test(f));

  // C. Section phrase alone = strong (spec rule 2: "homepage contains testimonial section")
  if (hasSectionPhrase)
    return ev(true, `Reviews: ${evidenceStr}`, 'High');

  // D. Any 2 of the 4 contractor signals
  const strongCount = [hasReviewHeading, hasPraisePhrase, hasGoogleMention].filter(Boolean).length;
  // (hasSectionPhrase already handled in C above)
  if (strongCount >= 2)
    return ev(true, `Reviews: ${evidenceStr}`, 'High');

  // E. Review heading + any praise
  if (hasReviewHeading && hasPraisePhrase)
    return ev(true, `Reviews: ${evidenceStr}`, 'High');

  // F. 2+ praise phrases alone — multiple customer voices = real reviews
  if (allPraise.length >= 2)
    return ev(true, `Reviews: ${evidenceStr}`, 'High');

  // G. Quoted testimonial text (loose match, 3+ pts) — real quote = real review
  if (found.some(f => /quote/i.test(f)) && s >= 3)
    return ev(true, `Reviews: ${evidenceStr}`, 'High');

  // Partial: heading alone, single praise phrase, or other single weak signal
  if (s >= 2) return ev('partial', `Partial reviews: ${evidenceStr}`, 'Medium');

  return ev('partial:0.25', `Weak review signal: ${evidenceStr}`, 'Low');
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

  const addrM = findAddress(normalizeText(allHtml)) || findStructuredAddress(allHtml);
  if (addrM) { s += 2; evidence.push(`address: "${addrM.slice(0,50)}"`); }

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
// Counts: real HTML forms, booking widgets, iframe forms, embedded lead capture.
// Does NOT count: "contact us" text, newsletter-only email forms.
function checkContactForm(allHtml, widgets, pages) {
  const evidence = [];

  // Embedded booking/form widgets (GHL, Calendly, iframe booking, etc.)
  if (widgets.embeddedFormDetected && widgets.embeddedFormEvidence) {
    evidence.push(widgets.embeddedFormEvidence);
  } else if (widgets.isGHL) {
    evidence.push('GoHighLevel embedded form/funnel');
  } else if (widgets.hasIframeForm) {
    evidence.push('Iframe form/booking widget detected');
  } else if (widgets.hasBooking && !widgets.isGHL) {
    evidence.push(widgets.hasCalendly ? 'Calendly booking widget' : widgets.hasAcuity ? 'Acuity booking' : 'Booking widget detected');
  }

  // Known chat widgets that serve as a contact mechanism
  if (widgets.hasTawk)          evidence.push('Tawk.to live chat');
  else if (widgets.hasIntercom) evidence.push('Intercom chat');
  else if (widgets.hasDrift)    evidence.push('Drift chat');
  else if (widgets.hasCrisp)    evidence.push('Crisp chat');
  else if (widgets.hasFreshchat) evidence.push('Freshchat');
  else if (widgets.hasZendesk)  evidence.push('Zendesk chat');
  else if (widgets.hasChat)     evidence.push('Live chat widget');

  // Playwright-detected HTML forms
  const pwForms          = pages.flatMap(p => p.domData?.forms || []);
  const pwNewsletterOnly = pages.some(p => p.domData?.widgets?.hasNewsletterOnlyForm);
  const pwLeadForms      = pwForms.filter(f => !pwNewsletterOnly || f.fieldCount > 1);

  if (pwLeadForms.length > 0) {
    evidence.push(`HTML form: ${pwLeadForms[0].fieldCount} field(s), submit: "${pwLeadForms[0].submitText || 'yes'}"`);
  } else if (pwForms.length > 0 && pwNewsletterOnly) {
    evidence.push(`Email/newsletter form only (${pwForms[0].fieldCount} field) — not a lead form`);
  } else if (/<form\b/i.test(allHtml)) {
    // HTML fallback field count
    const allInputs = allHtml.match(/<input\b[^>]+>/gi) || [];
    const hidden    = allInputs.filter(i => /type=["'](hidden|submit|button|reset|checkbox|radio|image)["']/i.test(i)).length;
    const vis       = Math.max(0, allInputs.length - hidden) + (allHtml.match(/<textarea\b/gi) || []).length;
    if (vis > 0) evidence.push(`HTML form with ${vis} visible field(s)`);
  }

  if (!evidence.length)
    return ev(false, 'No contact form, booking widget, embedded form, or chat found. "Contact Us" text alone does not count.');

  // Newsletter-only downgrade (only when that's the sole signal)
  const onlyNewsletter = pwNewsletterOnly && pwLeadForms.length === 0
    && !widgets.embeddedFormDetected && !widgets.isGHL && !widgets.hasIframeForm && !widgets.hasBooking;
  if (onlyNewsletter)
    return ev('partial:0.3', `Newsletter/email-only form: ${evidence.join('; ')}`, 'Low');

  // Full credit: embedded widget OR real form with multiple evidence points
  if (widgets.embeddedFormDetected || widgets.isGHL || pwLeadForms.length > 0 || evidence.length >= 2)
    return ev(true, `Form/widget: ${evidence.join('; ')}`);

  return ev('partial', `Partial: ${evidence.join('; ')}`, 'Medium');
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
  // GHL / embedded booking = optimised lead flow
  if (widgets.isGHL)                 return ev(true, 'GoHighLevel funnel — optimised lead flow');
  if (widgets.embeddedFormDetected)  return ev(true,  `Embedded form/booking widget — ${widgets.embeddedFormEvidence}`);
  if (widgets.hasBooking)            return ev(true,  'Booking/calendar widget — direct scheduling path');

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
  return ev(false, 'No short form, embedded booking, or clear conversion path');
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
const PAGESPEED_DIAGNOSTIC_IDS = [
  'largest-contentful-paint',
  'render-blocking-resources',
  'unused-css-rules',
  'unused-javascript',
  'modern-image-formats',
  'uses-long-cache-ttl',
];

function summarizePageSpeedAudit(id, audit) {
  if (!audit) return null;
  return {
    id,
    title: audit.title || id,
    displayValue: audit.displayValue || null,
    score: typeof audit.score === 'number' ? audit.score : null,
    numericValue: typeof audit.numericValue === 'number' ? audit.numericValue : null,
  };
}

function buildPageSpeedEvidence(psData) {
  const audits = psData?.lighthouseResult?.audits || {};
  const perf = psData?.lighthouseResult?.categories?.performance?.score;
  const score = typeof perf === 'number' ? Math.round(perf * 100) : null;

  const metricValue = id => audits[id]?.displayValue || null;
  const metrics = {
    lcp: metricValue('largest-contentful-paint'),
    cls: metricValue('cumulative-layout-shift'),
    inp: metricValue('interaction-to-next-paint') || metricValue('experimental-interaction-to-next-paint'),
  };

  const issues = [];
  const opportunities = [];

  for (const id of PAGESPEED_DIAGNOSTIC_IDS) {
    const audit = audits[id];
    if (!audit) continue;

    const item = summarizePageSpeedAudit(id, audit);
    const actionable = audit.score === null || audit.score === undefined || audit.score < 0.9;
    if (!actionable) continue;

    issues.push(item);
    if (audit.details?.type === 'opportunity' || audit.numericValue || audit.displayValue) {
      opportunities.push(item);
    }
  }

  return {
    score,
    metrics,
    issues,
    opportunities,
  };
}

function pageSpeedIssueLabels(pageSpeed) {
  const labels = new Set();
  for (const issue of pageSpeed?.issues || []) {
    if (['modern-image-formats'].includes(issue.id)) labels.add('image optimization');
    if (['uses-long-cache-ttl'].includes(issue.id)) labels.add('caching');
    if (['render-blocking-resources','unused-css-rules','unused-javascript'].includes(issue.id)) labels.add('render blocking');
    if (['largest-contentful-paint'].includes(issue.id)) labels.add('LCP / loading issues');
  }
  return [...labels];
}

function formatPageSpeedIssue(pageSpeed) {
  if (!pageSpeed || pageSpeed.score == null) return 'Mobile speed could not be verified automatically.';
  if (pageSpeed.score >= 90) return null;

  const labels = pageSpeedIssueLabels(pageSpeed);
  const detail = labels.length
    ? `Performance issues detected including ${labels.join(', ')} which may impact mobile load speed.`
    : '';

  if (pageSpeed.score < 50) {
    return detail
      ? `Mobile performance is likely impacting load speed. ${detail}`
      : 'Mobile performance is likely impacting load speed.';
  }

  return detail
    ? `Some performance improvements possible. ${detail}`
    : 'Some performance improvements possible.';
}

function checkMobileSpeed(psData) {
  const pageSpeed = buildPageSpeedEvidence(psData);

  if (pageSpeed.score == null) return ev('partial', pageSpeed, 'Low');
  if (pageSpeed.score >= 90) return ev(true, pageSpeed);
  if (pageSpeed.score >= 50) return ev('partial', pageSpeed, 'Medium');
  return ev(false, pageSpeed, 'High');
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
// VISUAL TRUST & DESIGN QUALITY (15 pts, conversion/trust insight only)
// This does not affect the main 100-point score.
// ═══════════════════════════════════════════════════════════════════════

const VISUAL_TRUST_MAX = 15;

function medianNumber(values) {
  const nums = values.filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  if (!nums.length) return 0;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function scoreVisualCheck(key, label, result, evidence, fix) {
  return {
    key,
    label,
    result,
    score: round2(weightedScore(result, 3)),
    max: 3,
    evidence,
    fix,
  };
}

function visualResultFromScore(score) {
  if (score >= 12) return true;
  if (score >= 6) return 'partial';
  return false;
}

function visualTrustStatus(result) {
  if (result === true) return 'Strong';
  if (result === false) return 'Weak';
  return 'Partial';
}

function visualTrustMessage(result) {
  if (result === true) {
    return 'The site has a clear, professional visual presentation that supports visitor trust.';
  }
  if (result === false) {
    return 'The visual presentation may reduce trust and make visitors less likely to contact the business.';
  }
  return 'The site has some professional design signals, but visual clarity or trust could be improved.';
}

function analyzeVisualTrust(pages) {
  const homeDom = pages.find(p => p.type === 'homepage')?.domData || pages.find(p => p.domData)?.domData;
  const vt = homeDom?.visualTrust;

  if (!vt) {
    const fallback = scoreVisualCheck(
      'visualTrustUnavailable',
      'Visual Trust Verification',
      'partial',
      'Rendered visual data could not be fully verified, so this was scored conservatively.',
      'Review the rendered page manually for spacing, readability, image quality, and CTA prominence.'
    );
    return {
      label: 'Visual Trust & Design Quality',
      factorType: 'Conversion/trust factor, not a direct Google ranking factor.',
      score: round2(weightedScore('partial', VISUAL_TRUST_MAX)),
      max: VISUAL_TRUST_MAX,
      result: 'partial',
      status: 'Partial',
      message: visualTrustMessage('partial'),
      breakdown: [fallback],
      recommendations: [fallback.fix],
      evidence: fallback.evidence,
    };
  }

  const readableSamples = Array.isArray(vt.readableSamples) ? vt.readableSamples : [];
  const fontSizes = readableSamples.map(s => Number(s.fontSize)).filter(n => n > 0);
  const medianFont = medianNumber(fontSizes);
  const smallTextRatio = readableSamples.length ? (Number(vt.smallTextCount || 0) / readableSamples.length) : 0;
  const longLineCount = Number(vt.longLineCount || 0);
  const imageCount = Number(vt.imageCount || 0);
  const imagesWithAlt = Number(vt.imagesWithAlt || 0);
  const imagesWithoutAlt = Number(vt.imagesWithoutAlt || 0);
  const placeholderImages = Number(vt.likelyPlaceholderImages || 0);
  const altRatio = imageCount ? imagesWithAlt / imageCount : 0;
  const headingCount = Number(vt.headingCount || 0);
  const sectionLikeCount = Number(vt.sectionLikeCount || 0);
  const textColorCount = Array.isArray(vt.uniqueTextColors) ? vt.uniqueTextColors.length : 0;
  const buttonColorCount = Array.isArray(vt.uniqueButtonColors) ? vt.uniqueButtonColors.length : 0;
  const fontFamilyCount = Array.isArray(vt.uniqueFonts) ? vt.uniqueFonts.length : 0;
  const aboveFoldCtaCount = Number(vt.aboveFoldCtaCount || 0);
  const prominentCtaCount = Number(vt.prominentCtaCount || 0);
  const aboveFoldButtonCount = Number(vt.aboveFoldButtonCount || 0);
  const ctaTexts = Array.isArray(vt.ctaTextsAboveFold) ? vt.ctaTextsAboveFold.filter(Boolean) : [];

  const layoutResult =
    headingCount >= 2 && sectionLikeCount >= 3 ? true :
    headingCount >= 1 && sectionLikeCount >= 1 ? 'partial:0.67' :
    headingCount >= 1 || sectionLikeCount >= 1 ? 'partial:0.33' :
    false;

  const fontResult =
    readableSamples.length < 5 ? 'partial' :
    medianFont >= 16 && smallTextRatio <= 0.15 && longLineCount <= 2 ? true :
    medianFont >= 14 && smallTextRatio <= 0.35 ? 'partial:0.67' :
    medianFont >= 12 ? 'partial:0.33' :
    false;

  const consistencyResult =
    textColorCount <= 6 && buttonColorCount <= 4 && fontFamilyCount <= 3 ? true :
    textColorCount <= 10 && buttonColorCount <= 6 && fontFamilyCount <= 5 ? 'partial:0.67' :
    textColorCount <= 14 && fontFamilyCount <= 7 ? 'partial:0.33' :
    false;

  const imageResult =
    imageCount >= 3 && altRatio >= 0.5 && placeholderImages === 0 ? true :
    imageCount > 0 && altRatio >= 0.25 ? 'partial:0.67' :
    imageCount > 0 ? 'partial:0.33' :
    false;

  const ctaResult =
    prominentCtaCount > 0 ? true :
    aboveFoldCtaCount > 0 ? 'partial:0.67' :
    aboveFoldButtonCount > 0 ? 'partial:0.33' :
    false;

  const breakdown = [
    scoreVisualCheck(
      'layoutClarity',
      'Layout clarity',
      layoutResult,
      `${headingCount} visible heading(s), ${sectionLikeCount} section/card-like block(s) detected.`,
      'Improve spacing and use clearer section hierarchy so visitors can scan services, proof, and contact options quickly.'
    ),
    scoreVisualCheck(
      'fontReadability',
      'Font/readability',
      fontResult,
      readableSamples.length
        ? `Median readable font size: ${round2(medianFont)}px; small text ratio: ${Math.round(smallTextRatio * 100)}%; long-line blocks: ${longLineCount}.`
        : 'Readable text samples were limited in the rendered page.',
      'Improve mobile readability with larger body text, shorter line lengths, and clearer spacing between content blocks.'
    ),
    scoreVisualCheck(
      'visualConsistency',
      'Visual consistency',
      consistencyResult,
      `${textColorCount} text color(s), ${buttonColorCount} button background color(s), ${fontFamilyCount} font family signal(s) detected.`,
      'Simplify inconsistent colors, button styles, headings, and spacing so the page feels more professional.'
    ),
    scoreVisualCheck(
      'imageQuality',
      'Image quality/professionalism',
      imageResult,
      `${imageCount} visible image(s), ${imagesWithAlt} with useful alt text, ${imagesWithoutAlt} without alt text, ${placeholderImages} likely placeholder image(s).`,
      'Add real project/customer photos, improve image quality, and add useful alt text for important images.'
    ),
    scoreVisualCheck(
      'ctaVisibility',
      'Visual hierarchy / CTA visibility',
      ctaResult,
      prominentCtaCount > 0
        ? `Prominent above-the-fold CTA detected: ${ctaTexts.slice(0, 2).join(', ') || 'CTA button'}.`
        : `${aboveFoldCtaCount} above-the-fold CTA(s), ${aboveFoldButtonCount} above-the-fold button/link control(s) detected.`,
      'Make the primary CTA button more prominent above the fold with clear contrast, size, and action-focused wording.'
    ),
  ];

  const score = round2(breakdown.reduce((sum, item) => sum + item.score, 0));
  const result = visualResultFromScore(score);
  const weakChecks = breakdown.filter(item => item.result !== true);

  return {
    label: 'Visual Trust & Design Quality',
    factorType: 'Conversion/trust factor, not a direct Google ranking factor.',
    score,
    max: VISUAL_TRUST_MAX,
    result,
    status: visualTrustStatus(result),
    message: visualTrustMessage(result),
    breakdown,
    recommendations: weakChecks.map(item => item.fix).slice(0, 5),
    evidence: breakdown.map(item => `${item.label}: ${item.evidence}`).join(' | '),
  };
}

function buildVisualTrustIssues(visualTrust) {
  if (!visualTrust || visualTrust.result === true) return [];
  return [{
    key: 'visualTrust',
    label: 'Visual Trust & Design Quality',
    severity: visualTrust.result === false ? 'fail' : 'partial',
    issue: visualTrust.message,
    fix: (visualTrust.recommendations || [])[0] || 'Improve spacing, hierarchy, image quality, and CTA visibility.',
    category: 'visualTrust',
    maxPoints: VISUAL_TRUST_MAX,
    evidence: visualTrust.evidence,
    confidence: 'Medium',
  }];
}

function buildVisualTrustRecommendations(visualTrust) {
  if (!visualTrust || visualTrust.result === true) return [];
  const fixes = Array.isArray(visualTrust.recommendations) ? visualTrust.recommendations : [];
  return fixes.slice(0, 3).map((fix, index) => ({
    key: index === 0 ? 'visualTrust' : `visualTrust${index + 1}`,
    label: 'Visual Trust & Design Quality',
    fix,
    impact: 'This is a conversion/trust factor, not a direct Google ranking factor. Clearer visual presentation can make visitors more comfortable calling or requesting a quote.',
    category: 'visualTrust',
    maxPoints: VISUAL_TRUST_MAX,
  }));
}


// ═══════════════════════════════════════════════════════════════════════
// MASTER SCORING TABLE
// Maps each check key to { category, label, max, issue, fix, impact }
// ═══════════════════════════════════════════════════════════════════════

const INDUSTRY_KEYWORDS = {
  contractor: [
    'contractor','excavation','demolition','roofing','plumbing','hvac','electrical',
    'landscaping','remodeling','concrete','grading','renovation','siding','gutters',
    'roof replacement','roof repair','air conditioning','lawn care','waterproofing',
    'stump removal','septic systems','retaining walls','trucking',
  ],
  detailing: [
    'detailing','auto detailing','car detailing','ceramic coating','paint correction',
    'mobile detailing','interior detailing','exterior detailing','wash and wax',
    'paint protection','ppf','window tint','detailing packages','full detail',
  ],
  general: [],
};

const SERVICE_TERMS = [
  ...INDUSTRY_KEYWORDS.contractor,
  ...INDUSTRY_KEYWORDS.detailing,
  'heating','cooling','painting','windows','doors','decking','deck building',
  'fencing','drywall','flooring','tile','masonry','insulation','pressure washing',
  'power washing','snow removal','tree service','framing','carpentry',
  'kitchen remodel','bathroom remodel',
];

const SCORE_TABLE = {
  // ── SEO Visibility (20) ───────────────────────────────────────
  titleTag: {
    cat: 'seoVisibility', max: 4, label: 'Title Tag (Service + Location)',
    issue: "Title tag is missing or doesn't include your trade and service area.",
    issueFn: (result, evidence) => {
      if (result === true) return null;
      if (result !== false) return 'The title tag is present but could better combine the main service and location.';
      if (/no title tag|too short/i.test(evidence || '')) return 'No usable title tag could be verified.';
      return 'The title tag is present, but it does not clearly include both the main service and location.';
    },
    fixFn: (result, evidence) => {
      if (/no title tag|too short/i.test(evidence || '')) return 'Add a concise title tag using: "[Service] in [City] | [Business Name]".';
      return 'Refine the title tag so it clearly combines the primary service, service area, and business name.';
    },
    fix: 'Format: "[Service] in [City] | [Business Name]" — keep it under 60 characters.',
    impact: 'The title tag is Google\'s #1 on-page ranking signal. A local-optimised title directly increases clicks from search results.',
  },
  headingKeywords: {
    cat: 'seoVisibility', max: 3.5, label: 'Heading Keywords (H1/H2/H3)',
    issue: 'Page headings do not include your trade or local keywords.',
    fix: 'Your H1 should state what you do and where: "Expert Roof Repair in [City]". Use H2s for service sections.',
    impact: 'Google reads headings to understand page content. Missing keywords here weakens both rankings and visitor clarity.',
  },
  metaDescription: {
    cat: 'seoVisibility', max: 2.5, label: 'Meta Description',
    issue: 'Meta description is missing or too short to be useful.',
    fix: 'Write 140–160 chars: "[Service] in [City]. Licensed & insured. Free estimates. Call [phone] or request a quote online."',
    impact: 'A strong meta description improves click-through rate from Google even when rankings are the same.',
  },
  servicesListed: {
    cat: 'seoVisibility', max: 3.5, label: 'Services Clearly Listed',
    issue: 'Your specific services are not clearly named on the site.',
    fix: 'Add a Services section listing each offering by name: Roof Replacement, Emergency Plumbing, AC Installation, etc.',
    impact: 'Visitors confirm within seconds whether you offer what they need. Unclear services cause immediate bounces.',
  },
  servicePageDepth: {
    cat: 'seoVisibility', max: 3, label: 'Dedicated Service Pages',
    issue: 'No individual pages targeting specific services were found.',
    issueFn: (result, evidence) => {
      if (result === true) return null;
      if (result !== false) return 'Some service content was detected, but dedicated service pages were not clearly confirmed.';
      if (/service link/i.test(evidence || '')) return 'Some service content was detected, but dedicated service pages were not clearly confirmed.';
      return 'No dedicated service pages or service-specific internal links could be verified.';
    },
    fixFn: (result, evidence) => {
      if (result !== false || /service link/i.test(evidence || '')) return 'Confirm each core service has a clearly linked page with its own URL, service copy, location context, and CTA.';
      return 'Create one clearly linked page per core service, such as "/excavation", "/demolition", or "/concrete-removal".';
    },
    fix: 'Create one page per core service: "/roof-replacement-[city]", "/emergency-plumber-[city]".',
    impact: 'Each service page is an additional Google ranking opportunity for high-intent searches.',
  },
  locationContent: {
    cat: 'seoVisibility', max: 2.5, label: 'Location & Service Area Content',
    issue: 'The site does not clearly list your city, region, or areas served.',
    fix: '"Proudly serving [City], [Nearby Town], and surrounding areas." Add this to homepage and footer.',
    impact: 'Without location content, Google cannot rank you in local searches.',
  },
  internalLinks: {
    cat: 'seoVisibility', max: 1, label: 'Internal Links to Key Pages',
    issue: 'The site lacks clear internal links between homepage, services, and contact pages.',
    fix: 'Link your homepage to each service page and to your contact page from the nav and body copy.',
    impact: 'Internal links help Google discover and index your most important pages, improving rankings.',
  },

  // ── Local Trust (30) ─────────────────────────────────────────
  reviewsVisible: {
    cat: 'localTrust', max: 8, label: 'Reviews & Testimonials Visible',
    issue: 'No customer reviews, star ratings, or testimonials found on the site.',
    issueFn: (result) => {
      if (result === true) return null;
      if (result === false) return 'No customer reviews, star ratings, or testimonials could be verified on the site.';
      return 'Some testimonial/review evidence was found, but stronger review signals like star ratings or embedded Google reviews could improve trust.';
    },
    fixFn: (result) => {
      if (result === false) return 'Add visible reviews or testimonials, link to Google reviews, and include named customer quotes where possible.';
      return 'Strengthen the existing review evidence with a visible rating/count, an embedded Google review widget, or more clearly attributed customer testimonials.';
    },
    fix: 'Embed your Google star rating widget. Add 3–5 named customer quotes. Link to your Google Business reviews.',
    impact: 'Over 80% of homeowners check reviews before hiring. Clear social proof builds trust before visitors call or submit a form.',
  },
  googleSignals: {
    cat: 'localTrust', max: 6, label: 'Google Signals (Map, Address, Reviews)',
    issue: 'No Google Maps embed, street address, or Google Business link found.',
    fix: 'Add your full address in the footer. Embed a Google Map on the contact page. Link to your Google Business Profile.',
    impact: 'Google uses these signals to place you in the local map pack — the top 3 results that generate most contractor leads.',
  },
  proofOfWork: {
    cat: 'localTrust', max: 6, label: 'Proof of Work (Gallery / Before & After)',
    issue: 'No project photos, before/after images, or portfolio found.',
    fix: 'Add a Gallery page with real job photos. Before/after shots are the most persuasive content for contractors.',
    impact: 'Showing your work builds instant visual trust. Contractors with photo galleries convert significantly better.',
  },
  professionalSignals: {
    cat: 'localTrust', max: 5, label: 'Licensed / Insured / Certified',
    issue: 'No visible credentials — no mention of being licensed, insured, bonded, or certified.',
    fix: '"Licensed & Insured | [X] Years Experience | [Trade Certification]" — display this near the top of every page.',
    impact: 'Homeowners\' top fear is hiring someone unqualified. Visible credentials remove this barrier immediately.',
  },
  riskReversal: {
    cat: 'localTrust', max: 5, label: 'Guarantees / Free Estimates / Warranties',
    issue: 'No free estimate offer, satisfaction guarantee, or warranty language found.',
    fix: '"Free Estimates | 100% Satisfaction Guaranteed | 5-Year Workmanship Warranty" — place near every CTA.',
    impact: 'Risk-reduction language directly lowers the hesitation that stops customers from submitting a form.',
  },

  // ── Lead Conversion (35) ─────────────────────────────────────
  cta: {
    cat: 'leadConversion', max: 8, label: 'Strong Call-to-Action',
    issue: 'No prominent CTA found — visitors have no clear next step to get a quote or call.',
    fix: 'Add a large, high-contrast button above the fold: "Get My Free Estimate", "Call Now", or "Book a Service".',
    impact: 'A missing or weak CTA is the #1 reason contractor websites generate few leads despite decent traffic.',
  },
  phone: {
    cat: 'leadConversion', max: 7, label: 'Phone Number (Visible & Clickable)',
    issue: 'Phone number is not visible, not tap-to-call on mobile, or missing entirely.',
    fix: 'Place a <a href="tel:+1..."> phone number in the header of every page. Make it large and immediately visible.',
    impact: 'Most contractor leads come from phone calls. Any friction between a visitor and your number costs you the job.',
  },
  contactForm: {
    cat: 'leadConversion', max: 7, label: 'Contact Form / Booking / Widget',
    issue: 'No contact form, booking widget, or lead capture mechanism found.',
    fix: 'Add a short 3–4 field form: Name, Phone, Service, Message. Or embed a Calendly/GHL booking widget.',
    impact: 'Not everyone will call. A form or booking option captures leads who prefer not to call immediately.',
  },
  contactMethods: {
    cat: 'leadConversion', max: 6, label: '3+ Contact Methods Present',
    issue: 'Fewer than 3 ways to contact you were found.',
    fix: 'Offer at minimum: clickable phone + contact form + email or booking link.',
    impact: 'Different people prefer different contact methods. One option means you are invisible to everyone who prefers another.',
  },
  aboveFold: {
    cat: 'leadConversion', max: 5, label: 'Above-the-Fold Clarity',
    issue: 'The top of the homepage does not immediately communicate what you do, where you serve, or what to do next.',
    issueFn: (result) => {
      if (result === true) return null;
      if (result === false) return 'The top section does not clearly show the service, location, or next step.';
      return 'The top section has some lead-generation signals, but could be clearer about service, location, and next step.';
    },
    fixFn: (result, evidence) => {
      if (result === false) return 'Rewrite the hero area so it immediately states the core service, service area, and primary CTA.';
      return 'Build on the detected above-the-fold signals (' + (evidence || 'partial evidence') + ') by making the service, location, and CTA visible together.';
    },
    fix: 'Your hero section must answer 3 questions instantly: What do you do? Where? What should I do now? (CTA)',
    impact: 'Visitors decide to stay or leave in 3 seconds. Clear above-the-fold copy helps them understand the offer before scrolling.',
  },
  conversionPath: {
    cat: 'leadConversion', max: 2, label: 'Low-Friction Conversion Path',
    issue: 'The path from visitor to lead has too many steps or asks for too much information.',
    fix: 'Keep forms to 3–4 fields. Offer click-to-call as an alternative. Remove unnecessary form fields.',
    impact: 'Every extra step or field reduces form completions. Simple paths convert 2–3× better.',
  },

  // ── Technical Health (15) ────────────────────────────────────
  https: {
    cat: 'technical', max: 3, label: 'HTTPS / Security',
    issue: 'The site uses HTTP — browsers display a "Not Secure" warning.',
    fix: 'Install a free SSL certificate via your host (Let\'s Encrypt). Takes under 10 minutes.',
    impact: 'An insecure warning instantly destroys trust and prevents many customers from submitting a form.',
  },
  mobileSpeed: {
    cat: 'technical', max: 6, label: 'Mobile Page Speed',
    issue: 'Mobile speed could not be verified automatically.',
    issueFn: (result, evidence) => {
      if (result === true) return null;
      const pageSpeed = evidence && typeof evidence === 'object' ? evidence : null;
      return formatPageSpeedIssue(pageSpeed);
    },
    fixFn: (result, evidence) => {
      const pageSpeed = evidence && typeof evidence === 'object' ? evidence : null;
      if (!pageSpeed || pageSpeed.score == null) return 'Run a manual PageSpeed test and optimize images/scripts if needed.';
      if (pageSpeed.opportunities?.length) return `Address PageSpeed opportunities: ${pageSpeed.opportunities.slice(0, 3).map(o => o.title || o.id || String(o)).join(', ')}.`;
      const labels = pageSpeedIssueLabels(pageSpeed);
      if (labels.includes('image optimization')) return 'Start by compressing/resizing images and serving modern formats like WebP.';
      if (labels.includes('render blocking')) return 'Reduce render-blocking CSS/JavaScript and defer non-critical scripts.';
      if (labels.includes('caching')) return 'Improve browser caching for static assets.';
      return 'Review PageSpeed diagnostics and optimize the highest-impact mobile performance items first.';
    },
    impactFn: (result, evidence) => {
      const pageSpeed = evidence && typeof evidence === 'object' ? evidence : null;
      if (!pageSpeed || pageSpeed.score == null) return 'Manual verification is needed before making a speed claim.';
      return 'Mobile performance affects how many visitors stay long enough to call, book, or submit a form.';
    },
    fix: 'Run a manual PageSpeed test and optimize images/scripts if needed.',
    impact: 'Mobile performance affects how many visitors stay long enough to call, book, or submit a form.',
  },
  mobileUsability: {
    cat: 'technical', max: 3, label: 'Mobile Usability / Responsiveness',
    issue: 'The site may not be fully responsive — no mobile viewport configuration detected.',
    fix: 'Use a mobile-responsive theme. Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
    impact: 'A broken mobile layout sends leads directly to competitors — the majority of your potential customers are on phones.',
  },
  crawlHealth: {
    cat: 'technical', max: 3, label: 'Site Crawlability',
    issue: 'The site may be blocking bots, loading slowly, or rendering content entirely in JavaScript.',
    fix: 'Ensure key content is in the HTML source, not just rendered by JavaScript. Test with Google Search Console.',
    impact: 'If Google cannot crawl your site properly, it will not rank it. Crawl issues silently suppress all your SEO effort.',
  },
};

// ═══════════════════════════════════════════════════════════════════════
// CRITICAL FLAGS
// ═══════════════════════════════════════════════════════════════════════

function buildCriticalFlags(checks, psData) {
  // checks values may be raw booleans OR ev() objects { result, evidence, confidence }
  const getR = v => (v && typeof v === 'object') ? v.result : v;
  const flags = [];

  if (getR(checks.phone) === false) {
    flags.push({ key: 'noPhone', label: 'No Phone Number Found',
      detail: 'Contractor customers expect to call. No visible, clickable phone number is the fastest way to lose leads.' });
  }
  if (getR(checks.contactForm) === false && getR(checks.contactMethods) === false) {
    flags.push({ key: 'noContactMethod', label: 'No Contact Form or Booking Option',
      detail: "Customers who won't call need another way to reach you. No form = lost quote requests." });
  }
  if (getR(checks.cta) === false) {
    flags.push({ key: 'noCTA', label: 'No Call-to-Action Found',
      detail: 'Without a CTA button, visitors have no clear next step and leave without contacting you.' });
  }
  if (getR(checks.servicesListed) === false) {
    flags.push({ key: 'noServices', label: 'No Services Clearly Listed',
      detail: "If visitors can't immediately see what you offer, they'll find a competitor who makes it obvious." });
  }
  // Only flag "no reviews" when result is strictly false — partial means something WAS detected
  if (getR(checks.reviewsVisible) === false) {
    flags.push({ key: 'noReviews', label: 'No Reviews or Testimonials Found',
      detail: 'Over 80% of homeowners check reviews before hiring. No social proof = no trust = no calls.' });
  }
  if (getR(checks.https) === false) {
    flags.push({ key: 'notHttps', label: 'Site Not Secured with HTTPS',
      detail: 'Browsers show "Not Secure" on HTTP sites. This stops many customers from submitting a form.' });
  }
  const psScore = psData?.lighthouseResult?.categories?.performance?.score;
  if (psScore != null && psScore < 0.35) {
    flags.push({ key: 'slowSpeed', label: 'Very Slow Mobile Speed',
      detail: `Mobile PageSpeed: ${Math.round(psScore * 100)}/100. Sites this slow lose most mobile visitors before loading.` });
  }
  if (getR(checks.locationContent) === false && getR(checks.titleTag) === false) {
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

  // ── Raw weighted scores ──────────────────────────────────────────
  const scores = {};
  let total = 0;
  for (const [key, meta] of Object.entries(SCORE_TABLE)) {
    const pts   = weightedScore(checks[key], meta.max);
    scores[key] = pts;
    total      += pts;
  }
  let rawTotal  = Math.round(total * 10) / 10;

  // ── Lead Conversion internal caps ────────────────────────────────
  // Stricter caps applied to the Lead Conversion category BEFORE global cap.
  // This prevents high LC scores when critical conversion elements are absent.
  const LC_KEYS    = ['cta','phone','contactForm','contactMethods','aboveFold','conversionPath'];
  const lcRaw      = LC_KEYS.reduce((s, k) => s + (scores[k] || 0), 0);
  const lcMax      = 35;
  let   lcCap      = lcMax;
  let   lcCapNote  = null;

  const noPhone    = getR(checks.phone)       === false;
  const noStrongCTA= getR(checks.cta)         === false;
  const noForm     = getR(checks.contactForm) === false;

  // Rule: no form AND no booking AND no phone → strong penalty
  if (noForm && noPhone && noStrongCTA) {
    lcCap = 17.5;
    lcCapNote = 'Lead Conversion capped at 17.5 — no phone, no CTA, no form/booking';
  } else if (noForm && noPhone) {
    lcCap = 21;
    lcCapNote = 'Lead Conversion capped at 21 — no phone and no form/booking';
  } else if (noPhone) {
    lcCap = 21;
    lcCapNote = 'Lead Conversion capped at 21 — no phone number';
  } else if (noStrongCTA) {
    lcCap = 21;
    lcCapNote = 'Lead Conversion capped at 21 — no strong CTA';
  } else if (noForm) {
    lcCap = 23;
    lcCapNote = 'Lead Conversion capped at 23 — no form or booking widget';
  }

  if (lcRaw > lcCap) {
    // Proportionally reduce all LC scores
    const ratio = lcCap / lcRaw;
    let excess  = 0;
    for (const k of LC_KEYS) {
      const reduced  = Math.round(scores[k] * ratio * 10) / 10;
      excess        += scores[k] - reduced;
      scores[k]      = reduced;
    }
    rawTotal  -= excess;
    rawTotal   = Math.round(rawTotal * 10) / 10;
  }

  // ── 6-tier global cap — missing core signals ─────────────────────
  // Core = the six most impactful lead-gen checks
  const CORE = ['phone','cta','servicesListed','reviewsVisible','contactForm','locationContent'];
  const missing   = CORE.filter(k => getR(checks[k]) === false).length;
  let cappedTotal = rawTotal;
  let capApplied  = null;

  if      (missing >= 6 && cappedTotal > 40) { cappedTotal = 40; capApplied = `Capped at 40 — all 6 core signals missing`; }
  else if (missing >= 5 && cappedTotal > 40) { cappedTotal = 40; capApplied = `Capped at 40 — ${missing} core signals missing`; }
  else if (missing >= 4 && cappedTotal > 55) { cappedTotal = 55; capApplied = `Capped at 55 — ${missing} core signals missing`; }
  else if (missing >= 3 && cappedTotal > 65) { cappedTotal = 65; capApplied = `Capped at 65 — ${missing} core signals missing`; }
  else if (missing >= 2 && cappedTotal > 80) { cappedTotal = 80; capApplied = `Capped at 80 — ${missing} core signals missing`; }

  if (lcCapNote) {
    capApplied = (capApplied ? capApplied + '; ' : '') + lcCapNote;
  }

  // ── Critical caps ────────────────────────────────────────────────
  // These keep low-quality sites from looking mid-range when key SEO/trust
  // signals are missing.
  const criticalCaps = [];
  if (getR(checks.reviewsVisible) === false)   criticalCaps.push({ cap: 50, note: 'Capped at 50 — no reviews or testimonials' });
  if (getR(checks.cta) === false)              criticalCaps.push({ cap: 60, note: 'Capped at 60 — no clear CTA' });
  if (getR(checks.servicePageDepth) === false) criticalCaps.push({ cap: 65, note: 'Capped at 65 — no dedicated service pages' });
  if (checks._isSinglePage)                    criticalCaps.push({ cap: 55, note: 'Capped at 55 — single-page site structure' });

  for (const { cap, note } of criticalCaps) {
    if (cappedTotal > cap) {
      cappedTotal = cap;
      capApplied = (capApplied ? capApplied + '; ' : '') + note;
    }
  }

  // ── Critical final-score multipliers ─────────────────────────────
  // Apply after caps so missing core signals have real impact on the final score.
  const multipliers = [];
  if (getR(checks.reviewsVisible) === false) multipliers.push({ factor: 0.7, note: 'x0.7 no reviews' });
  if (getR(checks.cta) === false)            multipliers.push({ factor: 0.8, note: 'x0.8 no CTA' });
  if (getR(checks.aboveFold) === false)      multipliers.push({ factor: 0.8, note: 'x0.8 poor above-the-fold clarity' });
  if (getR(checks.servicesListed) === false) multipliers.push({ factor: 0.75, note: 'x0.75 no service clarity' });
  if (checks._isSinglePage)                  multipliers.push({ factor: 0.7, note: 'x0.7 single-page site' });

  for (const { factor, note } of multipliers) {
    cappedTotal = cappedTotal * factor;
    capApplied = (capApplied ? capApplied + '; ' : '') + note;
  }

  cappedTotal = Math.round(cappedTotal * 10) / 10;

  return { scores, total: cappedTotal, rawTotal, capApplied, missingCritical: missing, lcCapNote };
}

// ═══════════════════════════════════════════════════════════════════════
// BUILD OUTPUT STRUCTURES
// ═══════════════════════════════════════════════════════════════════════

function buildCategories(scores) {
  const cats = {
    seoVisibility:  { label: 'SEO Visibility',    max: 20, keys: ['titleTag','headingKeywords','metaDescription','servicesListed','servicePageDepth','locationContent','internalLinks'] },
    localTrust:     { label: 'Local Trust',        max: 30, keys: ['reviewsVisible','googleSignals','proofOfWork','professionalSignals','riskReversal'] },
    leadConversion: { label: 'Lead Conversion',    max: 35, keys: ['cta','phone','contactForm','contactMethods','aboveFold','conversionPath'] },
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
  const issues = Object.entries(SCORE_TABLE)
    .filter(([key]) => getR(checks[key]) !== true)
    .map(([key]) => {
      const meta    = SCORE_TABLE[key];
      const result  = getR(checks[key]);
      const severity = result === false ? 'fail' : 'partial';

      const evidence = (checks[key] && typeof checks[key] === 'object') ? checks[key].evidence : null;
      const confidence = (checks[key] && typeof checks[key] === 'object') ? checks[key].confidence : 'High';
      const issueText = meta.issueFn ? meta.issueFn(result, evidence, confidence) : meta.issue;
      const fixText   = meta.fixFn   ? meta.fixFn(result, evidence, confidence)   : meta.fix;

      return {
        key,
        label:      meta.label,
        severity,
        issue:      issueText || meta.issue,
        fix:        fixText   || meta.fix,
        category:   meta.cat,
        maxPoints:  meta.max,
        evidence,
        confidence,
      };
    });

  if (checks._isSinglePage) {
    issues.push({
      key: 'limitedSiteStructure',
      label: 'Limited Site Structure',
      severity: 'fail',
      issue: 'This site appears to be a single-page website. This limits SEO potential and makes it harder to rank for multiple services or locations.',
      fix: 'Create dedicated pages for each service and key location to improve visibility and lead generation.',
      category: 'seoVisibility',
      maxPoints: 0,
      evidence: 'Only one unique internal page was crawled.',
      confidence: 'High',
    });
  }

  return issues.sort((a, b) => a.severity !== b.severity ? (a.severity === 'fail' ? -1 : 1) : b.maxPoints - a.maxPoints);
}

function buildRecommendations(checks) {
  const getR = v => (v && typeof v === 'object') ? v.result : v;
  const recommendations = Object.entries(SCORE_TABLE)
    .filter(([key]) => getR(checks[key]) !== true)
    .map(([key]) => {
      const meta = SCORE_TABLE[key];
      const result = getR(checks[key]);
      const evidence = (checks[key] && typeof checks[key] === 'object') ? checks[key].evidence : null;
      const confidence = (checks[key] && typeof checks[key] === 'object') ? checks[key].confidence : 'High';
      return {
        key,
        label:     meta.label,
        fix:       meta.fixFn ? meta.fixFn(result, evidence, confidence) : meta.fix,
        impact:    meta.impactFn ? meta.impactFn(result, evidence, confidence) : meta.impact,
        category:  meta.cat,
        maxPoints: meta.max,
      };
    });

  if (checks._isSinglePage) {
    recommendations.push({
      key: 'limitedSiteStructure',
      label: 'Limited Site Structure',
      fix: 'Create dedicated pages for each service and key location to improve visibility and lead generation.',
      impact: 'A single-page site has fewer ranking opportunities and gives visitors less proof that the business handles their specific service or location.',
      category: 'seoVisibility',
      maxPoints: 0,
    });
  }

  return recommendations.sort((a, b) => b.maxPoints - a.maxPoints);
}

function buildPositives(checks, methods, widgets) {
  const getR = v => (v && typeof v === 'object') ? v.result : v;
  const positives = [];
  const add = (condition, text) => {
    if (condition && !positives.includes(text)) positives.push(text);
  };

  add(getR(checks.reviewsVisible) !== false, 'Review or testimonial signals were found, which helps build trust with potential customers.');
  add(methods.phone || getR(checks.phone) === true, 'A visible phone number makes it easier for visitors to call.');
  add(methods.telLink, 'Click-to-call functionality is present, which improves mobile lead conversion.');
  add(getR(checks.cta) === true, 'A strong call-to-action was found, helping guide visitors toward booking or requesting a quote.');
  add(getR(checks.servicesListed) !== false, 'Core services are clearly mentioned on the website.');
  add(methods.form || methods.booking || widgets.hasChat || widgets.embeddedFormDetected, 'A form, booking tool, or chat option was found, giving visitors a clear way to take action.');
  add(getR(checks.https) === true, 'The site uses HTTPS, which helps create trust and security.');
  add(getR(checks.visualTrust) === true, 'The site has a clear, professional visual presentation that supports visitor trust.');
  add(getR(checks.proofOfWork) !== false, 'Project/gallery evidence was found, which helps visitors verify quality of work.');

  return positives.slice(0, 7);
}

// ═══════════════════════════════════════════════════════════════════════
// REVIEW EVIDENCE COLLECTOR
// ═══════════════════════════════════════════════════════════════════════
// REVIEW EVIDENCE COLLECTOR
// Runs after all pages are crawled. Produces a structured per-page
// reviewEvidence[] array and a simple boolean reviewFound flag.
// This is the single source of truth for "were reviews detected?"
// ═══════════════════════════════════════════════════════════════════════

function collectReviewEvidence(pages, allHtml, allText) {
  const reviewEvidence = [];

  // Per-page widget, keyword, and text pattern checks
  const REVIEW_WIDGET_RE = /elfsight|birdeye|podium|nicejob|trustindex|reviewtrackers|reputation\.com|yotpo|sociablekit|embedreviews|tagembed|widg\.io|grade\.us|reviews\.io/i;
  const REVIEW_IFRAME_RE = /review|google|elfsight|birdeye|podium|nicejob|trustindex|sociablekit|embedreviews|tagembed|reputation/i;
  const REVIEW_HEADING_RE = /reviews?|testimonials?|what\s+(?:our|clients?|customers?)\s+say|customer\s+(?:reviews?|feedback)|client\s+(?:reviews?|feedback)|happy\s+customers?|hear\s+from/i;
  const STAR_RE = /[★☆⭐\u2605\u2606\u2B50]{1,}|(?:rated?\s+)?[45][\d.]*\s*(?:out of\s*\d+\s*)?stars?|five.?star|5.?star\s+(?:rating|review)/i;
  const REVIEW_COUNT_RE = /(\d+\+?)\s+(?:verified\s+)?(?:customer\s+|google\s+)?reviews?/i;
  const QUOTED_REVIEW_RE = /"([^"]{20,150})"[\s\S]{0,100}[-\u2013\u2014]\s*([A-Z][a-z]{2,})/;
  const REVIEW_KW_RE = /\b(reviews?|testimonials?|customer reviews?|client reviews?|google reviews?|5.?star|five.?star|star rating|rated [45][\d.]|what our customers say|what clients say|customer feedback|client feedback|highly recommend|great service|excellent work|would recommend)\b/gi;

  for (const page of pages) {
    const pageText    = page.domData?.visibleText || normalizeText(page.html);
    const sig         = page.domData?.reviewSignals || {};
    const iframeSrcs  = (page.domData?.iframes || []).map(f => f.src);
    const scriptSrcs  = page.domData?.scripts || [];
    const classIds    = [...(page.html || '').matchAll(/(?:class|id)=["']([^"']+)["']/gi)].map(m => m[1]).join(' ');

    const matches   = [];
    const snippets  = [];

    // 1. Review widget in script/iframe src
    const widgetSrc = [...scriptSrcs, ...iframeSrcs].find(s => REVIEW_WIDGET_RE.test(s));
    if (widgetSrc) {
      matches.push(`review widget: ${widgetSrc.slice(0, 80)}`);
    }

    // 2. Review iframe (broader — includes generic "review" in src)
    const reviewIframe = iframeSrcs.find(s => REVIEW_IFRAME_RE.test(s));
    if (reviewIframe && !widgetSrc) {
      matches.push(`review iframe: ${reviewIframe.slice(0, 80)}`);
    }

    // 3. Review widget class/id in HTML
    if (/review-widget|reviews-widget|review[-_]?card|testimonial[-_]?widget|customer[-_]?review/i.test(classIds)) {
      const m = classIds.match(/review-widget|reviews-widget|review[-_]?card|testimonial[-_]?widget|customer[-_]?review/i);
      if (m) matches.push(`review element class: ${m[0]}`);
    }

    // 4. Playwright reviewSignals — widget class/ids detected in rendered DOM
    if (sig.reviewWidgetClasses?.length > 0) {
      matches.push(`rendered widget class: ${sig.reviewWidgetClasses[0].slice(0, 60)}`);
    }
    if (sig.reviewIframeSrcs?.length > 0) {
      matches.push(`rendered review iframe: ${sig.reviewIframeSrcs[0].slice(0, 60)}`);
    }
    if (sig.reviewScriptSrcs?.length > 0) {
      matches.push(`rendered review script: ${sig.reviewScriptSrcs[0].slice(0, 60)}`);
    }

    // 5. Review heading in rendered DOM or HTML
    const headingFromPW  = (sig.reviewHeadings || []).find(h => REVIEW_HEADING_RE.test(h));
    const htmlHeadings   = (page.html || '').match(/<h[1-4][^>]*>([\s\S]{0,120}?)<\/h[1-4]>/gi) || [];
    const headingFromHtml = htmlHeadings.map(h => normalizeText(h)).find(h => REVIEW_HEADING_RE.test(h));
    if (headingFromPW)   matches.push(`review heading (rendered): "${headingFromPW.slice(0, 60)}"`);
    else if (headingFromHtml) matches.push(`review heading (HTML): "${headingFromHtml.slice(0, 60)}"`);

    // 6. Star rating in text (allText now preserves ★)
    const starMatch = (pageText + ' ' + (sig.reviewKeywordsFound||[]).join(' ')).match(STAR_RE);
    if (starMatch) { matches.push(`star rating: "${starMatch[0].slice(0, 40)}"`); }

    // 7. Playwright star elements
    if (sig.starElements > 0) {
      matches.push(`star elements in DOM: ${sig.starElements}`);
    }

    // 8. Review count
    const countMatch = pageText.match(REVIEW_COUNT_RE);
    if (countMatch) matches.push(`review count: "${countMatch[0].slice(0, 40)}"`);

    // 9. Quoted testimonial with attribution
    const quoteMatch = (page.html || '').match(QUOTED_REVIEW_RE);
    if (quoteMatch) {
      matches.push(`quoted testimonial: "${quoteMatch[1].slice(0, 60)}…"`);
      snippets.push(`"${quoteMatch[1].slice(0, 80)}" — ${quoteMatch[2]}`);
    }

    // 10. Playwright quoted reviews and praise
    if (sig.visibleQuotes?.length > 0) {
      matches.push(`visible quotes (rendered): ${sig.visibleQuotes.length}`);
      snippets.push(...sig.visibleQuotes.slice(0, 2).map(q => q.slice(0, 80)));
    }
    if (sig.praiseMatches?.length >= 2) {
      matches.push(`praise phrases: ${sig.praiseMatches.slice(0, 3).join(', ')}`);
    }

    // 11. Keyword matches from visible text
    const kwMatches = [...new Set((pageText.match(REVIEW_KW_RE) || []).map(k => k.toLowerCase()))].slice(0, 6);
    if (kwMatches.length >= 2) {
      matches.push(`review keywords (${kwMatches.length}): ${kwMatches.join(', ')}`);
    } else if (kwMatches.length === 1 && !matches.length) {
      matches.push(`review keyword: "${kwMatches[0]}"`);
    }

    // 12. Review links
    if (sig.reviewLinks?.length > 0) {
      matches.push(`review links: ${sig.reviewLinks.slice(0, 3).join(', ')}`);
    }

    if (!matches.length) continue;  // nothing found on this page

    // Determine confidence for this page
    const hasWidget   = matches.some(m => /widget|iframe|script|class/.test(m));
    const hasStrong   = matches.some(m => /star rating|review count|quoted|star elements/.test(m));
    const hasMedium   = matches.some(m => /heading|keyword|praise|link/.test(m));
    const confidence  = hasWidget || hasStrong ? 'High' : hasMedium ? 'Medium' : 'Low';

    let path;
    try { path = new URL(page.url).pathname || '/'; } catch { path = page.url; }

    reviewEvidence.push({
      pageUrl:    page.url,
      pagePath:   path,
      pageType:   page.type,
      sourceType: hasWidget ? 'widget' : hasStrong ? 'content' : 'keyword',
      matches:    matches.slice(0, 8),
      snippets:   snippets.slice(0, 3),
      confidence,
    });
  }

  return reviewEvidence;
}



function buildEvidenceFound(pages, methods, widgets, checks) {
  const getR   = v => (v && typeof v === 'object') ? v.result   : v;
  const getEv  = v => (v && typeof v === 'object') ? v.evidence  : null;
  const getC   = v => (v && typeof v === 'object') ? v.confidence : 'High';
  const status = v => getR(v) === true ? 'yes' : getR(v) === false ? 'no' : 'partial';

  const pagesScanned = pages.map(p => {
    let path; try { path = new URL(p.url).pathname || '/'; } catch { path = p.url; }
    return { path, url: p.url, type: p.type, source: p.source || 'unknown', rendered: !!p.domData };
  });

  const locationEvidence = getEv(checks.locationContent) || getEv(checks.googleSignals);
  const addressOrLocationDetected = methods.address || getR(checks.locationContent) !== false || /address|map|schema|location/i.test(locationEvidence || '');
  const addressOrLocationValue = methods.addressValue || locationEvidence || null;
  const contactTotal = methods.count + (addressOrLocationDetected && !methods.address ? 1 : 0);

  return {
    pagesScanned,
    scanMethod: pages[0]?.domData ? 'playwright' : 'http-fallback',
    contactMethodsDetected: {
      phone:   { detected: methods.phone,   clickable: methods.telLink, value: methods.firstTelLink || null },
      email:   { detected: methods.email,   value: methods.firstEmail  || null },
      form:    { detected: methods.form   },
      chat:    { detected: methods.chat,    vendor: widgets.hasTawk ? 'Tawk' : widgets.hasIntercom ? 'Intercom' : widgets.hasDrift ? 'Drift' : widgets.hasCrisp ? 'Crisp' : widgets.hasChat ? 'unknown' : null },
      booking: { detected: methods.booking, vendor: widgets.hasCalendly ? 'Calendly' : widgets.hasAcuity ? 'Acuity' : widgets.isGHL ? 'GHL' : null },
      address: { detected: addressOrLocationDetected, value: addressOrLocationValue },
      total:   contactTotal,
    },
    formsDetected:        getEv(checks.contactForm)  || (methods.form ? 'Form detected' : 'No form found'),
    chatWidgetsDetected:  widgets.isGHL ? 'GoHighLevel' : widgets.hasTawk ? 'Tawk.to' : widgets.hasIntercom ? 'Intercom' : widgets.hasDrift ? 'Drift' : widgets.hasCrisp ? 'Crisp' : widgets.hasChat ? 'Chat widget' : 'None',
    reviewsDetected:      getEv(checks.reviewsVisible) || 'None',
    reviewEvidence:       getEv(checks.reviewsVisible) || 'No review evidence found',
    reviewConfidence:     getC(checks.reviewsVisible),
    reviewStrength:       (() => {
      const r = getR(checks.reviewsVisible);
      if (r === true)                                               return 'strong';
      if (r === false)                                              return 'none';
      if (typeof r === 'string' && r.startsWith('partial:0.25'))   return 'weak';
      return 'partial';
    })(),
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

  // ── Detailed review evidence logging ──────────────────────────────
  const pwReviewSigs = pages.flatMap(p => p.domData?.reviewSignals ? [p.domData.reviewSignals] : []);
  const reviewKeywordsAll = pwReviewSigs.flatMap(s => s.reviewKeywordsFound || []);
  const reviewWidgetsAll  = pwReviewSigs.flatMap(s => [...(s.reviewIframeSrcs||[]), ...(s.reviewScriptSrcs||[])]);
  const reviewQuotesAll   = pwReviewSigs.flatMap(s => s.visibleQuotes || []);
  const reviewPraiseAll   = pwReviewSigs.flatMap(s => s.praiseMatches || []);
  const reviewHeadingsAll = pwReviewSigs.flatMap(s => s.reviewHeadings || []);
  const reviewClassesAll  = pwReviewSigs.flatMap(s => s.reviewWidgetClasses || []);
  const reviewLinksAll    = pwReviewSigs.flatMap(s => s.reviewLinks || []);
  const reviewAltsAll     = pwReviewSigs.flatMap(s => s.reviewImageAlts || []);
  const reviewStarEls     = pwReviewSigs.reduce((n, s) => n + (s.starElements || 0), 0);
  const hasStarHtml       = !!(allHtml.match(/[\u2605\u2606\u2B50]{2,}/u) || allHtml.match(/\d[\d.]*\s*stars?/i) || allText.match(/five.?star|5.?star/i));
  const hasCountHtml      = !!allText.match(/\d{2,}\s+reviews?/i);
  const hasTestimonialKw  = /\btestimonials?\b/i.test(allText);
  console.log('  Reviews (per source):');
  console.log(`    Keywords found     : ${reviewKeywordsAll.length ? reviewKeywordsAll.slice(0,6).join(', ') : 'none'}`);
  console.log(`    Review widgets     : ${reviewWidgetsAll.length ? reviewWidgetsAll.slice(0,3).join(', ') : 'none'}`);
  console.log(`    Widget class/ids   : ${reviewClassesAll.length ? reviewClassesAll.slice(0,3).join(', ') : 'none'}`);
  console.log(`    Quoted reviews     : ${reviewQuotesAll.length ? reviewQuotesAll.slice(0,2).map(q=>q.slice(0,50)).join(' | ') : 'none'}`);
  console.log(`    Praise phrases     : ${reviewPraiseAll.length ? reviewPraiseAll.slice(0,3).join(', ') : 'none'}`);
  console.log(`    Review headings    : ${reviewHeadingsAll.length ? reviewHeadingsAll.slice(0,2).join(', ') : 'none'}`);
  console.log(`    Review links/btns  : ${reviewLinksAll.length ? reviewLinksAll.slice(0,3).join(', ') : 'none'}`);
  console.log(`    Review image alts  : ${reviewAltsAll.length ? reviewAltsAll.join(', ') : 'none'}`);
  console.log(`    Star elements (PW) : ${reviewStarEls}`);
  console.log(`    Star rating (HTML) : ${hasStarHtml}`);
  console.log(`    Review count (HTML): ${hasCountHtml}`);
  console.log(`    Testimonial keyword: ${hasTestimonialKw}`);
  console.log(`  CTA phrases   : ${(homeDom?.ctaFound||[]).slice(0,3).join(', ') || 'NONE (Playwright)'}`);
  console.log(`  Service terms : ${SERVICE_TERMS.filter(t=>allText.includes(t)).slice(0,5).join(', ') || 'NONE'}`);
  console.log(`  HTTPS         : ${startUrl.startsWith('https://')}`);

  // ── Single-page detection ────────────────────────────────────────
  const uniqueCrawledPageCount = new Set(pages.map(p => urlKey(p.url))).size;
  const isSinglePage = uniqueCrawledPageCount <= 1;

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
  const industry = detectIndustry(allText);
  const visualTrust = analyzeVisualTrust(pages);

  const checks = {
    titleTag:            checkTitleTag(homepageHtml, pages),
    headingKeywords:     checkHeadingKeywords(homepageHtml, homepageText, pages),
    metaDescription:     checkMetaDescription(homepageHtml, pages),
    servicesListed:      detectServices(allHtml, allText, industry),
    servicePageDepth:    checkServicePageDepth(pages, allHtml, industry),
    locationContent:     detectLocalSEO(allText, pages),
    internalLinks:       checkInternalLinks(pages, allHtml),
    reviewsVisible:      detectTrustSignals(allHtml, allText, pages),
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
    visualTrust:         ev(visualTrust.result, visualTrust.evidence, 'Medium'),
    _isSinglePage:       isSinglePage,   // consumed by calculateScore, stripped before response
  };

  const getEv = v => (v && typeof v === 'object') ? v.evidence : '—';
  const getR  = v => (v && typeof v === 'object') ? v.result   : v;

  // ── Collect structured per-page review evidence ──────────────────
  // Run AFTER checks so detectTrustSignals has already run.
  // reviewEvidence is the single source of truth for "reviews found?".
  // If reviewEvidence.length > 0, reviews ARE detected regardless of scoring tier.
  const reviewEvidence = collectReviewEvidence(pages, allHtml, allText);
  const reviewFound    = reviewEvidence.length > 0;

  // If reviewEvidence found something but detectTrustSignals returned false,
  // override checks.reviewsVisible to at least 'partial' so the report is consistent.
  if (reviewFound && getR(checks.reviewsVisible) === false) {
    const bestPage    = reviewEvidence[0];
    const bestMatches = bestPage.matches.join('; ');
    checks.reviewsVisible = ev(
      'partial:0.4',
      `Review evidence found on ${bestPage.pagePath}: ${bestMatches}`,
      bestPage.confidence
    );
  }

  // ── LAYER 3: Score + build report ───────────────────────────────
  const { scores, total, rawTotal, capApplied, missingCritical, lcCapNote } = calculateScore(checks);
  const categories = buildCategories(scores);
  scores.visualTrust = visualTrust.score;
  categories.visualTrust = {
    label: 'Visual Trust & Design Quality',
    score: visualTrust.score,
    max: visualTrust.max,
    factorType: visualTrust.factorType,
  };
  const pageSpeed = buildPageSpeedEvidence(psData);
  const psScore    = pageSpeed.score == null ? null : pageSpeed.score / 100;

  // Log final score — now includes all new detection fields
  // Derive summary booleans for the log
  const formOrBookingFound = methods.form || methods.booking || widgets.embeddedFormDetected;
  const embeddedFormDetected = widgets.embeddedFormDetected;
  const bookingDetected    = methods.booking || widgets.hasBooking || widgets.embeddedFormDetected;
  const chatDetected       = widgets.hasChat;
  const reviewStrength     = getR(checks.reviewsVisible) === true    ? 'strong'
                           : getR(checks.reviewsVisible) === false   ? 'none'
                           : (checks.reviewsVisible?.result || '').startsWith('partial:0.25') ? 'weak'
                           : 'partial';

  // ── Build reviewDebug — full audit trail ──────────────────────────
  const reviewDebug = {
    finalReviewsDetected:  reviewFound,
    finalReviewResult:     getR(checks.reviewsVisible),
    finalReviewConfidence: checks.reviewsVisible?.confidence || 'High',
    finalReviewStrength:   reviewStrength,
    finalReviewEvidence:   getEv(checks.reviewsVisible),
    reviewEvidenceByPage:  reviewEvidence,
    // Per-source signals
    visibleTextMatches:    reviewKeywordsAll.slice(0, 10),
    headingMatches:        reviewHeadingsAll.slice(0, 5),
    iframeMatches:         pages.flatMap(p => (p.domData?.iframes||[]).map(f=>f.src)).filter(s => /review|elfsight|birdeye|podium|nicejob|trustindex|sociablekit|embedreviews|tagembed/i.test(s)).slice(0, 5),
    scriptMatches:         pages.flatMap(p => (p.domData?.scripts||[])).filter(s => /review|elfsight|birdeye|podium|nicejob|trustindex|sociablekit/i.test(s)).slice(0, 5),
    classIdMatches:        reviewClassesAll.slice(0, 5),
    possibleReviewSnippets: reviewQuotesAll.slice(0, 5),
    starElementsFound:     reviewStarEls,
    praisePhrasesFound:    reviewPraiseAll.slice(0, 5),
    reviewLinksFound:      reviewLinksAll.slice(0, 5),
  };

  console.log('\n[LeadCheck] REVIEW DEBUG:', JSON.stringify(reviewDebug, null, 2));

  console.log('\n[LeadCheck] Final score:');
  for (const [, cat] of Object.entries(categories)) {
    const bar = '█'.repeat(Math.round(cat.score / cat.max * 10)).padEnd(10, '░');
    console.log(`  ${(cat.label + '              ').slice(0, 22)} ${bar} ${cat.score}/${cat.max}`);
  }
  console.log(`  ${'TOTAL'.padEnd(22)} ${total}/100 (raw: ${rawTotal})`);
  if (capApplied) console.log(`  ⚠  Cap applied: ${capApplied}`);
  console.log('');
  console.log('[LeadCheck] Detection summary:');
  console.log(`  formOrBookingFound    : ${formOrBookingFound}`);
  console.log(`  embeddedFormDetected  : ${embeddedFormDetected}${embeddedFormDetected ? ' — ' + widgets.embeddedFormEvidence : ''}`);
  console.log(`  bookingDetected       : ${bookingDetected}`);
  console.log(`  chatDetected          : ${chatDetected}`);
  // Review detail
  const reviewEv = getEv(checks.reviewsVisible);
  console.log(`  reviewStrength        : ${reviewStrength}`);
  console.log(`  reviewEvidence        : ${reviewEv ? reviewEv.slice(0, 120) : 'none'}`);
  console.log(`  missingCoreCount      : ${missingCritical}`);
  if (capApplied) console.log(`  capsApplied           : ${capApplied}`);
  console.log(`  finalCappedScore      : ${total}/100\n`);

  const evidenceFound = buildEvidenceFound(pages, methods, widgets, checks);
  evidenceFound.visualTrust = visualTrust;
  evidenceFound.checkEvidence = evidenceFound.checkEvidence || {};
  evidenceFound.checkEvidence.visualTrust = {
    status: visualTrust.result === true ? 'yes' : visualTrust.result === false ? 'no' : 'partial',
    evidence: visualTrust.message,
    confidence: 'Medium',
  };
  const positives = buildPositives(checks, methods, widgets);
  const issues = [
    ...buildIssues(checks),
    ...buildVisualTrustIssues(visualTrust),
  ];
  const recommendations = [
    ...buildRecommendations(checks),
    ...buildVisualTrustRecommendations(visualTrust),
  ];

  // publicChecks: strip internal _ keys AND unwrap ev() objects to raw result values.
  // The frontend uses `v === true` to detect passed checks — it cannot handle ev() objects.
  const getResultValue = v => (v && typeof v === 'object' && 'result' in v) ? v.result : v;
  const publicChecks = Object.fromEntries(
    Object.entries(checks)
      .filter(([k]) => !k.startsWith('_'))
      .map(([k, v]) => [k, getResultValue(v)])
  );

  // pagesList alias: frontend renderEvidence() reads ev.pagesList but backend returns pagesScanned.
  // Add both keys so old and new frontend code both work.
  if (evidenceFound && !evidenceFound.pagesList) {
    evidenceFound.pagesList = evidenceFound.pagesScanned || [];
  }

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
    industry,
    positives,
    checks:          publicChecks,
    scores,
    pageSpeedScore:  pageSpeed.score,
    pageSpeed,
    visualTrust,
    categories,
    issues,
    recommendations,
    criticalFlags:   buildCriticalFlags(checks, psData),
    evidenceFound,
    evidence:        evidenceFound,
    reviewEvidence,              // structured per-page review evidence (new — additive)
    reviewFound,                 // simple boolean: were reviews detected on any page?
    reviewDebug,
    // New detection fields (additive — does not break existing frontend)
    detectionSummary: {
      embeddedFormDetected: widgets.embeddedFormDetected,
      embeddedFormEvidence: widgets.embeddedFormEvidence,
      bookingDetected:      methods.booking || widgets.hasBooking || widgets.embeddedFormDetected,
      formOrBookingFound:   methods.form || methods.booking || widgets.embeddedFormDetected,
      chatDetected:         widgets.hasChat,
      reviewStrength:       reviewStrength,
      missingCoreCount:     missingCritical,
    },
    disclaimer:      'This score is based on automated checks of visible website elements and is designed to highlight likely opportunities to improve contractor lead generation. It is not a replacement for a full manual audit.',
  };

  if (debugMode) {
    // ── RAW PLAYWRIGHT EVIDENCE DUMP — one entry per scanned page ──────
    // This is unsummarised. Every field is exactly what Playwright returned.
    // Use this to diagnose whether reviews are visible, in iframes, images, etc.
    const REVIEW_SNIP_RE = /\b(review|reviews|testimonial|testimonials|star|rated|recommend|google|client|customer)\b/gi;
    const REVIEW_CLASS_RE = /review|testimonial|star|google|elfsight|trustindex|birdeye|podium|nicejob/i;

    const rawPageDumps = pages.map(p => {
      const d   = p.domData || {};
      const vt  = d.visibleText || '';

      // All snippets around any review-related word (±80 chars context)
      const snippets = [];
      let sm;
      const vtl = vt.toLowerCase();
      const snipRe = new RegExp(REVIEW_SNIP_RE.source, 'gi');
      snipRe.lastIndex = 0;
      while ((sm = snipRe.exec(vtl)) !== null && snippets.length < 20) {
        const s = Math.max(0, sm.index - 80);
        const e = Math.min(vtl.length, sm.index + 120);
        snippets.push(vt.slice(s, e).replace(/\s+/g, ' ').trim());
        snipRe.lastIndex = sm.index + sm[0].length;
      }

      // All class and id values from raw HTML that match review keywords
      const reviewClassIds = [];
      const ciRe = /(?:class|id)=["']([^"']+)["']/gi;
      let cm;
      while ((cm = ciRe.exec(p.html || '')) !== null) {
        if (REVIEW_CLASS_RE.test(cm[1])) reviewClassIds.push(cm[1]);
      }

      let path;
      try { path = new URL(p.url).pathname || '/'; } catch { path = p.url; }

      return {
        pageUrl:       p.url,
        pagePath:      path,
        pageType:      p.type,
        // 1. Full visible text (unsummarised)
        fullVisibleText: vt,
        visibleTextLength: vt.length,
        // 2. All headings
        allHeadings:   (d.headings || []).map(h => `[${h.tag}] ${h.text}`),
        // 3. All button text + all link text
        allButtons:    d.buttons || [],
        allLinkTexts:  (d.links || []).map(l => l.text).filter(Boolean),
        // 4. All iframe src values (every single one — not filtered)
        allIframeSrcs: (d.iframes || []).map(f => ({ src: f.src, title: f.title })),
        // 5. All script src values (every single one — not filtered)
        allScriptSrcs: d.scripts || [],
        // 6. Class/id names containing review-related keywords
        reviewClassIds,
        // 7. All image alt text
        allImageAlts:  Array.isArray(d.images)
          ? d.images.map(i => i.alt).filter(Boolean)
          : (d.reviewSignals?.reviewImageAlts || []),
        // 8. Snippets around review-related words in visible text
        reviewSnippets: snippets,
        // 9. What reviewSignals extracted (Playwright-side)
        reviewSignals: d.reviewSignals || {},
      };
    });

    console.log('\n[LeadCheck] RAW REVIEW DEBUG', JSON.stringify(rawPageDumps, null, 2));

    response._debug = {
      rawPageDumps,                   // ← the full unsummarised per-page dump
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
  detectIndustry,
  detectServices,
  detectTrustSignals,
  detectLocalSEO,
  calculateScore,
};
