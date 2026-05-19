// api/prof-carbonio-routes.js
// Espone le route HTTP di Prof. Carbonio.
// Si registra in api/index.js con una sola riga:
//
//   const { registerProfCarbonioRoutes } = require('./prof-carbonio-routes');
//   registerProfCarbonioRoutes(app, { pool, anthropic, openai, requireStudent, requireNonGuest });
//
// Le route richiedono autenticazione studente (requireStudent) e non-guest.

const {
  createSession,
  getSession,
  getRecentMessages,
  chatTurn,
  escalateToTeacher
} = require('./prof-carbonio-chat');

const {
  getLiveAvatarSessionToken,
  stripCitationMarkers
} = require('./prof-carbonio-avatar');

function registerProfCarbonioRoutes(app, deps) {
  const { pool, anthropic, openai, requireStudent, requireNonGuest } = deps;

  if (!app) throw new Error('Express app required');
  if (!requireStudent || !requireNonGuest) {
    throw new Error('Auth middlewares (requireStudent, requireNonGuest) required');
  }

  function ensureDb(res) {
    if (!pool) {
      res.status(503).json({ error: 'Database not configured' });
      return false;
    }
    if (!anthropic) {
      res.status(503).json({ error: 'Anthropic API key not configured' });
      return false;
    }
    if (!openai) {
      res.status(503).json({ error: 'OpenAI API key not configured (needed for embeddings)' });
      return false;
    }
    return true;
  }

  // ===========================================================================
  // POST /api/tutor/sessions — crea nuova sessione di chat
  // ===========================================================================
  app.post('/api/tutor/sessions', requireStudent, requireNonGuest, async (req, res) => {
    if (!ensureDb(res)) return;
    try {
      const { firstMessage = null, language = 'it' } = req.body || {};
      const session = await createSession(pool, {
        userId: req.user.userId,
        language,
        firstMessage
      });
      res.status(201).json({ session });
    } catch (err) {
      console.error('[tutor] createSession error:', err);
      res.status(500).json({ error: 'Failed to create session' });
    }
  });

  // ===========================================================================
  // GET /api/tutor/sessions — lista sessioni dell'utente
  // ===========================================================================
  app.get('/api/tutor/sessions', requireStudent, async (req, res) => {
    if (!ensureDb(res)) return;
    try {
      const { rows } = await pool.query(
        `SELECT id, title, language, created_at, last_message_at,
                (SELECT COUNT(*) FROM tutor_messages WHERE session_id = s.id) AS message_count
           FROM tutor_sessions s
          WHERE user_id = $1 AND audience = 'student'
          ORDER BY last_message_at DESC
          LIMIT 50`,
        [req.user.userId]
      );
      res.json({ sessions: rows });
    } catch (err) {
      console.error('[tutor] listSessions error:', err);
      res.status(500).json({ error: 'Failed to list sessions' });
    }
  });

  // ===========================================================================
  // GET /api/tutor/sessions/:id — dettaglio sessione + messaggi
  // ===========================================================================
  app.get('/api/tutor/sessions/:id', requireStudent, async (req, res) => {
    if (!ensureDb(res)) return;
    try {
      const session = await getSession(pool, req.params.id, req.user.userId);
      if (!session) return res.status(404).json({ error: 'Session not found' });

      const { rows: messages } = await pool.query(
        `SELECT id, role, content, citations, created_at
           FROM tutor_messages
          WHERE session_id = $1
          ORDER BY created_at ASC`,
        [req.params.id]
      );
      res.json({ session, messages });
    } catch (err) {
      console.error('[tutor] getSession error:', err);
      res.status(500).json({ error: 'Failed to fetch session' });
    }
  });

  // ===========================================================================
  // POST /api/tutor/sessions/:id/messages — turno conversazionale
  // ===========================================================================
  app.post('/api/tutor/sessions/:id/messages', requireStudent, requireNonGuest, async (req, res) => {
    if (!ensureDb(res)) return;
    try {
      const { message, language } = req.body || {};
      if (!message?.trim()) {
        return res.status(400).json({ error: 'message is required' });
      }

      const result = await chatTurn(
        { pool, anthropic, openai },
        {
          sessionId: req.params.id,
          userId: req.user.userId,
          userMessage: message,
          language: language || 'it'
        }
      );
      res.json(result);
    } catch (err) {
      const status = err.status || 500;
      console.error('[tutor] chatTurn error:', err.message);
      if (status === 429) {
        return res.status(429).json({ error: err.message, usage: err.usage });
      }
      res.status(status).json({ error: err.message || 'Chat turn failed' });
    }
  });

  // ===========================================================================
  // POST /api/tutor/messages/:id/escalate — inoltra al docente
  // ===========================================================================
  app.post('/api/tutor/messages/:id/escalate', requireStudent, requireNonGuest, async (req, res) => {
    if (!ensureDb(res)) return;
    try {
      const { lmsLessonId = null, moduleId = null } = req.body || {};
      const question = await escalateToTeacher(pool, {
        messageId: req.params.id,
        userId: req.user.userId,
        lmsLessonId,
        moduleId
      });
      res.status(201).json({ question });
    } catch (err) {
      const status = err.status || 500;
      console.error('[tutor] escalate error:', err.message);
      res.status(status).json({ error: err.message || 'Escalate failed' });
    }
  });

  // ===========================================================================
  // POST /api/tutor/avatar/session — token LiveAvatar per modalita' voce/avatar
  // ===========================================================================
  app.post('/api/tutor/avatar/session', requireStudent, requireNonGuest, async (req, res) => {
    try {
      const { language = 'it' } = req.body || {};
      const result = await getLiveAvatarSessionToken({ language });
      res.json(result);
    } catch (err) {
      const status = err.status || 500;
      console.error('[tutor] avatar session error:', err.message);
      res.status(status).json({ error: err.message });
    }
  });

  // ===========================================================================
  // POST /api/tutor/avatar/turn — turno conversazionale ottimizzato per voce
  // Differenze rispetto a /sessions/:id/messages:
  //  - rimuove i marker [^N] dal testo da pronunciare
  //  - ritorna "spoken" (per session.repeat) e "citations" (per pannello UI)
  // ===========================================================================
  app.post('/api/tutor/avatar/turn', requireStudent, requireNonGuest, async (req, res) => {
    if (!ensureDb(res)) return;
    try {
      const { sessionId, message, language = 'it' } = req.body || {};
      if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
      if (!message?.trim()) return res.status(400).json({ error: 'message required' });

      const result = await chatTurn(
        { pool, anthropic, openai },
        { sessionId, userId: req.user.userId, userMessage: message, language }
      );

      const { spoken } = stripCitationMarkers(result.reply);

      res.json({
        ...result,
        spoken,            // testo "pulito" da passare a LiveAvatar.repeat()
        replyWithMarkers: result.reply
      });
    } catch (err) {
      const status = err.status || 500;
      console.error('[tutor] avatar turn error:', err.message);
      if (status === 429) {
        return res.status(429).json({ error: err.message, usage: err.usage });
      }
      res.status(status).json({ error: err.message });
    }
  });

  // ===========================================================================
  // GET /api/tutor/usage — quota giornaliera utente
  // ===========================================================================
  app.get('/api/tutor/usage', requireStudent, async (req, res) => {
    if (!ensureDb(res)) return;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const { rows } = await pool.query(
        `SELECT message_count, tokens_in, tokens_out, cost_cents
           FROM tutor_usage_daily
          WHERE user_id = $1 AND day = $2`,
        [req.user.userId, today]
      );
      const limit = parseInt(process.env.TUTOR_DAILY_LIMIT || '50', 10);
      const row = rows[0] || { message_count: 0, tokens_in: 0, tokens_out: 0, cost_cents: 0 };
      res.json({
        today,
        used: row.message_count,
        limit,
        remaining: Math.max(0, limit - row.message_count),
        cost_cents: row.cost_cents
      });
    } catch (err) {
      console.error('[tutor] usage error:', err);
      res.status(500).json({ error: 'Failed to fetch usage' });
    }
  });
}

module.exports = { registerProfCarbonioRoutes };
