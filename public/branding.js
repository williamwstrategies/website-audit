(function () {
  const STORAGE_KEY = 'leadcheck.agencyBranding.v2';
  const SYSTEM_FAVICON = '/icons/icon-192.png';
  const DEFAULT_BRANDING = {
    whiteLabelEnabled: true,
    agencyName: 'W Strategies',
    platformLabel: 'Website Assessment',
    logoUrl: '',
    logoStoragePath: '',
    faviconUrl: '',
    faviconStoragePath: '',
    primaryAccent: '#23a8ff',
    secondaryAccent: '#75ceff',
    website: '',
    phone: '',
    email: '',
    bookingLink: '',
    tagline: 'Website audit platform',
    reportDisclaimer: 'This assessment is based on observable website signals at the time of review.',
  };
  const PLATFORM_BRANDING = {
    ...DEFAULT_BRANDING,
    whiteLabelEnabled: false,
    agencyName: 'Website Strategy Scan',
    platformLabel: 'Website Assessment',
    logoUrl: '',
    logoStoragePath: '',
    faviconUrl: '',
    faviconStoragePath: '',
    primaryAccent: '#f5c842',
    secondaryAccent: '#1d1d1f',
    tagline: 'Website Assessment',
    reportDisclaimer: 'This assessment is based on observable website signals at the time of review.',
    poweredBy: 'Powered by Website Strategy Scan',
  };

  function safeJsonParse(raw) {
    try {
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function cleanText(value) {
    return String(value || '').trim();
  }

  function isHex(value) {
    return /^#[0-9a-fA-F]{6}$/.test(cleanText(value));
  }

  function normalizeHex(value, fallback) {
    const raw = cleanText(value);
    return isHex(raw) ? raw.toLowerCase() : fallback;
  }

  function hexToRgb(hex) {
    const safe = normalizeHex(hex, DEFAULT_BRANDING.primaryAccent).slice(1);
    return {
      r: parseInt(safe.slice(0, 2), 16),
      g: parseInt(safe.slice(2, 4), 16),
      b: parseInt(safe.slice(4, 6), 16),
    };
  }

  function channelLuminance(value) {
    const channel = value / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  }

  function relativeLuminance(hex) {
    const { r, g, b } = hexToRgb(hex);
    return (0.2126 * channelLuminance(r)) +
      (0.7152 * channelLuminance(g)) +
      (0.0722 * channelLuminance(b));
  }

  function readableTextColor(hex) {
    return relativeLuminance(hex) > 0.48 ? '#1d1d1f' : '#ffffff';
  }

  function rgba(hex, alpha) {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function initials(name) {
    return String(name || DEFAULT_BRANDING.agencyName)
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(part => part[0])
      .join('')
      .toUpperCase() || 'WA';
  }

  function setText(selector, value) {
    document.querySelectorAll(selector).forEach(node => {
      node.textContent = value || '';
    });
  }

  function setHref(selector, href, fallback = '#') {
    document.querySelectorAll(selector).forEach(node => {
      node.setAttribute('href', href || fallback);
      node.toggleAttribute('aria-disabled', !href);
    });
  }

  function setOptionalText(selector, value) {
    const text = cleanText(value);
    document.querySelectorAll(selector).forEach(node => {
      node.textContent = text;
      node.hidden = !text;
    });
  }

  function setOptionalHref(selector, href, label) {
    const safeHref = cleanText(href);
    const safeLabel = cleanText(label);
    document.querySelectorAll(selector).forEach(node => {
      node.textContent = safeLabel;
      node.hidden = !(safeHref && safeLabel);
      node.toggleAttribute('aria-disabled', !(safeHref && safeLabel));
      if (safeHref) node.setAttribute('href', safeHref);
      else node.removeAttribute('href');
    });
  }

  function collapseEmptyBrandContactGroups() {
    document.querySelectorAll('.report-contact-block, .report-footer-links').forEach(group => {
      const hasVisibleContact = Array.from(group.children).some(child => !child.hidden);
      group.hidden = !hasVisibleContact;
    });
  }

  function routeTitle(route) {
    if (route.startsWith('/app/reports/current')) return 'Website Assessment';
    if (/^\/app\/reports\/[^/?#]+/.test(route)) return 'Website Assessment';
    if (route.startsWith('/app/reports')) return 'Reports';
    if (route.startsWith('/app/scan')) return 'New Audit';
    if (route.startsWith('/app/branding')) return 'Branding';
    if (route.startsWith('/app/billing')) return 'Billing';
    if (route.startsWith('/app/settings')) return 'Settings';
    return 'Dashboard';
  }

  function hasUsableLogo(brand) {
    return !!(brand.whiteLabelEnabled && brand.logoUrl);
  }

  function normalizeBranding(update = {}) {
    return {
      whiteLabelEnabled: update.whiteLabelEnabled !== false,
      agencyName: cleanText(update.agencyName || update.agency_name) || DEFAULT_BRANDING.agencyName,
      platformLabel: cleanText(update.platformLabel || update.platform_label) || DEFAULT_BRANDING.platformLabel,
      logoUrl: cleanText(update.logoUrl || update.logo_url || update.logoResolvedUrl || update.logo_resolved_url),
      logoStoragePath: cleanText(update.logoStoragePath || update.logo_storage_path),
      faviconUrl: cleanText(update.faviconUrl || update.favicon_url || update.faviconResolvedUrl || update.favicon_resolved_url),
      faviconStoragePath: cleanText(update.faviconStoragePath || update.favicon_storage_path),
      primaryAccent: normalizeHex(update.primaryAccent || update.primary_color, DEFAULT_BRANDING.primaryAccent),
      secondaryAccent: normalizeHex(update.secondaryAccent || update.secondary_color, DEFAULT_BRANDING.secondaryAccent),
      website: cleanText(update.website),
      phone: cleanText(update.phone),
      email: cleanText(update.email),
      bookingLink: cleanText(update.bookingLink || update.booking_link),
      tagline: cleanText(update.tagline) || DEFAULT_BRANDING.tagline,
      reportDisclaimer: cleanText(update.reportDisclaimer || update.disclaimer || update.report_disclaimer),
    };
  }

  function databasePayload(branding = {}) {
    const brand = normalizeBranding(branding);
    return {
      agencyName: brand.agencyName,
      logoUrl: brand.logoStoragePath || brand.logoUrl,
      primaryAccent: brand.primaryAccent,
      secondaryAccent: brand.secondaryAccent,
      website: brand.website,
      phone: brand.phone,
      email: brand.email,
      bookingLink: brand.bookingLink,
      faviconUrl: brand.faviconStoragePath || brand.faviconUrl,
      tagline: brand.tagline,
      reportDisclaimer: brand.reportDisclaimer,
    };
  }

  class BrandingProvider {
    constructor(storage = window.localStorage) {
      this.storage = storage;
      this.branding = this.load();
      this.isLoading = false;
      this.whiteLabelAllowed = true;
    }

    load() {
      const legacy = safeJsonParse(this.storage.getItem('leadcheck.agencyBranding.v1'));
      const saved = safeJsonParse(this.storage.getItem(STORAGE_KEY));
      return { ...DEFAULT_BRANDING, ...normalizeBranding({ ...legacy, ...saved }) };
    }

    getBranding() {
      return {
        ...this.branding,
        primaryColor: this.branding.primaryAccent,
        secondaryColor: this.branding.secondaryAccent,
        disclaimer: this.branding.reportDisclaimer,
        isLoading: this.isLoading,
      };
    }

    getEffectiveBranding() {
      const canUseAgencyBranding = this.whiteLabelAllowed && this.branding.whiteLabelEnabled;
      const brand = canUseAgencyBranding ? this.branding : PLATFORM_BRANDING;
      return {
        ...brand,
        primaryColor: brand.primaryAccent,
        secondaryColor: brand.secondaryAccent,
        disclaimer: brand.reportDisclaimer,
        isLoading: this.isLoading,
      };
    }

    setWhiteLabelAccess(isAllowed, options = {}) {
      this.whiteLabelAllowed = !!isAllowed;
      document.body.dataset.whiteLabelAllowed = this.whiteLabelAllowed ? 'true' : 'false';
      if (options.apply !== false) this.apply();
      return this.getEffectiveBranding();
    }

    setLoading(isLoading) {
      this.isLoading = !!isLoading;
      document.body.dataset.brandingLoading = this.isLoading ? 'true' : 'false';
    }

    save(update = {}, options = {}) {
      this.branding = {
        ...DEFAULT_BRANDING,
        ...this.branding,
        ...normalizeBranding({ ...this.branding, ...update }),
      };
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.branding));
      if (options.apply !== false) this.apply();
      if (options.populate !== false) this.populateForm();
      return this.getBranding();
    }

    fromDatabaseRecord(record = {}) {
      const logoValue = cleanText(record.logo_url);
      const faviconValue = cleanText(record.favicon_url);
      const logoIsExternal = /^https?:\/\//i.test(logoValue);
      const faviconIsExternal = /^https?:\/\//i.test(faviconValue);
      return normalizeBranding({
        agencyName: record.agency_name,
        logoUrl: record.logo_resolved_url || (logoIsExternal ? logoValue : ''),
        logoStoragePath: record.logo_storage_path || (logoIsExternal ? '' : logoValue),
        primaryAccent: record.primary_color,
        secondaryAccent: record.secondary_color,
        website: record.website,
        phone: record.phone,
        email: record.email,
        bookingLink: record.booking_link,
        faviconUrl: record.favicon_resolved_url || (faviconIsExternal ? faviconValue : ''),
        faviconStoragePath: record.favicon_storage_path || (faviconIsExternal ? '' : faviconValue),
        tagline: record.tagline,
        reportDisclaimer: record.disclaimer,
      });
    }

    async refreshBranding(databaseService) {
      if (!databaseService?.isReady?.()) return this.getBranding();
      this.setLoading(true);
      try {
        const record = await databaseService.getAgencyBranding();
        if (record) return this.save(this.fromDatabaseRecord(record));
        return this.getBranding();
      } finally {
        this.setLoading(false);
      }
    }

    async updateBranding(databaseService, update = {}) {
      if (!databaseService?.isReady?.()) {
        return this.save(update);
      }

      this.setLoading(true);
      try {
        const record = await databaseService.updateAgencyBranding(databasePayload(update));
        return this.save(this.fromDatabaseRecord(record));
      } finally {
        this.setLoading(false);
      }
    }

    reset(options = {}) {
      this.branding = { ...DEFAULT_BRANDING };
      this.storage.removeItem(STORAGE_KEY);
      if (options.apply !== false) this.apply();
      if (options.populate !== false) this.populateForm();
      return this.getBranding();
    }

    apply(route = window.location.pathname) {
      const isApp = route.startsWith('/app');
      const isLogin = route.startsWith('/login') ||
        route.startsWith('/signup') ||
        route.startsWith('/forgot-password') ||
        route.startsWith('/reset-password');
      const brand = isApp ? this.getEffectiveBranding() : this.branding;
      const agencyName = brand.agencyName || DEFAULT_BRANDING.agencyName;
      const platformLabel = brand.platformLabel || DEFAULT_BRANDING.platformLabel;
      const primary = normalizeHex(brand.primaryAccent, DEFAULT_BRANDING.primaryAccent);
      const secondary = normalizeHex(brand.secondaryAccent, DEFAULT_BRANDING.secondaryAccent);

      document.documentElement.style.setProperty('--accent', primary);
      document.documentElement.style.setProperty('--accent-strong', secondary);
      document.documentElement.style.setProperty('--accent-soft', rgba(primary, 0.18));
      document.documentElement.style.setProperty('--accent-contrast', readableTextColor(primary));
      document.documentElement.style.setProperty('--accent-strong-contrast', readableTextColor(secondary));
      document.documentElement.style.setProperty('--agency-secondary', secondary);
      document.body.dataset.whiteLabelMode = brand.whiteLabelEnabled ? 'enabled' : 'disabled';
      document.body.dataset.whiteLabelAllowed = this.whiteLabelAllowed ? 'true' : 'false';

      setText('[data-brand-name]', agencyName);
      setText('[data-brand-platform]', platformLabel);
      setText('[data-brand-tagline]', brand.tagline || platformLabel);
      setText('[data-brand-logo-text]', initials(agencyName));
      setOptionalText('[data-brand-phone]', brand.phone);
      setText('[data-brand-disclaimer]', brand.reportDisclaimer || '');

      setOptionalHref('[data-brand-email]', brand.email ? `mailto:${brand.email}` : '', brand.email);
      setOptionalHref('[data-brand-website]', brand.website, brand.website);
      setOptionalHref('[data-brand-booking]', brand.bookingLink, brand.bookingLink ? 'Book a consultation' : '');
      collapseEmptyBrandContactGroups();
      setText('[data-platform-powered]', brand.poweredBy || 'Powered by Website Strategy Scan');
      document.querySelectorAll('[data-platform-powered]').forEach(node => {
        node.hidden = !(isApp && !this.whiteLabelAllowed);
      });

      document.querySelectorAll('[data-brand-logo-img]').forEach(img => {
        img.alt = `${agencyName} logo`;
        img.onerror = () => {
          img.hidden = true;
          img.closest('.brand-lockup')?.querySelector('.brand-logo-fallback')?.removeAttribute('hidden');
        };
        if (hasUsableLogo(brand)) {
          img.src = brand.logoUrl;
          img.hidden = false;
        } else {
          img.removeAttribute('src');
          img.hidden = true;
        }
      });

      document.querySelectorAll('.brand-logo-fallback').forEach(mark => {
        mark.hidden = hasUsableLogo(brand);
      });

      this.applyFavicon(isApp && brand.whiteLabelEnabled ? brand.faviconUrl : '');

      if (isApp) {
        document.title = `${agencyName} | ${routeTitle(route)}`;
      } else if (isLogin) {
        document.title = 'W Strategies Account Access';
      } else {
        document.title = 'W Strategies - White-Label Website Audit Software';
      }

      const whiteLabelStatus = document.getElementById('whiteLabelStatus');
      if (whiteLabelStatus) whiteLabelStatus.textContent = brand.whiteLabelEnabled ? 'White-label' : 'Standard';
    }

    applyFavicon(faviconUrl) {
      let icon = document.querySelector('link[rel="icon"]');
      if (!icon) {
        icon = document.createElement('link');
        icon.rel = 'icon';
        document.head.appendChild(icon);
      }
      icon.href = faviconUrl || SYSTEM_FAVICON;
    }

    populateForm() {
      const form = document.getElementById('brandingForm');
      if (!form) return;
      const brand = this.branding;
      const fieldMap = {
        whiteLabelEnabledInput: 'whiteLabelEnabled',
        agencyNameInput: 'agencyName',
        agencyLogoInput: 'logoUrl',
        primaryAccentInput: 'primaryAccent',
        primaryAccentHexInput: 'primaryAccent',
        secondaryAccentInput: 'secondaryAccent',
        secondaryAccentHexInput: 'secondaryAccent',
        agencyWebsiteInput: 'website',
        agencyPhoneInput: 'phone',
        agencyEmailInput: 'email',
        agencyBookingInput: 'bookingLink',
        agencyFaviconInput: 'faviconUrl',
        agencyTaglineInput: 'tagline',
        reportDisclaimerInput: 'reportDisclaimer',
      };

      Object.entries(fieldMap).forEach(([id, key]) => {
        const input = document.getElementById(id);
        if (!input) return;
        if (input.type === 'checkbox') input.checked = !!brand[key];
        else input.value = brand[key] || '';
      });
    }

    readForm() {
      const current = this.branding;
      const logoInput = cleanText(document.getElementById('agencyLogoInput')?.value);
      const faviconInput = cleanText(document.getElementById('agencyFaviconInput')?.value);
      const logoUrl = current.logoStoragePath && logoInput === current.logoUrl ? current.logoStoragePath : logoInput;
      const faviconUrl = current.faviconStoragePath && faviconInput === current.faviconUrl ? current.faviconStoragePath : faviconInput;

      return normalizeBranding({
        whiteLabelEnabled: !!document.getElementById('whiteLabelEnabledInput')?.checked,
        agencyName: document.getElementById('agencyNameInput')?.value.trim() || DEFAULT_BRANDING.agencyName,
        logoUrl,
        logoStoragePath: logoUrl === current.logoStoragePath ? current.logoStoragePath : '',
        primaryAccent: document.getElementById('primaryAccentHexInput')?.value || document.getElementById('primaryAccentInput')?.value,
        secondaryAccent: document.getElementById('secondaryAccentHexInput')?.value || document.getElementById('secondaryAccentInput')?.value,
        website: document.getElementById('agencyWebsiteInput')?.value.trim() || '',
        phone: document.getElementById('agencyPhoneInput')?.value.trim() || '',
        email: document.getElementById('agencyEmailInput')?.value.trim() || '',
        bookingLink: document.getElementById('agencyBookingInput')?.value.trim() || '',
        faviconUrl,
        faviconStoragePath: faviconUrl === current.faviconStoragePath ? current.faviconStoragePath : '',
        tagline: document.getElementById('agencyTaglineInput')?.value.trim() || DEFAULT_BRANDING.tagline,
        reportDisclaimer: document.getElementById('reportDisclaimerInput')?.value.trim() || '',
      });
    }
  }

  window.DEFAULT_AGENCY_BRANDING = DEFAULT_BRANDING;
  window.PLATFORM_REPORT_BRANDING = PLATFORM_BRANDING;
  window.getReadableTextColor = readableTextColor;
  window.BrandingProvider = BrandingProvider;
})();
