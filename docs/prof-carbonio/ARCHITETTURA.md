# Prof. Carbonio — AI Tutor del Master in Carbon Farming

> Documento di architettura tecnica.
> Versione 0.2 — 19 maggio 2026 (added avatar layer)

## 1. Visione

**Prof. Carbonio** è un tutor conversazionale specializzato in carbon farming, disponibile 24/7 per gli studenti del Master e in versione demo per il pubblico.

Disponibile in **due modalità complementari**:

- **Text chat** (default): risposte testuali ricche, con citazioni cliccabili al PDF/slide/minuto del video. Modello: Claude Sonnet 4.5.
- **Modalità Avatar** (premium): conversazione vocale con avatar 3D parlante (LiveAvatar ex HeyGen), pattern riusato dal progetto `azzurra-wrapper`. Modello: Claude Haiku 4.5 per latenza bassa (~1.5-2.5s).

Lo studente attiva l'avatar con un toggle nel widget. La text chat è il "lavoro serio" (citazioni, ricerca, escalation al docente), l'avatar è l'esperienza "wow" per ripasso conversazionale e demo pubblica.

Risponde citando sempre la fonte (slide del docente X, paragrafo del Regolamento UE 2024/3012, minuto 12:30 della lezione del Prof. Y, articolo del blog Z), mai per "saputa" generica del modello. Quando non sa, escala la domanda al docente reale tramite la tabella `student_questions` già esistente.

Differenziatori rispetto a un ChatGPT generico:

- Risponde **solo** sulla base dei materiali del master (RAG strict)
- Cita sempre fonti puntuali e linkabili (apre la slide o salta al minuto della lezione)
- Conosce il calendario, i docenti, le scadenze, i moduli del corso
- Demo pubblica = strumento di marketing e lead generation per il master

## 2. Stack tecnologico

| Layer | Scelta | Motivazione |
|---|---|---|
| **LLM text chat** | Claude Sonnet 4.5 (`claude-sonnet-4-20250514`) | Già in uso per quiz; risposte ricche con citazioni |
| **LLM modalità avatar** | Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) | Latenza ~500ms — vitale per voce conversazionale, stesso modello usato in azzurra-wrapper |
| **LLM routing / classificazione** | Claude Haiku 4.5 | Query expansion, re-rank, intent detection (10× meno costoso) |
| **Avatar streaming** | LiveAvatar (ex HeyGen) via `@heygen/liveavatar-web-sdk` | Pattern già funzionante in azzurra-wrapper, modalità CUSTOM (LLM lo gestiamo noi) |
| **Embeddings** | Voyage AI `voyage-3-large` (1024d, multilingual) | Partner ufficiale Anthropic, qualità top in italiano, $0.06/MTok |
| **Vector store** | `pgvector` su Neon Postgres | Zero infra aggiuntiva, già hai Neon, query ibride SQL+vector |
| **Re-ranking** | Voyage `rerank-2` (opzionale, in FASE 2) | Migliora precisione top-K del 15-20% |
| **Backend** | Express in `api/index.js` (stesso monolito) | Coerente con il pattern del progetto |
| **Frontend chat** | Vanilla JS + Web Component | Coerente con vincolo "no framework" del CLAUDE.md — porting da React di azzurra-wrapper |
| **Streaming testo** | Server-Sent Events (SSE) | Risposte token-by-token, supportato nativamente da Vercel |
| **Rate limit** | Postgres `tutor_usage_daily` + fingerprint canvas/UA | Niente Redis necessario |

### Perché non OpenAI embeddings?

Hai già `openai` nel package.json (lo usi per Whisper trascrizioni, suppongo). Va benissimo in alternativa a Voyage. Confronto rapido:

- **Voyage `voyage-3-large`**: migliore qualità in italiano, partner Anthropic, $0.06/MTok input → consigliato.
- **OpenAI `text-embedding-3-small`** (1536d): più economico ($0.02/MTok), già hai la chiave → fallback accettabile.

Decisione consigliata: **Voyage** in produzione, ma il codice deve essere agnostico (interfaccia `embedProvider`) così switchi senza riscrivere nulla.

## 3. Schema database

Nuove tabelle (migrazione `045_prof_carbonio.sql`):

