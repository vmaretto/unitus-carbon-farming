-- 072_project_partner.sql
-- Collega un progetto all'azienda/partner eventualmente coinvolto.

ALTER TABLE network_opportunities
  ADD COLUMN IF NOT EXISTS partner_id UUID REFERENCES partners(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_network_opportunities_partner
  ON network_opportunities(partner_id);
