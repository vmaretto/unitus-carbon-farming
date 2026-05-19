-- 045_prof_carbonio.sql
-- Knowledge base e chat per Prof. Carbonio (AI tutor del Master).
-- Pattern derivato da azzurra-wrapper (api/chat.js + search_ricette RPC su Supabase),
-- riportato qui su Neon Postgres con pgvector.
--
-- Decisioni v1:
-- - Embeddings: OpenAI text-embedding-3-small (1536 dim) — gia' presente nelle deps,
--   costo trascurabile per la KB del master. Switch a Voyage in v2 senza migrazione.
-- - Solo audience studente in v1: NO demo pubblica (budget contenuto).
-- - Niente avatar/voce in questa migrazione (parcheggiato per v2).

CREATE EXTENSION IF NOT EXISTS vector;

-- =============================================================================
-- KB: SORGENTI
-- =============================================================================
-- Una sorgente = un documento "logico" (un PDF, un articolo blog, una lezione,
-- un testo normativo). Da una sorgente derivano N chunk indicizzati.

CREATE TABLE IF NOT EXISTS kb_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type TEXT NOT NULL CHECK (source_type IN (
    'resource',      -- da tabella resources (PDF/slide caricati dai docenti)
    'lms_lesson',    -- trascrizione videolezione LMS
    'blog_post',     -- articolo del blog
    'normative',     -- Regolamento UE 2024/3012, MASAF, ecc.
    'faq',           -- domande risposte da docenti via student_questions
    'manual'         -- testo inserito a mano dall'admin
  )),
  source_ref UUID,                       -- FK soft alla riga origine (resources.id, ecc.)
  title TEXT NOT NULL,
  author TEXT,
  url TEXT,                              -- link pubblico apribile dal frontend
  language TEXT DEFAULT 'it' CHECK (language IN ('it', 'en')),
  metadata JSONB NOT NULL DEFAULT '{}',  -- modulo, lezione, ssd, data, tag
  content_hash TEXT,                     -- md5 del testo originale, per re-index su change
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived', 'pending')),
  indexed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_sources_type ON kb_sources(source_type);
CREATE INDEX IF NOT EXISTS idx_kb_sources_status ON kb_sources(status);
CREATE INDEX IF NOT EXISTS idx_kb_sources_ref ON kb_sources(source_ref);

-- =============================================================================
-- KB: CHUNK
-- =============================================================================
-- Ogni chunk e' ~800 token con overlap 100. Embedding + FTS per ricerca ibrida.

CREATE TABLE IF NOT EXISTS kb_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES kb_sources(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_tokens INTEGER,
  -- Localizzazione per citazione precisa
  page_number INTEGER,                   -- pagina PDF
  slide_number INTEGER,                  -- numero slide PPTX
  start_seconds INTEGER,                 -- inizio segmento video transcript
  end_seconds INTEGER,
  heading TEXT,                          -- titolo sezione (utile per citazione "umana")
  -- Embedding OpenAI text-embedding-3-small = 1536 dim
  embedding vector(1536),
  -- Full-text search per ricerca ibrida
  content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('italian', coalesce(content, ''))) STORED,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_chunks_source ON kb_chunks(source_id);
-- HNSW per vector similarity (cosine). Performante anche con qualche milione di righe.
CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding ON kb_chunks
  USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_fts ON kb_chunks USING gin(content_tsv);

-- =============================================================================
-- FUNZIONE RPC: ricerca semantica + filtro
-- =============================================================================
-- Equivalente di azzurra-wrapper search_ricette() ma generica e con filtri.
-- Usa cosine similarity (1 - distance).

CREATE OR REPLACE FUNCTION search_kb_chunks(
  query_embedding vector(1536),
  match_count INTEGER DEFAULT 5,
  filter_language TEXT DEFAULT NULL,
  filter_source_types TEXT[] DEFAULT NULL,
  min_similarity FLOAT DEFAULT 0.2
)
RETURNS TABLE (
  chunk_id UUID,
  source_id UUID,
  source_type TEXT,
  source_title TEXT,
  source_url TEXT,
  page_number INTEGER,
  slide_number INTEGER,
  start_seconds INTEGER,
  heading TEXT,
  content TEXT,
  similarity FLOAT
)
LANGUAGE sql STABLE
AS $$
  SELECT
    c.id AS chunk_id,
    s.id AS source_id,
    s.source_type,
    s.title AS source_title,
    s.url AS source_url,
    c.page_number,
    c.slide_number,
    c.start_seconds,
    c.heading,
    c.content,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM kb_chunks c
  JOIN kb_sources s ON s.id = c.source_id
  WHERE s.status = 'active'
    AND c.embedding IS NOT NULL
    AND (filter_language IS NULL OR s.language = filter_language)
    AND (filter_source_types IS NULL OR s.source_type = ANY(filter_source_types))
    AND (1 - (c.embedding <=> query_embedding)) >= min_similarity
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- =============================================================================
-- CHAT: SESSIONI
-- =============================================================================

CREATE TABLE IF NOT EXISTS tutor_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  audience TEXT NOT NULL DEFAULT 'student'
    CHECK (audience IN ('student', 'teacher', 'admin')),
  title TEXT,                            -- auto-generato dalla prima domanda
  language TEXT DEFAULT 'it' CHECK (language IN ('it', 'en')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_message_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tutor_sessions_user ON tutor_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_tutor_sessions_audience ON tutor_sessions(audience);

-- =============================================================================
-- CHAT: MESSAGGI
-- =============================================================================

CREATE TABLE IF NOT EXISTS tutor_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES tutor_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  citations JSONB NOT NULL DEFAULT '[]', -- [{n, chunk_id, source_id, title, url, page, snippet}]
  retrieved_chunk_ids UUID[],            -- per audit / debug
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_cents NUMERIC(8,4),               -- 4 decimali, conserva cents.frazione
  model TEXT,
  latency_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tutor_messages_session ON tutor_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_tutor_messages_created ON tutor_messages(created_at DESC);

-- =============================================================================
-- RATE LIMITING e budget cap
-- =============================================================================
-- Una riga per (utente, giorno). UPDATE atomico per fare il check del limite.

CREATE TABLE IF NOT EXISTS tutor_usage_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_cents NUMERIC(8,4) NOT NULL DEFAULT 0,
  UNIQUE(user_id, day)
);

CREATE INDEX IF NOT EXISTS idx_tutor_usage_day ON tutor_usage_daily(day);

-- =============================================================================
-- AGGANCIO a student_questions: escalation dal tutor al docente
-- =============================================================================

ALTER TABLE student_questions
  ADD COLUMN IF NOT EXISTS escalated_from_message_id UUID
    REFERENCES tutor_messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_student_questions_escalated
  ON student_questions(escalated_from_message_id)
  WHERE escalated_from_message_id IS NOT NULL;
