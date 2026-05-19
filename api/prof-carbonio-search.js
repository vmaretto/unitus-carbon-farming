// api/prof-carbonio-search.js
// Ricerca semantica sulla knowledge base di Prof. Carbonio.
//
// Portato da azzurra-wrapper api/chat.js (searchRecipesSemantic + RPC search_ricette),
// adattato per Neon Postgres con pgvector e per una KB generica (non solo ricette).
//
// Dipendenze iniettate: pool (pg), openai (SDK).

const EMBEDDING_MODEL = 'text-embedding-3-small'; // 1536 dim, stesso usato in azzurra
const EMBEDDING_DIMENSIONS = 1536;

/**
 * Genera l'embedding di una stringa di testo.
 * Wrapper minimal: in v2 si potra' switchare a Voyage cambiando solo questa funzione.
 *
 * @param {OpenAI} openai - istanza OpenAI SDK
 * @param {string} text
 * @returns {Promise<number[]>} vettore di 1536 numeri
 */
async function embedText(openai, text) {
  if (!openai) {
    throw new Error('OpenAI client not configured (set OPENAI_API_KEY)');
  }
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    throw new Error('Cannot embed empty text');
  }
  const resp = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: trimmed
  });
  return resp.data[0].embedding;
}

/**
 * Genera embeddings in batch (per ingest massivo della KB).
 *
 * @param {OpenAI} openai
 * @param {string[]} texts - max 128 elementi per chiamata raccomandato
 * @returns {Promise<number[][]>}
 */
async function embedTextBatch(openai, texts) {
  if (!openai) {
    throw new Error('OpenAI client not configured');
  }
  if (!texts?.length) return [];

  const resp = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts.map(t => String(t || '').trim()).filter(Boolean)
  });
  return resp.data.map(d => d.embedding);
}

/**
 * Ricerca semantica nella KB. Wrappa la funzione SQL search_kb_chunks().
 *
 * @param {Pool} pool - pg pool
 * @param {OpenAI} openai
 * @param {string} query - testo della domanda dell'utente
 * @param {object} opts
 * @param {number} [opts.matchCount=5]
 * @param {string|null} [opts.language='it']
 * @param {string[]|null} [opts.sourceTypes=null] - filtra per source_type
 * @param {number} [opts.minSimilarity=0.2]
 * @returns {Promise<Array>} chunks ordinati per rilevanza
 */
async function searchKBChunks(pool, openai, query, opts = {}) {
  const {
    matchCount = 5,
    language = 'it',
    sourceTypes = null,
    minSimilarity = 0.2
  } = opts;

  if (!pool) throw new Error('pool required');
  if (!query?.trim()) return [];

  // 1) Embed della query utente
  const queryEmbedding = await embedText(openai, query);

  // pgvector accetta il vettore come stringa formato "[0.1,0.2,...]"
  const embeddingLiteral = `[${queryEmbedding.join(',')}]`;

  // 2) Chiama la funzione RPC. Cast esplicito a vector per essere sicuri.
  const { rows } = await pool.query(
    `SELECT *
       FROM search_kb_chunks(
         $1::vector,
         $2::int,
         $3::text,
         $4::text[],
         $5::float
       )`,
    [embeddingLiteral, matchCount, language, sourceTypes, minSimilarity]
  );

  return rows; // chunk_id, source_id, source_type, source_title, source_url,
              // page_number, slide_number, start_seconds, heading, content, similarity
}

/**
 * Ricerca solo full-text (BM25-like via tsvector italiano).
 * Utile per query molto specifiche dove la ricerca semantica perde su nomi propri.
 *
 * @param {Pool} pool
 * @param {string} query
 * @param {object} opts
 * @returns {Promise<Array>}
 */
async function searchKBChunksFTS(pool, query, opts = {}) {
  const { matchCount = 5, language = 'it' } = opts;
  if (!query?.trim()) return [];

  const { rows } = await pool.query(
    `SELECT c.id AS chunk_id, s.id AS source_id, s.source_type, s.title AS source_title,
            s.url AS source_url, c.page_number, c.slide_number, c.start_seconds,
            c.heading, c.content,
            ts_rank(c.content_tsv, plainto_tsquery('italian', $1)) AS rank
       FROM kb_chunks c
       JOIN kb_sources s ON s.id = c.source_id
      WHERE s.status = 'active'
        AND s.language = $3
        AND c.content_tsv @@ plainto_tsquery('italian', $1)
      ORDER BY rank DESC
      LIMIT $2`,
    [query, matchCount, language]
  );

  return rows;
}

/**
 * Ricerca ibrida: combina semantica + FTS con Reciprocal Rank Fusion.
 * Spesso recupera meglio della sola semantica, soprattutto su query miste
 * (concetti + nomi propri di docenti, normative, ecc.).
 *
 * @returns {Promise<Array>}
 */
async function searchKBHybrid(pool, openai, query, opts = {}) {
  const { matchCount = 5, language = 'it' } = opts;
  const expandFactor = 4; // recupera 4x dai due lati, poi fonde

  const [semantic, lexical] = await Promise.all([
    searchKBChunks(pool, openai, query, {
      ...opts,
      matchCount: matchCount * expandFactor,
      language
    }),
    searchKBChunksFTS(pool, query, {
      matchCount: matchCount * expandFactor,
      language
    })
  ]);

  // Reciprocal Rank Fusion
  const k = 60; // costante RRF standard
  const scores = new Map();
  const seen = new Map();

  semantic.forEach((row, idx) => {
    const id = row.chunk_id;
    scores.set(id, (scores.get(id) || 0) + 1 / (k + idx + 1));
    seen.set(id, row);
  });
  lexical.forEach((row, idx) => {
    const id = row.chunk_id;
    scores.set(id, (scores.get(id) || 0) + 1 / (k + idx + 1));
    if (!seen.has(id)) seen.set(id, row);
  });

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, matchCount)
    .map(([id]) => seen.get(id));
}

module.exports = {
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  embedText,
  embedTextBatch,
  searchKBChunks,
  searchKBChunksFTS,
  searchKBHybrid
};
