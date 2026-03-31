require('dotenv').config();
const fs = require('fs');
const { put } = require('@vercel/blob');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

// Configurazione database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function uploadFileDirectly(filePath, originalName) {
  try {
    console.log(`📤 Caricando ${originalName}...`);
    
    // 1. Upload su Vercel Blob
    const fileBuffer = fs.readFileSync(filePath);
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
    
    const blob = await put(safeName, fileBuffer, {
      access: 'public'
      // Token viene preso automaticamente dalla configurazione Vercel
    });
    
    console.log(`✅ Blob URL: ${blob.url}`);
    
    // 2. Inserisci nel database
    const resourceId = uuidv4();
    const now = new Date().toISOString();
    
    await pool.query(`
      INSERT INTO resources (id, name, type, url, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [resourceId, originalName.replace(/\.pdf$/i, ''), 'pdf', blob.url, now, now]);
    
    console.log(`✅ ${originalName} → Database inserito (ID: ${resourceId})`);
    
    return {
      id: resourceId,
      url: blob.url,
      filename: safeName
    };
    
  } catch (error) {
    console.error(`❌ Errore upload ${originalName}:`, error.message);
    return null;
  }
}

async function main() {
  const files = [
    {
      path: '/Users/virgiliomaretto/clawd/CF_Valentini_masterCF_Intro rev.pdf',
      name: 'CF_Valentini_masterCF_Intro.pdf'
    },
    {
      path: '/Users/virgiliomaretto/clawd/Papale_CarbonFarming_ciclo_C Rev.pdf', 
      name: 'Papale_CarbonFarming_ciclo_C.pdf'
    }
  ];
  
  console.log('🚀 Inizio caricamento diretto...\n');
  
  for (const file of files) {
    if (fs.existsSync(file.path)) {
      const result = await uploadFileDirectly(file.path, file.name);
      if (result) {
        console.log(`\n📋 ${file.name}:`);
        console.log(`   URL: ${result.url}`);
        console.log(`   ID:  ${result.id}\n`);
      }
    } else {
      console.log(`❌ File non trovato: ${file.path}`);
    }
  }
  
  await pool.end();
  console.log('✅ Caricamento completato!');
}

main().catch(console.error);