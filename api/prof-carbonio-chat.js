// api/prof-carbonio-chat.js
// Chat handler RAG di Prof. Carbonio.
// Pattern derivato da azzurra-wrapper/api/chat.js, esteso con:
// - retrieval ibrido (semantico + FTS) anziche' solo semantico
// - citazioni estratte dalla risposta e persistite
// - tracking costo per ogni messaggio
// - rate limit per utente (tutor_usage_daily)
//
// Dipendenze iniettate: pool (pg), anthropic (SDK), openai (SDK).

const {
  searchKBHybrid
} = require('./prof-carbonio-search');

const {
  PROF_CARBONIO_SYSTEM_PROMPT,
  formatChunksContext,
  extractCitations
} = require('./prof-carbonio-prompt');

// ----------------------------------------------------------------------------
// CONFIG
// ----------------------------------------------------------------------------
// Claude Haiku 4.5: stesso modello usato in azzurra-wrapper (line 420 di chat.js)
// Costo: $0.80/MTok input, $4/MTok output (frazioni di centesimo per messaggio).
const CHAT_MODEL = 'claude-haiku-4-5-20251001';
const MAX_OUTPUT_TOKENS = 700;
const MAX_HISTORY_MESSAGES = 8; // ultimi N messaggi in contesto

// Prezzi in $/Mtok (aggiornare se cambia il modello)
const COST_INPUT_PER_MTOK = 0.80;
const COST_OUTPUT_PER_MTOK = 4.00;

// Rate limit: domande/giorno per studente
const DAILY_MESSAGE_LIMIT = parseInt(process.env.TUTOR_DAILY_LIMIT || '50', 10);

// ----------------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------------

function estimateCostCents(tokensIn, tokensOut) {
  const usd = (tokensIn / 1_000_000) * COST_INPUT_PER_MTOK
            + (tokensOut / 1_000_000) * COST_OUTPUT_PER_MTOK;
  // 1 USD ≈ 0.92 EUR (approssimazione conservativa per budget tracking)
  const eur = usd * 0.92;
  return Math.round(eur * 10000) / 100; // cents con 2 decimali
}

/**
 * Atomico: incrementa il contatore giornaliero. Se supera DAILY_MESSAGE_LIMIT,
 * fa rollback decrementando e ritorna { allowed: false }.
 */
async function checkAndIncrementUsage(pool, userId) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const { rows } = await pool.query(
    `INSERT INTO tutor_usage_daily (user_id, day, message_count)
     VALUES ($1, $2, 1)
     ON CONFLICT (user_id, day)
     DO UPDATE SET message_count = tutor_usage_daily.message_count + 1
     RETURNING message_count`,
    [userId, today]
  );

  const count = rows[0].message_count;
  if (count > DAILY_MESSAGE_LIMIT) {
    // Rollback
    await pool.query(
      `UPDATE tutor_usage_daily
          SET message_count = message_count - 1
        WHERE user_id = $1 AND day = $2`,
      [userId, today]
    );
    return { allowed: false, used: count - 1, limit: DAILY_MESSAGE_LIMIT };
  }
  return { allowed: true, used: count, limit: DAILY_MESSAGE_LIMIT };
}

async function recordUsage(pool, userId, tokensIn, tokensOut, costCents) {
  const today = new Date().toISOString().slice(0, 10);
  await pool.query(
    `UPDATE tutor_usage_daily
        SET tokens_in = tokens_in + $3,
            tokens_out = tokens_out + $4,
            cost_cents = cost_cents + $5
      WHERE user_id = $1 AND day = $2`,
    [userId, today, tokensIn, tokensOut, costCents]
  );
}

// ----------------------------------------------------------------------------
// CHAT HANDLER PRINCIPALE
// ----------------------------------------------------------------------------

/**
 * Crea una nuova sessione di chat per uno studente.
 */
async function createSession(pool, { userId, language = 'it', firstMessage = null }) {
  const title = firstMessage
    ? firstMessage.slice(0, 80) + (firstMessage.length > 80 ? '…' : '')
    : 'Nuova conversazione';

  const { rows } = await pool.query(
    `INSERT INTO tutor_sessions (user_id, audience, language, title)
     VALUES ($1, 'student', $2, $3)
     RETURNING id, user_id, audience, language, title, created_at`,
    [userId, language, title]
  );
  return rows[0];
}

async function getSession(pool, sessionId, userId) {
  const { rows } = await pool.query(
    `SELECT id, user_id, audience, language, title, created_at, last_message_at
       FROM tutor_sessions
      WHERE id = $1 AND user_id = $2`,
    [sessionId, userId]
  );
  return rows[0] || null;
}

