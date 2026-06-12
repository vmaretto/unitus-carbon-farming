# Handoff Network

Data: 2026-06-12

## Aggiornamento 2026-06-12 — Modello di consenso GDPR completato

Il pezzo lasciato a metà (consensi privacy) è stato implementato in Fase 1:

- **Migrazione** `db/migrations/064_network_consent.sql`: aggiunge a `network_profiles`
  `external_visible` (opt-in, default FALSE) e le colonne di audit
  `internal_consent_at/version` e `external_consent_at/version`; backfill del consenso
  interno per i profili già visibili sotto la v1.0.
- **API** (`api/index.js`): costante `NETWORK_CONSENT_VERSION`, esposta in
  `GET /api/lms/network/config`; `GET/PUT /api/lms/network/profile` leggono/scrivono i
  due consensi. Il timestamp/versione si registra solo alla concessione (o a nuova
  versione del testo) e lo storico è preservato in caso di revoca. La directory continua
  a filtrare su `is_visible`; la visibilità esterna è solo memorizzata (consumo = Fase 3).
- **Frontend** (`learn/network.html`): due checkbox di consenso esplicito (interno +
  esterno facoltativo) con informativa e riepilogo data/versione del consenso prestato.
- **Test** (`tests/network-api.test.js`): coprono cattura consenso interno e opt-in esterno.

Restano per il futuro: vista admin di accountability dei consensi (Fase 1+), profili
docente navigabili (Fase 2), bacheca opportunità partner (Fase 3).

## Aggiornamento 2026-06-12 (2) — Admin consensi + Fase 2 + Fase 3a

- **Vista admin consensi**: `GET /api/admin/network/profiles` espone i campi consenso e
  la tabella admin mostra la colonna "Consenso (interno / esterno)" con data e versione.
- **Fase 2 — docenti nell'area studente**: `GET /api/lms/network/faculty` (riusa la
  tabella `faculty`, aggrega i moduli/lezioni insegnati); sezione "Docenti del Master"
  in `learn/network.html` con contatto tesi/mentorship via mailto e link profilo.
- **Fase 3a — bacheca opportunità**: migrazione `065_network_opportunities.sql`
  (`network_opportunities` + `network_opportunity_applications`). API studente
  (lista pubblicate + `POST .../:id/apply`) e API admin (CRUD + lista candidature).
  Sezione "Opportunità" studente in `learn/network.html`; pannello di gestione nella
  sezione Network di `admin/index.html` (form, pubblica/ritira, elimina, candidature).
- Test in `tests/network-api.test.js` per faculty e candidatura opportunità (8 test
  network, 68 totali, tutti verdi).

Non implementata (rinviata, da confermare): **Fase 3b** — login partner + vista filtrata
sui profili con consenso esterno. L'infrastruttura dati (`external_visible` + consenso)
è già pronta.

## Stato generale

Il network non è solo un'idea o un prompt: nel repo esiste già una prima implementazione funzionale.

Componenti già presenti:

- frontend dedicato in [`learn/network.html`](/Users/vmaretto/Projects/unitus-carbon-farming/learn/network.html)
- API LMS network in [`api/index.js`](/Users/vmaretto/Projects/unitus-carbon-farming/api/index.js)
- migrazione DB per le richieste di contatto in [`db/migrations/058_network_intro_requests.sql`](/Users/vmaretto/Projects/unitus-carbon-farming/db/migrations/058_network_intro_requests.sql)
- test di copertura in [`tests/network-api.test.js`](/Users/vmaretto/Projects/unitus-carbon-farming/tests/network-api.test.js)
- sezione admin network già presente in [`admin/index.html`](/Users/vmaretto/Projects/unitus-carbon-farming/admin/index.html)

## Cosa c'è già

### 1) Profilo studente / partecipante

In [`learn/network.html`](/Users/vmaretto/Projects/unitus-carbon-farming/learn/network.html) esiste già una pagina completa con:

