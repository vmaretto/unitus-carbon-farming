#!/usr/bin/env node
// scripts/reset-stuck-study-plans.js
//
// Resetta i piani di studio bloccati in status='generating' da più di N minuti.
// Capita quando una generazione è andata in timeout di Vercel e il piano è
// rimasto "appeso". Lo script li riporta a status='draft' così lo studente può
// rigenerarli dal widget.
//
// Uso:
//   node scripts/reset-stuck-study-plans.js          # reset piani >5 min
//   node scripts/reset-stuck-study-plans.js --all    # reset TUTTI i generating
//   node scripts/reset-stuck-study-plans.js --delete # cancella i piani stuck

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

const ALL = process.argv.includes('--all');
const DELETE = process.argv.includes('--delete');

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🔧 Reset stuck study_plans');
  console.log(`   Mode: ${DELETE ? 'DELETE' : 'RESET'} | Filter: ${ALL ? 'all generating' : '>5 min stuck'}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const ageFilter = ALL ? '' : `AND generation_started_at < NOW() - INTERVAL '5 minutes'`;

  const { rows: stuck } = await pool.query(
    `SELECT id, user_id, goal, target_date, status, generation_started_at,
            (SELECT COUNT(*) FROM study_artifacts WHERE study_plan_id = study_plans.id) AS artifact_count
       FROM study_plans
      WHERE status = 'generating' ${ageFilter}
      ORDER BY generation_started_at ASC`
  );

  if (stuck.length === 0) {
    console.log('✨ Nessun piano bloccato trovato.');
    await pool.end();
    return;
  }

  console.log(`🔍 Trovati ${stuck.length} piani bloccati:\n`);
  for (const p of stuck) {
    console.log(`   - ${p.id.slice(0, 8)}... user ${p.user_id.slice(0, 8)}...`);
    console.log(`     goal: "${(p.goal || '').slice(0, 50)}"`);
    console.log(`     target: ${p.target_date} | started: ${p.generation_started_at}`);
    console.log(`     artifacts già salvati: ${p.artifact_count}`);
  }

  console.log();
  if (DELETE) {
    const ids = stuck.map(p => p.id);
    await pool.query('DELETE FROM study_plans WHERE id = ANY($1)', [ids]);
    console.log(`🗑  Cancellati ${stuck.length} piani (e i loro artefatti via CASCADE).`);
  } else {
    // Reset: se ha già qualche artefatto salvato, lo rendiamo 'active' (è
    // utilizzabile). Altrimenti torna 'draft' (lo studente lo deve rigenerare).
    for (const p of stuck) {
      const newStatus = Number(p.artifact_count) > 0 ? 'active' : 'draft';
      await pool.query(
        `UPDATE study_plans
            SET status = $2,
                generation_completed_at = CASE WHEN $2 = 'active' THEN NOW() ELSE generation_completed_at END,
                generation_error = $3
          WHERE id = $1`,
        [p.id, newStatus, 'reset_after_stuck_generation']
      );
      console.log(`   ${p.id.slice(0, 8)}... → ${newStatus} ${newStatus === 'active' ? '(' + p.artifact_count + ' artefatti già ok)' : '(da rigenerare)'}`);
    }
  }

  console.log('\n✅ Fatto.');
  await pool.end();
}

main().catch(err => {
  console.error('❌ Errore:', err);
  pool.end();
  process.exit(1);
});
