-- 064_network_consent.sql
-- Modello di consenso GDPR per i profili del network studenti.
-- Due consensi distinti, registrati con timestamp e versione del testo accettato:
--   * visibilità interna  -> profilo visibile agli altri studenti/alumni del master
--   * visibilità esterna  -> opt-in, spento di default, visibile a partner/pubblico (Fase 3)
-- La visibilità interna resta governata dalla colonna esistente is_visible; qui si
-- aggiungono il flag esterno e le colonne di audit del consenso.

ALTER TABLE network_profiles
  ADD COLUMN IF NOT EXISTS external_visible BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS internal_consent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS internal_consent_version TEXT,
  ADD COLUMN IF NOT EXISTS external_consent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS external_consent_version TEXT;

-- Backfill: i profili già visibili internamente hanno di fatto prestato il consenso
-- interno quando hanno attivato is_visible. Registriamo quel consenso sotto la v1.0
-- usando il timestamp di ultimo aggiornamento, così non risultano "mai consenzienti".
UPDATE network_profiles
   SET internal_consent_at = COALESCE(updated_at, created_at, NOW()),
       internal_consent_version = '1.0'
 WHERE is_visible = TRUE
   AND internal_consent_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_network_profiles_external_visible
  ON network_profiles(external_visible);
