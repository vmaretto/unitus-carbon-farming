# Carbon Farming Master - LMS Platform

## Progetto
Piattaforma web per il Master Universitario di II livello in Carbon Farming (Università della Tuscia - UNITUS Academy).
- **Sito pubblico**: https://unitus.carbonfarmingmaster.it
- **GitHub**: https://github.com/vmaretto/unitus-carbon-farming
- **Deploy**: Vercel (serverless)

## Stack Tecnologico
- **Backend**: Express.js (Node.js) — tutto in `server.js`
- **Database**: PostgreSQL su Neon (connessione via `DATABASE_URL` env var)
- **Frontend**: HTML statico + vanilla JavaScript + fetch API (nessun framework)
- **Admin**: Dashboard single-page a `/admin/index.html` protetta da JWT
- **Serverless**: `api/index.js` è il wrapper Vercel che chiama `server.js`
- **Dipendenze**: express, pg, uuid, dotenv (vedi package.json)

## Architettura Database
Tabelle esistenti (create automaticamente in `initDatabase()` dentro server.js):
- `faculty` — docenti del master
- `blog_posts` — articoli del blog
- `partners` — partner e patrocini
- `modules` — moduli del curriculum (CFU, SSD, ore)
- `lessons` — lezioni con calendario, docente, location fisica/remota

## Autenticazione
- Le API di scrittura (POST/PUT/DELETE) richiedono header `Authorization: Bearer <token>`
- Token JWT generato tramite `POST /api/auth/login` con password da env var `ADMIN_PASSWORD`
- Le API di lettura (GET) sono pubbliche (servono al sito)
- Il middleware `requireAdmin` protegge le route di scrittura
- In alternativa al JWT, le route protette da `requireAdmin` accettano anche un API key statico via env var `PIPELINE_API_KEY` — usato dalla pipeline post-produzione `cf-lesson-pipeline` per non dover rinnovare il JWT ogni 7 giorni. Il key passa nell'header `Authorization: Bearer <PIPELINE_API_KEY>`.

## Convenzioni
- Database: snake_case per colonne, UUID come primary key
- API: camelCase nelle risposte JSON, snake_case nel DB
- Nuove tabelle vanno in `db/migrations/` come file SQL numerati
- La funzione `initDatabase()` in server.js esegue le migrazioni all'avvio
- Helper `buildUpdateQuery()` per costruire query UPDATE dinamiche
- Helper `ensurePool()` per verificare che il DB sia connesso

## Piano di Evoluzione LMS
Il progetto sta evolvendo verso un LMS completo. Le fasi di sviluppo sono:

### FASE 1 — Fondamenta (in corso)
1. ✅ Autenticazione admin (JWT + middleware)
2. Migrazioni SQL per nuove tabelle LMS (users, courses, course_editions, lms_modules, lms_lessons, lesson_assets, enrollments, lesson_progress, quizzes, quiz_questions, quiz_attempts, attendance, attendance_codes, teacher_consents, content_workflow)
3. API LMS core: CRUD corsi, moduli, lezioni, enrollments
4. Area studente `/learn/` (dashboard, navigazione corso, player video)
5. Player video (Plyr) con resume e tracking progresso
6. Quiz con calcolo score e regole completamento

### FASE 2 — Presenze e Produzione Contenuti
7. Sistema presenze (check-in QR/PIN, import CSV Teams, auto-tracking)
8. Workflow produzione contenuti (upload → Whisper transcript → revisione → avatar → pubblicazione)

### FASE 3 — Avatar AI e Layer Commerciale
9. Integrazione HeyGen/Synthesia per avatar
10. Layer commerciale (landing, Stripe, coupon)
11. Attestati PDF

## Note Importanti
- NON modificare le tabelle esistenti (faculty, blog_posts, partners, modules, lessons)
- Le nuove tabelle LMS usano nomi diversi (lms_modules, lms_lessons) per non confondersi con modules/lessons esistenti
- Il frontend è vanilla HTML+JS, non introdurre React/Vue/framework
- I video vanno hostati esternamente (Vimeo, Mux, S3 con signed URL), non su Vercel
- Il servizio di videoconferenza è Microsoft Teams fornito da INAIL
- Il file `.env` contiene DATABASE_URL, ADMIN_PASSWORD, JWT_SECRET
