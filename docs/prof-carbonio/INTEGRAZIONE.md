# Prof. Carbonio — Guida integrazione backend

Come accendere il backend appena creato in 5 passi.

## 1. Eseguire la migrazione SQL

**Niente da fare a mano** — il tuo `api/index.js` (linee 3730-3747) ha gia' un
sistema di auto-migrazione: legge i file in `db/migrations/`, applica quelli
non ancora eseguiti al cold start. Visto che `045_prof_carbonio.sql` e' in
quella cartella, parte da sola al prossimo deploy o `npm run dev`.

Vedrai nei log:

```
Running migration: 045_prof_carbonio.sql
Migration completed: 045_prof_carbonio.sql
```

**Nota su pgvector**: se al primo deploy vedi un errore tipo
`extension "vector" is not available`, vai sul dashboard Neon → tuo branch →
Settings → Extensions e abilita `vector` manualmente, poi riavvia il server.

## 2. Variabili d'ambiente

Aggiungi al tuo `.env` (e su Vercel Settings → Environment Variables):

```bash
# Gia' presenti
DATABASE_URL=postgres://...
ANTHROPIC_API_KEY=sk-ant-...

# Nuove
TUTOR_DAILY_LIMIT=50               # domande/giorno per studente (default 50)
```

**OPENAI_API_KEY**: usa quella che hai gia' configurato — la stessa che il codice
usa a `api/index.js` linea 4011 per la generazione AI. Niente chiave nuova da
prendere.

## 3. Wiring in `api/index.js`

Aggiungi questo blocco una volta sola in `api/index.js`, dopo che `pool`,
`anthropic` (creato come istanza globale) e i middleware sono già definiti
(qualsiasi punto dopo la creazione del `pool` e dei middleware `requireStudent`,
`requireNonGuest`):

```js
// Prof. Carbonio — AI Tutor del Master
const Anthropic = require('@anthropic-ai/sdk').default;
const OpenAI = require('openai');
const { registerProfCarbonioRoutes } = require('./prof-carbonio-routes');

const profCarbonioAnthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const profCarbonioOpenAI = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

registerProfCarbonioRoutes(app, {
  pool,
  anthropic: profCarbonioAnthropic,
  openai: profCarbonioOpenAI,
  requireStudent,
  requireNonGuest
});
```

## 4. Verifica veloce con curl

Una volta deployato (o in locale `npm run dev`):

```bash
# Login studente — ottieni un JWT come fai oggi per /api/lms/*
TOKEN="..."

# Crea una sessione
curl -X POST http://localhost:3000/api/tutor/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"firstMessage": "Spiegami il Regolamento UE 2024/3012"}'

# Risposta: { "session": { "id": "...", ... } }
SESSION_ID="..."

# Invia un messaggio
curl -X POST http://localhost:3000/api/tutor/sessions/$SESSION_ID/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "Cosa cambia per gli agricoltori italiani con il nuovo regolamento?"}'

# Risposta: { reply, citations, usage, latencyMs, ... }

# Vedi la tua quota
curl http://localhost:3000/api/tutor/usage -H "Authorization: Bearer $TOKEN"
```

**Nota**: la prima domanda restituirà una risposta tipo *"Non ho ancora i
materiali del Master nella mia knowledge base"*. Questo è atteso. La KB è
vuota finché non eseguiamo l'ingest (passo successivo, non ancora pronto).

## 5. Cosa manca ancora

Backend creato in questa fase:

- [x] Schema DB (`045_prof_carbonio.sql`)
- [x] System prompt + persona Prof. Carbonio (`prof-carbonio-prompt.js`)
- [x] Embeddings + ricerca semantica/FTS/ibrida (`prof-carbonio-search.js`)
- [x] Chat handler con citazioni, costi, rate limit (`prof-carbonio-chat.js`)
- [x] Route Express (`prof-carbonio-routes.js`)
- [x] Escalation al docente (riusa `student_questions`)

Ancora da fare:

- [ ] **Ingest worker** — modulo che chunka `resources.extracted_text`, blog,
  trascrizioni e popola `kb_chunks` con gli embedding. Senza questo la KB è vuota.
- [ ] **Frontend widget** — Custom Element vanilla JS in `/learn/` (porting da
  AzzurraChat.jsx) con citazioni cliccabili e bottone escalation.
- [ ] **Pagina admin** `/admin/prof-carbonio.html` per gestire KB sources,
  vedere analytics (cost, top domande), revisionare feedback.

Procedi con l'ingest worker quando hai eseguito i passi 1-3 e visto che il
backend risponde (anche con KB vuota).

## Costo per messaggio

Modello: Claude Haiku 4.5 (`claude-haiku-4-5-20251001`).
Una domanda tipica costa circa **0.4 centesimi di euro**:

| Voce | Token medi | Costo (€) |
|---|---|---|
| Input (system + 5 fonti + history + domanda) | ~3.000 | 0.0022 |
| Output (~150 parole) | ~250 | 0.0009 |
| Embedding query | ~20 | <0.0001 |
| **Totale per messaggio** | | **~0.0031 €** |

Con €10/mese di budget: **~3.200 domande/mese** distribuite tra tutti gli studenti.
Con limite default di 50 domande/giorno/utente e 50 studenti: capacita' teorica
~2.500 domande/giorno se tutti usano al massimo, ma il pattern reale e' ~5-10
domande/utente/giorno, quindi ampio margine.
