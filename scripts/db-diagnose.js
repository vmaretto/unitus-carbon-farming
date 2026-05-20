#!/usr/bin/env node
// scripts/db-diagnose.js
//
// Diagnostica veloce dello schema del DB. Lista le tabelle rilevanti per
// l'LMS e Study Companion, mostra il conteggio di righe e l'eventuale
// search_path attivo. Usare quando una query si lamenta che una tabella
// "non esiste" pur essendo presente.
//
// Uso:
//   node scripts/db-diagnose.js

require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL non configurata.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 2
});

const TABLES = [
  'users',
  'courses', 'course_editions',
  'lms_modules', 'lms_lessons', 'lesson_assets',
  'modules', 'lessons',          // calendario (vecchio LMS)
  'enrollments', 'lesson_progress', 'quizzes', 'quiz_attempts',
  'kb_sources', 'kb_chunks',     // Prof. Carbonio
  'study_plans', 'study_artifacts', 'study_events'  // Study Companion
];

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🔎 DB Diagnose');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Connessione info
  const meta = await pool.query(`
    SELECT current_database() AS db,
           current_user AS usr,
           current_schema() AS schema,
           current_setting('search_path') AS search_path,
           version() AS pg_version
  `);
  const m = meta.rows[0];
  console.log(`📍 Database:    ${m.db}`);
  console.log(`👤 User:        ${m.usr}`);
  console.log(`📁 Schema:      ${m.schema}`);
  console.log(`🔍 search_path: ${m.search_path}`);
  console.log(`🐘 ${m.pg_version.split(',')[0]}\n`);

  // Lista TUTTE le tabelle nello schema corrente
  const allTables = await pool.query(`
    SELECT table_schema, table_name
      FROM information_schema.tables
     WHERE table_type = 'BASE TABLE'
       AND table_schema NOT IN ('pg_catalog', 'information_schema')
     ORDER BY table_schema, table_name
  `);
  console.log(`📋 Totale tabelle nel DB: ${allTables.rows.length}\n`);
  const bySchema = {};
  for (const r of allTables.rows) {
    (bySchema[r.table_schema] ||= []).push(r.table_name);
  }
  for (const [schema, tabs] of Object.entries(bySchema)) {
    console.log(`   [${schema}] ${tabs.length} tabelle: ${tabs.join(', ')}`);
  }
  console.log();

  // Per ogni tabella rilevante, conta righe
  console.log('📊 Conteggio righe nelle tabelle chiave:');
  console.log('   (─── = tabella non trovata)\n');
  for (const t of TABLES) {
    try {
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM "${t}"`);
      const n = rows[0].n;
      const pad = t.padEnd(22);
      console.log(`   ${pad} ${String(n).padStart(8)} righe`);
    } catch (err) {
      const pad = t.padEnd(22);
      if (err.code === '42P01') {
        console.log(`   ${pad} ──── (tabella non esiste)`);
      } else {
        console.log(`   ${pad} ❌ ${err.message}`);
      }
    }
  }

  // Se lms_modules esiste, mostra qualche riga
  try {
    const { rows: sample } = await pool.query(
      `SELECT id, title, course_id, is_published, sort_order
         FROM lms_modules ORDER BY sort_order LIMIT 6`
    );
    if (sample.length > 0) {
      console.log('\n🎓 Prime righe di lms_modules:');
      for (const r of sample) {
        console.log(`   - ${r.title} (published=${r.is_published}, course=${r.course_id?.slice(0,8)})`);
      }
    }
  } catch (e) { /* skip */ }

  // Se enrollments esiste, mostra quanti utenti hanno enrollment attivo
  try {
    const { rows } = await pool.query(
      `SELECT user_id, status, COUNT(*) AS n
         FROM enrollments
        GROUP BY user_id, status
        ORDER BY n DESC LIMIT 5`
    );
    if (rows.length > 0) {
      console.log('\n📚 Top enrollments per utente:');
      for (const r of rows) {
        console.log(`   - user ${r.user_id?.slice(0,8)}... status=${r.status} count=${r.n}`);
      }
    }
  } catch (e) { /* skip */ }

  console.log('\n✅ Diagnostica completata.');
  await pool.end();
}

main().catch(err => {
  console.error('❌ Errore:', err);
  pool.end();
  process.exit(1);
});
