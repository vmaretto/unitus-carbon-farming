-- 058_network_intro_requests.sql
-- Richieste di contatto tra partecipanti del network riservato

CREATE TABLE IF NOT EXISTS network_intro_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT network_intro_requests_no_self CHECK (sender_user_id <> recipient_user_id),
  CONSTRAINT network_intro_requests_status_check CHECK (status IN ('pending', 'accepted', 'declined', 'archived'))
);

CREATE INDEX IF NOT EXISTS idx_network_intro_requests_sender ON network_intro_requests(sender_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_network_intro_requests_recipient ON network_intro_requests(recipient_user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_network_intro_requests_pending_unique
  ON network_intro_requests(sender_user_id, recipient_user_id)
  WHERE status = 'pending';
