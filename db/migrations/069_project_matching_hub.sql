-- 069_project_matching_hub.sql
-- Estende la bacheca opportunità esistente in un hub progetti condiviso
-- tra studenti e docenti. Le opportunità già presenti restano valide.

ALTER TABLE network_opportunities
  ADD COLUMN IF NOT EXISTS organization_type TEXT NOT NULL DEFAULT 'external',
  ADD COLUMN IF NOT EXISTS sector TEXT,
  ADD COLUMN IF NOT EXISTS skills TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS interests TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS duration_text TEXT,
  ADD COLUMN IF NOT EXISTS commitment_text TEXT,
  ADD COLUMN IF NOT EXISTS work_mode TEXT,
  ADD COLUMN IF NOT EXISTS created_by_teacher_id UUID REFERENCES faculty(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS supervisor_teacher_id UUID REFERENCES faculty(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS accepts_applications BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE network_opportunities
  DROP CONSTRAINT IF EXISTS network_opportunities_organization_type_check;

ALTER TABLE network_opportunities
  ADD CONSTRAINT network_opportunities_organization_type_check
  CHECK (organization_type IN ('partner', 'external', 'university'));

CREATE INDEX IF NOT EXISTS idx_network_opportunities_teacher
  ON network_opportunities(created_by_teacher_id, supervisor_teacher_id);

CREATE INDEX IF NOT EXISTS idx_network_opportunities_skills
  ON network_opportunities USING GIN(skills);
