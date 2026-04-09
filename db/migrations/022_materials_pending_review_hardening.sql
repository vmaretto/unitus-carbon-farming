-- Harden teacher materials review schema for legacy DBs.
-- Some environments may still miss columns introduced after early teachers migrations.

ALTER TABLE materials_pending
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Keep updated_at aligned for existing rows
UPDATE materials_pending
SET updated_at = COALESCE(updated_at, created_at, NOW())
WHERE updated_at IS NULL;