async function getRecentMessages(pool, sessionId, limit = MAX_HISTORY_MESSAGES) {
  const { rows } = await pool.query(
    `SELECT id, role, content, citations, created_at
       FROM tutor_messages
      WHERE session_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [sessionId, limit]
  );
  return rows.reverse(); // ordine cronologico
}

/**
 * Esegue un turno conversazionale completo:
 * 1. Verifica rate limit
 * 2. Salva il messaggio utente
 * 3. Recupera chunk rilevanti dalla KB (retrieval ibrido)
 * 4. Costruisce il prompt e chiama Claude Haiku
 * 5. Estrae citazioni, persiste il messaggio assistant
 * 6. Aggiorna usage e last_message_at
 *
 * @param {object} deps - { pool, anthropic, openai }
 * @param {object} args - { sessionId, userId, userMessage, language }
 * @returns {object} { reply, citations, messageId, usage, latencyMs }
 */
async function chatTurn(deps, args) {
  const { pool, anthropic, openai } = deps;
  const { sessionId, userId, userMessage, language = 'it' } = args;

  if (!userMessage?.trim()) {
    throw new Error('Empty user message');
  }

  const session = await getSession(pool, sessionId, userId);
  if (!session) {
    const err = new Error('Session not found or access denied');
    err.status = 404;
    throw err;
  }

  // 1) Rate limit
  const usage = await checkAndIncrementUsage(pool, userId);
  if (!usage.allowed) {
    const err = new Error(
      `Hai raggiunto il limite giornaliero di ${usage.limit} domande. Torna domani o usa la chat con il docente.`
    );
    err.status = 429;
    err.usage = usage;
    throw err;
  }

  const startedAt = Date.now();

  // 2) Persiste subito il messaggio utente
  const { rows: userRows } = await pool.query(
    `INSERT INTO tutor_messages (session_id, role, content)
     VALUES ($1, 'user', $2)
     RETURNING id, created_at`,
    [sessionId, userMessage.trim()]
  );
  const userMessageId = userRows[0].id;

  // 3) Recupera chunk rilevanti (ricerca ibrida semantica + FTS)
  let chunks = [];
  try {
    chunks = await searchKBHybrid(pool, openai, userMessage, {
      matchCount: 5,
      language
    });
  } catch (err) {
    console.error('KB search error:', err.message);
    // continuiamo con KB vuota: Claude lo gestisce dicendo "non lo so"
  }

  // 4) Recupera history conversazione
  const history = await getRecentMessages(pool, sessionId, MAX_HISTORY_MESSAGES);
  // Escludi il messaggio user appena inserito (lo passiamo a parte)
  const historyForPrompt = history
    .filter(m => m.id !== userMessageId)
    .map(m => ({ role: m.role, content: m.content }));

  // 5) Costruisci system prompt con FONTI
  const systemPrompt = PROF_CARBONIO_SYSTEM_PROMPT + formatChunksContext(chunks);

  // 6) Chiama Claude Haiku
  const claudeResponse = await anthropic.messages.create({
    model: CHAT_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: systemPrompt,
    messages: [
      ...historyForPrompt,
      { role: 'user', content: userMessage.trim() }
    ]
  });

  const replyText = claudeResponse.content[0]?.text || '';
  const tokensIn = claudeResponse.usage?.input_tokens || 0;
  const tokensOut = claudeResponse.usage?.output_tokens || 0;
  const costCents = estimateCostCents(tokensIn, tokensOut);
  const latencyMs = Date.now() - startedAt;

  // 7) Estrai citazioni dalla risposta
  const citations = extractCitations(replyText, chunks);
  const retrievedChunkIds = chunks.map(c => c.chunk_id);

  // 8) Persiste messaggio assistant
  const { rows: assistantRows } = await pool.query(
    `INSERT INTO tutor_messages
       (session_id, role, content, citations, retrieved_chunk_ids,
        tokens_in, tokens_out, cost_cents, model, latency_ms)
     VALUES ($1, 'assistant', $2, $3::jsonb, $4::uuid[], $5, $6, $7, $8, $9)
     RETURNING id, created_at`,
    [
      sessionId,
      replyText,
      JSON.stringify(citations),
      retrievedChunkIds,
      tokensIn,
      tokensOut,
      costCents,
      CHAT_MODEL,
      latencyMs
    ]
  );
  const assistantMessageId = assistantRows[0].id;

  // 9) Update aggregati
  await Promise.all([
    pool.query(
      `UPDATE tutor_sessions SET last_message_at = NOW() WHERE id = $1`,
      [sessionId]
    ),
    recordUsage(pool, userId, tokensIn, tokensOut, costCents)
  ]);

  return {
    sessionId,
    userMessageId,
    messageId: assistantMessageId,
    reply: replyText,
    citations,
    usage: {
      tokensIn,
      tokensOut,
      costCents,
      messagesUsedToday: usage.used,
      dailyLimit: usage.limit
    },
    latencyMs,
    retrievedChunks: chunks.length
  };
}

/**
 * Escalation: lo studente vuole inoltrare la domanda al docente perche'
 * Prof. Carbonio non ha risposto bene o l'argomento e' troppo specifico.
 * Crea una riga in student_questions collegata al messaggio originale.
 *
 * @param {Pool} pool
 * @param {object} args - { messageId, userId, lmsLessonId?, moduleId? }
 */
async function escalateToTeacher(pool, args) {
  const { messageId, userId, lmsLessonId = null, moduleId = null } = args;

  // Recupera il contenuto del messaggio user precedente nello stesso flusso
  const { rows: msgRows } = await pool.query(
    `SELECT m.session_id, m.content AS assistant_content,
            (SELECT content FROM tutor_messages
              WHERE session_id = m.session_id
                AND role = 'user'
                AND created_at < m.created_at
              ORDER BY created_at DESC
              LIMIT 1) AS user_question,
            s.user_id
       FROM tutor_messages m
       JOIN tutor_sessions s ON s.id = m.session_id
      WHERE m.id = $1 AND m.role = 'assistant'`,
    [messageId]
  );

  if (!msgRows.length) {
    const err = new Error('Message not found');
    err.status = 404;
    throw err;
  }
  const msg = msgRows[0];
  if (msg.user_id !== userId) {
    const err = new Error('Access denied');
    err.status = 403;
    throw err;
  }

  const questionText = msg.user_question || msg.assistant_content;

  const { rows } = await pool.query(
    `INSERT INTO student_questions
       (user_id, module_id, lms_lesson_id, question_text, escalated_from_message_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, status, created_at`,
    [userId, moduleId, lmsLessonId, questionText, messageId]
  );

  return rows[0];
}

module.exports = {
  CHAT_MODEL,
  DAILY_MESSAGE_LIMIT,
  createSession,
  getSession,
  getRecentMessages,
  chatTurn,
  escalateToTeacher,
  estimateCostCents
};
