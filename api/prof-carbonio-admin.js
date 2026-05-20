// api/prof-carbonio-admin.js
// Endpoint admin per gestione Prof. Carbonio:
// - stats (KB, costi, sessioni, top domande, escalation rate)
// - gestione sorgenti KB (lista, crea manuale, archive, reindex)
// - feature flags (chat enabled, avatar enabled, daily limit, budget cap)
//
// Tutte le route richiedono requireAdmin (auth JWT con role=admin).

const { ingestSource } = require('./prof-carbonio-ingest');
const { getHeygenSessionToken } = require('./prof-carbonio-avatar');

function registerProfCarbonioAdminRoutes(app, deps) {
  const { pool, openai, requireAdmin } = deps;
  if (!app) throw new Error('Express app required');
  if (!requireAdmin) throw new Error('requireAdmin middleware required');

  function ensureDb(res) {
    if (!pool) { res.status(503).json({ error: 'Database not configured' }); return false; }
    return true;
  }

  // ===========================================================================
  // POST /api/admin/tutor/avatar/session — test admin HeyGen Streaming Avatar
  // ===========================================================================
  app.post('/api/admin/tutor/avatar/session', requireAdmin, async (req, res) => {
    try {
      const { language = 'it' } = req.body || {};
      const result = await getHeygenSessionToken({ language });
      res.json({
        ...result,
        provider: 'heygen',
        configured: {
          apiKey: Boolean(process.env.HEYGEN_API_KEY),
          avatarId: Boolean(process.env.HEYGEN_AVATAR_ID)
        }
      });
    } catch (err) {
      const status = err.status || 500;
      console.error('[admin/tutor] avatar session error:', err.message);
      res.status(status).json({
        error: err.message || 'Unable to create HeyGen session',
        provider: err.provider || 'heygen',
        status,
        details: err.details || null
      });
    }
  });

  // ===========================================================================
  // GET /api/admin/tutor/stats — dashboard overview
  // ===========================================================================
  app.get('/api/admin/tutor/stats', requireAdmin, async (req, res) => {
    if (!ensureDb(res)) return;
    try {
      const [kb, sessions, msgs, today, month, escalations, topQs] = await Promise.all([
        pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE status = 'active') AS active_sources,
            COUNT(*) FILTER (WHERE status = 'archived') AS archived_sources,
            COUNT(*) FILTER (WHERE source_type = 'resource') AS resource_count,
            COUNT(*) FILTER (WHERE source_type = 'blog_post') AS blog_count,
            COUNT(*) FILTER (WHERE source_type = 'normative') AS normative_count,
            COUNT(*) FILTER (WHERE source_type = 'manual') AS manual_count
          FROM kb_sources
        `),
        pool.query(`SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS last_7d,
          COUNT(*) FILTER (WHERE last_message_at > NOW() - INTERVAL '24 hours') AS active_24h
          FROM tutor_sessions
        `),
        pool.query(`SELECT
          COUNT(*) AS total_messages,
          COUNT(*) FILTER (WHERE role='assistant') AS assistant_messages,
          (SELECT COUNT(*) FROM kb_chunks) AS total_chunks,
          COALESCE(SUM(cost_cents), 0) AS total_cost_cents
          FROM tutor_messages
        `),
        pool.query(`SELECT
          COALESCE(SUM(message_count), 0) AS messages,
          COALESCE(SUM(cost_cents), 0) AS cost_cents,
          COALESCE(SUM(tokens_in), 0) AS tokens_in,
          COALESCE(SUM(tokens_out), 0) AS tokens_out
          FROM tutor_usage_daily WHERE day = CURRENT_DATE
        `),
        pool.query(`SELECT
          COALESCE(SUM(message_count), 0) AS messages,
          COALESCE(SUM(cost_cents), 0) AS cost_cents
          FROM tutor_usage_daily WHERE day >= date_trunc('month', CURRENT_DATE)
        `),
        pool.query(`SELECT COUNT(*) AS n FROM student_questions WHERE escalated_from_message_id IS NOT NULL`),
        pool.query(`SELECT content, created_at
          FROM tutor_messages
          WHERE role='user' AND created_at > NOW() - INTERVAL '7 days'
          ORDER BY created_at DESC LIMIT 15
        `)
      ]);

      res.json({
        kb: kb.rows[0],
        sessions: sessions.rows[0],
        messages: msgs.rows[0],
        usage_today: today.rows[0],
        usage_month: month.rows[0],
        escalations_total: escalations.rows[0].n,
        recent_questions: topQs.rows
      });
    } catch (err) {
      console.error('[admin/tutor] stats error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ===========================================================================
  // GET /api/admin/tutor/sources — lista sorgenti KB (paginata)
  // ===========================================================================
  app.get('/api/admin/tutor/sources', requireAdmin, async (req, res) => {
    if (!ensureDb(res)) return;
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const offset = parseInt(req.query.offset, 10) || 0;
      const filterType = req.query.type || null;
      const filterStatus = req.query.status || null;

      const { rows } = await pool.query(`
        SELECT s.id, s.source_type, s.source_ref, s.title, s.author, s.url,
               s.language, s.status, s.indexed_at, s.created_at, s.updated_at,
               (SELECT COUNT(*) FROM kb_chunks WHERE source_id = s.id) AS chunk_count,
               (SELECT SUM(content_tokens) FROM kb_chunks WHERE source_id = s.id) AS tokens
          FROM kb_sources s
         WHERE ($1::text IS NULL OR s.source_type = $1)
           AND ($2::text IS NULL OR s.status = $2)
         ORDER BY s.updated_at DESC
         LIMIT $3 OFFSET $4
      `, [filterType, filterStatus, limit, offset]);

      const total = await pool.query(`
        SELECT COUNT(*) AS n FROM kb_sources
         WHERE ($1::text IS NULL OR source_type = $1)
           AND ($2::text IS NULL OR status = $2)
      `, [filterType, filterStatus]);

      res.json({ sources: rows, total: parseInt(total.rows[0].n, 10), limit, offset });
    } catch (err) {
      console.error('[admin/tutor] sources list error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ===========================================================================
  // POST /api/admin/tutor/sources — crea sorgente manuale
  // ===========================================================================
  app.post('/api/admin/tutor/sources', requireAdmin, async (req, res) => {
    if (!ensureDb(res)) return;
    try {
      const { title, content, sourceType = 'manual', author, url, language = 'it', contentFormat = 'text' } = req.body || {};
      if (!title?.trim() || !content?.trim()) {
        return res.status(400).json({ error: 'title e content sono obbligatori' });
      }
      if (!openai) {
        return res.status(503).json({ error: 'OPENAI_API_KEY non configurata per gli embeddings' });
      }
      const result = await ingestSource({ pool, openai }, {
        sourceType, title, content, author, url, language, contentFormat
      });
      res.status(201).json(result);
    } catch (err) {
      console.error('[admin/tutor] create source error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ===========================================================================
  // POST /api/admin/tutor/sources/:id/reindex — re-ingest forzato
  // ===========================================================================
  app.post('/api/admin/tutor/sources/:id/reindex', requireAdmin, async (req, res) => {
    if (!ensureDb(res)) return;
    if (!openai) return res.status(503).json({ error: 'OPENAI_API_KEY non configurata' });
    try {
      const { rows } = await pool.query(
        `SELECT s.*, r.extracted_text, r.resource_type, r.file_size_bytes, r.extraction_metadata,
                bp.content AS blog_content, bp.author AS blog_author, bp.slug
           FROM kb_sources s
           LEFT JOIN resources r ON s.source_type = 'resource' AND r.id = s.source_ref
           LEFT JOIN blog_posts bp ON s.source_type = 'blog_post' AND bp.id = s.source_ref
          WHERE s.id = $1`,
        [req.params.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Source not found' });
      const s = rows[0];

      // Cancella content_hash per forzare re-ingest
      await pool.query(`UPDATE kb_sources SET content_hash = NULL WHERE id = $1`, [req.params.id]);

      let content, contentFormat;
      if (s.source_type === 'resource' && s.extracted_text) {
        content = s.extracted_text;
        contentFormat = (s.resource_type === 'pdf' || s.resource_type === 'document') ? 'pdf'
                     : (s.resource_type === 'video' || s.resource_type === 'audio') ? 'transcript'
                     : 'text';
      } else if (s.source_type === 'blog_post' && s.blog_content) {
        content = s.blog_content;
        contentFormat = 'html';
      } else {
        // Per fonti manuali: il content non e' recuperabile, serve POST sources nuova
        return res.status(400).json({ error: 'Per sorgenti manuali, ri-crea la sorgente con POST /sources' });
      }

      const result = await ingestSource({ pool, openai }, {
        sourceType: s.source_type,
        sourceRef: s.source_ref,
        title: s.title,
        content,
        author: s.author || s.blog_author,
        url: s.url,
        language: s.language || 'it',
        metadata: s.metadata || {},
        contentFormat
      });
      res.json(result);
    } catch (err) {
      console.error('[admin/tutor] reindex error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ===========================================================================
  // PATCH /api/admin/tutor/sources/:id — archivia o riattiva
  // ===========================================================================
  app.patch('/api/admin/tutor/sources/:id', requireAdmin, async (req, res) => {
    if (!ensureDb(res)) return;
    try {
      const { status, title } = req.body || {};
      const updates = [];
      const params = [req.params.id];
      if (status && ['active', 'archived'].includes(status)) {
        params.push(status);
        updates.push(`status = $${params.length}`);
      }
      if (title?.trim()) {
        params.push(title.trim());
        updates.push(`title = $${params.length}`);
      }
      if (!updates.length) return res.status(400).json({ error: 'no updates' });
      updates.push(`updated_at = NOW()`);
      const { rows } = await pool.query(
        `UPDATE kb_sources SET ${updates.join(', ')} WHERE id = $1 RETURNING id, title, status`,
        params
      );
      if (!rows.length) return res.status(404).json({ error: 'Source not found' });
      res.json(rows[0]);
    } catch (err) {
      console.error('[admin/tutor] patch source error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ===========================================================================
  // DELETE /api/admin/tutor/sources/:id — elimina sorgente + chunks
  // ===========================================================================
  app.delete('/api/admin/tutor/sources/:id', requireAdmin, async (req, res) => {
    if (!ensureDb(res)) return;
    try {
      const { rowCount } = await pool.query(`DELETE FROM kb_sources WHERE id = $1`, [req.params.id]);
      if (!rowCount) return res.status(404).json({ error: 'Source not found' });
      res.json({ deleted: true });
    } catch (err) {
      console.error('[admin/tutor] delete source error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ===========================================================================
  // GET /api/admin/tutor/settings — leggi feature flags
  // ===========================================================================
  app.get('/api/admin/tutor/settings', requireAdmin, async (req, res) => {
    if (!ensureDb(res)) return;
    try {
      const { rows } = await pool.query(
        `SELECT key, value, description, updated_at FROM tutor_settings ORDER BY key`
      );
      res.json({ settings: rows });
    } catch (err) {
      console.error('[admin/tutor] settings get error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ===========================================================================
  // PUT /api/admin/tutor/settings/:key — aggiorna feature flag
  // ===========================================================================
  app.put('/api/admin/tutor/settings/:key', requireAdmin, async (req, res) => {
    if (!ensureDb(res)) return;
    try {
      const { value } = req.body || {};
      if (value === undefined || value === null) {
        return res.status(400).json({ error: 'value required' });
      }
      const { rows } = await pool.query(
        `INSERT INTO tutor_settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
         RETURNING key, value, updated_at`,
        [req.params.key, String(value)]
      );
      res.json(rows[0]);
    } catch (err) {
      console.error('[admin/tutor] settings put error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ===========================================================================
  // GET /api/tutor/config — endpoint PUBBLICO (auth studente) per il widget
  // Solo i flag pubblici, niente dati admin.
  // ===========================================================================
  app.get('/api/tutor/config', deps.requireStudent || ((req, res, next) => next()), async (req, res) => {
    if (!ensureDb(res)) return;
    try {
      const { rows } = await pool.query(
        `SELECT key, value FROM tutor_settings
          WHERE key IN ('chat_enabled', 'avatar_enabled', 'daily_limit_per_student', 'avatar_provider')`
      );
      const config = {};
      rows.forEach(r => { config[r.key] = r.value; });
      res.json({
        chatEnabled:   config.chat_enabled === 'true',
        avatarEnabled: config.avatar_enabled === 'true',
        avatarProvider: config.avatar_provider || 'none',
        dailyLimit:    parseInt(config.daily_limit_per_student || '50', 10)
      });
    } catch (err) {
      console.error('[tutor] config error:', err);
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerProfCarbonioAdminRoutes };
