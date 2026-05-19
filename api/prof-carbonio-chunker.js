// api/prof-carbonio-chunker.js
// Splitter di testo in chunk semantici per ingest nella KB.
//
// Strategia:
// - Target ~800 token per chunk, overlap ~100 token (regola del pollice
//   per RAG su modelli Anthropic / OpenAI).
// - Boundary preferenziali: paragrafi (\n\n), poi frasi (./?/!), poi cut hard.
// - Preserva metadati di posizione: page_number (per PDF), slide_number,
//   start_seconds/end_seconds (per transcript VTT/SRT).

const TARGET_TOKENS = 800;
const OVERLAP_TOKENS = 100;

// Approssimazione: 1 token ≈ 4 caratteri (vale per testi italiani simili a inglese).
const CHARS_PER_TOKEN = 4;
const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN;
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN;

// ----------------------------------------------------------------------------
// CLEANUP
// ----------------------------------------------------------------------------

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/ /g, ' ')          // non-breaking space
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ----------------------------------------------------------------------------
// CHUNKING TESTO SEMPLICE
// ----------------------------------------------------------------------------

/**
 * Divide un testo in chunk rispettando boundary semantici.
 * @param {string} text
 * @returns {string[]} chunks
 */
function splitTextIntoChunks(text) {
  const norm = normalizeText(text);
  if (!norm) return [];
  if (norm.length <= TARGET_CHARS) return [norm];

  // Split su paragrafi
  const paragraphs = norm.split(/\n\n+/).filter(p => p.trim());

  const chunks = [];
  let buffer = '';

  for (const para of paragraphs) {
    // Caso 1: il paragrafo da solo e' piu' grande del target → spezzalo per frasi
    if (para.length > TARGET_CHARS) {
      // flush buffer corrente
      if (buffer) {
        chunks.push(buffer.trim());
        buffer = '';
      }
      const sentences = para.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [para];
      let local = '';
      for (const s of sentences) {
        if ((local + ' ' + s).length > TARGET_CHARS && local) {
          chunks.push(local.trim());
          local = s;
        } else {
          local = local ? local + ' ' + s : s;
        }
      }
      if (local) chunks.push(local.trim());
      continue;
    }

    // Caso 2: aggiungere il paragrafo supera il target → flush e riparti
    if ((buffer + '\n\n' + para).length > TARGET_CHARS && buffer) {
      chunks.push(buffer.trim());
      buffer = para;
    } else {
      buffer = buffer ? buffer + '\n\n' + para : para;
    }
  }

  if (buffer) chunks.push(buffer.trim());

  // Aggiungi overlap: prependa al chunk N le ultime OVERLAP_CHARS del chunk N-1.
  // Migliora il retrieval nei casi "concetto si sviluppa tra due chunk".
  return chunks.map((c, i) => {
    if (i === 0) return c;
    const prev = chunks[i - 1];
    const tail = prev.slice(Math.max(0, prev.length - OVERLAP_CHARS));
    // Inizia l'overlap dall'inizio di una frase per leggibilita'
    const cut = tail.search(/[.!?]\s/);
    const overlap = cut >= 0 ? tail.slice(cut + 2) : tail;
    return (overlap.trim() + ' ' + c).trim();
  });
}

// ----------------------------------------------------------------------------
// CHUNKING CON PAGINE PDF
// ----------------------------------------------------------------------------

/**
 * Chunker per PDF dove l'extracted_text contiene marker di pagina
 * (formato comune: "\f" o "[Page N]" o "--- Page N ---").
 * Mantiene il numero di pagina per ogni chunk.
 *
 * @param {string} text - testo con marker di pagina
 * @returns {Array<{content, page_number}>}
 */
function chunkWithPages(text) {
  const norm = normalizeText(text);
  if (!norm) return [];

  // Prova diversi formati di marker di pagina, in ordine di probabilita'
  const pageRegexes = [
    /\f/g,                                    // form feed (più comune da pdf-parse)
    /\n?--- Page (\d+) ---\n?/g,              // formato esplicito
    /\n?\[Page (\d+)\]\n?/g,                  // formato alternativo
    /\n?\[?Pagina (\d+)\]?\n?/gi              // italiano
  ];

  // Se nessun marker, fallback al chunking semplice senza page tracking
  const hasFormFeed = norm.includes('\f');
  const hasExplicitMarker = pageRegexes.slice(1).some(r => r.test(norm));

  if (!hasFormFeed && !hasExplicitMarker) {
    return splitTextIntoChunks(norm).map((content, i) => ({
      content,
      page_number: null,
      chunk_index: i
    }));
  }

  // Split per pagine (form feed e' il caso piu' comune)
  let pages;
  if (hasFormFeed) {
    pages = norm.split('\f').map(p => p.trim()).filter(Boolean);
  } else {
    // Re-split con marker esplicito (usa il primo regex che matcha)
    const regex = pageRegexes.slice(1).find(r => { r.lastIndex = 0; return r.test(norm); });
    regex.lastIndex = 0;
    pages = norm.split(regex).map(p => p?.trim()).filter(Boolean);
  }

  const out = [];
  pages.forEach((pageContent, pageIdx) => {
    const pageNum = pageIdx + 1;
    const subChunks = splitTextIntoChunks(pageContent);
    subChunks.forEach((sub) => {
      out.push({
        content: sub,
        page_number: pageNum,
        chunk_index: out.length
      });
    });
  });

  return out;
}

// ----------------------------------------------------------------------------
// CHUNKING TRANSCRIPT VTT/SRT
// ----------------------------------------------------------------------------

/**
 * Chunker per trascrizioni video (formato SRT o VTT).
 * Raggruppa i segmenti in chunk di ~60-90 secondi di parlato preservando
 * start_seconds e end_seconds per citazioni cliccabili al minuto.
 *
 * @param {string} vttOrSrt
 * @returns {Array<{content, start_seconds, end_seconds, chunk_index}>}
 */
function chunkTranscript(vttOrSrt) {
  if (!vttOrSrt) return [];

  // Parse molto tollerante: cerca pattern "HH:MM:SS.mmm --> HH:MM:SS.mmm"
  // (sia "," che ".") seguito dal testo.
  const cueRegex = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*([\s\S]*?)(?=\n\d{2}:|\n\d+\n\d{2}:|$)/g;
  const cues = [];
  let m;
  while ((m = cueRegex.exec(vttOrSrt)) !== null) {
    const start = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
    const end   = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]);
    const text  = m[9].replace(/\n+/g, ' ').replace(/<[^>]+>/g, '').trim();
    if (text) cues.push({ start, end, text });
  }

  if (!cues.length) {
    // Fallback: tratta come testo piatto
    return splitTextIntoChunks(vttOrSrt).map((content, i) => ({
      content,
      start_seconds: null,
      end_seconds: null,
      chunk_index: i
    }));
  }

  // Raggruppa cue contigui finche' (a) il testo accumulato non supera target,
  // oppure (b) la durata accumulata supera 90 secondi.
  const CHUNK_MAX_SECONDS = 90;
  const out = [];
  let buf = { text: '', start: null, end: null };

  for (const c of cues) {
    if (buf.start == null) buf.start = c.start;
    const candidate = (buf.text ? buf.text + ' ' : '') + c.text;
    const duration = c.end - buf.start;
    if (candidate.length > TARGET_CHARS || duration > CHUNK_MAX_SECONDS) {
      if (buf.text) {
        out.push({
          content: buf.text.trim(),
          start_seconds: buf.start,
          end_seconds: buf.end,
          chunk_index: out.length
        });
      }
      buf = { text: c.text, start: c.start, end: c.end };
    } else {
      buf.text = candidate;
      buf.end = c.end;
    }
  }
  if (buf.text) {
    out.push({
      content: buf.text.trim(),
      start_seconds: buf.start,
      end_seconds: buf.end,
      chunk_index: out.length
    });
  }
  return out;
}

// ----------------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------------

const crypto = require('crypto');

function md5(text) {
  return crypto.createHash('md5').update(String(text || '')).digest('hex');
}

function approximateTokens(text) {
  return Math.ceil((text?.length || 0) / CHARS_PER_TOKEN);
}

module.exports = {
  TARGET_TOKENS,
  OVERLAP_TOKENS,
  stripHtml,
  normalizeText,
  splitTextIntoChunks,
  chunkWithPages,
  chunkTranscript,
  md5,
  approximateTokens
};
