#!/usr/bin/env node
// scripts/re-extract-failed-pdfs.js
//
// Ri-estrae il testo dai PDF che hanno extraction_status='failed' nella tabella
// resources. Causa storica del fallimento: pdf-parse v2 + pdfjs-dist moderno
// che richiede API browser (DOMMatrix) non disponibili in Node.js puro.
//
// Prerequisito: npm install pdf-parse@1.1.1
//   (downgrade dalla v2 buggata. La v1.1.1 e' la versione LTS storica che
//   funziona perfettamente in Node senza polyfill.)
//
// Uso:
//   node scripts/re-extract-failed-pdfs.js                  # processa tutti i failed
//   node scripts/re-extract-failed-pdfs.js --dry-run        # mostra cosa farebbe
//   node scripts/re-extract-failed-pdfs.js --limit 5        # primi 5 (per test)
//   node scripts/re-extract-failed-pdfs.js --include-pending # anche pending (di default no)

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// ----------------------------------------------------------------------------
// CLI args
// ----------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flags = {
  dryRun: argv.includes('--dry-run'),
  includePending: argv.includes('--include-pending'),
  verbose: argv.includes('--verbose') || argv.includes('-v')
};
const limitIdx = argv.indexOf('--limit');
const limit = limitIdx >= 0 ? parseInt(argv[limitIdx + 1], 10) : null;

// ----------------------------------------------------------------------------
// Setup
// ----------------------------------------------------------------------------
if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL non configurata');
  process.exit(1);
}

let pdfParse;
try {
  pdfParse = require('pdf-parse');
} catch (err) {
  console.error('❌ pdf-parse non installato. Lancia:  npm install pdf-parse@1.1.1');
  process.exit(1);
}

// Quick check sulla versione (heuristic): se la chiamata fallisce subito con
// "DOMMatrix is not defined" su un buffer minimo, sei ancora sulla v2 buggata.
async function checkPdfParseVersion() {
  // PDF minimo valido: "Hello PDF" 1-page in PDF stream
  const minimalPdf = Buffer.from(
    '%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/Resources<<>>/MediaBox[0 0 100 100]>>endobj\n' +
    'xref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000110 00000 n \n' +
    'trailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF',
    'utf8'
  );
  try {
    await pdfParse(minimalPdf);
    return true;
  } catch (err) {
    if (/DOMMatrix|Path2D|ImageData/.test(err.message)) {
      console.error('\n❌ pdf-parse e\' nella versione 2 buggata.');
      console.error('   Fix: lancia subito  npm install pdf-parse@1.1.1');
      console.error('   Poi ri-lancia questo script.\n');
      return false;
    }
    // Altri errori sul PDF minimo sono normali, la lib funziona
    return true;
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 3
});

// ----------------------------------------------------------------------------
// Stats
// ----------------------------------------------------------------------------
const stats = {
  total: 0,
  ok: 0,
  failed: 0,
  skipped: 0,
  charsExtracted: 0
};

function fmt(n) { return Number(n || 0).toLocaleString('it-IT'); }
function fmtBytes(b) {
  const k = b / 1024;
  if (k < 1024) return `${k.toFixed(1)} KB`;
  return `${(k / 1024).toFixed(2)} MB`;
}

// ----------------------------------------------------------------------------
// Download PDF dal suo URL
// ----------------------------------------------------------------------------
async function downloadPdf(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} su ${url}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 100) {
    throw new Error(`File troppo piccolo (${buffer.length} byte)`);
  }
  // Verifica che sia davvero un PDF (header %PDF-)
  if (!buffer.slice(0, 5).toString('ascii').startsWith('%PDF-')) {
    throw new Error(`Non e\' un PDF (header: ${buffer.slice(0, 8).toString('ascii')})`);
  }
  return buffer;
}

