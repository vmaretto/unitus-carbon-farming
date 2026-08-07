-- 074_partner_user_memberships.sql
-- Referenti ospiti associati a un partner, utilizzabili nelle proposte progetto.

CREATE TABLE IF NOT EXISTS partner_user_memberships (
  partner_id UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (partner_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_partner_user_memberships_user
  ON partner_user_memberships(user_id);
