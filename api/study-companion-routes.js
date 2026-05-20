// api/study-companion-routes.js
// Espone le route HTTP dell'AI Study Companion.
// Si registra in api/index.js con:
//
//   const { registerStudyCompanionRoutes } = require('./study-companion-routes');
//   registerStudyCompanionRoutes(app, { pool, anthropic, requireStudent, requireNonGuest });
//
// SPRINT 1: persistenza piano + generazione "placeholder" senza agente Claude.
// SPRINT 2: la funzione generatePlanArtifacts() verrà sostituita dall'agente reale.

const PLACEHOLDER_ARTIFACTS = require('./study-companion-placeholders');

function registerStudyCompanionRoutes(app, deps) {
  const { pool, anthropic, requireStudent, requireNonGuest } = deps;

  if (!app) throw new Error('Express app required');
  if (!requireStudent || !requireNonGuest) {
    throw new Error('Auth middlewares (requireStudent, requireNonGuest) required');
  }

  function ensureDb(res) {
    if (!pool) {
      res.status(503).json({ error: 'Database not configured' });
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Trova il piano attivo (non completed/expired) di un utente.
   * Sfrutta lo UNIQUE INDEX parziale che garantisce al massimo uno.
   */
  async function findActivePlan(userId) {
    const { rows } = await pool.query(
      `SELECT * FROM study_plans
        WHERE user_id = $1
          AND status IN ('draft', 'generating', 'active', 'paused')
        LIMIT 1`,
      [userId]
    );
    return rows[0] || null;
  }

  /**
   * Calcola progresso aggregato di un piano: artefatti consumati / artefatti
   * scheduled da oggi all'indietro. Ritorna 0..1.
   */
  async function computePlanProgress(planId) {
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE scheduled_for <= CURRENT_DATE) AS due_so_far,
         COUNT(*) FILTER (WHERE consumed_at IS NOT NULL) AS consumed,
         COUNT(*) AS total
       FROM study_artifacts
       WHERE study_plan_id = $1 AND status = 'ready'`,
      [planId]
    );
    const r = rows[0] || {};
    const due = Number(r.due_so_far || 0);
    const consumed = Number(r.consumed || 0);
    const total = Number(r.total || 0);
    return {
      total,
      consumed,
      due_so_far: due,
      progress_ratio: total > 0 ? consumed / total : 0,
      on_track_ratio: due > 0 ? consumed / due : 1
    };
  }

  /**
   * Genera artefatti placeholder per un piano. Sprint 1: usa un seed
   * deterministico basato sui moduli focus. Sprint 2 sarà rimpiazzato da
   * un loop agentic con Claude tool use.
   *
   * Strategia: per ogni giorno disponibile (rispettando weekly_days) fino a
   * target_date, genera 2-3 artefatti che sommano a daily_minutes circa.
   * Pesca ciclicamente dal pool PLACEHOLDER_ARTIFACTS ordinato per
   * source_module_ids che intersecano focus_module_ids.
   */
  async function generatePlanArtifacts(plan) {
    const start = new Date();
    const end = new Date(plan.target_date);
    if (end <= start) {
      throw new Error('target_date deve essere nel futuro');
    }

    const weeklyDays = new Set((plan.weekly_days || []).map(Number));
    const focusModuleIds = new Set(plan.focus_module_ids || []);

    // Filtra placeholder rilevanti per i moduli focus, con fallback all'intero
    // pool se lo studente non ha scelto moduli specifici.
    let pool = PLACEHOLDER_ARTIFACTS;
    if (focusModuleIds.size > 0) {
      const filtered = PLACEHOLDER_ARTIFACTS.filter(p =>
        (p.source_module_ids || []).some(m => focusModuleIds.has(m))
      );
      if (filtered.length > 0) pool = filtered;
    }

    const artifacts = [];
    let cursor = new Date(start);
    cursor.setHours(0, 0, 0, 0);
    let idx = 0;

    while (cursor <= end && artifacts.length < 120) {
      // ISO weekday: 1=lun..7=dom. JS getDay: 0=dom..6=sab.
      const isoDay = ((cursor.getDay() + 6) % 7) + 1;
      if (weeklyDays.has(isoDay)) {
        let remaining = plan.daily_minutes;
        let perDay = 0;
        while (remaining >= 5 && perDay < 4) {
          const tmpl = pool[idx % pool.length];
          idx++;
          perDay++;
          remaining -= tmpl.estimated_minutes;
          artifacts.push({
            ...tmpl,
            scheduled_for: cursor.toISOString().slice(0, 10)
          });
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    return artifacts;
  }

  /**
   * Persiste un array di artefatti generati e aggiorna lo stato del piano.
   * Avvolto in transazione per consistenza.
   */
  async function persistGeneratedArtifacts(planId, artifacts) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Soft-replace: marca eventuali precedenti artefatti futuri come stale
      // (le rigenerazioni non cancellano la storia di consumed_at).
      await client.query(
        `UPDATE study_artifacts
            SET status = 'stale'
          WHERE study_plan_id = $1
            AND status IN ('queued', 'ready')
            AND consumed_at IS NULL
            AND scheduled_for >= CURRENT_DATE`,
        [planId]
      );

      for (const a of artifacts) {
        await client.query(
          `INSERT INTO study_artifacts
             (study_plan_id, type, title, description, scheduled_for,
              estimated_minutes, difficulty, source_lesson_ids, source_module_ids,
              source_citations, content, status, generated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'ready', NOW())`,
          [
            planId,
            a.type,
            a.title,
            a.description || null,
            a.scheduled_for,
            a.estimated_minutes,
            a.difficulty || 'medium',
            a.source_lesson_ids || [],
            a.source_module_ids || [],
            JSON.stringify(a.source_citations || []),
            JSON.stringify(a.content || {})
          ]
        );
      }

      await client.query(
        `UPDATE study_plans
            SET status = 'active',
                generation_completed_at = NOW(),
                generation_error = NULL,
                last_regenerated_at = NOW()
          WHERE id = $1`,
        [planId]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Wrapper async che lancia la generazione "fire-and-forget" dopo aver
   * marcato il piano come 'generating'. Lo studente vedrà lo stato evolvere
   * via polling lato client.
   *
   * NB: in produzione su Vercel serverless questa esecuzione non sopravvive
   * alla request. In Sprint 2 useremo una coda. Sprint 1: la generazione
   * placeholder è veloce (~50ms), facciamo tutto inline.
   */
  async function triggerGenerationInline(plan) {
    try {
      const artifacts = await generatePlanArtifacts(plan);
      await persistGeneratedArtifacts(plan.id, artifacts);
      return { ok: true, count: artifacts.length };
    } catch (err) {
      console.error('[study-companion] generation error:', err);
      await pool.query(
        `UPDATE study_plans
            SET status = 'draft',
                generation_error = $2
          WHERE id = $1`,
        [plan.id, String(err.message || err)]
      );
      return { ok: false, error: err.message };
    }
  }

  // ===========================================================================
  // POST /api/companion/study-plan
  // Crea o aggiorna l'obiettivo dello studente. Triggera la generazione.
  // ===========================================================================
  app.post('/api/companion/study-plan', requireStudent, requireNonGuest, async (req, res) => {
    if (!ensureDb(res)) return;
    try {
      const userId = req.user.userId;
      const {
        goal = null,
        target_date,
        daily_minutes,
        weekly_days = [1, 2, 3, 4, 5, 6, 7],
        focus_module_ids = [],
        focus_lesson_ids = [],
        level = 'intermediate',
        course_edition_id = null
      } = req.body || {};

      if (!target_date) {
        return res.status(400).json({ error: 'target_date required' });
      }
      if (!daily_minutes || daily_minutes < 10 || daily_minutes > 480) {
        return res.status(400).json({ error: 'daily_minutes must be 10..480' });
      }

      // Upsert: se esiste un piano attivo, aggiorna; altrimenti crea.
      const existing = await findActivePlan(userId);

      let plan;
      if (existing) {
        const { rows } = await pool.query(
          `UPDATE study_plans
              SET goal = $2,
                  target_date = $3,
                  daily_minutes = $4,
                  weekly_days = $5,
                  focus_module_ids = $6,
                  focus_lesson_ids = $7,
                  level = $8,
                  course_edition_id = $9,
                  status = 'generating',
                  generation_started_at = NOW(),
                  generation_completed_at = NULL,
                  generation_error = NULL
            WHERE id = $1
            RETURNING *`,
          [
            existing.id, goal, target_date, daily_minutes,
            weekly_days, focus_module_ids, focus_lesson_ids,
            level, course_edition_id
          ]
        );
        plan = rows[0];
      } else {
        const { rows } = await pool.query(
          `INSERT INTO study_plans
             (user_id, goal, target_date, daily_minutes, weekly_days,
              focus_module_ids, focus_lesson_ids, level, course_edition_id,
              status, generation_started_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'generating', NOW())
           RETURNING *`,
          [
            userId, goal, target_date, daily_minutes, weekly_days,
            focus_module_ids, focus_lesson_ids, level, course_edition_id
          ]
        );
        plan = rows[0];
      }

      // Sprint 1: generazione inline (placeholder veloce).
      const result = await triggerGenerationInline(plan);

      const { rows: refreshed } = await pool.query(
        'SELECT * FROM study_plans WHERE id = $1', [plan.id]
      );
      res.status(201).json({
        plan: refreshed[0],
        generation: result
      });
    } catch (err) {
      console.error('[study-companion] POST plan error:', err);
      res.status(500).json({ error: 'Failed to create or update plan' });
    }
  });

  // ===========================================================================
  // GET /api/companion/study-plan/current
  // ===========================================================================
  app.get('/api/companion/study-plan/current', requireStudent, async (req, res) => {
    if (!ensureDb(res)) return;
    try {
      const plan = await findActivePlan(req.user.userId);
      if (!plan) return res.json({ plan: null });
      const progress = await computePlanProgress(plan.id);

      const { rows: upcoming } = await pool.query(
        `SELECT id, type, title, scheduled_for, estimated_minutes, status,
                consumed_at, difficulty
           FROM study_artifacts
          WHERE study_plan_id = $1
            AND status IN ('ready', 'generating')
            AND scheduled_for >= CURRENT_DATE - INTERVAL '1 day'
          ORDER BY scheduled_for ASC, created_at ASC
          LIMIT 10`,
        [plan.id]
      );

      res.json({ plan, progress, upcoming });
    } catch (err) {
      console.error('[study-companion] GET current error:', err);
      res.status(500).json({ error: 'Failed to load plan' });
    }
  });

  // ===========================================================================
  // GET /api/companion/study-plan/today
  // Artefatti del giorno per il widget homepage.
  // ===========================================================================
  app.get('/api/companion/study-plan/today', requireStudent, async (req, res) => {
    if (!ensureDb(res)) return;
    try {
      const plan = await findActivePlan(req.user.userId);
      if (!plan) return res.json({ plan: null, artifacts: [] });

      const { rows: artifacts } = await pool.query(
        `SELECT id, type, title, description, scheduled_for, estimated_minutes,
                status, difficulty, consumed_at, time_spent_seconds, rating
           FROM study_artifacts
          WHERE study_plan_id = $1
            AND scheduled_for = CURRENT_DATE
            AND status IN ('ready', 'generating')
          ORDER BY created_at ASC`,
        [plan.id]
      );

      const progress = await computePlanProgress(plan.id);
      const daysToTarget = Math.max(0,
        Math.ceil((new Date(plan.target_date) - new Date()) / (1000 * 60 * 60 * 24)));

      res.json({
        plan: {
          id: plan.id,
          goal: plan.goal,
          target_date: plan.target_date,
          days_to_target: daysToTarget,
          daily_minutes: plan.daily_minutes,
          status: plan.status
        },
        artifacts,
        progress
      });
    } catch (err) {
      console.error('[study-companion] GET today error:', err);
      res.status(500).json({ error: 'Failed to load today artifacts' });
    }
  });

  // ===========================================================================
  // GET /api/companion/study-plan/full
  // Vista calendario completa.
  // ===========================================================================
  app.get('/api/companion/study-plan/full', requireStudent, async (req, res) => {
    if (!ensureDb(res)) return;
    try {
      const plan = await findActivePlan(req.user.userId);
      if (!plan) return res.json({ plan: null, artifacts: [] });

      const { rows: artifacts } = await pool.query(
        `SELECT id, type, title, scheduled_for, estimated_minutes, status,
                consumed_at, time_spent_seconds, rating, difficulty
           FROM study_artifacts
          WHERE study_plan_id = $1
            AND status IN ('ready', 'generating')
          ORDER BY scheduled_for ASC, created_at ASC`,
        [plan.id]
      );

      const progress = await computePlanProgress(plan.id);
      res.json({ plan, artifacts, progress });
    } catch (err) {
      console.error('[study-companion] GET full error:', err);
      res.status(500).json({ error: 'Failed to load full plan' });
    }
  });

  // ===========================================================================
  // POST /api/companion/study-plan/regenerate
  // ===========================================================================
  app.post('/api/companion/study-plan/regenerate',
    requireStudent, requireNonGuest, async (req, res) => {
      if (!ensureDb(res)) return;
      try {
        const plan = await findActivePlan(req.user.userId);
        if (!plan) return res.status(404).json({ error: 'No active plan' });

        await pool.query(
          `UPDATE study_plans
              SET status = 'generating', generation_started_at = NOW(),
                  generation_completed_at = NULL, generation_error = NULL
            WHERE id = $1`,
          [plan.id]
        );

        await pool.query(
          `INSERT INTO study_events (study_plan_id, event_type)
           VALUES ($1, 'regenerated')`,
          [plan.id]
        );

        const result = await triggerGenerationInline(plan);
        res.json({ ok: true, generation: result });
      } catch (err) {
        console.error('[study-companion] regenerate error:', err);
        res.status(500).json({ error: 'Failed to regenerate' });
      }
    }
  );

  // ===========================================================================
  // DELETE /api/companion/study-plan — elimina piano attivo
  // ===========================================================================
  app.delete('/api/companion/study-plan',
    requireStudent, requireNonGuest, async (req, res) => {
      if (!ensureDb(res)) return;
      try {
        const plan = await findActivePlan(req.user.userId);
        if (!plan) return res.status(404).json({ error: 'No active plan' });
        await pool.query('DELETE FROM study_plans WHERE id = $1', [plan.id]);
        res.json({ ok: true });
      } catch (err) {
        console.error('[study-companion] DELETE plan error:', err);
        res.status(500).json({ error: 'Failed to delete plan' });
      }
    }
  );

  // ===========================================================================
  // GET /api/companion/study-artifacts/:id
  // ===========================================================================
  app.get('/api/companion/study-artifacts/:id', requireStudent, async (req, res) => {
    if (!ensureDb(res)) return;
    try {
      const { rows } = await pool.query(
        `SELECT a.*
           FROM study_artifacts a
           JOIN study_plans p ON p.id = a.study_plan_id
          WHERE a.id = $1 AND p.user_id = $2`,
        [req.params.id, req.user.userId]
      );
      const artifact = rows[0];
      if (!artifact) return res.status(404).json({ error: 'Not found' });

      // Log evento 'opened' (idempotente-ish: lo registriamo comunque).
      pool.query(
        `INSERT INTO study_events (study_plan_id, artifact_id, event_type)
         VALUES ($1, $2, 'opened')`,
        [artifact.study_plan_id, artifact.id]
      ).catch(e => console.warn('[study-companion] opened event:', e.message));

      res.json({ artifact });
    } catch (err) {
      console.error('[study-companion] GET artifact error:', err);
      res.status(500).json({ error: 'Failed to load artifact' });
    }
  });

  // ===========================================================================
  // POST /api/companion/study-artifacts/:id/start
  // ===========================================================================
  app.post('/api/companion/study-artifacts/:id/start',
    requireStudent, requireNonGuest, async (req, res) => {
      if (!ensureDb(res)) return;
      try {
        const { rows } = await pool.query(
          `SELECT a.id, a.study_plan_id
             FROM study_artifacts a
             JOIN study_plans p ON p.id = a.study_plan_id
            WHERE a.id = $1 AND p.user_id = $2`,
          [req.params.id, req.user.userId]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Not found' });

        await pool.query(
          `INSERT INTO study_events (study_plan_id, artifact_id, event_type)
           VALUES ($1, $2, 'started')`,
          [rows[0].study_plan_id, rows[0].id]
        );
        res.json({ ok: true });
      } catch (err) {
        console.error('[study-companion] start error:', err);
        res.status(500).json({ error: 'Failed to mark started' });
      }
    }
  );

  // ===========================================================================
  // POST /api/companion/study-artifacts/:id/complete
  // ===========================================================================
  app.post('/api/companion/study-artifacts/:id/complete',
    requireStudent, requireNonGuest, async (req, res) => {
      if (!ensureDb(res)) return;
      try {
        const { time_spent_seconds = 0 } = req.body || {};
        const { rows } = await pool.query(
          `UPDATE study_artifacts a
              SET consumed_at = COALESCE(consumed_at, NOW()),
                  time_spent_seconds = a.time_spent_seconds + $3
            FROM study_plans p
            WHERE a.id = $1
              AND a.study_plan_id = p.id
              AND p.user_id = $2
           RETURNING a.id, a.study_plan_id, a.consumed_at`,
          [req.params.id, req.user.userId, Math.max(0, Math.round(time_spent_seconds))]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Not found' });

        await pool.query(
          `INSERT INTO study_events
             (study_plan_id, artifact_id, event_type, duration_seconds)
           VALUES ($1, $2, 'completed', $3)`,
          [rows[0].study_plan_id, rows[0].id, Math.max(0, Math.round(time_spent_seconds))]
        );

        res.json({ ok: true, consumed_at: rows[0].consumed_at });
      } catch (err) {
        console.error('[study-companion] complete error:', err);
        res.status(500).json({ error: 'Failed to mark completed' });
      }
    }
  );

  // ===========================================================================
  // POST /api/companion/study-artifacts/:id/rate
  // ===========================================================================
  app.post('/api/companion/study-artifacts/:id/rate',
    requireStudent, requireNonGuest, async (req, res) => {
      if (!ensureDb(res)) return;
      try {
        const { rating, comment = null } = req.body || {};
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
          return res.status(400).json({ error: 'rating must be 1..5' });
        }
        const { rows } = await pool.query(
          `UPDATE study_artifacts a
              SET rating = $3
            FROM study_plans p
            WHERE a.id = $1
              AND a.study_plan_id = p.id
              AND p.user_id = $2
           RETURNING a.id, a.study_plan_id`,
          [req.params.id, req.user.userId, rating]
        );
        if (!rows[0]) return res.status(404).json({ error: 'Not found' });

        await pool.query(
          `INSERT INTO study_events
             (study_plan_id, artifact_id, event_type, rating, comment)
           VALUES ($1, $2, 'rated', $3, $4)`,
          [rows[0].study_plan_id, rows[0].id, rating, comment]
        );
        res.json({ ok: true });
      } catch (err) {
        console.error('[study-companion] rate error:', err);
        res.status(500).json({ error: 'Failed to rate' });
      }
    }
  );

  // ===========================================================================
  // GET /api/companion/lms-modules — modulo focus picker
  // Ritorna i moduli LMS dell'edizione attiva dello studente, per popolare il
  // multi-select del form. Pesca dall'enrollment + course_editions + lms_modules.
  // ===========================================================================
  app.get('/api/companion/lms-modules', requireStudent, async (req, res) => {
    if (!ensureDb(res)) return;
    try {
      const { rows } = await pool.query(
        `SELECT DISTINCT m.id, m.title, m.sort_order, c.title AS course_title
           FROM enrollments e
           JOIN course_editions ce ON ce.id = e.course_edition_id
           JOIN courses c ON c.id = ce.course_id
           JOIN lms_modules m ON m.course_id = c.id
          WHERE e.user_id = $1
            AND e.status = 'active'
            AND m.is_published = TRUE
          ORDER BY m.sort_order ASC, m.title ASC`,
        [req.user.userId]
      );
      res.json({ modules: rows });
    } catch (err) {
      console.error('[study-companion] GET modules error:', err);
      res.status(500).json({ error: 'Failed to load modules' });
    }
  });

  console.log('[study-companion] routes registered');
}

module.exports = { registerStudyCompanionRoutes };
