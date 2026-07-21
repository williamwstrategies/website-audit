(function () {
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
      logo_url: cleanText(branding.logoUrl || branding.logo_url),
      primary_color: cleanText(branding.primaryAccent || branding.primary_color),
      secondary_color: cleanText(branding.secondaryAccent || branding.secondary_color),
      website: cleanText(branding.website),
      email: cleanText(branding.email),
      phone: cleanText(branding.phone),
      booking_link: cleanText(branding.bookingLink || branding.booking_link),
      favicon_url: cleanText(branding.faviconUrl || branding.favicon_url),
      tagline: cleanText(branding.tagline),
      disclaimer: cleanText(branding.reportDisclaimer || branding.disclaimer),
    };
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
      return data || null;
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
      return data;
    }

    async upsertAgencyBranding(branding = {}) {
      return this.updateAgencyBranding(branding);
    }

    async getSubscription() {
      const user = await this.requireUser();
      const client = this.requireClient();
      const { data, error } = await client
        .from('subscriptions')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();

      if (error) throw error;
      return data || null;
    }
  }

  window.DatabaseService = DatabaseService;
})();
