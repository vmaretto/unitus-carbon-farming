#!/usr/bin/env node
// scripts/ingest-prof-carbonio.js
//
// Backfill della knowledge base di Prof. Carbonio.
// Ingerisce:
//   - tutti i blog_posts pubblicati
//   - tutte le resources con extracted_status='ready'
//   - file di testo passati come argomenti CLI (per il Regolamento UE 2024/3012,
//     linee guida MASAF, ecc. che metterai in una cartella locale o Google Drive
//     scaricato)
//
// Uso:
//   node scripts/ingest-prof-carbonio.js                   # ingest blog + resources
//   node scripts/ingest-prof-carbonio.js path/to/file.pdf  # + file extra (manuale)
//   node scripts/ingest-prof-carbonio.js --only-blog       # solo blog
//   node scripts/ingest-prof-carbonio.js --only-resources  # solo resources
//   node scripts/ingest-prof-carbonio.js --dry-run         # mostra cosa farebbe, non scrive
//
// Idempotente: rilanciarlo non duplica.

require('dotenv').config();

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const Anthropic = require('@anthropic-ai/sdk').default;
const OpenAI = require('openai');

const {
  ingestSource,
  ingestBlogPost,
  ingestResource
} = require('../api/prof-carbonio-ingest');

// ----------------------------------------------------------------------------
// CLI ARGS
// ----------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flags = {
  onlyBlog: argv.includes('--only-blog'),
  onlyResources: argv.includes('--only-resources'),
  onlyFiles: argv.includes('--only-files'),
  dryRun: argv.includes('--dry-run'),
  verbose: argv.includes('--verbose') || argv.includes('-v')
};
const extraFiles = argv.filter(a => !a.startsWith('--') && a !== '-v');

// ----------------------------------------------------------------------------
// SETUP
// ----------------------------------------------------------------------------

function requireEnv(name) {
  if (!process.env[name]) {
    console.error(`❌ Missing required env var: ${name}`);
    process.exit(1);
  }
}

requireEnv('DATABASE_URL');
requireEnv('OPENAI_API_KEY');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 3
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ----------------------------------------------------------------------------
// REPORTING
// ----------------------------------------------------------------------------

const stats = {
  blogTotal: 0, blogIngested: 0, blogSkipped: 0, blogFailed: 0,
  resourcesTotal: 0, resourcesIngested: 0, resourcesSkipped: 0, resourcesFailed: 0,
  filesTotal: 0, filesIngested: 0, filesFailed: 0,
  chunksCreated: 0
};

function log(msg) { console.log(msg); }
function logv(msg) { if (flags.verbose) console.log(msg); }

function summary() {
  console.log('\n═══════════════════════════════════════');
  console.log('📊 REPORT FINALE');
  console.log('═══════════════════════════════════════');
  console.log(`Blog posts:  ${stats.blogIngested}/${stats.blogTotal} ingeriti (${stats.blogSkipped} skip, ${stats.blogFailed} errori)`);
  console.log(`Resources:   ${stats.resourcesIngested}/${stats.resourcesTotal} ingeriti (${stats.resourcesSkipped} skip, ${stats.resourcesFailed} errori)`);
  console.log(`File extra:  ${stats.filesIngested}/${stats.filesTotal} ingeriti (${stats.filesFailed} errori)`);
  console.log(`Chunk totali creati: ${stats.chunksCreated}`);
  console.log('═══════════════════════════════════════\n');
}

// ----------------------------------------------------------------------------
// INGEST: BLOG POSTS
// ----------------------------------------------------------------------------

async function ingestAllBlogPosts() {
  log('\n📰 Blog posts pubblicati...');

  const { rows } = await pool.query(
    `SELECT id, title, slug, content, excerpt, author, published_at, tags
       FROM blog_posts
      WHERE is_published = true
        AND content IS NOT NULL
        AND length(content) > 200
      ORDER BY published_at DESC NULLS LAST`
  );

  stats.blogTotal = rows.length;
  log(`   trovati ${rows.length}`);

  for (const post of rows) {
    try {
      if (flags.dryRun) {
        logv(`   [dry-run] ${post.title}`);
        stats.blogIngested++;
        continue;
      }
      const result = await ingestBlogPost({ pool, openai }, post);
      if (result.skipped) {
        logv(`   ↪ ${post.title} (skip: ${result.reason})`);
        stats.blogSkipped++;
      } else {
        log(`   ✅ ${post.title} (${result.chunksCreated} chunk)`);
        stats.blogIngested++;
        stats.chunksCreated += result.chunksCreated;
      }
    } catch (err) {
      console.error(`   ❌ ${post.title}:`, err.message);
      stats.blogFailed++;
    }
  }
}

// ----------------------------------------------------------------------------
// INGEST: RESOURCES (materiali docenti gia' estratti)
// ----------------------------------------------------------------------------

