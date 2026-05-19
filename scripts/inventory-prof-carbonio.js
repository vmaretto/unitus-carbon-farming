#!/usr/bin/env node
// scripts/inventory-prof-carbonio.js
//
// SOLO LETTURA: mostra cosa abbiamo gia' nel DB pronto per essere ingerito
// nella knowledge base di Prof. Carbonio. Non scrive nulla.
//
// Uso:
//   node scripts/inventory-prof-carbonio.js

require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL non configurata');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 2
});

function fmt(n) { return Number(n || 0).toLocaleString('it-IT'); }
function fmtBytes(b) {
  const k = b / 1024;
  if (k < 1024) return `${k.toFixed(1)} KB`;
  return `${(k / 1024).toFixed(2)} MB`;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('📊 Inventario knowledge base — Prof. Carbonio');
  console.log('═══════════════════════════════════════════════════════════\n');

  // -------------------------------------------------------------------------
  // BLOG POSTS
  // -------------------------------------------------------------------------
  const blog = await pool.query(`
    SELECT COUNT(*) FILTER (WHERE is_published = true) AS pubblicati,
           COUNT(*) FILTER (WHERE is_published = true AND length(coalesce(content, '')) > 200) AS indicizzabili,
           COALESCE(SUM(length(content)) FILTER (WHERE is_published = true), 0) AS char_totali,
           MAX(published_at) AS ultimo_published
      FROM blog_posts
  `);
  const b = blog.rows[0];
  console.log('📰 Blog posts');
  console.log(`   Pubblicati:        ${fmt(b.pubblicati)}`);
  console.log(`   Indicizzabili (>200 char): ${fmt(b.indicizzabili)}`);
  console.log(`   Caratteri totali:  ${fmt(b.char_totali)}  (~${fmt(Math.round(b.char_totali / 4))} token)`);
  if (b.ultimo_published) {
    console.log(`   Ultimo pubblicato: ${new Date(b.ultimo_published).toLocaleDateString('it-IT')}`);
  }
  console.log('');

  // Sample 5 titoli
  const blogSample = await pool.query(`
    SELECT title, length(content) AS len
      FROM blog_posts
     WHERE is_published = true
       AND length(coalesce(content, '')) > 200
     ORDER BY published_at DESC NULLS LAST
     LIMIT 5
  `);
  if (blogSample.rows.length) {
    console.log('   Esempi (top 5 recenti):');
    blogSample.rows.forEach(r => console.log(`     • ${r.title}  (${fmtBytes(r.len)})`));
    console.log('');
  }

  // -------------------------------------------------------------------------
  // RESOURCES (materiali docenti gia' estratti)
  // -------------------------------------------------------------------------
  const res = await pool.query(`
    SELECT extraction_status, resource_type,
           COUNT(*) AS n,
           COALESCE(SUM(length(coalesce(extracted_text, ''))), 0) AS char_totali
      FROM resources
     WHERE is_published = true
     GROUP BY extraction_status, resource_type
     ORDER BY extraction_status, resource_type
  `);
  console.log('📚 Resources (materiali caricati dai docenti)');
  if (!res.rows.length) {
    console.log('   (nessuna resource pubblicata)\n');
  } else {
    let readyTotal = 0;
    let readyChars = 0;
    res.rows.forEach(r => {
      const flag = r.extraction_status === 'ready' ? '✅' :
                   r.extraction_status === 'pending' ? '⏳' :
                   r.extraction_status === 'failed'  ? '❌' : '⚠️ ';
      console.log(`   ${flag} ${r.extraction_status.padEnd(11)} ${r.resource_type.padEnd(10)} → ${fmt(r.n)} risorse  (${fmt(r.char_totali)} char)`);
      if (r.extraction_status === 'ready') {
        readyTotal += parseInt(r.n, 10);
        readyChars += parseInt(r.char_totali, 10);
      }
    });
    console.log('');
    console.log(`   Totale INDICIZZABILE (ready, >200 char): ${fmt(readyTotal)} risorse, ${fmt(readyChars)} char (~${fmt(Math.round(readyChars / 4))} token)`);
    console.log('');
  }

  // Sample 5 titoli ready
  const resSample = await pool.query(`
    SELECT title, resource_type, length(extracted_text) AS len
      FROM resources
     WHERE is_published = true
       AND extraction_status = 'ready'
       AND length(coalesce(extracted_text, '')) > 200
     ORDER BY length(extracted_text) DESC
     LIMIT 5
  `);
  if (resSample.rows.length) {
    console.log('   Esempi (top 5 piu grandi):');
    resSample.rows.forEach(r => console.log(`     • [${r.resource_type}] ${r.title}  (${fmtBytes(r.len)})`));
    console.log('');
  }

  // -------------------------------------------------------------------------
  // KB GIA' POPOLATA (se la migrazione 045 e' stata eseguita)
  // -------------------------------------------------------------------------
  const kbExists = await pool.query(`
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'kb_sources'
  `);

  if (!kbExists.rows.length) {
    console.log('🟡 Tabelle kb_sources / kb_chunks non ancora create.');
    console.log('   La migrazione 045_prof_carbonio.sql non e ancora stata eseguita.');
    console.log('   Riavvia il server (deploy o npm run dev) per applicarla.\n');
  } else {
    const kb = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM kb_sources WHERE status = 'active') AS sources,
        (SELECT COUNT(*) FROM kb_chunks) AS chunks,
        (SELECT COALESCE(SUM(content_tokens), 0) FROM kb_chunks) AS tokens
    `);
    const k = kb.rows[0];
    console.log('🧠 Knowledge base attuale');
    console.log(`   Sorgenti attive:   ${fmt(k.sources)}`);
    console.log(`   Chunk indicizzati: ${fmt(k.chunks)}`);
    console.log(`   Token totali:      ${fmt(k.tokens)}`);
    console.log('');

    if (k.sources > 0) {
      const breakdown = await pool.query(`
        SELECT source_type, COUNT(*) AS n
          FROM kb_sources WHERE status = 'active'
         GROUP BY source_type ORDER BY n DESC
      `);
      console.log('   Sorgenti per tipo:');
      breakdown.rows.forEach(r => {
        console.log(`     ${r.source_type.padEnd(12)} ${fmt(r.n)}`);
      });
      console.log('');
    }
  }

  // -------------------------------------------------------------------------
  // STIMA COSTI INGEST
  // -------------------------------------------------------------------------
  const totalChars =
    parseInt(b.char_totali, 10) +
    res.rows.filter(r => r.extraction_status === 'ready')
            .reduce((sum, r) => sum + parseInt(r.char_totali, 10), 0);
  const totalTokens = Math.round(totalChars / 4);
  const embedCostUsd = (totalTokens / 1_000_000) * 0.02; // text-embedding-3-small
  const embedCostEur = embedCostUsd * 0.92;

  console.log('💰 Stima costo embedding INIZIALE');
  console.log(`   Token da embeddare: ${fmt(totalTokens)}`);
  console.log(`   Costo OpenAI:       $${embedCostUsd.toFixed(4)} (€${embedCostEur.toFixed(4)})`);
  console.log(`   Tempo stimato:      ${Math.ceil(totalTokens / 100_000)} secondi circa`);
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');

  await pool.end();
}

main().catch(err => {
  console.error('❌ Errore:', err.message);
  process.exit(1);
});