```sql
-- Estensione pgvector (Neon la supporta nativamente)
CREATE EXTENSION IF NOT EXISTS vector;

-- 3.1 Registro fonti che alimentano la knowledge base
CREATE TABLE IF NOT EXISTS kb_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type TEXT NOT NULL CHECK (source_type IN (
    'resource',      -- da tabella resources (PDF, slide caricati)
    'lms_lesson',    -- trascrizione videolezione
    'blog_post',     -- articolo del blog
    'normative',     -- regolamento UE 2024/3012 ecc.
    'faq',           -- domande gia' risposte da docenti
    'manual'         -- testo inserito a mano dall'admin
  )),
  source_id UUID,                       -- FK opzionale alla riga origine
  title TEXT NOT NULL,
  author TEXT,                          -- docente / autore
  url TEXT,                             -- link pubblico (apre il PDF, il video al minuto, ecc.)
  metadata JSONB NOT NULL DEFAULT '{}', -- modulo, lezione, ssd, data, tag
  language TEXT DEFAULT 'it',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  indexed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_kb_sources_type ON kb_sources(source_type);
CREATE INDEX idx_kb_sources_status ON kb_sources(status);

-- 3.2 Chunk di testo con embedding vettoriale
CREATE TABLE IF NOT EXISTS kb_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES kb_sources(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_tokens INTEGER,
  -- Riferimenti puntuali per citazione
  page_number INTEGER,                  -- pagina del PDF
  slide_number INTEGER,                 -- numero slide
  start_seconds INTEGER,                -- minutaggio inizio (per video)
  end_seconds INTEGER,
  heading TEXT,                         -- titolo sezione (utile per citazione "umana")
  -- Embedding vettoriale Voyage 1024d (o OpenAI 1536d se cambi provider)
  embedding vector(1024),
  -- Full-text search per ricerca ibrida
  content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('italian', content)) STORED,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
-- Indici per retrieval performante
CREATE INDEX idx_kb_chunks_source ON kb_chunks(source_id);
CREATE INDEX idx_kb_chunks_embedding ON kb_chunks
  USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_kb_chunks_fts ON kb_chunks USING gin(content_tsv);

-- 3.3 Sessioni di chat (uno studente puo' avere piu' sessioni)
CREATE TABLE IF NOT EXISTS tutor_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL, -- NULL per demo pubblica
  fingerprint TEXT,                     -- hash canvas/UA per demo pubblica
  audience TEXT NOT NULL CHECK (audience IN ('student', 'public_demo', 'teacher', 'admin')),
  lead_email TEXT,                      -- catturato in demo pubblica
  lead_phone TEXT,
  title TEXT,                           -- auto-generato dalla prima domanda
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_message_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_tutor_sessions_user ON tutor_sessions(user_id);
CREATE INDEX idx_tutor_sessions_fingerprint ON tutor_sessions(fingerprint);
CREATE INDEX idx_tutor_sessions_audience ON tutor_sessions(audience);

-- 3.4 Messaggi della chat
CREATE TABLE IF NOT EXISTS tutor_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES tutor_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  citations JSONB NOT NULL DEFAULT '[]',  -- [{chunk_id, source_id, title, url, page, snippet}]
  retrieved_chunk_ids UUID[],             -- chunks usati come contesto (per audit)
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_cents INTEGER,                     -- in centesimi di euro per audit
  model TEXT,                             -- es. 'claude-sonnet-4-20250514'
  latency_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_tutor_messages_session ON tutor_messages(session_id);

-- 3.5 Rate limit giornaliero (per fingerprint o user_id)
CREATE TABLE IF NOT EXISTS tutor_usage_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL,                    -- 'user:<uuid>' o 'fp:<hash>'
  day DATE NOT NULL,
  audience TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  UNIQUE(key, day)
);
CREATE INDEX idx_tutor_usage_day ON tutor_usage_daily(day);

-- 3.6 Feedback (thumbs up/down su risposte)
CREATE TABLE IF NOT EXISTS tutor_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES tutor_messages(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  rating SMALLINT NOT NULL CHECK (rating IN (-1, 1)),
  reason TEXT,                          -- 'inaccurate' | 'incomplete' | 'off_topic' | 'great' | testo libero
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_tutor_feedback_message ON tutor_feedback(message_id);

-- 3.7 Aggancio a student_questions: quando il tutor non sa, escala
ALTER TABLE student_questions
  ADD COLUMN IF NOT EXISTS escalated_from_message_id UUID
    REFERENCES tutor_messages(id) ON DELETE SET NULL;
```

