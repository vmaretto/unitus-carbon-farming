-- 070_project_creators.sql
-- Permette a studenti e referenti ospiti di proporre progetti, mantenendo
-- il docente supervisore separato dal creatore della proposta.

ALTER TABLE network_opportunities
  ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_network_opportunities_creator_user
  ON network_opportunities(created_by_user_id);
