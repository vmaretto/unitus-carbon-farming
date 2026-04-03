-- Teacher-facing documents and signatures (liberatorie docenti)
CREATE TABLE IF NOT EXISTS teacher_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  document_type TEXT DEFAULT 'liberatoria',
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS teacher_document_signatures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES teacher_documents(id) ON DELETE CASCADE,
  teacher_id UUID NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  consent_given BOOLEAN NOT NULL,
  signature_image TEXT,
  signature_method TEXT DEFAULT 'draw',
  signer_name TEXT,
  signer_surname TEXT,
  ip_address TEXT,
  user_agent TEXT,
  signed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(document_id, teacher_id)
);

CREATE INDEX IF NOT EXISTS idx_teacher_doc_sigs_teacher ON teacher_document_signatures(teacher_id);
CREATE INDEX IF NOT EXISTS idx_teacher_doc_sigs_doc ON teacher_document_signatures(document_id);
