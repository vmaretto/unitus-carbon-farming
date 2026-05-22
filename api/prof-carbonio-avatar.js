// api/prof-carbonio-avatar.js
// Backend per la modalita' avatar di Prof. Carbonio (HeyGen Streaming Avatar).
// Nota: HeyGen ha annunciato il sunset di Interactive Avatar al 31/03/2026.
// Questo modulo resta utile per verificare se l'account ha ancora accesso
// all'API streaming legacy; in caso di 410 l'endpoint non e' piu' disponibile
// per la chiave/piano in uso.
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

  const rawText = await response.text();
  let data = {};
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch (_) {
    data = { raw: rawText };
  }

  if (!response.ok) {
    console.error('[prof-carbonio-avatar] HeyGen API error:', response.status, data);
    const message = typeof data?.message === 'string'
      ? data.message
      : typeof data?.error === 'string'
        ? data.error
        : data?.error?.message
          ? data.error.message
          : `HeyGen API error (${response.status})`;
    const err = new Error(message);
    err.status = response.status;
    err.provider = 'heygen';
    err.details = data;
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

// =============================================================================
// LiveAvatar (ex-HeyGen, app.liveavatar.com) - prodotto streaming "nuovo"
// Diverso da HeyGen Streaming Avatar:
//  - Endpoint: api.liveavatar.com/v1/sessions/token (non api.heygen.com)
//  - SDK: @heygen/liveavatar-web-sdk (NON @heygen/streaming-avatar)
//  - Modalita' FULL = voice chat integrata con STT lato SDK
//  - Pattern: new LiveAvatarSession(token, opts), .start(), .repeat(text), .stop()
// =============================================================================
const LIVEAVATAR_TOKEN_URL = 'https://api.liveavatar.com/v1/sessions/token';

async function getLiveAvatarSessionToken(opts = {}) {
  const apiKey = (process.env.LIVEAVATAR_API_KEY || process.env.HEYGEN_API_KEY || '').trim();
  if (!apiKey) {
    const err = new Error('LIVEAVATAR_API_KEY not configured');
    err.status = 503;
    throw err;
  }

  const avatarId = opts.avatarId
    || process.env.LIVEAVATAR_AVATAR_ID
    || process.env.HEYGEN_AVATAR_ID
    || DEFAULT_AVATAR_ID;

  const contextId = (opts.contextId || process.env.LIVEAVATAR_CONTEXT_ID || '').trim() || null;
  const language = opts.language || 'it';

  const body = {
    mode: 'FULL',
    avatar_id: avatarId,
    avatar_persona: {
      ...(contextId ? { context_id: contextId } : {}),
      language
    }
  };

  const response = await fetch(LIVEAVATAR_TOKEN_URL, {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const rawText = await response.text();
  let data = {};
  try { data = rawText ? JSON.parse(rawText) : {}; } catch (_) { data = { raw: rawText }; }

  if (!response.ok) {
    console.error('[prof-carbonio-avatar] LiveAvatar API error:', response.status, data);
    const message = typeof data?.message === 'string'
      ? data.message
      : typeof data?.error === 'string'
        ? data.error
        : data?.error?.message
          ? data.error.message
          : `LiveAvatar API error (${response.status})`;
    const err = new Error(message);
    err.status = response.status;
    err.provider = 'liveavatar';
    err.details = data;
    throw err;
  }

  // Formato risposta LiveAvatar: { data: { session_token, session_id, ... } }
  const sessionToken = data?.data?.session_token || data?.session_token;
  const sessionId   = data?.data?.session_id   || data?.session_id || null;
  if (!sessionToken) {
    console.error('[prof-carbonio-avatar] Unexpected LiveAvatar response:', data);
    const err = new Error('Unexpected response from LiveAvatar API');
    err.status = 502;
    throw err;
  }

  return { sessionToken, sessionId, avatarId, language, provider: 'liveavatar' };
}

/**
 * Variante della risposta Claude pensata per la voce: produce un testo "spoken"
 * pulito che l'avatar puo' pronunciare ad alta voce senza pasticci. Rimuove:
 *  - marker di citazione [^N] e [N] (Claude haiku spesso omette il caret)
 *  - asterischi del markdown **bold**, *italic*, __bold__, _italic_
 *  - backtick di `code`
 *  - simboli markdown a inizio riga (#, >, -, *, 1.) e link [testo](url) -> testo
 * Ritorna anche l'array dei numeri citazione trovati per la UI.
 */
function stripCitationMarkers(text) {
  if (!text) return { spoken: '', markers: [] };
  const markers = [];
  // Estrai i numeri sia da [^N] sia da [N] (solo numeri puri, non link markdown)
  const citeRegex = /\[\^?(\d+)\]/g;
  let m;
  while ((m = citeRegex.exec(text)) !== null) {
    markers.push(parseInt(m[1], 10));
  }
  let spoken = text;
  // Rimuovi marker citazione [^N] e [N] (con eventuale spazio davanti)
  spoken = spoken.replace(/\s*\[\^?\d+\]/g, '');
  // Link markdown [testo](url) -> tieni solo "testo"
  spoken = spoken.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Bold/italic markdown: **x** *x* __x__ _x_ -> x
  spoken = spoken.replace(/\*\*(.+?)\*\*/g, '$1');
  spoken = spoken.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, '$1');
  spoken = spoken.replace(/__(.+?)__/g, '$1');
  spoken = spoken.replace(/(?<!\w)_(.+?)_(?!\w)/g, '$1');
  // Inline code: `x` -> x
  spoken = spoken.replace(/`([^`]+)`/g, '$1');
  // Heading e blockquote a inizio riga (#, ##, >)
  spoken = spoken.replace(/^[ \t]*#{1,6}\s+/gm, '');
  spoken = spoken.replace(/^[ \t]*>\s?/gm, '');
  // Bullet a inizio riga (- *  -> spazio)
  spoken = spoken.replace(/^[ \t]*[-*+]\s+/gm, '');
  // Numerati a inizio riga (1.  2.) -> rimuovi numero, lascia testo
  spoken = spoken.replace(/^[ \t]*\d+[.)]\s+/gm, '');
  // Compatta spazi/newline multipli
  spoken = spoken.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { spoken, markers };
}

module.exports = {
  DEFAULT_AVATAR_ID,
  getHeygenSessionToken,
  getLiveAvatarSessionToken,
  stripCitationMarkers
};
