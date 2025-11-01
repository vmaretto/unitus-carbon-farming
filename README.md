# Master in Carbon Farming – UNITUS

Landing page ufficiale del **Master Universitario di II livello in Carbon Farming**
Università degli Studi della Tuscia – Unitus Academy

Il Master si terrà in lingua italiana con traduzione simultanea in inglese.

Sede delle lezioni: Roma.

👉 **Demo online**: [https://<tuo-username>.github.io/<repo-name>/](https://<tuo-username>.github.io/<repo-name>/)  
(sostituisci `<tuo-username>` e `<repo-name>` con i valori della tua repo GitHub)

---

## 📂 Struttura del progetto
- `index.html` → pagina principale
- `assets/img/` → immagini (es. logo `logo-tuscia.png`)
- `.gitignore` → file per escludere cartelle/file inutili
- `.github/workflows/pages.yml` → workflow GitHub Pages per il deploy automatico

---

## 🚀 Visualizzare in locale

Il progetto espone ora un server Node.js con API per gestire faculty e articoli del blog. Per lavorare in locale:

```bash
git clone https://github.com/<tuo-username>/<repo-name>.git
cd <repo-name>
npm install

# imposta la variabile DATABASE_URL (vedi sezione sotto)
export DATABASE_URL="postgres://<user>:<password>@<host>/<database>?sslmode=require"

npm run dev
# oppure
npm start

# Il sito e le API saranno disponibili su http://localhost:3000
```

> **Suggerimento:** per una semplice anteprima statica puoi aprire `index.html` nel browser. Le sezioni dinamiche mostreranno un messaggio di aggiornamento finché le API non sono disponibili.

### Configurazione database (Neon + Vercel)

1. **Crea l'istanza Neon**  
   - Registrati su [Neon](https://neon.tech/) e crea un nuovo progetto.  
   - Scegli il piano gratuito, assegna un nome al progetto e attendi che il database venga predisposto.  
   - Nella sezione **Branches → `main` → Connection details** copia la stringa `postgresql://` con SSL abilitato.
2. **Prepara gli utenti e le password (opzionale ma consigliato)**  
   - Dalla tab **Roles** genera una password dedicata per l'utente `neondb_owner` oppure crea un nuovo ruolo con privilegi di lettura/scrittura.  
   - Aggiorna la stringa di connessione con utente e password desiderati.
3. **Configura Vercel**
   - Apri il progetto su Vercel → **Settings → Environment Variables**.
   - Aggiungi una variabile `DATABASE_URL` con la stringa copiata da Neon (includendo `?sslmode=require`).
   - Salva e ripeti l'operazione sia per l'ambiente `Production` sia per `Preview` se vuoi usare l'admin anche nelle preview.
   - Se utilizzi `vercel dev`, crea un file `.env` o usa `vercel env pull` per avere `DATABASE_URL` anche in locale.
   - Per l'istanza attualmente predisposta puoi incollare direttamente il valore **Recommended for most uses** riportato qui sotto.
4. **Verifica la connessione**
   - In locale esporta la variabile: `export DATABASE_URL="postgres://<user>:<password>@<host>/<database>?sslmode=require"`.
   - Avvia il progetto con `npm run dev` o `npm start` e controlla i log: al primo avvio il server crea automaticamente le tabelle `faculty` e `blog_posts`.
   - Se la tabella `faculty` è vuota, l'applicazione popola automaticamente i docenti di default utilizzati nel fallback statico del sito pubblico.
   - Se l'applicazione gira su Vercel, esegui un nuovo deploy per forzare la lettura della variabile appena impostata.
5. **Opzioni avanzate**
   - Per disabilitare l'SSL con database locali imposta `DATABASE_SSL=false`.
   - Puoi monitorare l'attività dal pannello Neon → **Monitoring** per verificare le query provenienti dal progetto Vercel.
   - Ricordati di rigenerare i token di accesso se revoci o cambi la password del ruolo.

#### Variabili d'ambiente per l'istanza Neon fornita

Usa questi valori per popolare l'ambiente Vercel (Production e Preview) e per avviare il progetto in locale creando un file `.env` alla radice con le stesse chiavi.

```env
DATABASE_URL=postgresql://neondb_owner:npg_K2Yh5HukeqQs@ep-aged-field-agruc2b4-pooler.c-2.eu-central-1.aws.neon.tech/neondb?sslmode=require
DATABASE_URL_UNPOOLED=postgresql://neondb_owner:npg_K2Yh5HukeqQs@ep-aged-field-agruc2b4.c-2.eu-central-1.aws.neon.tech/neondb?sslmode=require

# Parametri individuali (facoltativi, utili per strumenti che richiedono variabili separate)
PGHOST=ep-aged-field-agruc2b4-pooler.c-2.eu-central-1.aws.neon.tech
PGHOST_UNPOOLED=ep-aged-field-agruc2b4.c-2.eu-central-1.aws.neon.tech
PGUSER=neondb_owner
PGDATABASE=neondb
PGPASSWORD=npg_K2Yh5HukeqQs

# Template compatibili con integrazione Vercel Postgres
POSTGRES_URL=postgresql://neondb_owner:npg_K2Yh5HukeqQs@ep-aged-field-agruc2b4-pooler.c-2.eu-central-1.aws.neon.tech/neondb?sslmode=require
POSTGRES_URL_NON_POOLING=postgresql://neondb_owner:npg_K2Yh5HukeqQs@ep-aged-field-agruc2b4.c-2.eu-central-1.aws.neon.tech/neondb?sslmode=require
POSTGRES_USER=neondb_owner
POSTGRES_HOST=ep-aged-field-agruc2b4-pooler.c-2.eu-central-1.aws.neon.tech
POSTGRES_PASSWORD=npg_K2Yh5HukeqQs
POSTGRES_DATABASE=neondb
POSTGRES_URL_NO_SSL=postgresql://neondb_owner:npg_K2Yh5HukeqQs@ep-aged-field-agruc2b4-pooler.c-2.eu-central-1.aws.neon.tech/neondb
POSTGRES_PRISMA_URL=postgresql://neondb_owner:npg_K2Yh5HukeqQs@ep-aged-field-agruc2b4-pooler.c-2.eu-central-1.aws.neon.tech/neondb?connect_timeout=15&sslmode=require
```

> ⚠️ **Importante**: conserva queste credenziali in un ambiente sicuro (variabili Vercel o `.env` locale non tracciato da Git). Non condividere pubblicamente il file `.env` con i valori reali.

### API disponibili

- `GET /api/faculty?published=true` → docenti visibili nella sezione faculty del sito pubblico
- `POST /api/faculty` → crea un docente (richiede `name`)
- `PUT /api/faculty/:id` · `DELETE /api/faculty/:id`
- `GET /api/blog-posts?published=true&limit=3` → feed per homepage e pagina blog
- `POST /api/blog-posts` → crea un articolo (richiede `title`)
- `PUT /api/blog-posts/:id` · `DELETE /api/blog-posts/:id`

La dashboard amministrativa disponibile su `/admin/` usa queste API per gestire contenuti e pubblicazione.

Per ripristinare manualmente i docenti di default (ad esempio dopo un reset dell'istanza Neon) puoi eseguire lo script SQL `db/faculty_seed.sql` presente nel repository oppure copiare gli inserimenti da questo file direttamente nella tua console SQL.

🌐 Deploy online (GitHub Pages)

La repo include un workflow (.github/workflows/pages.yml).
Ogni volta che fai push su main, GitHub pubblica automaticamente il sito.

Trovi l’URL sotto Settings → Pages → Environments → github-pages.

📧 Contatti

Coordinamento Master
Virgilio Maretto – virgilio.maretto@posti.world

Università degli Studi della Tuscia – www.unitus.it

✅ TODO

- Aggiungere immagini ufficiali (logo, foto faculty, ecc.)
- Collegare i form a un backend (es. Netlify Forms / Google Apps Script)
- Ottimizzare performance (CSS critico, lazy-loading immagini)
- Integrare autenticazione per l’area docenti e ruolo editoriale
