-- 047_study_companion.sql
-- AI Study Companion: piano di studio personalizzato + artefatti generati + telemetria.
-- Vedi docs/study-companion/ARCHITETTURA.md per il contesto completo.

-- ---------------------------------------------------------------------------
-- study_plans: l'obiettivo dichiarato dallo studente. Una riga attiva per utente.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS study_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_edition_id UUID REFERENCES course_editions(id) ON DELETE SET NULL,
  goal TEXT,
  target_date DATE NOT NULL,
  daily_minutes INTEGER NOT NULL CHECK (daily_minutes BETWEEN 10 AND 480),
  weekly_days SMALLINT[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6,7]::SMALLINT[],
  focus_module_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  focus_lesson_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  level TEXT NOT NULL DEFAULT 'intermediate'
    CHECK (level IN ('beginner', 'intermediate', 'advanced')),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'generating', 'active', 'paused', 'completed', 'expired')),
  generation_started_at TIMESTAMPTZ,
  generation_completed_at TIMESTAMPTZ,
  generation_error TEXT,
  last_regenerated_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Un solo piano "vivo" (non completed/expired) per studente alla volta.
CREATE UNIQUE INDEX IF NOT EXISTS idx_study_plans_active_per_user
  ON study_plans(user_id)
  WHERE status IN ('draft', 'generating', 'active', 'paused');

CREATE INDEX IF NOT EXISTS idx_study_plans_user
  ON study_plans(user_id, status);

CREATE INDEX IF NOT EXISTS idx_study_plans_status_generating
  ON study_plans(status, generation_started_at)
  WHERE status = 'generating';

-- ---------------------------------------------------------------------------
-- study_artifacts: i materiali generati dall'agente per un piano.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS study_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_plan_id UUID NOT NULL REFERENCES study_plans(id) ON DELETE CASCADE,
  type TEXT NOT NULL
    CHECK (type IN ('summary', 'quiz_personalized', 'flashcards', 'micro_lesson', 'mind_map', 'audio_overview')),
  title TEXT NOT NULL,
  description TEXT,
  scheduled_for DATE NOT NULL,
  estimated_minutes INTEGER NOT NULL DEFAULT 15 CHECK (estimated_minutes > 0),
  difficulty TEXT DEFAULT 'medium'
    CHECK (difficulty IN ('easy', 'medium', 'hard')),
  source_lesson_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  source_module_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  source_citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  asset_url TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'generating', 'ready', 'failed', 'stale')),
  generated_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  time_spent_seconds INTEGER NOT NULL DEFAULT 0,
  rating SMALLINT CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  generation_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- "Artefatti di oggi per il piano X" è la query più frequente.
CREATE INDEX IF NOT EXISTS idx_study_artifacts_plan_date
  ON study_artifacts(study_plan_id, scheduled_for);

CREATE INDEX IF NOT EXISTS idx_study_artifacts_status
  ON study_artifacts(status, scheduled_for);

CREATE INDEX IF NOT EXISTS idx_study_artifacts_unread
  ON study_artifacts(study_plan_id, scheduled_for)
  WHERE consumed_at IS NULL AND status = 'ready';

-- ---------------------------------------------------------------------------
-- study_events: telemetria fine-grained per l'adattività notturna.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS study_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  study_plan_id UUID NOT NULL REFERENCES study_plans(id) ON DELETE CASCADE,
  artifact_id UUID REFERENCES study_artifacts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('started', 'paused', 'resumed', 'completed', 'skipped', 'rated', 'opened', 'regenerated')),
  rating SMALLINT CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  comment TEXT,
  duration_seconds INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_study_events_plan
  ON study_events(study_plan_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_study_events_artifact
  ON study_events(artifact_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Trigger updated_at
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION study_companion_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_study_plans_updated_at ON study_plans;
CREATE TRIGGER trg_study_plans_updated_at
  BEFORE UPDATE ON study_plans
  FOR EACH ROW EXECUTE FUNCTION study_companion_touch_updated_at();

DROP TRIGGER IF EXISTS trg_study_artifacts_updated_at ON study_artifacts;
CREATE TRIGGER trg_study_artifacts_updated_at
  BEFORE UPDATE ON study_artifacts
  FOR EACH ROW EXECUTE FUNCTION study_companion_touch_updated_at();
