-- 065_network_opportunities.sql
-- Fase 3a del network: bacheca opportunità (stage/tesi/lavoro) pubblicate dall'admin,
-- con candidatura degli studenti. Nessun accesso dei partner ai profili: GDPR-safe.

CREATE TABLE IF NOT EXISTS network_opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'lavoro' CHECK (type IN ('stage', 'tesi', 'lavoro', 'altro')),
  organization TEXT,
  location TEXT,
  description TEXT NOT NULL,
  apply_url TEXT,
  contact_email TEXT,
  deadline DATE,
  is_published BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_network_opportunities_published
  ON network_opportunities(is_published, created_at DESC);

CREATE TABLE IF NOT EXISTS network_opportunity_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL REFERENCES network_opportunities(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'reviewed', 'accepted', 'declined', 'withdrawn')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (opportunity_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_network_opportunity_applications_opp
  ON network_opportunity_applications(opportunity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_network_opportunity_applications_user
  ON network_opportunity_applications(user_id, created_at DESC);
