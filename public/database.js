(function () {
  const BRANDING_BUCKET = 'agency-branding';
  const REPORT_LIST_FIELDS = [
    'id',
    'user_id',
    'website_url',
    'website',
    'website_domain',
    'website_name',
    'website_score',
    'scan_status',
    'created_at',
    'updated_at',
  ].join(', ');

  function cleanText(value) {
    return String(value || '').trim();
  }

  function toJson(value) {
    return JSON.parse(JSON.stringify(value || {}));
  }

  function scoreValue(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value.replace('%', '').trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  function normalizeUrl(value) {
    const raw = cleanText(value);
    if (!raw) return '';
    return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  }

  function domainFromUrl(value) {
    const url = normalizeUrl(value);
    if (!url) return '';
    try {
      return new URL(url).hostname.replace(/^www\./i, '');
    } catch {
      return url.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./i, '');
    }
  }

  function websiteNameFromUrl(value) {
    const domain = domainFromUrl(value);
    if (!domain) return '';
    return domain
      .split('.')
      .filter(Boolean)
      .slice(0, 2)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  function reportRoot(reportData) {
    const data = reportData && typeof reportData === 'object' && !Array.isArray(reportData) ? reportData : {};
    const report = data.report && typeof data.report === 'object' && !Array.isArray(data.report) ? data.report : data;
    return report || {};
  }

  function sortParts(sort) {
    const [requestedColumn = 'created_at', requestedDirection = 'desc'] = String(sort || '').split('.');
    const columns = {
      created_at: 'created_at',
      updated_at: 'updated_at',
      website: 'website_domain',
      website_url: 'website_url',
      website_domain: 'website_domain',
      website_name: 'website_name',
      website_score: 'website_score',
      scan_status: 'scan_status',
    };
    return {
      column: columns[requestedColumn] || 'created_at',
      ascending: requestedDirection === 'asc',
    };
  }

  function brandingPayload(userId, branding = {}) {
    return {
      user_id: userId,
      agency_name: cleanText(branding.agencyName || branding.agency_name),
      logo_url: cleanText(branding.logoStoragePath || branding.logoUrl || branding.logo_url),
      primary_color: cleanText(branding.primaryAccent || branding.primary_color),
      secondary_color: cleanText(branding.secondaryAccent || branding.secondary_color),
      website: cleanText(branding.website),
      email: cleanText(branding.email),
      phone: cleanText(branding.phone),
      booking_link: cleanText(branding.bookingLink || branding.booking_link),
      favicon_url: cleanText(branding.faviconStoragePath || branding.faviconUrl || branding.favicon_url),
      tagline: cleanText(branding.tagline),
      disclaimer: cleanText(branding.reportDisclaimer || branding.disclaimer),
    };
  }

  function extensionFromFile(file, fallback = 'png') {
    const nameExt = cleanText(file?.name).split('.').pop().toLowerCase();
    if (['png', 'jpg', 'jpeg', 'webp', 'svg', 'ico'].includes(nameExt)) return nameExt;
    const typeMap = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/svg+xml': 'svg',
      'image/x-icon': 'ico',
      'image/vnd.microsoft.icon': 'ico',
    };
    return typeMap[file?.type] || fallback;
  }

  function contentTypeFromExtension(extension, fallback = 'image/png') {
    const typeMap = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      svg: 'image/svg+xml',
      ico: 'image/x-icon',
    };
    return typeMap[extension] || fallback;
  }

  function isExternalUrl(value) {
    return /^https?:\/\//i.test(cleanText(value));
  }

  function fileNameFromDisposition(header, fallback) {
    const value = cleanText(header);
    const utfMatch = value.match(/filename\*=UTF-8''([^;]+)/i);
    if (utfMatch) return decodeURIComponent(utfMatch[1]);
    const match = value.match(/filename="?([^"]+)"?/i);
    return match ? match[1] : fallback;
  }

  function clientRequestId(prefix = 'request') {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  class DatabaseService {
    constructor(supabaseClient) {
      this.client = supabaseClient || null;
      this.profileSyncedFor = '';
    }

    isReady() {
      return !!this.client;
    }

    requireClient() {
      if (!this.client) throw new Error('Database is not connected.');
      return this.client;
    }

    async getCurrentUser() {
      const client = this.requireClient();
      const { data, error } = await client.auth.getUser();
      if (error) throw error;
      return data?.user || null;
    }

    async requireUser() {
      const user = await this.getCurrentUser();
      if (!user) throw new Error('You must be logged in to use the database.');
      return user;
    }

    async getAccessToken() {
      const client = this.requireClient();
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      const token = data?.session?.access_token;
      if (!token) throw new Error('You must be logged in to continue.');
      return token;
    }

    async authHeaders(extra = {}) {
      return {
        ...extra,
        Authorization: `Bearer ${await this.getAccessToken()}`,
      };
    }

    async serverJson(path, options = {}) {
      const headers = await this.authHeaders({
        Accept: 'application/json',
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      });

      const response = await fetch(path, {
        method: options.method || 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload.error || 'Request failed. Please try again.');
        error.status = response.status;
        error.code = payload.code || 'request_failed';
        error.subscription = payload.subscription || null;
        throw error;
      }
      return payload;
    }

    async serverBlob(path, options = {}) {
      const headers = await this.authHeaders(options.headers || {});
      const response = await fetch(path, {
        method: options.method || 'GET',
        headers,
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const error = new Error(payload.error || 'Request failed. Please try again.');
        error.status = response.status;
        error.code = payload.code || 'request_failed';
        error.subscription = payload.subscription || null;
        throw error;
      }

      return {
        blob: await response.blob(),
        fileName: fileNameFromDisposition(response.headers.get('content-disposition'), options.fileName || 'website-assessment.pdf'),
      };
    }

    async ensureWorkspace() {
      const payload = await this.serverJson('/api/account/provision', { method: 'POST' });
      const account = payload?.account || {};
      if (account.user_id) this.profileSyncedFor = account.user_id;
      return account;
    }

    profilePayload(user, update = {}) {
      return {
        id: user.id,
        email: cleanText(update.email || user.email),
        full_name: cleanText(update.fullName || update.full_name || user.user_metadata?.name),
        agency_name: cleanText(update.agencyName || update.agency_name || user.user_metadata?.agency_name),
      };
    }

    async ensureUserProfile(user = null) {
      const currentUser = user || await this.requireUser();
      if (this.profileSyncedFor === currentUser.id) return currentUser;

      const client = this.requireClient();
      const { error } = await client
        .from('profiles')
        .upsert(this.profilePayload(currentUser), { onConflict: 'id' });

      if (error) throw error;
      this.profileSyncedFor = currentUser.id;
      return currentUser;
    }

    async getCurrentProfile() {
      const user = await this.requireUser();
      const client = this.requireClient();
      const { data, error } = await client
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .maybeSingle();

      if (error) throw error;
      return data || null;
    }

    async updateCurrentProfile(update = {}) {
      const user = await this.ensureUserProfile();
      const client = this.requireClient();
      const payload = this.profilePayload(user, update);

      const { data, error } = await client
        .from('profiles')
        .update(payload)
        .eq('id', user.id)
        .select('*')
        .single();

      if (error) throw error;
      return data;
    }

    async createReport({ websiteUrl, website, websiteScore, reportData, scanStatus = 'completed', websiteName } = {}) {
      const user = await this.ensureUserProfile();
      const client = this.requireClient();
      const root = reportRoot(reportData);
      const normalizedWebsite = normalizeUrl(websiteUrl || website || root.url || root.websiteUrl);

      if (!normalizedWebsite) throw new Error('Report website is required.');

      const payload = {
        user_id: user.id,
        website_url: normalizedWebsite,
        website: normalizedWebsite,
        website_domain: domainFromUrl(normalizedWebsite),
        website_name: cleanText(websiteName) || websiteNameFromUrl(normalizedWebsite),
        website_score: scoreValue(websiteScore ?? root.total ?? root.score ?? root.websiteScore ?? root.rating),
        report_data: toJson(reportData),
        scan_status: cleanText(scanStatus) || 'completed',
      };

      const { data, error } = await client
        .from('reports')
        .insert(payload)
        .select(REPORT_LIST_FIELDS)
        .single();

      if (error) throw error;
      return data;
    }

    async saveReport(input = {}) {
      return this.createReport({
        websiteUrl: input.websiteUrl || input.website,
        websiteName: input.websiteName,
        websiteScore: input.websiteScore,
        reportData: input.reportData,
        scanStatus: input.scanStatus || 'completed',
      });
    }

    async getReportsForCurrentUser({ search = '', sort = 'created_at.desc', limit = 25 } = {}) {
      const user = await this.requireUser();
      const client = this.requireClient();
      const { column, ascending } = sortParts(sort);
      const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 250));
      const term = cleanText(search);

      let query = client
        .from('reports')
        .select(REPORT_LIST_FIELDS)
        .eq('user_id', user.id);

      if (term) query = query.ilike('website_url', `%${term}%`);

      const { data, error } = await query
        .order(column, { ascending })
        .limit(safeLimit);

      if (error) throw error;
      return data || [];
    }

    async listReports(options = {}) {
      return this.getReportsForCurrentUser(options);
    }

    async getReportById(reportId) {
      const user = await this.requireUser();
      const client = this.requireClient();
      const { data, error } = await client
        .from('reports')
        .select('*')
        .eq('user_id', user.id)
        .eq('id', reportId)
        .maybeSingle();

      if (error) throw error;
      if (!data) throw new Error('Report not found or access denied.');
      return data;
    }

    async getReport(reportId) {
      return this.getReportById(reportId);
    }

    async updateReport(reportId, update = {}) {
      const user = await this.requireUser();
      const client = this.requireClient();
      const payload = {};

      if ('websiteUrl' in update || 'website_url' in update || 'website' in update) {
        const websiteUrl = normalizeUrl(update.websiteUrl || update.website_url || update.website);
        payload.website_url = websiteUrl;
        payload.website = websiteUrl;
        payload.website_domain = domainFromUrl(websiteUrl);
        payload.website_name = cleanText(update.websiteName || update.website_name) || websiteNameFromUrl(websiteUrl);
      }
      if ('websiteScore' in update || 'website_score' in update) {
        payload.website_score = scoreValue(update.websiteScore ?? update.website_score);
      }
      if ('reportData' in update || 'report_data' in update) {
        payload.report_data = toJson(update.reportData || update.report_data);
      }
      if ('scanStatus' in update || 'scan_status' in update) {
        payload.scan_status = cleanText(update.scanStatus || update.scan_status);
      }

      const { data, error } = await client
        .from('reports')
        .update(payload)
        .eq('user_id', user.id)
        .eq('id', reportId)
        .select('*')
        .single();

      if (error) throw error;
      return data;
    }

    async deleteReport(reportId) {
      const user = await this.requireUser();
      const client = this.requireClient();
      const { error } = await client
        .from('reports')
        .delete()
        .eq('user_id', user.id)
        .eq('id', reportId);

      if (error) throw error;
      return true;
    }

    async duplicateReport(reportId) {
      const report = await this.getReportById(reportId);
      return this.createReport({
        websiteUrl: report.website_url || report.website,
        websiteName: report.website_name,
        websiteScore: report.website_score,
        reportData: report.report_data,
        scanStatus: 'completed',
      });
    }

    async getAgencyBranding() {
      const user = await this.requireUser();
      const client = this.requireClient();
      const { data, error } = await client
        .from('agency_branding')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();

      if (error) throw error;
      return data ? await this.resolveBrandingAssets(data) : null;
    }

    async updateAgencyBranding(branding = {}) {
      const user = await this.ensureUserProfile();
      const client = this.requireClient();

      const { data, error } = await client
        .from('agency_branding')
        .upsert(brandingPayload(user.id, branding), { onConflict: 'user_id' })
        .select('*')
        .single();

      if (error) throw error;
      return this.resolveBrandingAssets(data);
    }

    async upsertAgencyBranding(branding = {}) {
      return this.updateAgencyBranding(branding);
    }

    async resolveBrandingAssetUrl(value, expiresIn = 60 * 60 * 24 * 7) {
      const path = cleanText(value);
      if (!path || isExternalUrl(path)) return path;

      const client = this.requireClient();
      const { data, error } = await client.storage
        .from(BRANDING_BUCKET)
        .createSignedUrl(path, expiresIn);

      if (error) throw error;
      return data?.signedUrl || '';
    }

    async resolveBrandingAssets(record = {}) {
      const data = { ...record };
      if (data.logo_url && !isExternalUrl(data.logo_url)) {
        data.logo_storage_path = data.logo_url;
        data.logo_resolved_url = await this.resolveBrandingAssetUrl(data.logo_url).catch(() => '');
      }
      if (data.favicon_url && !isExternalUrl(data.favicon_url)) {
        data.favicon_storage_path = data.favicon_url;
        data.favicon_resolved_url = await this.resolveBrandingAssetUrl(data.favicon_url).catch(() => '');
      }
      return data;
    }

    async uploadBrandingAsset(kind, file) {
      const user = await this.requireUser();
      const client = this.requireClient();
      const safeKind = kind === 'favicon' ? 'favicon' : 'logo';
      const extension = extensionFromFile(file, safeKind === 'favicon' ? 'ico' : 'png');
      const contentType = file?.type || contentTypeFromExtension(extension);
      const path = `${user.id}/${safeKind}.${extension}`;

      const { error } = await client.storage
        .from(BRANDING_BUCKET)
        .upload(path, file, {
          cacheControl: '3600',
          contentType,
          upsert: true,
        });

      if (error) throw error;

      return {
        path,
        signedUrl: await this.resolveBrandingAssetUrl(path),
      };
    }

    async removeBrandingAsset(path) {
      const user = await this.requireUser();
      const cleanPath = cleanText(path);
      if (!cleanPath || isExternalUrl(cleanPath) || !cleanPath.startsWith(`${user.id}/`)) return true;

      const client = this.requireClient();
      const { error } = await client.storage
        .from(BRANDING_BUCKET)
        .remove([cleanPath]);

      if (error) throw error;
      return true;
    }

    async getSubscription() {
      const payload = await this.serverJson('/api/billing/subscription');
      return payload.subscription || null;
    }

    async createCheckoutSession(options = {}) {
      return this.serverJson('/api/billing/checkout', {
        method: 'POST',
        body: options,
      });
    }

    async startPaidSubscriptionNow() {
      return this.serverJson('/api/billing/start-paid-now', {
        method: 'POST',
        body: {},
      });
    }

    async createBillingPortalSession() {
      return this.serverJson('/api/billing/portal', {
        method: 'POST',
        body: {},
      });
    }

    async runAudit({ url, idempotencyKey, debug = false } = {}) {
      return this.serverJson('/api/analyze', {
        method: 'POST',
        headers: {
          'X-Audit-Idempotency-Key': idempotencyKey || clientRequestId('audit'),
        },
        body: {
          url,
          ...(debug && { debug: true }),
        },
      });
    }

    async downloadReportPdf(reportId) {
      return this.serverBlob(`/api/reports/${encodeURIComponent(reportId)}/pdf`, {
        fileName: 'website-assessment.pdf',
      });
    }
  }

  window.DatabaseService = DatabaseService;
})();
