-- 050_liveavatar_provider.sql
-- Switch del provider avatar Prof. Carbonio da D-ID a HeyGen LiveAvatar
-- (qualita' video superiore + voice chat con STT integrato).
-- L'integrazione D-ID (migrazione 049) e' superata.

INSERT INTO tutor_settings (key, value, description, updated_at)
VALUES ('avatar_provider', 'liveavatar',
        'Provider avatar attivo: none | heygen | liveavatar | d-id | custom', NOW())
ON CONFLICT (key) DO UPDATE SET value = 'liveavatar', updated_at = NOW();

-- Manteniamo avatar_enabled = true (era gia' impostato in 049)
INSERT INTO tutor_settings (key, value, description, updated_at)
VALUES ('avatar_enabled', 'true',
        'Se true il widget mostra il toggle modalita'' avatar parlante', NOW())
ON CONFLICT (key) DO UPDATE SET value = 'true', updated_at = NOW();