async function ingestAllResources() {
  log('\n📚 Resources con extracted_text pronto...');

  const { rows } = await pool.query(
    `SELECT id, title, description, resource_type, url, file_size_bytes,
            extracted_text, extraction_metadata
       FROM resources
      WHERE is_published = true
        AND extraction_status = 'ready'
        AND extracted_text IS NOT NULL
        AND length(extracted_text) > 200`
  );

  stats.resourcesTotal = rows.length;
  log(`   trovati ${rows.length}`);

  for (const r of rows) {
    try {
      if (flags.dryRun) {
        logv(`   [dry-run] ${r.title} (${r.resource_type})`);
        stats.resourcesIngested++;
        continue;
      }
      const result = await ingestResource({ pool, openai }, r);
      if (result.skipped) {
        logv(`   ↪ ${r.title} (skip: ${result.reason})`);
        stats.resourcesSkipped++;
      } else {
        log(`   ✅ ${r.title} (${result.chunksCreated} chunk)`);
        stats.resourcesIngested++;
        stats.chunksCreated += result.chunksCreated;
      }
    } catch (err) {
      console.error(`   ❌ ${r.title}:`, err.message);
      stats.resourcesFailed++;
    }
  }
}

// ----------------------------------------------------------------------------
// INGEST: FILE LOCALI (Regolamento, MASAF, ecc.)
// ----------------------------------------------------------------------------

async function ingestLocalFile(filePath) {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    console.error(`   ❌ File non trovato: ${absPath}`);
    stats.filesFailed++;
    return;
  }

  const ext = path.extname(absPath).toLowerCase();
  const baseName = path.basename(absPath, ext);

  let content = '';
  let contentFormat = 'text';
  let sourceType = 'manual';

  try {
    if (ext === '.pdf') {
      // Usa pdf-parse (gia' nelle deps di unitus)
      const pdfParse = require('pdf-parse');
      const buffer = fs.readFileSync(absPath);
      const data = await pdfParse(buffer);
      // pdf-parse separa le pagine con \f form-feed
      content = data.text;
      contentFormat = 'pdf';
      sourceType = baseName.toLowerCase().includes('regolamento') ||
                   baseName.toLowerCase().includes('crcf') ||
                   baseName.toLowerCase().includes('masaf')
        ? 'normative'
        : 'manual';
    } else if (ext === '.docx') {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ path: absPath });
      content = result.value;
      contentFormat = 'text';
    } else if (ext === '.srt' || ext === '.vtt') {
      content = fs.readFileSync(absPath, 'utf8');
      contentFormat = 'transcript';
      sourceType = 'lms_lesson';
    } else if (ext === '.md' || ext === '.txt') {
      content = fs.readFileSync(absPath, 'utf8');
      contentFormat = 'text';
    } else if (ext === '.html' || ext === '.htm') {
      content = fs.readFileSync(absPath, 'utf8');
      contentFormat = 'html';
    } else {
      console.error(`   ⏭️  ${baseName}${ext}: estensione non supportata, skip`);
      stats.filesFailed++;
      return;
    }
  } catch (err) {
    console.error(`   ❌ ${baseName}${ext}: errore parsing:`, err.message);
    stats.filesFailed++;
    return;
  }

  if (!content?.trim()) {
    console.error(`   ❌ ${baseName}${ext}: file vuoto`);
    stats.filesFailed++;
    return;
  }

  if (flags.dryRun) {
    logv(`   [dry-run] ${baseName}${ext} (${contentFormat}, ${content.length} char)`);
    stats.filesIngested++;
    return;
  }

  try {
    const result = await ingestSource({ pool, openai }, {
      sourceType,
      title: baseName,
      content,
      contentFormat,
      language: 'it',
      metadata: { source_path: absPath, file_size_bytes: fs.statSync(absPath).size }
    });
    if (result.skipped) {
      logv(`   ↪ ${baseName} (skip: ${result.reason})`);
    } else {
      log(`   ✅ ${baseName} (${result.chunksCreated} chunk, type=${sourceType})`);
      stats.chunksCreated += result.chunksCreated;
    }
    stats.filesIngested++;
  } catch (err) {
    console.error(`   ❌ ${baseName}:`, err.message);
    stats.filesFailed++;
  }
}

async function ingestAllLocalFiles() {
  if (!extraFiles.length) return;
  log(`\n📄 File locali (${extraFiles.length})...`);
  stats.filesTotal = extraFiles.length;
  for (const f of extraFiles) {
    await ingestLocalFile(f);
  }
}

// ----------------------------------------------------------------------------
// MAIN
// ----------------------------------------------------------------------------

async function main() {
  console.log('═══════════════════════════════════════');
  console.log('🌱 Prof. Carbonio — Ingest backfill');
  console.log(`   Modalita': ${flags.dryRun ? 'DRY RUN (nessuna scrittura)' : 'PRODUZIONE'}`);
  console.log('═══════════════════════════════════════');

  try {
    if (!flags.onlyResources && !flags.onlyFiles) {
      await ingestAllBlogPosts();
    }
    if (!flags.onlyBlog && !flags.onlyFiles) {
      await ingestAllResources();
    }
    if (!flags.onlyBlog && !flags.onlyResources) {
      await ingestAllLocalFiles();
    }
    summary();
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Errore fatale:', err);
    summary();
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
