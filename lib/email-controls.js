function cleanText(value = '') {
  return String(value || '').trim();
}

function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(cleanText(process.env[name]));
}

function outboundEmailsPaused() {
  return envFlag('OUTBOUND_EMAILS_PAUSED') || envFlag('EMAILS_PAUSED') || envFlag('PAUSE_EMAILS');
}

function pausedEmailResult(extra = {}) {
  return {
    configured: false,
    sent: false,
    paused: true,
    error: '',
    id: '',
    ...extra,
  };
}

module.exports = {
  cleanText,
  envFlag,
  outboundEmailsPaused,
  pausedEmailResult,
};