## 4. Pipeline di ingestion

Tre modalità di ingest, tutte fanno capo allo stesso worker `ingestSource(sourceId)`:

1. **Auto (resource)** — quando `resources.extraction_status` passa a `'ready'`, un trigger / job inserisce una riga in `kb_sources` con `source_type = 'resource'` e lancia il chunking.
2. **Auto (lms_lesson)** — quando una videolezione ottiene la sua trascrizione (Whisper), si ingerisce il transcript con timestamping (chunk per ~60-90s di parlato).
3. **Manuale (admin)** — pagina `/admin/prof-carbonio.html`: upload PDF/testo, riga "manual" o "normative", trigger ingest.

### Chunking

- Target: **800 token per chunk**, **overlap 100**.
- Boundary semantici: si tenta lo split su `\n\n` (paragrafi), poi `. ` (frasi), poi cut hard.
- Header propagation: il titolo della sezione viene prepeso al chunk (migliora retrieval).
- Per i PDF, si preserva `page_number`. Per le slide PPTX, `slide_number`. Per i transcript, `start_seconds`/`end_seconds`.

### Embedding batch

- Voyage AI accetta batch di 128 chunk per richiesta.
- I chunk vengono embeddati e inseriti nella stessa transazione.
- Re-index automatico quando una `resource.extracted_text` cambia (versionamento via hash MD5 del contenuto).

## 5. Pipeline di retrieval (RAG)

```
user_question
   │
   ▼
[1] Query rewrite (Haiku, opzionale)
   ├─ Risolve riferimenti contestuali ("quello di prima")
   └─ Genera 2-3 query alternative per migliorare il recall
   │
   ▼
[2] Hybrid retrieval (Postgres)
   ├─ Vector search: top 20 per cosine similarity
   ├─ BM25 (full-text italiano): top 20 per ts_rank
   └─ Reciprocal Rank Fusion → top 20 unificati
   │
   ▼
[3] Re-rank (Voyage rerank-2, opzionale FASE 2)
   └─ Riordina top 20 → top 5 piu' rilevanti
   │
   ▼
[4] Context assembly
   ├─ Inserisce i 5 chunk nel prompt con marker [Fonte 1], [Fonte 2]...
   └─ Aggiunge metadati struttura corso se la domanda e' organizzativa
   │
   ▼
[5] Sonnet 4.5 risponde (streaming SSE)
   ├─ System prompt persona "Prof. Carbonio"
   ├─ Citazioni inline obbligatorie [^1] [^2]
   └─ Se confidence bassa → suggerisce escalation a docente
   │
   ▼
[6] Persistenza + telemetria
   ├─ Salva tutor_messages con citations e cost_cents
   └─ Aggiorna tutor_usage_daily
```

### System prompt (bozza)

```
Sei Prof. Carbonio, tutor accademico del Master di II livello in
Carbon Farming dell'Universita' della Tuscia.

Regole inderogabili:
1. Rispondi SOLO basandoti sulle FONTI fornite qui sotto.
2. Cita SEMPRE la fonte con il marcatore [^N] dove N e' il numero
   della fonte. Una risposta senza citazioni e' un errore grave.
3. Se le fonti non bastano a rispondere con certezza, dillo
   chiaramente e proponi allo studente di inoltrare la domanda al
   docente competente (sara' l'interfaccia a gestire l'escalation).
4. Lingua: italiano accademico ma chiaro. Spiega gli acronimi
   (CRCF, SOC, CFU, SSD) la prima volta che li usi.
5. Se la domanda e' fuori scope (es. "che tempo fa?", politica,
   gossip), rispondi con cortesia che il tuo dominio e' il carbon
   farming e riporta lo studente sul tema.

FONTI:
{numbered_chunks_with_metadata}

CRONOLOGIA CONVERSAZIONE:
{last_6_messages}

DOMANDA STUDENTE:
{user_question}
```

## 6. Endpoint API

Tutti sotto `/api/tutor/*`, registrati in `api/index.js`.

