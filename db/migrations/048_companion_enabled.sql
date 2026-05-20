-- 048_companion_enabled.sql
-- Feature flag per attivare/disattivare l'AI Study Companion dal pannello admin.
-- Riusa la tabella tutor_settings (chiave/valore) della 046.

INSERT INTO tutor_settings (key, value, description) VALUES
  ('companion_enabled', 'true',
    'Se true il widget AI Study Companion in /learn/ è attivo. Se false il widget non viene mostrato e le route /api/companion/* rifiutano nuovi piani.')
ON CONFLICT (key) DO NOTHING;
