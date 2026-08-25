(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PitchProofWebsitePrompt = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const NOT_PROVIDED = 'Not Provided';

  function isRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
  }

  function asRecord(value) {
    return isRecord(value) ? value : {};
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function cleanText(value) {
    if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
    if (value == null) return '';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    if (Array.isArray(value)) return value.map(cleanText).filter(Boolean).join(', ');
    if (isRecord(value)) {
      const preferred = [
        value.label,
        value.title,
        value.issue,
        value.description,
        value.detail,
        value.fix,
        value.recommendation,
        value.impact,
        value.evidence,
        value.snippet,
        value.message,
      ].map(cleanText).filter(Boolean);
      if (preferred.length) return preferred.join(' - ');
      return Object.entries(value)
        .filter(([, child]) => child !== null && child !== undefined && child !== false && child !== '')
        .map(([key, child]) => `${humanizeKey(key)}: ${cleanText(child)}`)
        .filter(Boolean)
        .join(', ');
    }
    return String(value || '').trim();
  }

  function humanizeKey(key = '') {
    return String(key || '')
      .replace(/[_-]+/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, char => char.toUpperCase());
  }

  function valueOrNotProvided(value) {
    const text = cleanText(value);
    return text || NOT_PROVIDED;
  }

  function firstText(...values) {
    for (const value of values) {
      const text = cleanText(value);
      if (text) return text;
    }
    return '';
  }

  function uniqueList(values = [], limit = 12) {
    const seen = new Set();
    const list = [];
    asArray(values).forEach(value => {
      const text = cleanText(value);
      if (!text) return;
      const normalized = text.toLowerCase();
      if (seen.has(normalized)) return;
      seen.add(normalized);
      list.push(text);
    });
    return list.slice(0, limit);
  }

  function bulletList(values = [], emptyText = NOT_PROVIDED) {
    const list = uniqueList(values, 18);
    if (!list.length) return `- ${emptyText}`;
    return list.map(item => `- ${item}`).join('\n');
  }

  function numberedList(values = [], emptyText = NOT_PROVIDED) {
    const list = uniqueList(values, 12);
    if (!list.length) return `1. ${emptyText}`;
    return list.map((item, index) => `${index + 1}. ${item}`).join('\n');
  }

  function hostnameFromUrl(value) {
    const raw = cleanText(value);
    if (!raw) return '';
    try {
      const normalized = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      return new URL(normalized).hostname.replace(/^www\./i, '');
    } catch {
      return raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0] || '';
    }
  }

  function businessNameFromDomain(value) {
    const host = hostnameFromUrl(value);
    if (!host) return '';
    return host
      .split('.')
      .filter(Boolean)
      .slice(0, 2)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1).replace(/[-_]+/g, ' '))
      .join(' ');
  }

  function scoreText(score, max) {
    const numericScore = Number(score);
    const numericMax = Number(max) || 100;
    if (!Number.isFinite(numericScore)) return NOT_PROVIDED;
    return `${Math.round(numericScore * 10) / 10} / ${numericMax}`;
  }

  function categoryType(text = '') {
    const normalized = cleanText(text).toLowerCase();
    if (/seo|search|visibility|keyword|metadata|meta description|title tag|heading|crawl|index|local/.test(normalized)) return 'seo';
    if (/trust|credib|review|testimonial|proof|guarantee|certif|license|award|gallery|photo|project|social proof/.test(normalized)) return 'trust';
    if (/conversion|cta|call|phone|form|booking|lead|quote|estimate|above fold|next step|contact/.test(normalized)) return 'conversion';
    if (/technical|speed|performance|mobile|responsive|broken|link|https|sitemap|robots|accessibility|layout shift/.test(normalized)) return 'technical';
    if (/visual|design|hierarchy|spacing|typography|imagery|navigation|layout|brand|color/.test(normalized)) return 'design';
    return 'general';
  }

  function issuePriorityText(item, fallbackIndex = 0) {
    const raw = asRecord(item);
    const explicit = cleanText(raw.priority || raw.severity || raw.impactLevel || raw.impact_level).toLowerCase();
    if (explicit.includes('high')) return 'High';
    if (explicit.includes('low')) return 'Low';
    if (explicit.includes('medium') || explicit.includes('moderate')) return 'Medium';
    return fallbackIndex === 0 ? 'High' : fallbackIndex < 3 ? 'Medium' : 'Low';
  }

  function itemTitle(item, fallback = 'Audit finding') {
    const raw = asRecord(item);
    return firstText(raw.label, raw.title, raw.key, raw.issue, raw.description, item) || fallback;
  }

  function itemDetail(item) {
    const raw = asRecord(item);
    const detail = firstText(raw.detail, raw.description, raw.evidence, raw.fix, raw.recommendation, raw.impact);
    const title = itemTitle(item);
    if (!detail || detail === title) return title;
    return `${title}: ${detail}`;
  }

  function normalizeCategories(report = {}) {
    const rows = [];
    Object.entries(asRecord(report.categories)).forEach(([key, value]) => {
      const cat = asRecord(value);
      const label = firstText(cat.label, humanizeKey(key));
      const score = Number(cat.score);
      const max = Number(cat.max) || 100;
      if (!label) return;
      rows.push({
        key,
        label,
        type: categoryType(`${key} ${label}`),
        score: Number.isFinite(score) ? score : null,
        max,
      });
    });
    return rows;
  }

  function categoryScore(categories, type, fallback = {}) {
    const row = categories.find(item => item.type === type);
    if (row) return scoreText(row.score, row.max);
    if (type === 'design') {
      const visual = asRecord(fallback.visualTrust);
      if (visual.score !== undefined) return scoreText(visual.score, visual.max || 15);
    }
    return NOT_PROVIDED;
  }

  function evidenceText(report = {}, key = '') {
    const evidence = asRecord(report.evidenceFound || report.evidence);
    return cleanText(evidence[key]);
  }

  function contactMethods(report = {}) {
    const evidence = asRecord(report.evidenceFound || report.evidence);
    const contact = asRecord(evidence.contactMethodsDetected);
    const phone = asRecord(contact.phone);
    const email = asRecord(contact.email);
    const address = asRecord(contact.address);
    return {
      phone: phone.detected ? firstText(phone.value, 'Detected on website') : '',
      email: email.detected ? firstText(email.value, 'Detected on website') : '',
      address: address.detected ? firstText(address.value, 'Detected on website') : '',
    };
  }

  function quotedPhrases(text = '') {
    const phrases = [];
    const source = cleanText(text);
    source.replace(/"([^"]{3,90})"/g, (_, phrase) => {
      phrases.push(phrase);
      return '';
    });
    return uniqueList(phrases, 12);
  }

  function detectedServices(report = {}) {
    const servicesEvidence = evidenceText(report, 'servicesDetected') || cleanText(asRecord(asRecord(report.evidenceFound || report.evidence).seoEvidence).servicesListed);
    const phrases = quotedPhrases(servicesEvidence)
      .filter(item => !/service|page|section|found|listed|detected|none/i.test(item) || item.split(/\s+/).length <= 5);
    return uniqueList(phrases, 12);
  }

  function detectedServiceAreas(report = {}) {
    const evidence = asRecord(report.evidenceFound || report.evidence);
    const seoEvidence = asRecord(evidence.seoEvidence);
    const locationEvidence = firstText(seoEvidence.locationContent, asRecord(evidence.contactMethodsDetected).address?.value);
    return uniqueList(quotedPhrases(locationEvidence), 10);
  }

  function collectAuditItems(report = {}) {
    const critical = asArray(report.criticalFlags).map((item, index) => ({
      source: 'critical',
      priority: issuePriorityText(item, index),
      text: itemDetail(item),
      type: categoryType(`${itemTitle(item)} ${itemDetail(item)}`),
    }));
    const issues = asArray(report.issues).map((item, index) => ({
      source: 'issue',
      priority: issuePriorityText(item, index + critical.length),
      text: itemDetail(item),
      type: categoryType(`${itemTitle(item)} ${itemDetail(item)}`),
    }));
    const recommendations = asArray(report.recommendations).map((item, index) => ({
      source: 'recommendation',
      priority: issuePriorityText(item, index),
      text: itemDetail(item),
      type: categoryType(`${itemTitle(item)} ${itemDetail(item)}`),
    }));
    const checkEvidence = Object.entries(asRecord(asRecord(report.evidenceFound || report.evidence).checkEvidence))
      .map(([key, value]) => {
        const check = asRecord(value);
        const status = cleanText(check.status).toLowerCase();
        const evidence = firstText(check.evidence, value);
        return {
          source: status === 'yes' ? 'passed-check' : 'check',
          priority: status === 'no' ? 'High' : 'Medium',
          text: `${humanizeKey(key)}: ${evidence}`,
          status,
          type: categoryType(`${key} ${evidence}`),
        };
      })
      .filter(item => item.text && !/no evidence found$/i.test(item.text));

    return {
      critical,
      issues,
      recommendations,
      checks: checkEvidence,
      all: [...critical, ...issues, ...recommendations, ...checkEvidence],
    };
  }

  function categoryFindings(items, type, limit = 7) {
    return uniqueList(items.all
      .filter(item => item.type === type && item.source !== 'passed-check')
      .map(item => item.text), limit);
  }

  function categoryOpportunities(items, type, limit = 6) {
    return uniqueList(items.recommendations
      .filter(item => item.type === type || type === 'general')
      .map(item => item.text), limit);
  }

  function buildActionBuckets(report = {}, items = collectAuditItems(report)) {
    const positives = uniqueList([
      ...asArray(report.positives).map(cleanText),
      ...items.checks.filter(item => item.source === 'passed-check').map(item => item.text),
    ], 8);

    const prioritySource = uniqueList([
      ...items.critical.map(item => item.text),
      ...items.issues.filter(item => item.priority === 'High').map(item => item.text),
      ...items.recommendations.filter(item => item.priority === 'High').map(item => item.text),
      ...items.issues.map(item => item.text),
      ...items.recommendations.map(item => item.text),
    ], 12);

    const addItems = uniqueList([
      ...items.all
        .filter(item => /\b(no|missing|not detected|none|without|lacks|weak)\b/i.test(item.text))
        .map(item => item.text),
      ...items.recommendations
        .filter(item => /\b(add|include|create|place|show|build|write|embed|link)\b/i.test(item.text))
        .map(item => item.text),
    ], 10);

    const removeItems = uniqueList(items.all
      .filter(item => /\b(remove|avoid|confus|clutter|friction|broken|dead end|distract|unclear|slow|thin|duplicate)\b/i.test(item.text))
      .map(item => item.text), 8);

    return {
      keep: positives.length ? positives : ['Preserve any accurate business information, real contact details, real services, real locations, and real proof that already appear on the existing website.'],
      fix: prioritySource,
      add: addItems,
      remove: removeItems.length ? removeItems : ['Do not remove anything purely for style. Remove or simplify only elements that create confusion, unnecessary friction, clutter, weak SEO, broken paths, or poor conversion during the rebuild.'],
      priority: prioritySource.slice(0, 8),
    };
  }

  function strongestAreas(categories = []) {
    return uniqueList(categories
      .filter(category => Number.isFinite(Number(category.score)) && Number(category.max) && (Number(category.score) / Number(category.max)) >= 0.75)
      .sort((a, b) => (Number(b.score) / Number(b.max)) - (Number(a.score) / Number(a.max)))
      .map(category => `${category.label}: ${scoreText(category.score, category.max)}`), 5);
  }

  function weakestAreas(categories = []) {
    return uniqueList(categories
      .filter(category => Number.isFinite(Number(category.score)) && Number(category.max))
      .sort((a, b) => (Number(a.score) / Number(a.max)) - (Number(b.score) / Number(b.max)))
      .slice(0, 4)
      .map(category => `${category.label}: ${scoreText(category.score, category.max)}`), 5);
  }

  function buildBusinessInputs(report = {}, context = {}) {
    const website = firstText(report.url, report.websiteUrl, report.website, context.requestedWebsite);
    const contact = contactMethods(report);
    const companyName = firstText(context.companyName, report.businessName, report.business_name, report.websiteName, businessNameFromDomain(website));
    const evidence = asRecord(report.evidenceFound || report.evidence);
    const seoEvidence = asRecord(evidence.seoEvidence);
    const services = detectedServices(report);
    const serviceAreas = detectedServiceAreas(report);
    const primaryLocation = firstText(contact.address, seoEvidence.locationContent);

    return {
      businessName: companyName,
      industry: firstText(report.industry, context.industry),
      primaryService: firstText(context.primaryService, services[0]),
      description: firstText(context.notes, report.businessDescription, report.description),
      targetCustomer: NOT_PROVIDED,
      primaryGoal: 'Generate more qualified calls, quote requests, and trust from local website visitors.',
      googleBusinessProfileUrl: NOT_PROVIDED,
      contactPerson: firstText(context.prospectName),
      phone: contact.phone,
      email: contact.email,
      address: contact.address,
      city: NOT_PROVIDED,
      stateProvince: NOT_PROVIDED,
      postalCode: NOT_PROVIDED,
      domain: hostnameFromUrl(website),
      website,
      socials: [],
      brandColors: [],
      logoStatus: NOT_PROVIDED,
      faviconStatus: NOT_PROVIDED,
      preferredStyle: NOT_PROVIDED,
      services,
      serviceAreas,
      seoKeywords: uniqueList([
        ...quotedPhrases(firstText(seoEvidence.headings, seoEvidence.titleTag, seoEvidence.servicesListed)),
        ...asArray(asRecord(report.keywordRanking).keywords).map(cleanText),
      ], 12),
      reviewsDetected: firstText(evidence.reviewsDetected, evidence.reviewEvidence, report.reviewFound === true ? 'Detected' : ''),
      photosDetected: firstText(asRecord(report.visualTrust).photoEvidence, asRecord(report.visualTrust).message),
      existingCta: firstText(evidence.ctasDetected),
      servicesEvidence: firstText(evidence.servicesDetected, seoEvidence.servicesListed),
      locationEvidence: firstText(seoEvidence.locationContent, primaryLocation),
    };
  }

  function dataLine(label, value) {
    return `- ${label}: ${valueOrNotProvided(value)}`;
  }

  function generateWebsiteBuildPrompt(input = {}) {
    const report = asRecord(input.report || input);
    const context = asRecord(input.context);
    const business = buildBusinessInputs(report, context);
    const categories = normalizeCategories(report);
    const items = collectAuditItems(report);
    const actions = buildActionBuckets(report, items);
    const overallScore = scoreText(
      report.total ?? report.score ?? report.websiteScore ?? report.rating,
      report.maxScore || 100
    );

    const seoFindings = categoryFindings(items, 'seo');
    const trustFindings = categoryFindings(items, 'trust');
    const conversionFindings = categoryFindings(items, 'conversion');
    const technicalFindings = categoryFindings(items, 'technical');
    const designFindings = categoryFindings(items, 'design');

    const prompt = `# Website Rebuild Brief Based on a PitchProof Audit

Use this as the source brief for rebuilding the website for ${valueOrNotProvided(business.businessName)}.

This prompt was generated from the PitchProof audit for ${valueOrNotProvided(business.website)}. Use the audit findings below to create a substantially better website. Do not run a new audit unless the user asks you to.

## Role and Mission

Act as a senior web developer, technical SEO consultant, local SEO strategist, and conversion rate optimization specialist.

Create a premium, production-ready, conversion-focused, local SEO-friendly, mobile-first website that is fast, crawlable, trustworthy, and built to generate qualified leads.

Every major decision should improve at least one of:

- Clarity
- Trust
- Speed
- Crawlability
- Local SEO authority
- Lead conversions
- Phone calls
- Quote requests

The website should function as a revenue-producing asset, not merely a brochure.

## Verify Before Building

Some business information was automatically extracted from the existing website. Treat it as a strong starting point, but it may be incomplete or outdated.

Do not ask the user to reconfirm information that is already clear and consistent.

Only ask questions if important information is missing, uncertain, or conflicting.

If necessary, ask:

1. Is the business name, phone number, email, primary location, and service area information provided above correct?
2. Which service should be treated as the highest-priority or primary service?
3. Is there anything currently shown on the existing website, such as a service, location, offer, or business detail, that should not be carried into the new website?
4. Is there anything important about the business, offer, target customer, branding, or positioning that is missing?

If this information is already clear, do not ask these questions again. Proceed with the website planning and build process.

## Accuracy Rules

Never invent factual business information.

Do not invent:

- Business name
- Owner name
- Phone number
- Email
- Address
- Locations served
- Years of experience
- Project count
- Customer count
- Licenses
- Certifications
- Awards
- Guarantees
- Pricing
- Ratings
- Testimonials
- Reviews
- Partnerships
- Business history
- Local projects
- Local statistics

If factual information is unavailable, write "Not Provided" or use a clearly marked placeholder.

You should still use professional judgment for layout, UX, page structure, CTA placement, SEO architecture, internal linking, visual hierarchy, conversion strategy, mobile layout, and section order.

## Business Inputs

${dataLine('Business Name', business.businessName)}
${dataLine('Industry / Niche', business.industry)}
${dataLine('Primary Service', business.primaryService)}
${dataLine('Business Description', business.description)}
${dataLine('Target Customer', business.targetCustomer)}
${dataLine('Primary Goal', business.primaryGoal)}
${dataLine('Google Business Profile URL', business.googleBusinessProfileUrl)}

### Contact Information

${dataLine('Contact Person', business.contactPerson)}
${dataLine('Phone', business.phone)}
${dataLine('Email', business.email)}
${dataLine('Address', business.address)}
${dataLine('City', business.city)}
${dataLine('State / Province', business.stateProvince)}
${dataLine('Postal Code', business.postalCode)}
${dataLine('Domain', business.domain)}
${dataLine('Website URL', business.website)}
${dataLine('Instagram / Social Profiles', business.socials)}

### Branding

${dataLine('Brand Colors', business.brandColors)}
${dataLine('Logo Status', business.logoStatus)}
${dataLine('Favicon Status', business.faviconStatus)}
${dataLine('Preferred Style', business.preferredStyle)}

Default visual direction if no better style is provided: Blue-Collar Authority for contractor/home-service businesses. Use a premium, clean, professional, local, trustworthy, strong, modern, agency-built style. Do not make it gimmicky or generic.

### Services

${bulletList(business.services)}

Detected service evidence from the scan:
${bulletList([business.servicesEvidence].filter(Boolean))}

### Service Areas

${bulletList(business.serviceAreas)}

Detected location evidence from the scan:
${bulletList([business.locationEvidence].filter(Boolean))}

### SEO Keywords

${bulletList(business.seoKeywords)}

### Reviews and Photos

${dataLine('Real Reviews Detected / Provided', business.reviewsDetected)}
${dataLine('Real Photos Detected / Provided', business.photosDetected)}
${dataLine('Existing CTA Evidence', business.existingCta)}

# PitchProof Website Audit Results

## Overall Audit

Overall Score: ${overallScore}

Strongest Areas:
${bulletList(strongestAreas(categories), 'No clearly strong categories were identified. Preserve any accurate business facts and working conversion elements already present.')}

Weakest Areas:
${bulletList(weakestAreas(categories), 'No category score breakdown was available. Use the detailed findings below instead.')}

Highest-Priority Improvements:
${numberedList(actions.priority, 'No high-priority audit findings were available. Use professional judgment to improve clarity, trust, conversion, SEO, speed, and mobile UX.')}

## SEO Visibility

SEO Score: ${categoryScore(categories, 'seo')}

Findings:
${bulletList(seoFindings)}

Opportunities:
${bulletList(categoryOpportunities(items, 'seo'))}

Use these findings when deciding page architecture, service pages, service-area pages, heading structure, metadata, internal links, local targeting, content depth, and crawlability.

## Trust and Credibility

Trust Score: ${categoryScore(categories, 'trust')}

Findings:
${bulletList(trustFindings)}

Opportunities:
${bulletList(categoryOpportunities(items, 'trust'))}

Use these findings when determining whether the site needs stronger reviews, testimonials, project proof, credentials, company information, guarantees, certifications, local presence, contact information, About content, photos, or social proof.

Never fabricate trust signals.

## Lead Conversion

Conversion Score: ${categoryScore(categories, 'conversion')}

Findings:
${bulletList(conversionFindings)}

Opportunities:
${bulletList(categoryOpportunities(items, 'conversion'))}

Use these findings when improving hero messaging, calls to action, phone visibility, form placement, CTA frequency, mobile conversion, offer clarity, service clarity, user journey, friction, next-step clarity, and trust around conversion points.

## Technical Health

Technical Score: ${categoryScore(categories, 'technical')}

Findings:
${bulletList(technicalFindings)}

Opportunities:
${bulletList(categoryOpportunities(items, 'technical'))}

Use these findings when prioritizing performance, mobile experience, images, HTTPS, headings, metadata, broken links, sitemap, robots.txt, crawlability, responsiveness, accessibility, and layout stability.

## Visual Design

Visual Design Score: ${categoryScore(categories, 'design', report)}

Findings:
${bulletList(designFindings)}

Opportunities:
${bulletList(categoryOpportunities(items, 'design'))}

Use these findings to improve hierarchy, typography, spacing, navigation, imagery, CTA prominence, colors, content density, mobile layout, and perceived quality.

# Rebuild Strategy

## KEEP

Preserve or improve these elements:
${bulletList(actions.keep)}

## FIX

Improve these weak areas first:
${bulletList(actions.fix)}

## ADD

Add missing or underdeveloped elements where appropriate:
${bulletList(actions.add)}

## REMOVE

Remove, simplify, or avoid these sources of friction:
${bulletList(actions.remove)}

## Priority Order

Prioritize improvements in this order:

1. Make sure visitors can quickly understand what the business does, where it works, and who it serves.
2. Strengthen weak or missing conversion paths.
3. Improve trust and credibility.
4. Fix major mobile UX issues.
5. Address technical and crawlability problems.
6. Build SEO opportunities into the site architecture.
7. Improve visual hierarchy and design quality.
8. Handle minor cosmetic refinements last.

Do not treat every audit item equally. The rebuild should improve business results, not simply maximize a numerical audit score.

# Existing Website Research Rule

Use the existing website as research for services, company information, branding, business history, messaging, locations, offers, photos, content, and SEO targeting.

Do not blindly duplicate the existing site. Use accurate information from it while correcting the weaknesses identified by PitchProof.

# Website Architecture Guidelines

Consider creating these pages when relevant:

- Home
- About
- Contact
- Thank You
- Gallery
- Reviews
- Blog / Resources
- Services hub
- Individual service pages
- Service Areas hub
- Individual service-area pages
- Privacy Policy
- Terms and Conditions

Only create service pages for confirmed services.
Only create location pages for confirmed service areas.
Do not create thin location pages simply to increase page count.

# Homepage Architecture

Use a conversion-first homepage structure similar to:

1. Hero
2. Trust signals
3. Main services
4. Why choose us
5. Process
6. Gallery preview
7. Areas served
8. Reviews
9. FAQ
10. Final CTA
11. Footer

The homepage must quickly communicate:

- Who the business is
- What it does
- Where it works
- Why someone should trust it
- What the visitor should do next

Let the PitchProof findings influence which sections receive the greatest prominence.

# Conversion Requirements

Every important page should have:

- One clear primary CTA
- One secondary micro-commitment
- One obvious next step

Primary CTAs may include Request an Estimate, Request a Free Quote, Contact Us, or Call Now.

Secondary actions may include read reviews, view gallery, see service areas, view process, or read FAQs.

Avoid excessive CTA choices. Include click-to-call prominently where phone leads matter. Include a sticky mobile CTA/action bar where appropriate. Do not add a booking calendar unless requested. Forms should remain GoHighLevel webhook-ready where applicable.

# Local SEO Requirements

Include:

- Service page architecture
- Service area hub
- Unique city/service area pages where real service areas are confirmed
- Descriptive internal linking
- Unique title tags
- Unique meta descriptions
- Proper H1/H2/H3 hierarchy
- LocalBusiness schema
- Service schema
- FAQ schema when relevant
- Breadcrumb schema where appropriate
- BlogPosting schema for blogs
- Self-referencing canonicals
- XML sitemap
- robots.txt
- Crawlable navigation
- Clean URLs

Do not create fake local facts or mass-generated city pages that only swap the city name.

# Copywriting Rules

Use direct-response principles. Copy should be clear, specific, confident, benefit-driven, human, and non-hypey.

Avoid generic phrases such as:

- Your trusted partner
- High-quality services
- Tailored solutions
- Best in the business
- We are committed to customer satisfaction

Do not create fake urgency or unsupported guarantees. Use the audit findings to determine where messaging needs the most improvement.

# Image Rules

Placeholder or generated imagery must contain:

- No readable text
- No fake business branding
- No fake logos
- No branded uniforms
- No branded trucks
- No fake signage

Use real assets if provided. Real project photos should be preferred over generic imagery.

Images should be responsive, compressed, properly sized, and given useful alt text. Do not claim a project occurred in a particular city unless confirmed.

# Performance Requirements

Target fast mobile performance, minimal layout shift, optimized images, good accessibility, responsive layouts, 90+ Lighthouse Mobile where reasonable, and 95+ where realistically achievable.

Performance targets should not override usability or essential functionality.

# Final QA Against PitchProof Audit

Before considering the rebuild complete, provide a short QA report confirming:

## PitchProof Audit

- Highest-priority audit issues addressed
- Conversion weaknesses addressed
- Trust weaknesses addressed
- SEO opportunities incorporated where appropriate
- Technical issues addressed
- Visual weaknesses addressed
- Strong existing elements preserved where appropriate
- Missing factual information not fabricated

## Pages

- Pages created
- Service pages created
- Service area pages created
- Pages requiring additional real content

## Navigation

- Desktop navigation works
- Mobile navigation works
- Services navigation works
- Service Areas navigation works
- Phone is visible/clickable where appropriate

## SEO

- Unique metadata
- Canonicals
- Sitemap
- Robots
- Correct indexing
- Valid schema
- No temporary preview URLs in production metadata

## Conversion

- Primary CTA clear
- Phone clickable
- Forms work
- Forms are GoHighLevel-ready
- Mobile CTA works
- No unnecessary booking calendar

## Content Accuracy

- No fake reviews
- No fake statistics
- No fake projects
- No fake locations
- No unsupported claims
- No old business information

## Performance

- Mobile layout verified
- Images optimized
- Major performance issues corrected
- Scroll/navigation behavior works
`;

    return prompt
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function generate(input = {}) {
    const report = asRecord(input.report || input);
    const context = asRecord(input.context);
    const categories = normalizeCategories(report);
    const items = collectAuditItems(report);
    const actions = buildActionBuckets(report, items);
    const prompt = generateWebsiteBuildPrompt({ report, context });
    return {
      prompt,
      meta: {
        characterCount: prompt.length,
        categoryCount: categories.length,
        findingCount: uniqueList(items.all.map(item => item.text), 100).length,
        priorityCount: actions.priority.length,
      },
    };
  }

  return {
    NOT_PROVIDED,
    generate,
    generateWebsiteBuildPrompt,
    buildBusinessInputs,
    collectAuditItems,
    buildActionBuckets,
  };
});
