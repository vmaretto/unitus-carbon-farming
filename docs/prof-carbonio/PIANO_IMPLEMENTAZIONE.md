# Prof. Carbonio — Piano di implementazione

> Roadmap operativa per portare il tutor da zero a produzione.
> Versione 0.2 — added Sprint Avatar.
> Riferimento: [ARCHITETTURA.md](./ARCHITETTURA.md)

## Logica del piano

**Sei sprint** da circa 1-1.5 settimana ciascuno. MVP utilizzabile dopo **Sprint 2**, modalità avatar attiva dopo **Sprint 4**, demo pubblica con wow factor dopo **Sprint 5**, regime dopo **Sprint 6**.

Il piano sfrutta il fatto che hai già **`azzurra-wrapper`** funzionante: il porting dell'avatar (Sprint 4) è il pezzo più rapido perché non parti da zero — sai già che il pattern LiveAvatar + Claude in modalità CUSTOM funziona end-to-end.

Il piano si **innesta nella FASE 1-2** del piano LMS già esistente nel CLAUDE.md, non la sostituisce. Le tabelle nuove hanno tutte prefisso `kb_` o `tutor_` per non creare confusione.

---

## Sprint 1 — Fondamenta KB (5-7 giorni)

**Obiettivo**: ingerire materiali esistenti in formato cercabile. Niente UI ancora.

### Deliverable

- [ ] Migrazione SQL `045_prof_carbonio.sql` con tutte le tabelle nuove + estensione `pgvector`
- [ ] Modulo `api/lib/embeddings.js` con interfaccia `embed(texts[]) → vectors[]` (Voyage + fallback OpenAI)
- [ ] Modulo `api/lib/chunker.js` che divide testo in chunk semantici con metadati
- [ ] Worker `api/lib/kb-ingest.js`: `ingestSource({sourceId, content, metadata})`
- [ ] Script CLI `scripts/ingest-all.js` per backfill iniziale di:
  - tutte le `resources` con `extraction_status='ready'`
  - tutti i `blog_posts` pubblicati
  - testo del Regolamento UE 2024/3012 (PDF da caricare a mano)
- [ ] Endpoint admin `POST /api/admin/tutor/sources` (manual + reindex)
- [ ] Test: query SQL diretta `SELECT id, title FROM kb_chunks ORDER BY embedding <=> :q LIMIT 5` deve tornare risultati sensati

### Setup ambiente

```bash
# Nuove env var
VOYAGE_API_KEY=...           # da https://www.voyageai.com
ANTHROPIC_API_KEY=...        # gia' presente
TUTOR_EMBED_PROVIDER=voyage  # voyage | openai
TUTOR_MONTHLY_BUDGET_USD=200
```

### Stima costo embedding iniziale
~5M token totali di KB × $0.06/MTok = **$0.30 una tantum**.

---

## Sprint 2 — Retrieval + chat backend (5-7 giorni)

**Obiettivo**: Prof. Carbonio risponde via curl. Niente UI, ma logica end-to-end funzionante.

### Deliverable

- [ ] Modulo `api/lib/tutor-retrieval.js`:
  - Hybrid search (vector + BM25 + Reciprocal Rank Fusion)
  - Filtri per `audience` (student/public_demo) e `course_edition_id`
- [ ] Modulo `api/lib/tutor-chat.js`:
  - System prompt "Prof. Carbonio" con regole di citazione
  - Chiamata Sonnet 4.5 streaming
  - Estrazione citazioni `[^N]` dalla risposta
  - Persistenza `tutor_messages` con `cost_cents`
- [ ] Endpoint `POST /api/tutor/sessions/:id/messages` (SSE streaming)
- [ ] Endpoint `GET /api/tutor/sessions` + `POST /api/tutor/sessions`
- [ ] Rate limit middleware `tutor_usage_daily`
- [ ] Test integrazione: invio domanda → ricezione risposta con almeno 2 citazioni valide

### Definition of Done
Posso chiedere da Postman: *"Cosa cambia con il Regolamento 2024/3012 per gli agricoltori italiani?"* e ricevere una risposta in italiano con citazioni cliccabili ai PDF/slide originali. Costo loggato in `tutor_messages.cost_cents`.

---

## Sprint 3 — Widget chat studenti in /learn/ (5-7 giorni)

**Obiettivo**: gli studenti iscritti usano Prof. Carbonio dentro il LMS.

### Deliverable

- [ ] Web component `learn/js/prof-carbonio-chat.js` (vanilla JS, no framework)
  - Pannello laterale, espandibile, mobile-first
  - Cronologia sessioni
  - Streaming SSE con typewriter effect
  - Citazioni cliccabili che aprono in nuova tab/iframe il viewer
  - Pulsante "Inoltra al docente" → POST `/api/tutor/messages/:id/escalate`
  - Pulsante feedback 👍 👎
