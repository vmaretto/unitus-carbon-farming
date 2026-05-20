#!/usr/bin/env node
// scripts/export-kb-for-notebooklm.js
//
// Esporta tutti i materiali della KB di Prof. Carbonio in una cartella locale
// pronta per essere caricata su NotebookLM (o Google Drive).
//
// Cosa fa:
// 1) Scarica TUTTI i PDF dei docenti (resources con extraction_status='ready')
//    dai loro URL pubblici (Cloudinary / Vercel Blob).
// 2) Converte i blog posts del Master in file .md/.txt leggibili.
// 3) Organizza tutto in una cartella ./exports/notebooklm-kb/ con sottocartelle
//    per tipo, pronta per essere zippata o caricata su Drive.
//
// Uso:
//   node scripts/export-kb-for-notebooklm.js
//   node scripts/export-kb-for-notebooklm.js --skip-existing  # non riscarica
//
// Output: ./exports/notebooklm-kb/
//   ├── 01-Regolamenti-e-Normative/
//   ├── 02-Dispense-e-Lezioni/
//   ├── 03-Report-Internazionali/
//   ├── 04-Blog-Master/
//   └── INDICE.md  (lista di tutti i file con descrizione)

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL non configurata');
  process.exit(1);
}

const skipExisting = process.argv.includes('--skip-existing');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 3
});

