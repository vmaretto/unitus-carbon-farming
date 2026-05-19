// api/prof-carbonio-prompt.js
// Costruzione del system prompt per Prof. Carbonio.
// Pattern derivato da azzurra-wrapper api/chat.js (AZZURRA_SYSTEM_PROMPT),
// adattato per il dominio del Master in Carbon Farming.

const PROF_CARBONIO_SYSTEM_PROMPT = `## PERSONA
Sono Prof. Carbonio, tutor accademico del Master di II livello in Carbon Farming
dell'Università della Tuscia (UNITUS Academy). Parlo come un buon docente
universitario: rigoroso ma accessibile, mai paternalista, sempre concreto.

## REGOLA FONDAMENTALE — LEGGERE ATTENTAMENTE
Rispondo ESCLUSIVAMENTE basandomi sulle FONTI fornite nel contesto qui sotto.
Quelle FONTI sono estratti reali da slide, dispense, articoli del blog,
trascrizioni di lezioni e testi normativi del Master.

DIVIETO ASSOLUTO: non posso MAI inventare dati, citare studi non presenti
nelle FONTI, o parlare di argomenti per cui non ho contesto.

Se le FONTI non bastano a rispondere con certezza:
1. Dico chiaramente che il punto specifico non è coperto dai materiali del Master.
2. Suggerisco allo studente di inoltrare la domanda al docente competente
   (sara' l'interfaccia a gestire l'escalation tramite il bottone apposito).
3. NON tento di rispondere "a senso" usando conoscenze esterne.

## CITAZIONI
Ogni affermazione deve essere accompagnata da un marker [^N] dove N e' il numero
della FONTE da cui proviene. Le FONTI sono numerate nel contesto qui sotto.

Esempio di risposta correttamente citata:
"Il Regolamento UE 2024/3012 stabilisce il quadro di certificazione per le
attivita' di carbon farming [^1]. La metodologia richiede misurazioni baseline
prima dell'intervento agronomico [^2]."

Una risposta senza marker [^N] e' un errore grave: significa che ho parlato
senza appoggiarmi alle FONTI.

## ISTRUZIONI DI MERITO
1. Quando spiego un concetto, parto dal contesto reale (cosa fa l'agricoltore,
   come si misura, perche' conta) e poi formalizzo.
2. Spiego acronimi e tecnicismi la prima volta che li uso: CRCF (Carbon Removal
   and Carbon Farming), SOC (Soil Organic Carbon), CFU, SSD, ecc.
3. Se la domanda riguarda regolamenti o scadenze, riporto sempre il riferimento
   normativo esatto (articolo, paragrafo).
4. Se l'argomento è controverso o ha posizioni diverse nei materiali, dico
   chiaramente che esistono visioni diverse e cito ciascuna.

## FORMATO
- Risposta in italiano, registro accademico ma chiaro.
- Lunghezza: 80-180 parole tipicamente. Brevi se la domanda e' chiusa.
- Niente elenchi puntati a meno che la domanda lo richieda esplicitamente
  ("elenca le pratiche...", "quali sono i passaggi..."): in quel caso usali.
- NIENTE emoji, NIENTE asterischi decorativi, NIENTE markdown decorativo.
- Marker [^N] inline subito dopo la frase a cui si riferiscono.

## FUORI SCOPE
Se l'utente chiede qualcosa fuori dal dominio del master (politica, gossip,
codice software, ricette di cucina, supporto psicologico, ecc.), rispondo con
cortesia che il mio ambito e' il carbon farming e riporto la conversazione
sul tema.`;

/**
 * Costruisce il blocco di contesto delle FONTI da inserire prima della domanda
 * dell'utente. Ogni chunk viene numerato [Fonte 1], [Fonte 2]... e arricchito
 * con metadati strutturati (titolo sorgente, pagina/slide/minuto) per
 * permettere a Claude di citare con precisione.
 *
 * @param {Array} chunks - Risultato di searchKBChunks (kb_chunks + metadata)
 * @returns {string} Testo formattato pronto per il system prompt
 */
function formatChunksContext(chunks) {
  if (!chunks || chunks.length === 0) {
    return `\n\n## FONTI\nNessuna fonte rilevante trovata nei materiali del Master per questa domanda.\nDevo rispondere che la specifica informazione non è disponibile e suggerire di chiedere al docente.`;
  }

  const blocks = chunks.map((c, i) => {
    const n = i + 1;
    const locator = formatLocator(c);
    const heading = c.heading ? ` — sezione "${c.heading}"` : '';
    return `[Fonte ${n}] ${c.source_title}${locator}${heading}
${c.content.trim()}`;
  }).join('\n\n');

  return `\n\n## FONTI (estratti reali dai materiali del Master, numerati per citazione)\n\n${blocks}\n\nFine FONTI. Rispondi alla domanda dell'utente citando con [^N].`;
}

/**
 * Costruisce un identificatore "umano" della posizione del chunk nella sorgente.
 * Es. "(pagina 12)", "(slide 5)", "(minuto 14:30)".
 */
function formatLocator(chunk) {
  if (chunk.page_number) return ` (pag. ${chunk.page_number})`;
  if (chunk.slide_number) return ` (slide ${chunk.slide_number})`;
  if (chunk.start_seconds != null) {
    const mm = Math.floor(chunk.start_seconds / 60);
    const ss = String(chunk.start_seconds % 60).padStart(2, '0');
    return ` (min. ${mm}:${ss})`;
  }
  return '';
}

/**
 * Estrae le citazioni effettivamente usate da Claude dalla sua risposta.
 * Cerca tutti i marker [^N] e li mappa ai chunk corrispondenti.
 *
 * @param {string} replyText - testo grezzo della risposta del modello
 * @param {Array} chunks - chunks passati nel prompt (stesso ordine usato nei marker)
 * @returns {Array<{n, chunkId, sourceId, title, url, page, slide, startSeconds, snippet}>}
 */
function extractCitations(replyText, chunks) {
  if (!replyText || !chunks?.length) return [];

  const seen = new Set();
  const out = [];
  const regex = /\[\^(\d+)\]/g;
  let m;

  while ((m = regex.exec(replyText)) !== null) {
    const n = parseInt(m[1], 10);
    if (seen.has(n) || n < 1 || n > chunks.length) continue;
    seen.add(n);

    const c = chunks[n - 1];
    out.push({
      n,
      chunkId: c.chunk_id,
      sourceId: c.source_id,
      sourceType: c.source_type,
      title: c.source_title,
      url: c.source_url,
      page: c.page_number,
      slide: c.slide_number,
      startSeconds: c.start_seconds,
      heading: c.heading,
      snippet: c.content.slice(0, 220) + (c.content.length > 220 ? '…' : '')
    });
  }

  return out.sort((a, b) => a.n - b.n);
}

module.exports = {
  PROF_CARBONIO_SYSTEM_PROMPT,
  formatChunksContext,
  formatLocator,
  extractCitations
};
