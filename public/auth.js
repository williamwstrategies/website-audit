(function () {
  const AUTH_CONFIG_URL = '/api/auth-config';
  const LOGIN_REDIRECT_PATH = '/login';
  const RESET_PASSWORD_PATH = '/reset-password';

  function appOrigin() {
    return window.location.origin;
  }

  function authRedirect(path) {
    return `${appOrigin()}${path}`;
  }

  function normalizeSupabaseUrl(rawUrl) {
    return String(rawUrl || '')
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/rest\/v1$/i, '')
      .replace(/\/auth\/v1$/i, '');
  }

  class AuthProvider {
    constructor(options = {}) {
      this.onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
      this.client = null;
      this.config = null;
      this.session = null;
      this.user = null;
      this.ready = false;
      this.error = '';
    }

    async init() {
      try {
        const response = await fetch(AUTH_CONFIG_URL, { cache: 'no-store' });
        if (!response.ok) throw new Error('Could not load authentication configuration.');
        this.config = await response.json();
        this.config.supabaseUrl = normalizeSupabaseUrl(this.config.supabaseUrl);

        if (!this.config.supabaseUrl || !this.config.supabaseAnonKey) {
          this.error = 'Supabase is not configured yet. Add SUPABASE_URL and SUPABASE_ANON_KEY in Render.';
          this.ready = true;
          this.onChange('CONFIG_MISSING', null);
          return this;
        }

        if (!window.supabase?.createClient) {
          this.error = 'Supabase client failed to load. Check the network connection and CDN access.';
          this.ready = true;
          this.onChange('CLIENT_MISSING', null);
          return this;
        }

        this.client = window.supabase.createClient(
          this.config.supabaseUrl,
          this.config.supabaseAnonKey,
          {
            auth: {
              autoRefreshToken: true,
              persistSession: true,
              detectSessionInUrl: true,
            },
          }
        );

        this.client.auth.onAuthStateChange((event, session) => {
          this.session = session || null;
          this.user = session?.user || null;

          if (event === 'PASSWORD_RECOVERY' && !window.location.pathname.startsWith(RESET_PASSWORD_PATH)) {
            window.history.replaceState({}, '', RESET_PASSWORD_PATH);
          }

          this.onChange(event, session);
        });

        const { data, error } = await this.client.auth.getSession();
        if (error) throw error;

        this.session = data?.session || null;
        this.user = this.session?.user || null;
        this.ready = true;
        this.onChange('INITIAL_SESSION', this.session);
      } catch (error) {
        this.error = error?.message || 'Authentication could not start.';
        this.ready = true;
        this.onChange('AUTH_ERROR', null);
      }

      return this;
    }

    isConfigured() {
      return !!this.client && !this.error;
    }

    isAuthenticated() {
      return !!this.session?.user;
    }

    getUser() {
      return this.user || null;
    }

    getUserEmail() {
      return this.user?.email || '';
    }

    requireClient() {
      if (!this.client) throw new Error(this.error || 'Supabase is not configured.');
      return this.client;
    }

    async signUp({ name, email, password }) {
      const client = this.requireClient();
      return client.auth.signUp({
        email,
        password,
        options: {
          data: { name },
          emailRedirectTo: authRedirect(LOGIN_REDIRECT_PATH),
        },
      });
    }

    async signIn({ email, password }) {
      const client = this.requireClient();
      return client.auth.signInWithPassword({ email, password });
    }

    async signOut() {
      const client = this.requireClient();
      return client.auth.signOut();
    }

    async sendPasswordReset(email) {
      const client = this.requireClient();
      return client.auth.resetPasswordForEmail(email, {
        redirectTo: authRedirect(RESET_PASSWORD_PATH),
      });
    }

    async updatePassword(password) {
      const client = this.requireClient();
      return client.auth.updateUser({ password });
    }

    async resendVerification(email) {
      const client = this.requireClient();
      return client.auth.resend({
        type: 'signup',
        email,
        options: {
          emailRedirectTo: authRedirect(LOGIN_REDIRECT_PATH),
        },
      });
    }
  }

  window.AuthProvider = AuthProvider;
})();