const OUT_BASE = path.resolve(__dirname, '..', 'exports', 'notebooklm-kb');

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function sanitizeFilename(s) {
  return String(s || 'untitled')
    .replace(/[\\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Categorizza una resource in base al titolo (euristica semplice)
function categorize(title, resourceType) {
  const t = String(title || '').toLowerCase();
  if (/regolament|crcf|2024.?3012|directive|decreto/.test(t)) return '01-Regolamenti-e-Normative';
  if (/initial report|article 6|nation/i.test(t)) return '03-Report-Internazionali';
  if (/dispens|lezion|master|ipcc|crea|fao/.test(t)) return '02-Dispense-e-Lezioni';
  return '02-Dispense-e-Lezioni';
}

async function downloadPdf(url, destPath) {
  if (skipExisting && fs.existsSync(destPath)) return 'skip';
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100) throw new Error('file vuoto');
  fs.writeFileSync(destPath, buf);
  return 'ok';
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

const stats = { pdfs: 0, pdfSkipped: 0, pdfFailed: 0, blog: 0, totalBytes: 0 };
const indexLines = [];

async function exportResources() {
  console.log('\n📚 Scarico i PDF e documenti dei docenti...\n');

  const { rows } = await pool.query(`
    SELECT r.id, r.title, r.url, r.resource_type, r.description,
           length(coalesce(r.extracted_text, '')) AS text_len
      FROM resources r
     WHERE r.is_published = true
       AND r.extraction_status = 'ready'
       AND r.url IS NOT NULL
     ORDER BY r.title
  `);

  for (const r of rows) {
    const category = categorize(r.title, r.resource_type);
    const dir = path.join(OUT_BASE, category);
    ensureDir(dir);

    const ext = (path.extname(new URL(r.url).pathname) || '.pdf').toLowerCase();
    const filename = sanitizeFilename(r.title) + (ext.startsWith('.') ? ext : '.pdf');
    const dest = path.join(dir, filename);

    try {
      const result = await downloadPdf(r.url, dest);
      if (result === 'skip') {
        stats.pdfSkipped++;
        console.log(`   ↪ ${filename} (già presente, skip)`);
      } else {
        const size = fs.statSync(dest).size;
        stats.totalBytes += size;
        stats.pdfs++;
        console.log(`   ✅ ${filename} (${(size/1024).toFixed(0)} KB)`);
        indexLines.push(`- **${category}** / ${filename} — ${r.description || ''}`);
      }
    } catch (err) {
      stats.pdfFailed++;
      console.error(`   ❌ ${filename}: ${err.message}`);
    }
  }
}

async function exportBlog() {
  console.log('\n📰 Esporto i blog post in markdown...\n');

  const dir = path.join(OUT_BASE, '04-Blog-Master');
  ensureDir(dir);

  const { rows } = await pool.query(`
    SELECT id, title, slug, content, excerpt, author, published_at
      FROM blog_posts
     WHERE is_published = true
       AND length(coalesce(content, '')) > 200
     ORDER BY published_at DESC NULLS LAST
  `);

  for (const p of rows) {
    const filename = sanitizeFilename(p.title) + '.md';
    const dest = path.join(dir, filename);

    if (skipExisting && fs.existsSync(dest)) {
      stats.pdfSkipped++;
      continue;
    }

    const md = [
      `# ${p.title}`,
      '',
      `> ${p.excerpt || ''}`,
      '',
      `**Autore:** ${p.author || 'Master Carbon Farming'}`,
      `**Pubblicato:** ${p.published_at ? new Date(p.published_at).toLocaleDateString('it-IT') : 'n/d'}`,
      `**Link:** https://unitus.carbonfarmingmaster.it/blog/${p.slug || ''}`,
      '',
      '---',
      '',
      stripHtml(p.content)
    ].join('\n');

    fs.writeFileSync(dest, md, 'utf8');
    stats.blog++;
    console.log(`   ✅ ${filename}`);
    indexLines.push(`- **04-Blog-Master** / ${filename}`);
  }
}

function writeIndex() {
  const indexPath = path.join(OUT_BASE, 'INDICE.md');
  const lines = [
    '# Knowledge Base — Master in Carbon Farming',
    '',
    `Esportata il ${new Date().toLocaleString('it-IT')} per essere caricata su NotebookLM.`,
    '',
    `Totale file: ${stats.pdfs + stats.blog}`,
    '',
    '## Struttura',
    '',
    '- `01-Regolamenti-e-Normative/` — Regolamento UE 2024/3012 (CRCF) e altri testi normativi',
    '- `02-Dispense-e-Lezioni/` — Materiali didattici dei docenti del Master',
    '- `03-Report-Internazionali/` — Initial Reports Article 6 (Paris Agreement) di vari paesi',
    '- `04-Blog-Master/` — Articoli del blog del Master (in markdown)',
    '',
    '## Come usarla su NotebookLM',
    '',
    '1. Vai su https://drive.google.com e crea una cartella "Master Carbon Farming KB"',
    '2. Trascina dentro tutta la cartella `notebooklm-kb` con le sue sottocartelle',
    '3. Apri https://notebooklm.google.com',
    '4. Crea un nuovo notebook PER MODULO (es. "Modulo 2 - Regolamento CRCF")',
    '5. "Add source" → "Google Drive" → seleziona i file rilevanti per quel modulo',
    '6. Una volta caricato, vai su "Studio" → "Video Overview" → scegli lingua italiano',
    '7. Aspetta 5-10 minuti, scarica il video MP4',
    '',
    '## File inclusi',
    '',
    indexLines.join('\n')
  ].join('\n');

  fs.writeFileSync(indexPath, lines, 'utf8');
  console.log(`\n📋 Indice scritto in: ${indexPath}`);
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('📦 Export KB Prof. Carbonio per NotebookLM');
  console.log(`   Destinazione: ${OUT_BASE}`);
  console.log('═══════════════════════════════════════════════════════════');

  ensureDir(OUT_BASE);

  try {
    await exportResources();
    await exportBlog();
    writeIndex();

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('📊 REPORT');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`   PDF/documenti scaricati: ${stats.pdfs}`);
    console.log(`   PDF saltati (esistenti): ${stats.pdfSkipped}`);
    console.log(`   PDF falliti:             ${stats.pdfFailed}`);
    console.log(`   Blog post esportati:     ${stats.blog}`);
    console.log(`   Totale MB scaricati:     ${(stats.totalBytes / 1024 / 1024).toFixed(1)} MB`);
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`\n✅ Tutto pronto in: ${OUT_BASE}`);
    console.log('   Adesso apri quella cartella nel Finder, trascinala su Google Drive,');
    console.log('   poi creai i Notebook su https://notebooklm.google.com\n');
  } catch (err) {
    console.error('\n❌ Errore fatale:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
