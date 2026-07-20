(function () {
  const STORAGE_KEY = 'leadcheck.agencyBranding.v1';
  const DEFAULT_BRANDING = {
    whiteLabelEnabled: true,
    agencyName: 'WStrategies Canada',
    platformLabel: 'Website Assessment Platform',
    logoUrl: '',
    faviconUrl: '',
    primaryAccent: '#f5c842',
    secondaryAccent: '#1d1d1f',
    website: 'https://www.wstrategiescanada.ca',
    phone: '',
    email: 'hello@wstrategiescanada.ca',
    bookingLink: 'https://www.wstrategiescanada.ca/contact',
    tagline: 'Website Assessment Platform',
    reportDisclaimer: 'This assessment is based on observable website signals at the time of review.',
  };

  function safeJsonParse(raw) {
    try {
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function initials(name) {
    return String(name || 'Agency')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(part => part[0])
      .join('')
      .toUpperCase() || 'AG';
  }

  function setText(selector, value) {
    document.querySelectorAll(selector).forEach(node => {
      node.textContent = value || '';
    });
  }

  function setHref(selector, href, fallback = '#') {
    document.querySelectorAll(selector).forEach(node => {
      node.setAttribute('href', href || fallback);
    });
  }

  class BrandingProvider {
    constructor(storage = window.localStorage) {
      this.storage = storage;
      this.branding = this.load();
    }

    load() {
      const saved = safeJsonParse(this.storage.getItem(STORAGE_KEY));
      return { ...DEFAULT_BRANDING, ...saved };
    }

    getBranding() {
      return { ...this.branding };
    }

    save(update) {
      this.branding = { ...this.branding, ...update };
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.branding));
      this.apply();
      this.populateForm();
      return this.getBranding();
    }

    reset() {
      this.branding = { ...DEFAULT_BRANDING };
      this.storage.removeItem(STORAGE_KEY);
      this.apply();
      this.populateForm();
      return this.getBranding();
    }

    apply(route = window.location.pathname) {
      const brand = this.branding;
      const isApp = route.startsWith('/app');
      const isLogin = route.startsWith('/login') ||
        route.startsWith('/signup') ||
        route.startsWith('/forgot-password') ||
        route.startsWith('/reset-password');
      const agencyName = brand.agencyName || 'Agency';
      const platformLabel = brand.platformLabel || 'Website Assessment Platform';

      document.documentElement.style.setProperty('--accent', brand.primaryAccent || DEFAULT_BRANDING.primaryAccent);
      document.documentElement.style.setProperty('--accent-strong', brand.secondaryAccent || DEFAULT_BRANDING.secondaryAccent);
      document.documentElement.style.setProperty('--agency-secondary', brand.secondaryAccent || DEFAULT_BRANDING.secondaryAccent);
      document.body.dataset.whiteLabelMode = brand.whiteLabelEnabled ? 'enabled' : 'disabled';

      setText('[data-brand-name]', agencyName);
      setText('[data-brand-platform]', platformLabel);
      setText('[data-brand-tagline]', brand.tagline || platformLabel);
      setText('[data-brand-logo-text]', initials(agencyName));
      setText('[data-brand-phone]', brand.phone || 'Phone not set');
      setText('[data-brand-disclaimer]', brand.reportDisclaimer || '');

      setHref('[data-brand-email]', brand.email ? `mailto:${brand.email}` : '#');
      setText('[data-brand-email]', brand.email || 'Email not set');
      setHref('[data-brand-website]', brand.website || '#');
      setText('[data-brand-website]', brand.website || 'Website not set');
      setHref('[data-brand-booking]', brand.bookingLink || '#');

      document.querySelectorAll('[data-brand-logo-img]').forEach(img => {
        if (brand.logoUrl && brand.whiteLabelEnabled) {
          img.src = brand.logoUrl;
          img.hidden = false;
        } else {
          img.removeAttribute('src');
          img.hidden = true;
        }
      });

      document.querySelectorAll('.brand-logo-fallback').forEach(mark => {
        mark.hidden = !!(brand.logoUrl && brand.whiteLabelEnabled);
      });

      this.applyFavicon(isApp && brand.whiteLabelEnabled ? brand.faviconUrl : '');

      if (isApp) {
        document.title = `${agencyName} | Website Assessment`;
      } else if (isLogin) {
        document.title = 'LeadCheck Login';
      } else {
        document.title = 'LeadCheck - White-Label Website Assessment Software';
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
      icon.href = faviconUrl || '/icons/icon-192.png';
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
        secondaryAccentInput: 'secondaryAccent',
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
      return {
        whiteLabelEnabled: !!document.getElementById('whiteLabelEnabledInput')?.checked,
        agencyName: document.getElementById('agencyNameInput')?.value.trim() || DEFAULT_BRANDING.agencyName,
        logoUrl: document.getElementById('agencyLogoInput')?.value.trim() || '',
        primaryAccent: document.getElementById('primaryAccentInput')?.value || DEFAULT_BRANDING.primaryAccent,
        secondaryAccent: document.getElementById('secondaryAccentInput')?.value || DEFAULT_BRANDING.secondaryAccent,
        website: document.getElementById('agencyWebsiteInput')?.value.trim() || '',
        phone: document.getElementById('agencyPhoneInput')?.value.trim() || '',
        email: document.getElementById('agencyEmailInput')?.value.trim() || '',
        bookingLink: document.getElementById('agencyBookingInput')?.value.trim() || '',
        faviconUrl: document.getElementById('agencyFaviconInput')?.value.trim() || '',
        tagline: document.getElementById('agencyTaglineInput')?.value.trim() || DEFAULT_BRANDING.tagline,
        reportDisclaimer: document.getElementById('reportDisclaimerInput')?.value.trim() || '',
      };
    }
  }

  window.DEFAULT_AGENCY_BRANDING = DEFAULT_BRANDING;
  window.BrandingProvider = BrandingProvider;
})();
