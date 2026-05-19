// api/prof-carbonio-avatar.js
// Backend per la modalita' avatar di Prof. Carbonio (HeyGen LiveAvatar).
// Porting da azzurra-wrapper/api/liveavatar-session.js.
//
// Env richieste:
//   LIVEAVATAR_API_KEY   (la stessa di Azzurra, hai gia' l'account)
//   LIVEAVATAR_AVATAR_ID (per il Master: 1402006ac8c7459d97ae9e1dce024fb7)
//
// L'avatar gira in modalita' "CUSTOM": HeyGen gestisce STT+TTS+rendering video,
// noi gestiamo il "cervello" via /api/tutor/sessions/:id/messages (gia' esistente,
// con Claude Haiku + RAG sulla KB di Prof. Carbonio).

const LIVEAVATAR_API_URL = 'https://api.liveavatar.com/v1/sessions/token';

// Avatar di Prof. Carbonio (signore con barba in mezzo al campo)
const DEFAULT_AVATAR_ID = '1402006ac8c7459d97ae9e1dce024fb7';

/**
 * Richiede un session token a LiveAvatar.
 * Il token e' a uso singolo, scade in ~60 secondi, va passato all'SDK lato browser.
 *
 * @param {object} opts
 * @param {string} [opts.avatarId] - se omesso, prende da env o default
 * @param {string} [opts.language='it']
 * @returns {Promise<{sessionToken, sessionId}>}
 */
async function getLiveAvatarSessionToken(opts = {}) {
  const apiKey = process.env.LIVEAVATAR_API_KEY || process.env.HEYGEN_API_KEY;
  if (!apiKey) {
    const err = new Error('LIVEAVATAR_API_KEY not configured');
    err.status = 503;
    throw err;
  }

  const avatarId = opts.avatarId
    || process.env.LIVEAVATAR_AVATAR_ID
    || DEFAULT_AVATAR_ID;

  const language = opts.language || 'it';

  const body = {
    mode: 'FULL', // HeyGen gestisce STT+TTS, noi solo brain via repeat()
    avatar_id: avatarId,
    avatar_persona: {
      context_id: process.env.LIVEAVATAR_CONTEXT_ID || undefined,
      language
    }
  };

  const response = await fetch(LIVEAVATAR_API_URL, {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error('[prof-carbonio-avatar] LiveAvatar API error:', response.status, data);
    const err = new Error(data?.message || data?.error || `LiveAvatar API error (${response.status})`);
    err.status = response.status;
    throw err;
  }

  // La risposta e' annidata: data.data.session_token
  const sessionData = data?.data;
  if (!sessionData || !sessionData.session_token) {
    console.error('[prof-carbonio-avatar] Unexpected LiveAvatar response:', data);
    const err = new Error('Unexpected response from LiveAvatar API');
    err.status = 502;
    throw err;
  }

  return {
    sessionToken: sessionData.session_token,
    sessionId: sessionData.session_id,
    avatarId
  };
}

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
  getLiveAvatarSessionToken,
  stripCitationMarkers
};