| Metodo | Endpoint | Auth | Descrizione |
|---|---|---|---|
| POST | `/api/tutor/sessions` | studente o public | Crea sessione; per public richiede fingerprint |
| GET | `/api/tutor/sessions` | studente | Lista sue sessioni |
| GET | `/api/tutor/sessions/:id` | owner | Dettaglio sessione + messaggi |
| POST | `/api/tutor/sessions/:id/messages` | owner | Invia messaggio → stream SSE risposta |
| POST | `/api/tutor/messages/:id/feedback` | owner | Thumbs up/down |
| POST | `/api/tutor/messages/:id/escalate` | studente | Inoltra a docente (crea riga in `student_questions`) |
| GET | `/api/tutor/usage` | studente | Quante domande hai usato oggi |
| POST | `/api/tutor/public/lead` | public | Cattura email/telefono in demo pubblica |
| POST | `/api/admin/tutor/sources` | admin | Crea/aggiorna sorgente KB manuale |
| POST | `/api/admin/tutor/sources/:id/reindex` | admin | Re-ingest forzato |
| GET | `/api/admin/tutor/analytics` | admin | Dashboard: cost/giorno, top domande, % escalation |

### Rate limiting

| Pubblico | Limite |
|---|---|
| Studente iscritto attivo | 50 domande / giorno, soft cap 200 (alert admin) |
| Demo pubblica (fingerprint) | 5 domande / giorno, dopo la 3a modal "iscriviti" |
| Teacher/Admin | Illimitato (per testing/QA) |

Implementazione: `UPDATE tutor_usage_daily ... RETURNING message_count`, abort se supera la soglia.

## 7. Frontend

### 7.1 Widget studenti — `/learn/`

Web component `<prof-carbonio-chat>` montato nella sidebar dell'area studente in tutte le pagine `/learn/*.html`. Features:

- Pannello laterale espandibile (40% larghezza desktop, full-screen mobile)
- Storia conversazioni precedenti
- Citazioni cliccabili → aprono il viewer al punto giusto (PDF page, video time)
- Pulsante "Inoltra al docente" su ogni risposta
- Indicatore quota giornaliera

### 7.2 Demo pubblica — homepage

Sezione hero della home `index.html`:

- Header: "Hai domande sul Carbon Farming? Provami."
- Esempi di prompt cliccabili: "Cosa cambia con il Regolamento UE 2024/3012?", "Come si calcola il SOC?", "Quali pratiche generano piu' crediti?"
- Dopo la 3a domanda: modal con form lead capture (nome + email + telefono) e CTA "Scopri il Master".
- Watermark "Powered by Prof. Carbonio — Master Carbon Farming UNITUS".

## 8. Stima costi mensili

Ipotesi a regime: 100 studenti attivi, 30 domande/mese ciascuno + 500 utenti pubblici demo con 3 domande medie.

| Voce | Calcolo | Costo/mese |
|---|---|---|
| Ingestion embeddings (one-shot, ~5M token totali KB) | 5M × $0.06/MTok | $0.30 |
| Re-embedding update (~500k token/mese) | 0.5M × $0.06/MTok | $0.03 |
| Embedding query studenti (3000 query × 30 token) | trascurabile | <$0.01 |
| Sonnet 4.5 input (3000 × ~3000 token contesto) | 9M × $3/MTok | $27 |
| Sonnet 4.5 output (3000 × ~500 token risposta) | 1.5M × $15/MTok | $22.5 |
| Demo pubblica (1500 query × stessi token) | 4.5M in + 0.75M out | $24.75 |
| Voyage rerank (FASE 2, opzionale) | 4500 query × $0.05/Mreq | $0.50 |
| **Totale stimato** | | **~$75/mese** |

Soglie di allerta in `tutor_usage_daily`:
- Alert email admin a $5/giorno di spesa pubblica
- Auto-disable demo pubblica oltre $10/giorno
- Hard cap mensile configurabile via env `TUTOR_MONTHLY_BUDGET_USD`

## 9. Sicurezza e privacy

