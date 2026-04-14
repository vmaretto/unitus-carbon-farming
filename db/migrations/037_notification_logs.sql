CREATE TABLE IF NOT EXISTS notification_batches (
  id UUID PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'all',
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  course_edition_id UUID NULL,
  bcc_email TEXT NULL,
  requested_total INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT notification_batches_scope_check CHECK (scope IN ('all', 'manual')),
  CONSTRAINT notification_batches_status_check CHECK (status IN ('pending', 'completed', 'partial', 'failed'))
);

CREATE TABLE IF NOT EXISTS notification_batch_recipients (
  id BIGSERIAL PRIMARY KEY,
  batch_id UUID NOT NULL REFERENCES notification_batches(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  first_name TEXT NULL,
  last_name TEXT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT NULL,
  provider TEXT NULL,
  sent_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT notification_batch_recipients_status_check CHECK (status IN ('pending', 'sent', 'failed', 'not_found'))
);

CREATE INDEX IF NOT EXISTS idx_notification_batches_created_at
  ON notification_batches(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_batch_recipients_batch_id
  ON notification_batch_recipients(batch_id);

CREATE INDEX IF NOT EXISTS idx_notification_batch_recipients_status
  ON notification_batch_recipients(status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_batch_recipients_batch_email
  ON notification_batch_recipients(batch_id, lower(email));
