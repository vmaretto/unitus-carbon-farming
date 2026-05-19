// api/prof-carbonio-avatar.js
// Backend per la modalita' avatar di Prof. Carbonio (HeyGen Streaming Avatar).
//
// Env richieste:
//   HEYGEN_API_KEY    (chiave del tuo account HeyGen Team Unlimited)
//   HEYGEN_AVATAR_ID  (per il Master: 1402006ac8c7459d97ae9e1dce024fb7)
//
// L'avatar gira in modalita' "REPEAT": HeyGen renderizza il video e fa il TTS,
// noi controlliamo cosa dice via SDK speak({task_type:'repeat'}). Il "cervello"
// arriva da /api/tutor/sessions/:id/messages (Claude Haiku + RAG).

const HEYGEN_TOKEN_URL = 'https://api.heygen.com/v1/streaming.create_token';

// Avatar di Prof. Carbonio (signore con barba in mezzo al campo)
const DEFAULT_AVATAR_ID = '1402006ac8c7459d97ae9e1dce024fb7';

/**
 * Richiede un session token a HeyGen Streaming Avatar.
 * Il token e' a uso singolo, scade in ~60s, va passato all'SDK lato browser.
 *
 * @param {object} opts
 * @param {string} [opts.avatarId] - se omesso, prende da env o default
 * @param {string} [opts.language='it']
 * @returns {Promise<{sessionToken, avatarId}>}
 */
async function getHeygenSessionToken(opts = {}) {
  const apiKey = process.env.HEYGEN_API_KEY || process.env.LIVEAVATAR_API_KEY;
  if (!apiKey) {
    const err = new Error('HEYGEN_API_KEY not configured');
    err.status = 503;
    throw err;
  }

  const avatarId = opts.avatarId
    || process.env.HEYGEN_AVATAR_ID
    || process.env.LIVEAVATAR_AVATAR_ID
    || DEFAULT_AVATAR_ID;

  const response = await fetch(HEYGEN_TOKEN_URL, {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json'
    },
    // L'endpoint create_token non richiede body; alcuni esempi passano {}
    body: '{}'
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error('[prof-carbonio-avatar] HeyGen API error:', response.status, data);
    const err = new Error(data?.message || data?.error || `HeyGen API error (${response.status})`);
    err.status = response.status;
    throw err;
  }

  // Formato risposta HeyGen: { data: { token: "..." }, error: null }
  const token = data?.data?.token;
  if (!token) {
    console.error('[prof-carbonio-avatar] Unexpected HeyGen response:', data);
    const err = new Error('Unexpected response from HeyGen API');
    err.status = 502;
    throw err;
  }

  return {
    sessionToken: token,
    avatarId,
    language: opts.language || 'it'
  };
}

// Alias retrocompatibile (se qualcosa importa il vecchio nome)
const getLiveAvatarSessionToken = getHeygenSessionToken;

/**
 * Variante della risposta Claude pensata per la voce:
 * rimuove i marker di citazione [^N] dal testo che verra' pronunciato dall'avatar
 * (suonerebbero malissimo letti ad alta voce), ma li ritorna a parte cosi' la UI
 * puo' mostrarli nel pannello laterale.
 */
function stripCitationMarkers(text) {
  if (!text) return { spoken: '', markers: [] };
  const markers = [];
  const regex = /\[\^(\d+)\]/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    markers.push(parseInt(m[1], 10));
  }
  const spoken = text.replace(/\s*\[\^\d+\]/g, '').replace(/\s{2,}/g, ' ').trim();
  return { spoken, markers };
}

module.exports = {
  DEFAULT_AVATAR_ID,
  getHeygenSessionToken,
  getLiveAvatarSessionToken,  // alias retrocompatibile
  stripCitationMarkers
};
