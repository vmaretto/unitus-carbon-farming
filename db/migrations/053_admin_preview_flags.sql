-- 053_admin_preview_flags.sql
-- Feature flag "solo anteprima admin" per Prof. Carbonio.
--
-- Motivazione:
-- Prima di abilitare chat o avatar a tutti gli studenti, l'admin vuole poter
-- attivare la modalita' solo per se' (preview in /admin/prof-carbonio-preview.html),
-- testarla, e poi accendere il flag globale per il rollout.
--
-- Logica applicata in /api/tutor/config:
--   - chiamata da studente vero  -> chatEnabled = chat_enabled === 'true'
--   - chiamata da admin preview  -> chatEnabled = chat_enabled || chat_enabled_admin
-- (idem per avatar). In OR: se attivo globalmente, l'admin vede comunque; se
-- attivo solo admin, lo vede solo l'admin in preview.

INSERT INTO tutor_settings (key, value, description, updated_at)
VALUES
  ('chat_enabled_admin', 'false',
   'Anteprima admin: attiva la chat testuale solo nella pagina /admin/prof-carbonio-preview.html (gli studenti continuano a vedere quello deciso da chat_enabled).',
   NOW()),
  ('avatar_enabled_admin', 'false',
   'Anteprima admin: attiva la modalita'' avatar solo nella pagina /admin/prof-carbonio-preview.html (gli studenti continuano a vedere quello deciso da avatar_enabled).',
   NOW())
ON CONFLICT (key) DO NOTHING;
