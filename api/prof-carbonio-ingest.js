// api/prof-carbonio-ingest.js
// Worker di ingest: prende una sorgente (PDF, blog post, transcript, testo manuale),
// la chunka, genera embeddings via OpenAI, popola kb_sources + kb_chunks.
//
// Idempotente: se la stessa sorgente (con stesso content_hash) e' gia' indicizzata,
// non fa niente. Se il content e' cambiato (hash diverso), svuota i chunk e re-indicizza.

const {
  stripHtml,
  normalizeText,
  splitTextIntoChunks,
  chunkWithPages,
  chunkTranscript,
  md5,
  approximateTokens
} = require('./prof-carbonio-chunker');

const { embedTextBatch } = require('./prof-carbonio-search');

const EMBED_BATCH_SIZE = 64; // OpenAI accetta fino a 2048, 64 e' un buon compromesso

// ----------------------------------------------------------------------------
// API PRINCIPALE
// ----------------------------------------------------------------------------

/**
 * Ingerisce una singola sorgente nella KB.
 *
 * @param {object} deps - { pool, openai }
 * @param {object} input
 * @param {string} input.sourceType - 'resource' | 'lms_lesson' | 'blog_post' | 'normative' | 'faq' | 'manual'
 * @param {string} input.title
 * @param {string} input.content - testo grezzo o HTML
 * @param {string} [input.sourceRef] - UUID della riga origine (resources.id, blog_posts.id, ecc.)
 * @param {string} [input.author]
 * @param {string} [input.url]
 * @param {string} [input.language='it']
 * @param {object} [input.metadata={}]
 * @param {string} [input.contentFormat='text'] - 'text' | 'html' | 'pdf' | 'transcript'
 * @returns {object} { sourceId, chunksCreated, skipped, reason }
 */
