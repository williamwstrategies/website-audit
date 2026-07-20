(function () {
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

    profilePayload(user) {
      return {
        id: user.id,
        email: user.email || '',
        name: cleanText(user.user_metadata?.name),
      };
    }

    async ensureUserProfile(user = null) {
      const currentUser = user || await this.requireUser();
      if (this.profileSyncedFor === currentUser.id) return currentUser;

      const client = this.requireClient();
      const { error } = await client
        .from('users')
        .upsert(this.profilePayload(currentUser), { onConflict: 'id' });

      if (error) throw error;
      this.profileSyncedFor = currentUser.id;
      return currentUser;
    }

    async saveReport({ website, websiteScore, reportData }) {
      const user = await this.ensureUserProfile();
      const client = this.requireClient();
      const payload = {
        user_id: user.id,
        website: cleanText(website),
        website_score: scoreValue(websiteScore),
        report_data: toJson(reportData),
      };

      if (!payload.website) throw new Error('Report website is required.');

      const { data, error } = await client
        .from('reports')
        .insert(payload)
        .select('id, website, website_score, created_at, updated_at')
        .single();

      if (error) throw error;
      return data;
    }

    async listReports({ search = '', sort = 'created_at.desc', limit = 25 } = {}) {
      const user = await this.requireUser();
      const client = this.requireClient();
      const [column = 'created_at', direction = 'desc'] = String(sort).split('.');

      let query = client
        .from('reports')
        .select('id, website, website_score, created_at, updated_at')
        .eq('user_id', user.id)
        .order(column, { ascending: direction === 'asc' })
        .limit(limit);

      const term = cleanText(search);
      if (term) query = query.ilike('website', `%${term}%`);

      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    }

    async getReport(reportId) {
      const user = await this.requireUser();
      const client = this.requireClient();
      const { data, error } = await client
        .from('reports')
        .select('*')
        .eq('user_id', user.id)
        .eq('id', reportId)
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
      const report = await this.getReport(reportId);
      return this.saveReport({
        website: report.website,
        websiteScore: report.website_score,
        reportData: report.report_data,
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

    async upsertAgencyBranding(branding) {
      const user = await this.ensureUserProfile();
      const client = this.requireClient();
      const payload = {
        user_id: user.id,
        agency_name: cleanText(branding.agencyName),
        logo: cleanText(branding.logoUrl),
        primary_color: cleanText(branding.primaryAccent),
        secondary_color: cleanText(branding.secondaryAccent),
        website: cleanText(branding.website),
        phone: cleanText(branding.phone),
        email: cleanText(branding.email),
        booking_link: cleanText(branding.bookingLink),
        favicon: cleanText(branding.faviconUrl),
        tagline: cleanText(branding.tagline),
        report_disclaimer: cleanText(branding.reportDisclaimer),
      };

      const { data, error } = await client
        .from('agency_branding')
        .upsert(payload, { onConflict: 'user_id' })
        .select('*')
        .single();

      if (error) throw error;
      return data;
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
