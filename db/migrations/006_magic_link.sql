-- 006_magic_link.sql
-- Aggiunge campi per magic link login

ALTER TABLE users ADD COLUMN IF NOT EXISTS token_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ;
