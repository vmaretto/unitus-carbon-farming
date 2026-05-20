# AI Study Companion — Architettura

> Feature che permette agli studenti del Master Carbon Farming di definire un
> obiettivo di studio (deadline, minuti/giorno, moduli focus, livello) e ricevere
> **materiali generati su misura** da un agente AI: riassunti, quiz, flashcard,
> micro-lezioni testuali. Il widget homepage del `/learn/` mostra ogni giorno
> "oggi devi fare X+Y+Z". Un cron notturno rigenera il futuro in base al
> consumo effettivo dello studente.
>
> Status: SPRINT 1 + SPRINT 2 deployati (maggio 2026). Agente AI vero attivo.

---

## 1. Concetto e differenze con Prof. Carbonio

Prof. Carbonio è un **tutor chat reattivo**: lo studente fa una domanda, lui
risponde citando la KB. Lo Study Companion è invece un **tutor proattivo che
genera materiali**: dato un obiettivo, decide autonomamente cosa lo studente
deve studiare oggi e produce gli artefatti.

Le due feature condividono la stessa KB (tabelle `kb_sources` / `kb_chunks` con
embeddings vector(1536) introdotti dalla migrazione 045) ma sono indipendenti.
Si integrano via bottone "Approfondisci con Prof. Carbonio" che dagli artefatti
dello Study Companion lancia il widget chat con contesto pre-impostato.

---

## 2. Schema dati (migrazione 047)

Tre tabelle nuove:

`study_plans` — l'obiettivo dello studente. Una riga per studente attiva alla
volta. Campi chiave: `user_id`, `course_edition_id`, `target_date`,
`daily_minutes`, `weekly_days[]` (1-7, ISO), `focus_module_ids[]`,
`focus_lesson_ids[]`, `level` (`beginner`|`intermediate`|`advanced`), `goal`
testo libero, `status` (`draft`|`generating`|`active`|`paused`|`completed`|`expired`).

`study_artifacts` — i materiali generati. Una riga per artefatto. Campi:
`study_plan_id` FK, `type` enum (`summary`|`quiz_personalized`|`flashcards`|`micro_lesson`|`mind_map`|`audio_overview` per fase 2), `title`, `scheduled_for`
DATE, `estimated_minutes`, `source_lesson_ids[]`, `source_module_ids[]`,
`content` JSONB (payload tipo-specifico), `asset_url` (per audio fase 2),
`status` (`queued`|`generating`|`ready`|`failed`|`stale`), `generated_at`,
`consumed_at`, `time_spent_seconds`.

`study_events` — telemetria per l'adattività. Campi: `study_plan_id`,
`artifact_id`, `event_type` (`started`|`completed`|`skipped`|`rated`),
`rating` 1-5, `comment`, `metadata` JSONB, `created_at`.

Indici: B-tree su `(study_plan_id, scheduled_for)` per query "artefatti di
oggi", B-tree su `(user_id, status)` per piano attivo dell'utente.

---

## 3. Contratti API

Tutte le route sotto `/api/companion/*`, protette da `requireStudent` +
`requireNonGuest`. Mount in `api/index.js` via
`registerStudyCompanionRoutes(app, deps)`.

| Method | Path | Scopo |
|---|---|---|
| POST | `/api/companion/study-plan` | Crea o aggiorna obiettivo dello studente. Triggera generazione iniziale. |
| GET | `/api/companion/study-plan/current` | Ritorna piano attivo dell'utente + 5 artefatti più imminenti. |
| GET | `/api/companion/study-plan/today` | Ritorna artefatti del giorno (`scheduled_for = CURRENT_DATE`). |
| GET | `/api/companion/study-plan/full` | Vista calendario completa (tutti gli artefatti del piano per data). |
| POST | `/api/companion/study-plan/regenerate` | Bottone manuale per ricalcolare lo schedule futuro. |
| DELETE | `/api/companion/study-plan` | Elimina piano attivo dello studente. |
| GET | `/api/companion/study-artifacts/:id` | Dettaglio singolo artefatto (con `content` JSONB completo). |
| POST | `/api/companion/study-artifacts/:id/start` | Marca `started`, salva timestamp. |
| POST | `/api/companion/study-artifacts/:id/complete` | Marca `consumed_at`, registra `time_spent_seconds`. |
| POST | `/api/companion/study-artifacts/:id/rate` | Valutazione 1-5 dello studente. |

---

## 4. Pipeline agente (Sprint 2, NON in Sprint 1)

L'agente è un loop Claude con tool use. System prompt riassuntivo:

> Sei un AI Study Companion del Master in Carbon Farming dell'Università della
> Tuscia. Il tuo compito è generare materiali di studio personalizzati per
> aiutare lo studente a raggiungere il suo obiettivo entro la deadline.
> Distribuisci gli artefatti nei giorni disponibili, bilancia teoria e
> pratica, includi quiz periodici per consolidamento. Cita SEMPRE le fonti
> (lezioni del Master) in ogni artefatto generato.

Tool a disposizione:

- `get_course_outline(edition_id)` → moduli + lezioni del Master con durate
- `get_student_progress(user_id)` → lesson_progress + quiz_attempts
- `search_kb(query, module_id?, top_k)` → RAG via `search_kb_chunks()`
- `summarize_lessons(lesson_ids[], target_minutes)` → riassunto markdown
- `generate_quiz(lesson_ids[], n_questions, difficulty)` → quiz JSON
- `generate_flashcards(lesson_ids[], n_cards)` → flashcard JSON
- `generate_micro_lesson(topic, lesson_ids[])` → mini-articolo testuale
- `save_artifact(...)` → persiste in `study_artifacts`

Modello: `claude-opus-4-6` per la generazione iniziale (qualità), `claude-haiku-4-5` per il loop adattivo notturno (costo).

---

## 5. Costi stimati per studente (60 giorni)

- Generazione iniziale piano: ~80K token Claude → **~$0.80** una tantum
- Adattamento notturno: ~15K token/giorno × 60 = 900K token → **~$3** complessivi (Haiku)
- Embeddings RAG: già coperti da Prof. Carbonio, costo zero aggiuntivo
- **Totale stimato per studente**: **~$4** sul ciclo del Master (solo testo, MVP Sprint 1+2)

Aggiunte fase 2:
- Audio TTS ElevenLabs (~$0.20/min): se 1-2 audio overview per modulo × 4 moduli = 8 audio × 10 min × $0.20 = $16 per studente. **Decidere in fase 2 se attivarlo.**

---

## 6. Sprint plan

**Sprint 1 (DONE)** — Fondamenta
- [x] Migrazione 047_study_companion.sql
- [x] Modulo `api/study-companion-routes.js` con tutti gli endpoint
- [x] Aggancio in `api/index.js` con `registerStudyCompanionRoutes(...)`
- [x] Widget homepage Custom Element `<study-companion-widget>` in `learn/js/study-companion.js`
- [x] Aggancio in `learn/index.html`
- [x] Form modal di setup piano (deadline, ore/giorno, moduli, livello)
- [x] Generatore artefatti placeholder per validare il flow E2E
- [x] Viewer artefatti in-place nel widget (markdown, quiz, flashcards)
- [x] Check euristico coerenza obiettivo con banner warning

**Sprint 2 (DONE)** — Agente AI reale
- [x] Tool definitions in `api/study-companion-agent.js`
- [x] Loop agentic con Claude tool use (4 tool: search_kb, get_course_outline, get_student_progress, save_artifact)
- [x] Modello configurabile via env STUDY_COMPANION_MODEL (default sonnet-4-6)
- [x] Persistenza artefatti via save_artifact tool durante il loop
- [x] Fallback ai placeholder se Anthropic/OpenAI non configurati o errore agente
- [x] Override forzato via env STUDY_COMPANION_USE_PLACEHOLDERS=true per testing
- [x] Telemetria persistita in study_plans.metadata.agent (model, turns, final_text)

**Sprint 3** — Adattività + UX finale
- [ ] Cron notturno `scripts/study-companion-adapt.js` (Vercel Cron)
- [ ] Logica catch-up / boost / ripasso
- [ ] Telemetria + bottone "rigenera manualmente"
- [ ] Vista calendario completa `learn/study-plan.html`

**Sprint 4 (opzionale)** — Audio
- [ ] Integrazione ElevenLabs TTS
- [ ] Tool `synthesize_audio` per l'agente
- [ ] Player audio in artifact viewer
- [ ] Gating: max 2 audio per modulo per studente

---

## 7. Decisioni di design già prese

- **Solo testo** nell'MVP (no audio fino a Sprint 4).
- **Generazione asincrona** con polling lato client (no BullMQ/Redis per ora).
- **Adattività ON** ma posticipata a Sprint 3.
- **Citazioni obbligatorie** in tutti gli artefatti: ogni summary/quiz/flashcard
  porta in coda i riferimenti alle lezioni/dispense da cui è stato derivato.
- **Aggancio nativo a Prof. Carbonio**: ogni artefatto include bottone
  "Approfondisci con Prof. Carbonio" che lancia il widget chat con prompt
  pre-impostato sul tema dell'artefatto.
- **Solo un piano attivo per studente** (vincolo applicato in DB).
