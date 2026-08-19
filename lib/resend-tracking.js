const RESEND_API_BASE = 'https://api.resend.com';
let trackingSetupPromise = null;

function cleanText(value = '') {
  return String(value || '').trim();
}

function envFlag(name, fallback = false) {
  const raw = cleanText(process.env[name]);
  if (!raw) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function resendDomainId() {
  return cleanText(process.env.RESEND_DOMAIN_ID);
}

function trackingSubdomain() {
  return cleanText(process.env.RESEND_TRACKING_SUBDOMAIN || 'links');
}

function trackingAutoConfigureEnabled() {
  return envFlag('RESEND_TRACKING_AUTO_CONFIGURE', true);
}

async function configureResendTracking(apiKey) {
  const domainId = resendDomainId();
  if (!apiKey || !domainId || !trackingAutoConfigureEnabled()) {
    return { configured: false, skipped: true };
  }

  const response = await fetch(`${RESEND_API_BASE}/domains/${encodeURIComponent(domainId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'pitchproof/1.0',
    },
    body: JSON.stringify({
      open_tracking: true,
      click_tracking: true,
      tracking_subdomain: trackingSubdomain(),
    }),
  });

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    const message = body?.message || body?.error || body?.hint || 'Resend tracking could not be configured.';
    throw new Error(`${message} HTTP ${response.status}`);
  }

  return {
    configured: true,
    open_tracking: body?.open_tracking === true,
    click_tracking: body?.click_tracking === true,
    tracking_subdomain: body?.tracking_subdomain || trackingSubdomain(),
    status: body?.status || '',
    records: Array.isArray(body?.records) ? body.records : [],
  };
}

function ensureResendTrackingEnabled(apiKey) {
  if (!apiKey || !resendDomainId() || !trackingAutoConfigureEnabled()) return Promise.resolve({ configured: false, skipped: true });
  if (!trackingSetupPromise) {
    trackingSetupPromise = configureResendTracking(apiKey).catch(error => {
      console.warn('[PitchProof] Resend tracking setup skipped:', error?.message || error);
      return { configured: false, skipped: false, error: error?.message || 'Resend tracking setup failed.' };
    });
  }
  return trackingSetupPromise;
}

module.exports = {
  ensureResendTrackingEnabled,
};
