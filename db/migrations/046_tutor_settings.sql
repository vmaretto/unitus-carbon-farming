-- 046_tutor_settings.sql
-- Tabella key/value per i feature flags di Prof. Carbonio.
-- Permette all'admin di attivare/disattivare modalita' chat/avatar e di
-- modificare configurazioni a caldo senza redeploy.

CREATE TABLE IF NOT EXISTS tutor_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  description TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID
);

-- Valori di default. ON CONFLICT DO NOTHING per essere idempotente.
INSERT INTO tutor_settings (key, value, description) VALUES
  ('chat_enabled', 'true',
    'Se true il widget Prof. Carbonio in /learn/ e'' attivo in modalita'' chat testuale'),
  ('avatar_enabled', 'false',
    'Se true il widget mostra anche il toggle modalita'' avatar parlante'),
  ('daily_limit_per_student', '50',
    'Numero massimo di domande/giorno per ogni studente'),
  ('avatar_provider', 'none',
    'Provider avatar attivo: none | heygen | liveavatar | custom (HeyGen v1/v2 streaming sunset marzo 2026)'),
  ('chat_model', 'claude-haiku-4-5-20251001',
    'Modello Claude utilizzato per le risposte'),
  ('monthly_budget_eur', '10',
    'Budget mensile in euro per controllo costi (alert al 80%)')
ON CONFLICT (key) DO NOTHING;