- **Prompt injection**: i chunk vengono delimitati con XML tag e il system prompt istruisce a ignorare istruzioni nei chunk. Test automatici nella suite con prompt malevoli noti.
- **Esfiltrazione contenuti riservati**: alcuni materiali (slide non pubblicate, test soluzioni) NON devono finire in KB. Filtro: `kb_sources.metadata.visibility = 'student'` vs `'public_demo'`. La demo pubblica retrieva SOLO `visibility in ('public', 'public_demo')`.
- **GDPR**: messaggi conservati 12 mesi, lead capture con consenso esplicito, export/cancellazione su richiesta utente.
- **PII**: log della query rimuove pattern email/telefono/CF prima del salvataggio (regex base).
- **Rate limiting** già coperto in §6.

## 10. Osservabilità

Dashboard admin `/admin/prof-carbonio-dashboard.html`:

- Domande/giorno (split studente / demo)
- Costo €/giorno (con cap visivo)
- Top 20 domande della settimana
- % risposte con "non lo so / escalation"
- Risposte con thumb-down → coda di revisione
- Coverage KB: quali documenti sono richiamati piu' spesso, quali mai
- Tempi di risposta P50/P95

## 11. Integrazione con quanto esiste

| Esistente | Come si aggancia |
|---|---|
| `resources.extracted_text` | Trigger di ingest quando `extraction_status='ready'` |
| `lms_lessons` (transcript) | Sorgente di tipo `lms_lesson`, chunk timestamped |
| `blog_posts` | Sorgente di tipo `blog_post`, ingerita all'autopubblicazione |
| `student_questions` | Endpoint `escalate` crea riga con `escalated_from_message_id` |
| `users` + magic_link | Auth riusata per accesso studenti |
| `course_editions` | Filtro: studente vede solo KB della propria edizione |
| Pattern Anthropic SDK | Codice esistente in `api/index.js` riusato per pattern |

## 12. Decisioni aperte

1. **Voyage o OpenAI per embedding?** — Voyage consigliato, ma posso partire con OpenAI per non aggiungere subito una chiave (hai gia' `openai` nelle deps).
2. **Re-rank dal giorno 1 o da FASE 2?** — Consiglio FASE 2: aggiunge $0.50/mese ma è ottimizzazione, non differenza vita/morte.
3. **Dove vive il widget pubblico**: solo home, o anche pagine `richiedi-informazioni.html` e `iscrizioni.html`? Ottimo per conversion.
4. **Personalita' di Prof. Carbonio**: sobrio-accademico o piu' "buddy" amichevole? Influenza il system prompt.
5. **Lingua**: solo italiano in v1, o anche inglese (utile per studenti internazionali e per il marketing)?
6. **Avatar dedicato vs riuso di Azzurra?** — Vedi §13. Se creiamo un avatar nuovo per il Prof. va creato su LiveAvatar e ottenuto un nuovo `AVATAR_ID`. Costo aggiuntivo: ~$0 setup + utilizzo.

---

## 13. Layer Avatar (modalità voce)

### 13.1 Architettura riusata da `azzurra-wrapper`

Il pattern è già operativo nel tuo progetto azzurra-wrapper. Lo portiamo in `unitus-carbon-farming` con tre adattamenti:

1. **Da React a Custom Element vanilla** — `AzzurraAvatar.jsx` e `useAzzurra.js` vengono riscritti come `<prof-carbonio-avatar>` Web Component (~150 righe JS).
2. **Aggancio al RAG** — `api/chat.js` di azzurra-wrapper riceve la domanda e chiama direttamente Claude. Qui invece passa prima dalla pipeline RAG (recupero chunk → assembly contesto → Claude Haiku con citazioni implicite).
3. **Voce + citazioni** — Le citazioni `[^N]` non vengono pronunciate dall'avatar (l'audio le ometterebbe goffamente), ma compaiono nella trascrizione testuale sottostante con link cliccabili.

### 13.2 Flow conversazione avatar

```
[Utente parla] → LiveAvatar STT (~500ms)
                      │
                      ▼
              testo trascritto
                      │
                      ▼
          API /api/tutor/avatar/turn
          ├─ Hybrid retrieval (top 5 chunks, ~150ms)
          ├─ Claude Haiku con contesto (~500ms streaming)
          └─ Risposta sanitizzata (cita marker rimossi)
                      │
                      ▼
       LiveAvatar.repeat(testoRisposta)
                      │
                      ▼
          [Avatar pronuncia + lipsync]
                      │
                      ▼
       Side-panel mostra trascrizione
       con citazioni cliccabili
```

