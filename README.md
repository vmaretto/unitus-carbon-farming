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

#### Variabili d'ambiente richieste

Crea un file `.env` alla radice del progetto (non tracciato da Git) con le seguenti variabili. I valori reali sono disponibili sulla console Neon del progetto e nelle Environment Variables di Vercel.

```env
DATABASE_URL=postgresql://<user>:<password>@<host>/<database>?sslmode=require
ADMIN_PASSWORD=<scegli-una-password-sicura>

# Opzionali
JWT_SECRET=<stringa-casuale-lunga>
DATABASE_SSL=true
```

> **Importante**: non pubblicare mai credenziali reali nel repository. Usa sempre variabili d'ambiente (Vercel Settings o `.env` locale).

### API disponibili

- `GET /api/faculty?published=true` → docenti visibili nella sezione faculty del sito pubblico
- `POST /api/faculty` → crea un docente (richiede `name`)
- `PUT /api/faculty/:id` · `DELETE /api/faculty/:id`
- `GET /api/blog-posts?published=true&limit=3` → feed per homepage e pagina blog
- `POST /api/blog-posts` → crea un articolo (richiede `title`)
- `PUT /api/blog-posts/:id` · `DELETE /api/blog-posts/:id`

La dashboard amministrativa disponibile su `/admin/` usa queste API per gestire contenuti e pubblicazione.

### Autenticazione Admin

L'area `/admin/` e tutte le API di scrittura (POST, PUT, DELETE) sono protette da autenticazione. Per attivarla:

1. Imposta la variabile d'ambiente `ADMIN_PASSWORD` con una password sicura (su Vercel e/o nel file `.env` locale).
2. Opzionalmente imposta `JWT_SECRET` con una stringa casuale lunga. Se non fornita, viene generata automaticamente ad ogni avvio del server.
3. All'accesso a `/admin/`, inserisci la password per ottenere l'accesso.
4. La sessione dura 24 ore, dopo le quali dovrai effettuare nuovamente il login.

Per ripristinare manualmente i docenti di default (ad esempio dopo un reset dell'istanza Neon) puoi eseguire lo script SQL `db/faculty_seed.sql` presente nel repository oppure copiare gli inserimenti da questo file direttamente nella tua console SQL.

🌐 Deploy online (GitHub Pages)

La repo include un workflow (.github/workflows/pages.yml).
Ogni volta che fai push su main, GitHub pubblica automaticamente il sito.

Trovi l’URL sotto Settings → Pages → Environments → github-pages.

📧 Contatti

Coordinamento Master
Virgilio Maretto – maretto@carbonfarmingmaster.it

Università degli Studi della Tuscia – www.unitus.it

✅ TODO

- Aggiungere immagini ufficiali (logo, foto faculty, ecc.)
- Collegare i form a un backend (es. Netlify Forms / Google Apps Script)
- Ottimizzare performance (CSS critico, lazy-loading immagini)
- Integrare autenticazione per l’area docenti e ruolo editoriale