// ----------------------------------------------------------------------------
// Estrai e aggiorna una riga
// ----------------------------------------------------------------------------
async function processResource(r) {
  const label = `${r.id.slice(0, 8)}  ${r.title}`;
  process.stdout.write(`   ${label} ... `);

  let buffer;
  try {
    buffer = await downloadPdf(r.url);
  } catch (err) {
    console.log(`❌ download: ${err.message}`);
    stats.failed++;
    await updateFailure(r.id, `download: ${err.message}`);
    return;
  }

  let parsed;
  try {
    parsed = await pdfParse(buffer);
  } catch (err) {
    console.log(`❌ parse: ${err.message}`);
    stats.failed++;
    await updateFailure(r.id, `parse: ${err.message}`);
    return;
  }

  const text = (parsed.text || '').trim();
  if (text.length < 50) {
    console.log(`⚠️  ${text.length} char (PDF probabilmente scansionato, serve OCR)`);
    stats.skipped++;
    await updateUnavailable(r.id, 'too_short_likely_scanned', parsed.numpages || 0, buffer.length);
    return;
  }

  console.log(`✅ ${fmt(text.length)} char, ${parsed.numpages || '?'} pag (${fmtBytes(buffer.length)})`);

  if (!flags.dryRun) {
    await updateSuccess(r.id, text, parsed.numpages || 0, buffer.length, parsed.info || {});
  }

  stats.ok++;
  stats.charsExtracted += text.length;
}

async function updateSuccess(id, text, pages, fileSize, info) {
  await pool.query(
    `UPDATE resources
        SET extracted_text = $2,
            extraction_status = 'ready',
            extraction_metadata = jsonb_build_object(
              'pages', $3::int,
              'file_size_bytes', $4::bigint,
              'extracted_at', NOW(),
              'extractor', 'pdf-parse@1.1.1',
              'pdf_info', $5::jsonb
            ),
            extracted_at = NOW(),
            updated_at = NOW()
      WHERE id = $1`,
    [id, text, pages, fileSize, JSON.stringify(info || {})]
  );
}

async function updateFailure(id, reason) {
  await pool.query(
    `UPDATE resources
        SET extraction_status = 'failed',
            extraction_metadata = jsonb_build_object(
              'error', $2::text,
              'attempted_at', NOW(),
              'extractor', 'pdf-parse@1.1.1'
            ),
            updated_at = NOW()
      WHERE id = $1`,
    [id, reason]
  );
}

async function updateUnavailable(id, reason, pages, fileSize) {
  await pool.query(
    `UPDATE resources
        SET extraction_status = 'unavailable',
            extraction_metadata = jsonb_build_object(
              'reason', $2::text,
              'pages', $3::int,
              'file_size_bytes', $4::bigint,
              'attempted_at', NOW(),
              'extractor', 'pdf-parse@1.1.1'
            ),
            updated_at = NOW()
      WHERE id = $1`,
    [id, reason, pages, fileSize]
  );
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🔧 Re-extract PDF falliti — Prof. Carbonio prep');
  console.log(`   Modalita': ${flags.dryRun ? 'DRY RUN (nessuna scrittura)' : 'PRODUZIONE'}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const versionOk = await checkPdfParseVersion();
  if (!versionOk) {
    process.exit(1);
  }

  const statuses = flags.includePending ? ['failed', 'pending'] : ['failed'];

  const query = `
    SELECT id, title, url, resource_type
      FROM resources
     WHERE resource_type = 'pdf'
       AND extraction_status = ANY($1::text[])
       AND url IS NOT NULL
     ORDER BY created_at DESC
     ${limit ? `LIMIT ${limit}` : ''}
  `;

  const { rows } = await pool.query(query, [statuses]);
  stats.total = rows.length;

  if (!rows.length) {
    console.log('Nessun PDF da ri-estrarre. Tutto a posto.\n');
    await pool.end();
    return;
  }

  console.log(`📋 ${rows.length} PDF da processare:\n`);

  for (const r of rows) {
    try {
      await processResource(r);
    } catch (err) {
      console.log(`   ❌ ${r.title}: errore inatteso: ${err.message}`);
      stats.failed++;
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('📊 REPORT FINALE');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`   Processati:        ${fmt(stats.total)}`);
  console.log(`   ✅ Successo:        ${fmt(stats.ok)}`);
  console.log(`   ⚠️  Scansionati (servono OCR): ${fmt(stats.skipped)}`);
  console.log(`   ❌ Falliti:         ${fmt(stats.failed)}`);
  console.log(`   Caratteri estratti: ${fmt(stats.charsExtracted)} (~${fmt(Math.round(stats.charsExtracted / 4))} token)`);

  if (stats.ok > 0 && !flags.dryRun) {
    console.log('\n💡 Adesso lancia:  node scripts/ingest-prof-carbonio.js');
    console.log('   per portare il nuovo materiale nella KB di Prof. Carbonio.');
  }

  console.log('═══════════════════════════════════════════════════════════\n');

  await pool.end();
}

main().catch(async (err) => {
  console.error('\n❌ Errore fatale:', err);
  await pool.end();
  process.exit(1);
});