- [ ] Iniezione del widget in tutte le pagine `/learn/*.html` (snippet `<script src="/learn/js/prof-carbonio-chat.js" defer></script>` + `<prof-carbonio-chat>` nel footer)
- [ ] Endpoint `POST /api/tutor/messages/:id/escalate` che crea riga in `student_questions` con riferimento al messaggio originale
- [ ] Pagina dedicata `learn/tutor.html` con vista full-screen e archivio sessioni
- [ ] Banner di onboarding alla prima apertura

### Definition of Done
Uno studente entra in `/learn/`, apre il widget, fa 3 domande, clicca una citazione (apre PDF alla pagina giusta), e fa escalation di una domanda al docente che la vede in `/teachers/`.

---

## Sprint 4 — Modalità Avatar (porting da azzurra-wrapper) (5 giorni)

**Obiettivo**: Prof. Carbonio parla. Toggle "modalità avatar" attivo nel widget /learn/.

### Deliverable

- [ ] Migrazione `046_tutor_avatar.sql`: colonne `mode`, `liveavatar_session_id`, `avatar_total_seconds` su `tutor_sessions`; `audio_seconds` + `input_modality` su `tutor_messages`
- [ ] Endpoint `POST /api/tutor/avatar/session` — porting da `api/liveavatar-session.js` di azzurra-wrapper, adattato all'auth unitus (JWT studente)
- [ ] Endpoint `POST /api/tutor/avatar/turn` — riceve trascrizione utente, esegue retrieval RAG ridotto (top 3 chunks, no rerank per latenza), genera risposta con Claude **Haiku** (max 60 parole), ritorna testo "pulito" senza marker `[^N]`
- [ ] System prompt versione voce (vedi ARCHITETTURA.md §13.6)
- [ ] Custom Element `<prof-carbonio-avatar>` in `learn/js/prof-carbonio-avatar.js`:
  - Porting da `AzzurraAvatar.jsx` + `useAzzurra.js` → vanilla JS
  - Inizializza LiveAvatar SDK con session token
  - Cattura STT del LiveAvatar → POST al nostro endpoint turn
  - Riceve testo risposta → `liveAvatar.repeat(testo)`
  - Side-panel laterale con trascrizione testuale + citazioni cliccabili
- [ ] Toggle nel widget chat: "🎙️ Modalità avatar" → switcha tra text e voice
- [ ] Cap utilizzo: max 10 min/giorno per studente in v1 (configurabile via env)
- [ ] Tracking secondi consumati in `tutor_usage_daily.avatar_seconds`
- [ ] Auto-fallback a text mode se cap superato o errore LiveAvatar

### Setup env

```bash
LIVEAVATAR_API_KEY=...                  # da app.liveavatar.com (riusa la chiave di Azzurra o creane una nuova)
LIVEAVATAR_AVATAR_ID=...                # avatar dedicato per Prof. Carbonio (crearne uno ad hoc o riusare Azzurra)
LIVEAVATAR_DAILY_MINUTES_PER_STUDENT=10
LIVEAVATAR_MONTHLY_BUDGET_USD=300
```

### Decisioni di design

- **Avatar dedicato o riuso di Azzurra?** Consigliato crearne uno nuovo per dare a Prof. Carbonio un'identità distintiva (es. uomo 50enne, ambientazione accademica). Costo setup: ~$0, alcuni minuti di click su dashboard LiveAvatar.
- **Quando l'avatar parla, la citazione come si mostra?** Solo nel pannello testuale laterale. L'audio resta pulito. Quando lo studente clicca "vedi le fonti" il pannello si espande e mostra le citazioni numerate cliccabili.

### Definition of Done
Uno studente entra in `/learn/`, attiva il toggle avatar, chiede *"Spiegami brevemente il Regolamento 2024/3012"*, vede Prof. Carbonio parlare in italiano con lipsync, e nel pannello laterale vede la trascrizione con 2 citazioni cliccabili che aprono i PDF originali.

---

## Sprint 5 — Demo pubblica con avatar + lead capture (5 giorni)

**Obiettivo**: la home `carbonfarmingmaster.it` converte visitatori in lead grazie a Prof. Carbonio che li accoglie parlando.

### Deliverable

- [ ] Sezione hero in `index.html` con avatar Prof. Carbonio sempre visibile
- [ ] On-load: Prof. Carbonio dice un saluto di 5 secondi ("Ciao, sono Prof. Carbonio, chiedimi qualsiasi cosa sul Master in Carbon Farming")
- [ ] Visitatore può: cliccare prompt suggerito, scrivere testo, o premere "🎙️ Parla" per voce
- [ ] Fingerprinting browser via canvas hash + UA + IP truncato (no cookie persistenti)
- [ ] Endpoint `POST /api/tutor/sessions` pubblico con `audience='public_demo'`
- [ ] Esempi di prompt cliccabili (8-10 domande "magnete")
- [ ] Limiti demo pubblica:
  - 5 messaggi/giorno text + 60 secondi totali avatar/giorno
  - Dopo 3 messaggi o 30s avatar → modal "iscriviti per accesso illimitato"