**Budget latenza target**: ≤2.5s da fine parlata utente a inizio risposta avatar.

### 13.3 Endpoint aggiuntivi

| Metodo | Endpoint | Auth | Descrizione |
|---|---|---|---|
| POST | `/api/tutor/avatar/session` | studente o public | Genera session token LiveAvatar (porting da `api/liveavatar-session.js`) |
| POST | `/api/tutor/avatar/turn` | owner | Riceve trascrizione utente → RAG → Haiku → ritorna testo pulito per `LiveAvatar.repeat()` |

### 13.4 Modifiche allo schema DB

```sql
ALTER TABLE tutor_sessions
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'text'
    CHECK (mode IN ('text', 'avatar', 'mixed')),
  ADD COLUMN IF NOT EXISTS liveavatar_session_id TEXT,
  ADD COLUMN IF NOT EXISTS avatar_total_seconds INTEGER DEFAULT 0;

ALTER TABLE tutor_messages
  ADD COLUMN IF NOT EXISTS audio_seconds INTEGER,  -- durata audio risposta avatar
  ADD COLUMN IF NOT EXISTS input_modality TEXT
    CHECK (input_modality IN ('text', 'voice'));
```

### 13.5 Costi avatar (in aggiunta ai €75 della §8)

LiveAvatar fattura a **secondi di video generato**. Tariffa indicativa (verifica su dashboard LiveAvatar): ~$0.10/min.

| Scenario | Calcolo | Costo/mese |
|---|---|---|
| Studenti che usano avatar 5 min/giorno × 100 utenti × 20 giorni | 10.000 min × $0.10 | $1.000 |
| Studenti che usano avatar 2 min/giorno × 100 utenti × 20 giorni | 4.000 min × $0.10 | $400 |
| Demo pubblica con avatar (500 sessioni × 1 min media) | 500 min × $0.10 | $50 |

**Strategia di contenimento costi consigliata:**

- Avatar è **opt-in esplicito** (toggle nel widget, non default)
- Demo pubblica: avatar disponibile solo per primi 30 secondi, poi text-only con CTA "iscriviti per accesso illimitato"
- Cap mensile in `tutor_usage_daily.avatar_seconds` con auto-fallback a text mode
- Avatar limitato a 10 minuti/giorno per studente in v1, espandibile poi

### 13.6 System prompt versione avatar

Il system prompt cambia leggermente quando lo studente è in modalità voce:

```
Sei Prof. Carbonio in modalita' conversazione vocale.

Differenze rispetto alla chat scritta:
1. Risposte brevi (max 60 parole) — l'utente ti sta ascoltando, non leggendo.
2. NIENTE marker di citazione [^N] nella risposta orale (suonerebbero
   strani). Le fonti compaiono solo nel pannello testuale.
3. Se la risposta è complessa, suggerisci "vediamo questo punto nella
   chat scritta" e l'interfaccia mostrerà la versione lunga.
4. Tono colloquiale ma accademico — come un docente che spiega alla
   lavagna, non un saggio scritto.
5. Conferme brevi ("ottima domanda", "vediamo insieme") sono
   benvenute per rendere la conversazione naturale.

FONTI: {numbered_chunks}
DOMANDA: {trascrizione_utente}
```

### 13.7 Riuso pratico da azzurra-wrapper

File da portare (con adattamenti):

| File originale | Destinazione in unitus-carbon-farming | Note |
|---|---|---|
| `api/liveavatar-session.js` | sezione di `api/index.js` | Funzione `getLiveAvatarSessionToken()` |
| `api/chat.js` | logica fusa in `api/lib/tutor-chat.js` | Sostituito da pipeline RAG, non più chiamata diretta a Claude |
| `src/hooks/useAzzurra.js` | parte di `learn/js/prof-carbonio-avatar.js` | Convertito da hook React a closure JS vanilla |
| `src/components/AzzurraAvatar.jsx` | Custom Element `<prof-carbonio-avatar>` | Render via `innerHTML` + querySelector, no JSX |
| `src/components/AzzurraAvatar.css` | inline o `learn/css/prof-carbonio.css` | Riusabile quasi integralmente |

`azzurra-wrapper` rimane intatto come tuo laboratorio per altri progetti — nessuna modifica richiesta lì.
