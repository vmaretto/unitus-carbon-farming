-- 055_event_registration_deadline.sql
-- Aggiunge la scadenza delle iscrizioni a un evento.
-- Dopo questa data/ora lo studente non puo' piu' iscriversi (es. "entro fine giugno").
-- NULL = nessuna scadenza (resta valido solo il flag registration_open ed eventuale capacity).

ALTER TABLE events ADD COLUMN IF NOT EXISTS registration_deadline TIMESTAMPTZ;