- [ ] Form lead capture (nome, email, telefono, consenso GDPR) integrato in nuova tabella `master_leads`
- [ ] Email transactional via Resend (già installato): "Grazie per aver parlato con Prof. Carbonio" + invito open day + CTA iscrizione master
- [ ] Auto-disable avatar pubblico oltre $20/giorno (text-only fallback)
- [ ] Watermark "Master Carbon Farming UNITUS" sull'angolo del video avatar

### Definition of Done
Un visitatore anonimo apre carbonfarmingmaster.it, viene accolto da Prof. Carbonio che parla, fa una domanda vocale, riceve risposta vocale, alla 3a domanda parte modal, lascia email, riceve follow-up email. Admin vede lead in dashboard.

---

## Sprint 6 — Dashboard admin + ottimizzazioni (5 giorni)

**Obiettivo**: capire come va, sistemare i problemi, abbattere i costi.

### Deliverable

- [ ] Pagina `/admin/prof-carbonio.html` con sezioni:
  - **KB Sources**: tabella, riga per riga reindex, edit metadati, archive
  - **Analytics**: grafici cost/giorno, domande/giorno, top domande, escalation rate
  - **Review**: code di feedback negativi e risposte da migliorare
  - **Leads** demo pubblica: tabella esportabile CSV
- [ ] Integrazione **Voyage rerank-2** (riduce contesto del 60% → costo Sonnet -50%)
- [ ] **Prompt caching** Anthropic sul system prompt + KB context statici (sconto 90% sui token cached, gia' supportato dall'SDK)
- [ ] Cache risposte identiche (hash domanda) per ridurre call ridondanti
- [ ] **Test antivelenamento**: suite con 20 prompt malevoli noti (jailbreak, injection, off-topic) che devono essere bloccati
- [ ] Documentazione `/docs/prof-carbonio/RUNBOOK.md` per gestione operativa
- [ ] Setup alert email su budget cap mensile

### Definition of Done
Admin apre la dashboard e capisce in 30 secondi: quanto sta spendendo, quali argomenti generano piu' domande, quali documenti mancano dalla KB (perche' la gente chiede cose a cui non c'e' risposta).

---

## Cronoprogramma e dipendenze

```
Sprint 1 (KB ingest)          |█████████|
Sprint 2 (Retrieval + chat)    |████████|        <- MVP testabile via API
Sprint 3 (Widget /learn/ text) |████████|        <- prima release a studenti pilota
Sprint 4 (Avatar mode)         |███████|         <- Prof. Carbonio parla
Sprint 5 (Demo pubblica+avatar)|███████|         <- wow factor pubblico
Sprint 6 (Dashboard+ottim.)    |███████|         <- regime
                               5  10  15  20  25  30  35 giorni lavorativi
```

Totale ~6-7 settimane calendariali con una persona dedicata.

## Decisioni che mi servono prima di iniziare lo Sprint 1

1. **Embedding provider**: Voyage (consigliato) o OpenAI (gia' hai la chiave)?
2. **Documenti normativi**: hai PDF del Regolamento UE 2024/3012 e altre fonti CRCF gia' a portata di mano, o devo includere lo scraping nel piano?
3. **Tabella leads**: ne esiste gia' una (`conference_registrations` non sembra adatta) o ne creo una nuova `master_leads`?
4. **Studenti pilota**: c'e' un sottoinsieme di 5-10 studenti che vogliamo usare come beta tester prima del rollout completo?
5. **Personalita'**: confermi "sobrio-accademico ma accessibile" o preferisci uno stile diverso?
6. **Budget mensile cap iniziale**: parto con €100/mese (solo text) o €400/mese (text + avatar)?
7. **Avatar di Prof. Carbonio**: ne creiamo uno nuovo dedicato (consigliato — identita' distintiva, prendere ispirazione da un docente reale o avatar generico professore) o riusiamo l'AVATAR_ID di Azzurra?
8. **Chiave LiveAvatar**: riusiamo quella di `azzurra-wrapper` o ne separiamo una nuova per il master?

---

## Cosa NON faccio in questa prima release

- ❌ Multilingua (solo italiano in v1, inglese diventa user story per v2)
- ❌ Voice input/output (nice to have, FASE 3)
- ❌ Generazione automatica di quiz personalizzati dal tutor (logico estendere dopo)
- ❌ Tutor proattivo che suggerisce contenuti senza essere interrogato (Phase 3)
- ❌ Integrazione avatar AI (HeyGen) — quella e' la FASE 3 del piano LMS, separata

Tutto questo è enumerato come backlog `v2+` per dopo.
