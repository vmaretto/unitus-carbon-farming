#!/usr/bin/env node
// scripts/apply-pending-migrations.js
//
// Applica al DB tutte le migrazioni di db/migrations/ che non risultano già
// eseguite nella tabella _migrations. Stesso identico algoritmo di
// initDatabase() in api/index.js, ma utilizzabile da locale per saltare
// eventuali problemi di build cache di Vercel.
//
// Uso:
//   node scripts/apply-pending-migrations.js
//
// Lo script carica DATABASE_URL dal .env (o dalla shell). Se non trova il DB,
// esce con errore.

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL non configurata. Aggiungi un .env o esporta la variabile.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 3
});

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'db', 'migrations');

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🗄  Apply pending migrations');
  console.log(`   Dir: ${MIGRATIONS_DIR}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // Crea _migrations se non esiste (stessa logica di initDatabase)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      executed_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.error(`❌ Directory ${MIGRATIONS_DIR} non trovata.`);
    process.exit(1);
  }

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  console.log(`📁 Trovati ${files.length} file SQL in db/migrations/\n`);

  const { rows: executed } = await pool.query('SELECT filename FROM _migrations');
  const executedSet = new Set(executed.map(r => r.filename));
  console.log(`✅ Già eseguite: ${executedSet.size}`);

  const pending = files.filter(f => !executedSet.has(f));
  console.log(`⏳ Pendenti:     ${pending.length}\n`);

  if (pending.length === 0) {
    console.log('✨ Nessuna migrazione da applicare. DB sincronizzato.');
    await pool.end();
    return;
  }

  for (const file of pending) {
    const sqlPath = path.join(MIGRATIONS_DIR, file);
    const sql = fs.readFileSync(sqlPath, 'utf8');
    process.stdout.write(`   → ${file} ... `);
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
      console.log('OK');
    } catch (err) {
      console.log('FALLITA');
      console.error(`\n❌ Errore nella migrazione ${file}:`);
      console.error(`   ${err.message}`);
      if (err.position) console.error(`   Posizione: ${err.position}`);
      if (err.detail) console.error(`   Dettaglio: ${err.detail}`);
      if (err.hint) console.error(`   Suggerimento: ${err.hint}`);
      await pool.end();
      process.exit(1);
    }
  }

  console.log('\n✅ Tutte le migrazioni applicate con successo.');
  await pool.end();
}

main().catch(err => {
  console.error('❌ Errore fatale:', err);
  pool.end();
  process.exit(1);
});
