-- 073_project_partner_assignments.sql
-- Assegnazione operativa del progetto a un referente ospite/partner.

ALTER TABLE network_opportunities
  ADD COLUMN IF NOT EXISTS partner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS partner_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (partner_status IN ('pending', 'accepted', 'declined')),
  ADD COLUMN IF NOT EXISTS partner_comment TEXT,
  ADD COLUMN IF NOT EXISTS partner_responded_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_network_opportunities_partner_user
  ON network_opportunities(partner_user_id, partner_status);