- form profilo personale
- campi tipo headline, organizzazione, ruolo, città, bio, competenze, interessi
- foto profilo e immagine copertina
- import da LinkedIn
- preview del profilo
- salvataggio profilo via API

L'UI mostra anche:

- directory dei profili
- filtri di ricerca
- azioni di contatto e follow
- feed post
- richieste di contatto
- notifiche

### 2) API network già implementate

In [`api/index.js`](/Users/vmaretto/Projects/unitus-carbon-farming/api/index.js) ho trovato route già operative per:

- `GET /api/lms/network/config`
- `POST /api/lms/network/blob-token`
- `GET /api/lms/network/profile`
- `PUT /api/lms/network/profile`
- `GET /api/lms/network/profiles`
- `GET /api/lms/network/intro-requests`
- `POST /api/lms/network/intro-requests`
- `PATCH /api/lms/network/intro-requests/:id`
- `GET /api/lms/network/posts`
- `POST /api/lms/network/posts`
- e altre route correlate visibili nel file

Le route sono protette con `requireStudent` e, dove serve, `requireNonGuest`.

### 3) Database

La migrazione [`058_network_intro_requests.sql`](/Users/vmaretto/Projects/unitus-carbon-farming/db/migrations/058_network_intro_requests.sql) crea:

- `network_intro_requests`
- indici per sender/recipient
- vincolo anti-self-request
- vincolo unicità per richieste pending

Questa parte conferma che il network è già entrato nella fase di implementazione concreta, non solo di progettazione.

### 4) Admin

In [`admin/index.html`](/Users/vmaretto/Projects/unitus-carbon-farming/admin/index.html) esiste già:

- sezione `Network`
- toggle configurazione
- statistiche
- elenco profili
- elenco post
- elenco richieste

## Quello che probabilmente manca o va verificato

### 1) Coerenza GDPR / consensi

Il prompt di riferimento in [`docs/prompt-network-studenti.md`](/Users/vmaretto/Projects/unitus-carbon-farming/docs/prompt-network-studenti.md) richiede:

- consenso visibilità interna
- consenso visibilità esterna
- revoca autonoma
- timestamp e versione del testo di consenso

Nel codice attuale va verificato se questi requisiti sono già coperti in modo completo o solo in parte.

### 2) Separazione tra MVP e future estensioni

Il network attuale sembra già andare oltre un MVP minimale:

- directory
- post
- follow
- richieste di contatto
- notifiche

Va chiarito se questa è la versione voluta oppure se bisogna rifattorizzare per allinearsi al piano in fasi.

### 3) Modello dati

Da verificare con precisione:

- quali tabelle network esistono oltre a `network_intro_requests`
- se i profili sono in `network_profiles`
- se ci sono tabelle per `network_posts`, `network_comments`, `network_likes`, `network_notifications`, `network_settings`
- come viene collegato il profilo al `users.id`

## Rischi

1. Il network è già abbastanza esteso: toccarlo senza una mappa precisa rischia regressioni su UI e API.
2. I requisiti privacy del prompt potrebbero non coincidere con lo stato attuale.
3. La pagina `learn/network.html` è densa e contiene molta logica client-side, quindi ogni refactor va fatto con test mirati.

## Cosa passare a Claude

Se vuoi continuare con Claude, il messaggio corretto è:

- non ripartire dal calendario
- il network esiste già nel repo
- chiedi una verifica mirata di:
  - schema DB completo
  - consensi e GDPR
  - gap rispetto al prompt in [`docs/prompt-network-studenti.md`](/Users/vmaretto/Projects/unitus-carbon-farming/docs/prompt-network-studenti.md)
  - eventuale rifinitura o riduzione a MVP

## Conclusione pratica

Per il network non sei allo stadio "da zero": sei già in uno stadio avanzato.

Il lavoro utile adesso è:

1. inventariare le tabelle e le route effettive
2. verificare i consensi
3. capire se il codice corrente è già sufficiente o va riallineato al piano
