-- Configurazione amministrativa del network studenti.

CREATE TABLE IF NOT EXISTS network_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO network_settings (key, value, description) VALUES
  ('network_enabled', 'true', 'Abilita o disabilita completamente la sezione Network'),
  ('profiles_enabled', 'true', 'Consente agli studenti di creare e modificare il proprio profilo'),
  ('posts_enabled', 'true', 'Consente la pubblicazione di post nel feed'),
  ('intro_requests_enabled', 'true', 'Consente l''invio di richieste di contatto'),
  ('profile_photos_enabled', 'true', 'Consente foto profilo e immagine di copertina'),
  ('link_previews_enabled', 'true', 'Consente l''uso di link esterni nei post')
ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value,
  description = EXCLUDED.description,
  updated_at = NOW();
