-- 051_avatar_id_setting.sql
-- Aggiunge la setting 'avatar_id' a tutor_settings per consentire all'admin
-- di cambiare l'avatar (LiveAvatar o D-ID Agent) direttamente dal pannello
-- senza dover modificare le env vars su Vercel e redeployare.
--
-- Comportamento backend (prof-carbonio-routes.js):
--  - Se questa setting e' valorizzata -> override dell'env LIVEAVATAR_AVATAR_ID
--    (o DID_AGENT_ID, a seconda del provider attivo)
--  - Se vuota -> fallback sull'env Vercel come prima

INSERT INTO tutor_settings (key, value, description, updated_at)
VALUES ('avatar_id', '',
        'ID avatar attivo (LiveAvatar Avatar ID o D-ID Agent ID). Lascia vuoto per usare l''env Vercel.',
        NOW())
ON CONFLICT (key) DO NOTHING;
