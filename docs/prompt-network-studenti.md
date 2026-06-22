# Prompt per Claude Code — Sezione "Network" del Master Carbon Farming

> Incolla il testo sotto (dentro il blocco) in Claude Code, dalla root del repo
> `unitus-carbon-farming`. Inizia con `ultrathink` per attivare il ragionamento
> esteso e la modalità di pianificazione: **prima il piano, poi il codice.**

---

ultrathink

Sei nel repository del Master Carbon Farming (UNITUS Academy). Leggi prima
`CLAUDE.md` e rispetta tutte le convenzioni descritte (migrazioni SQL numerate in
`db/migrations/`, niente modifiche alle tabelle esistenti `faculty`, `blog_posts`,
`partners`, `modules`, `lessons`; frontend vanilla HTML+JS senza framework; DB in
snake_case, JSON in camelCase; auth JWT con middleware `requireAdmin`).

## Obiettivo

Progettare una nuova sezione **"Network"** interna alla piattaforma, accessibile
dall'area studente `/learn/`. NON è un social con feed: è una rete di connessione
ad alta fiducia tra le persone già presenti nel sistema (studenti, alumni, docenti,
partner). LinkedIn resta il layer pubblico/professionale esterno; questa sezione
copre la vita interna del master.

Scala attesa: poche decine di persone per coorte.

## Stato attuale (verifica nel codice prima di pianificare)

- `users` (student/teacher/admin): profilo scarno — email, nome, ruolo, avatar.
- `faculty`: docenti con bio, foto, `profile_link`, email — già strutturati come profili.
- `partners`: partner con tipo, descrizione, sito web.
- Esiste il mondo LMS (enrollments, edizioni, lezioni) — verificalo per legare i
  profili alla coorte/edizione corretta.

## Le tre "facce" del network (da realizzare in fasi)

1. **Studente ↔ studente/alumni (Fase 1 — MVP).** Directory ricercabile, non un feed.
   Arricchire il profilo studente con: bio, coorte/edizione, ruolo e azienda attuali,
   competenze (tag), link LinkedIn, "cosa cerco / su cosa posso aiutare", e i flag di
   consenso (vedi sotto). Nuova pagina directory in `/learn/` con ricerca e filtri
   (coorte, competenze). Endpoint GET per elencare i profili visibili.

2. **Studente ↔ docente (Fase 2).** Riusare i profili `faculty` esistenti: renderli
   navigabili dall'area studente, mostrare "chi ha insegnato cosa" e un contatto per
   tesi/mentorship. Sforzo minimo perché i dati esistono già.

3. **Studente ↔ partner (Fase 3 — solo da pianificare, non implementare ora).**
   - 3a: bacheca opportunità (stage/tesi/lavoro) pubblicata inizialmente via admin,
     con candidatura degli studenti. Nessun accesso partner ai profili → GDPR-safe.
   - 3b: login partner + vista filtrata sui profili che hanno dato consenso esterno.
     Maggiore complessità, da rinviare finché 3a non dimostra la domanda.

## Modello di consenso / privacy (vincolante)

Due consensi distinti, registrati con timestamp e versione del testo:

- **Visibilità interna**: accettata in onboarding/completamento profilo (checkbox
  esplicito). Rende il profilo visibile agli altri studenti e alumni del master.
- **Visibilità esterna (opt-in, spento di default)**: rende il profilo visibile ai
  partner / pubblico. Scelta attiva e revocabile.

Il default-on senza consenso esplicito NON è accettabile. Prevedi la revoca e
l'aggiornamento del profilo in autonomia da parte dello studente.

## Cosa ti chiedo (in quest'ordine)

1. **NON scrivere ancora codice.** Esplora il repo e produci un **piano dettagliato**
   per le Fasi 1 e 2, con outline della Fase 3.
2. Nel piano includi: modello dati (nuovi campi su `users` o nuove tabelle di profilo
   — motiva la scelta; nuove migrazioni numerate progressive senza toccare le tabelle
   esistenti), modello di consenso e come/dove lo registri, lista degli endpoint API
   (metodo, path, auth, shape della risposta in camelCase), le pagine/file frontend da
   creare in `/learn/`, e l'integrazione con l'auth e i pattern esistenti.
3. Evidenzia rischi, decisioni aperte e impatti GDPR.
4. Proponi una sequenza di commit/PR piccoli e verificabili, con cosa testare a ogni passo.
5. Fermati e mostrami il piano per approvazione **prima** di implementare.

Quando il piano è approvato, implementa solo la Fase 1, con migrazioni e test, e
verifica che le tabelle esistenti restino intatte.
