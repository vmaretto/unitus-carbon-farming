-- 049_did_default_provider.sql
-- Attiva D-ID Agents come provider avatar di default per Prof. Carbonio.
-- L'integrazione HeyGen e' stata sostituita dal D-ID Client SDK nel widget studente
-- (learn/js/prof-carbonio-chat.js) e nell'endpoint backend (api/prof-carbonio-routes.js).

-- Setta avatar_provider = 'd-id'
INSERT INTO tutor_settings (key, value, description, updated_at)
VALUES ('avatar_provider', 'd-id',
        'Provider avatar attivo: none | heygen | d-id | custom', NOW())
ON CONFLICT (key) DO UPDATE SET value = 'd-id', updated_at = NOW();

-- Abilita la modalita' avatar nel widget (il bottone "Voce + Avatar" appare)
INSERT INTO tutor_settings (key, value, description, updated_at)
VALUES ('avatar_enabled', 'true',
        'Se true il widget mostra il toggle modalita'' avatar parlante', NOW())
ON CONFLICT (key) DO UPDATE SET value = 'true', updated_at = NOW();