async function ingestSource(deps, input) {
  const { pool, openai } = deps;
  const {
    sourceType,
    title,
    content,
    sourceRef = null,
    author = null,
    url = null,
    language = 'it',
    metadata = {},
    contentFormat = 'text'
  } = input;

  if (!pool) throw new Error('pool required');
  if (!openai) throw new Error('openai required (OPENAI_API_KEY)');
  if (!sourceType) throw new Error('sourceType required');
  if (!title?.trim()) throw new Error('title required');
  if (!content?.trim()) throw new Error('content required');

  // 1) Normalizza il content in base al formato
  const cleanText = prepareText(content, contentFormat);
  if (!cleanText.trim()) {
    return { sourceId: null, chunksCreated: 0, skipped: true, reason: 'empty content' };
  }
  const contentHash = md5(cleanText);

  // 2) Cerca se sorgente esiste gia' (per sourceRef o per (sourceType + title))
  const existing = await findExistingSource(pool, { sourceType, sourceRef, title });

  if (existing && existing.content_hash === contentHash) {
    return {
      sourceId: existing.id,
      chunksCreated: 0,
      skipped: true,
      reason: 'content unchanged (same hash)'
    };
  }

  // 3) Upsert kb_sources
  const sourceId = existing
    ? await updateSource(pool, existing.id, { title, author, url, language, metadata, contentHash })
    : await insertSource(pool, { sourceType, sourceRef, title, author, url, language, metadata, contentHash });

  // 4) Cancella chunk esistenti (re-index pulito)
  if (existing) {
    await pool.query(`DELETE FROM kb_chunks WHERE source_id = $1`, [sourceId]);
  }

  // 5) Chunking in base al formato
  const chunks = chunkByFormat(cleanText, contentFormat);
  if (!chunks.length) {
    return { sourceId, chunksCreated: 0, skipped: true, reason: 'no chunks produced' };
  }

  // 6) Embedding in batch
  let embedded = 0;
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const texts = batch.map(c => c.content);
    const vectors = await embedTextBatch(openai, texts);

    // Insert in transazione per atomicita'
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let j = 0; j < batch.length; j++) {
        const c = batch[j];
        const v = vectors[j];
        const literal = `[${v.join(',')}]`;
        await client.query(
          `INSERT INTO kb_chunks
             (source_id, chunk_index, content, content_tokens,
              page_number, slide_number, start_seconds, end_seconds, heading,
              embedding, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector, $11::jsonb)`,
          [
            sourceId,
            c.chunk_index,
            c.content,
            approximateTokens(c.content),
            c.page_number || null,
            c.slide_number || null,
            c.start_seconds || null,
            c.end_seconds || null,
            c.heading || null,
            literal,
            JSON.stringify(c.metadata || {})
          ]
        );
      }
      await client.query('COMMIT');
      embedded += batch.length;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // 7) Marca la sorgente come indicizzata
  await pool.query(
    `UPDATE kb_sources SET indexed_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [sourceId]
  );

  return { sourceId, chunksCreated: embedded, skipped: false };
}

// ----------------------------------------------------------------------------
// PREPARAZIONE TESTO
// ----------------------------------------------------------------------------

function prepareText(content, format) {
  switch (format) {
    case 'html':
      return stripHtml(content);
    case 'pdf':
    case 'transcript':
    case 'text':
    default:
      return normalizeText(content);
  }
}

function chunkByFormat(text, format) {
  if (format === 'pdf') return chunkWithPages(text);
  if (format === 'transcript') return chunkTranscript(text);
  // text / html / manual / normative
  return splitTextIntoChunks(text).map((content, i) => ({
    content,
    chunk_index: i
  }));
}

// ----------------------------------------------------------------------------
// DB HELPERS
// ----------------------------------------------------------------------------

async function findExistingSource(pool, { sourceType, sourceRef, title }) {
  // Match per sourceRef se fornito (caso resources/blog_posts/lms_lesson)
  if (sourceRef) {
    const { rows } = await pool.query(
      `SELECT id, content_hash, status FROM kb_sources
        WHERE source_type = $1 AND source_ref = $2
        LIMIT 1`,
      [sourceType, sourceRef]
    );
    if (rows[0]) return rows[0];
  }
  // Fallback: match per (sourceType, title) per i manuali
  const { rows } = await pool.query(
    `SELECT id, content_hash, status FROM kb_sources
      WHERE source_type = $1 AND title = $2 AND source_ref IS NULL
      LIMIT 1`,
    [sourceType, title]
  );
  return rows[0] || null;
}

async function insertSource(pool, args) {
  const { sourceType, sourceRef, title, author, url, language, metadata, contentHash } = args;
  const { rows } = await pool.query(
    `INSERT INTO kb_sources
       (source_type, source_ref, title, author, url, language, metadata, content_hash, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'active')
     RETURNING id`,
    [sourceType, sourceRef, title, author, url, language, JSON.stringify(metadata), contentHash]
  );
  return rows[0].id;
}

async function updateSource(pool, id, args) {
  const { title, author, url, language, metadata, contentHash } = args;
  await pool.query(
    `UPDATE kb_sources
        SET title = $2, author = $3, url = $4, language = $5,
            metadata = $6::jsonb, content_hash = $7, updated_at = NOW()
      WHERE id = $1`,
    [id, title, author, url, language, JSON.stringify(metadata), contentHash]
  );
  return id;
}

// ----------------------------------------------------------------------------
// HELPER: ingerisci una singola riga di blog_posts
// ----------------------------------------------------------------------------

async function ingestBlogPost(deps, post) {
  return ingestSource(deps, {
    sourceType: 'blog_post',
    sourceRef: post.id,
    title: post.title,
    content: post.content || '',
    author: post.author || null,
    url: post.slug ? `https://unitus.carbonfarmingmaster.it/blog/${post.slug}` : null,
    language: 'it',
    contentFormat: 'html',
    metadata: {
      slug: post.slug,
      excerpt: post.excerpt,
      published_at: post.published_at,
      tags: post.tags || []
    }
  });
}

// ----------------------------------------------------------------------------
// HELPER: ingerisci una singola riga di resources
// ----------------------------------------------------------------------------

async function ingestResource(deps, resource) {
  // Resources ha extracted_text gia' pronto, ma puo' essere null o vuoto.
  if (!resource.extracted_text?.trim()) {
    return { sourceId: null, chunksCreated: 0, skipped: true, reason: 'no extracted_text' };
  }

  // Determina format dal resource_type
  const format = resource.resource_type === 'pdf' || resource.resource_type === 'document'
    ? 'pdf'
    : (resource.resource_type === 'video' || resource.resource_type === 'audio')
      ? 'transcript'
      : 'text';

  return ingestSource(deps, {
    sourceType: 'resource',
    sourceRef: resource.id,
    title: resource.title,
    content: resource.extracted_text,
    url: resource.url,
    language: 'it',
    contentFormat: format,
    metadata: {
      resource_type: resource.resource_type,
      file_size_bytes: resource.file_size_bytes,
      extraction_metadata: resource.extraction_metadata || {}
    }
  });
}

module.exports = {
  ingestSource,
  ingestBlogPost,
  ingestResource
};
