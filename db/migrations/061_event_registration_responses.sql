-- Aggiorna le iscrizioni agli eventi a RSVP esplicito: parteciperò / non parteciperò.

ALTER TABLE event_registrations
  ADD COLUMN IF NOT EXISTS response_status TEXT NOT NULL DEFAULT 'registered',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE event_registrations
SET response_status = COALESCE(response_status, 'registered'),
    updated_at = COALESCE(updated_at, created_at, NOW())
WHERE response_status IS NULL;

ALTER TABLE event_registrations
  DROP CONSTRAINT IF EXISTS event_registrations_response_status_check;

ALTER TABLE event_registrations
  ADD CONSTRAINT event_registrations_response_status_check
  CHECK (response_status IN ('registered', 'declined'));

CREATE INDEX IF NOT EXISTS idx_event_registrations_event_response
  ON event_registrations(event_id, response_status);
