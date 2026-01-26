require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const app = express();
const port = process.env.PORT || 3000;

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);
let pool = null;

const defaultFaculty = [
  {
    name: 'Prof. Riccardo Valentini',
    role: 'Direttore Scientifico',
    bio: 'Università della Tuscia - Premio Nobel per la Pace IPCC, esperto internazionale in climate change e carbon cycle',
    photoUrl: null,
    sortOrder: 1,
    is_published: true
  },
  {
    name: 'Virgilio Maretto',
    role: 'Coordinatore',
    bio: 'Esperto in sostenibilità e gestione ambientale, consulente strategico per progetti di transizione ecologica',
    photoUrl: null,
    sortOrder: 2,
    is_published: true
  },
  {
    name: 'Dr.ssa Maria Vincenza Chiriacò',
    role: null,
    bio: 'CMCC - Specialista in inventari nazionali delle emissioni e metodologie IPCC per il settore LULUCF',
    photoUrl: null,
    sortOrder: 3,
    is_published: true
  },
  {
    name: 'Prof. Emanuele Blasi',
    role: null,
    bio: 'Università della Tuscia - Esperto in economia agraria e valutazione economica dei servizi ecosistemici',
    photoUrl: null,
    sortOrder: 4,
    is_published: true
  },
  {
    name: 'Prof. Tommaso Chiti',
    role: null,
    bio: 'Università della Tuscia - Esperto in biogeochemical cycles, soil carbon dynamics e Life Cycle Assessment',
    photoUrl: null,
    sortOrder: 5,
    is_published: true
  },
  {
    name: 'Prof. Dario Papale',
    role: null,
    bio: 'Università della Tuscia - Specialista in flussi di CO₂, eddy covariance e monitoraggio ecosistemi forestali',
    photoUrl: null,
    sortOrder: 6,
    is_published: true
  },
  {
    name: 'Prof. Raffaele Casa',
    role: null,
    bio: "Università della Tuscia - Esperto in agricoltura di precisione, remote sensing e tecnologie per l'agricoltura sostenibile",
    photoUrl: null,
    sortOrder: 7,
    is_published: true
  },
  {
    name: 'Prof. Andrea Vannini',
    role: null,
    bio: 'Università della Tuscia - Esperto in patologia vegetale e protezione delle colture in sistemi agricoli sostenibili',
    photoUrl: null,
    sortOrder: 8,
    is_published: true
  },
  {
    name: 'Prof.ssa Anna Barbati',
    role: null,
    bio: 'Università della Tuscia - Specialista in gestione forestale sostenibile, servizi ecosistemici e biodiversità forestale',
    photoUrl: null,
    sortOrder: 9,
    is_published: true
  },
  {
    name: 'Prof. Pier Maria Corona',
    role: null,
    bio: 'CREA - Esperto in inventari forestali, dendrometria e gestione sostenibile delle risorse forestali',
    photoUrl: null,
    sortOrder: 10,
    is_published: true
  },
  {
    name: 'Francesco Rutelli',
    role: null,
    bio: 'Esperto in politiche ambientali e governance della sostenibilità, ex Ministro per i Beni e le Attività Culturali',
    photoUrl: null,
    sortOrder: 11,
    is_published: true
  },
  {
    name: 'Luca Buonocore',
    role: null,
    bio: 'Consulente strategico in sostenibilità e carbon management, esperto in mercati dei crediti di carbonio',
    photoUrl: null,
    sortOrder: 12,
    is_published: true
  }
];

if (hasDatabaseUrl) {
  const sslOption = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: sslOption
  });
}

app.use(express.json());

const staticRoot = path.join(__dirname);
app.use(express.static(staticRoot));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', database: hasDatabaseUrl });
});

async function initDatabase() {
  if (!pool) {
    console.warn('DATABASE_URL not provided. API routes will respond with 503 until configured.');
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS faculty (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT,
      bio TEXT,
      photo_url TEXT,
      sort_order INTEGER,
      is_published BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Add profile_link column if it doesn't exist
  await pool.query(`
    ALTER TABLE faculty
    ADD COLUMN IF NOT EXISTS profile_link TEXT;
  `);

  const { rows: facultyCountRows } = await pool.query('SELECT COUNT(*)::INT AS count FROM faculty;');
  const facultyCount = facultyCountRows?.[0]?.count || 0;

  if (!facultyCount && defaultFaculty.length) {
    const seedValues = [];
    const seedPlaceholders = defaultFaculty
      .map((member, index) => {
        const base = index * 7;
        seedValues.push(
          uuidv4(),
          member.name,
          member.role ?? null,
          member.bio ?? null,
          member.photoUrl ?? null,
          typeof member.sortOrder === 'number' ? member.sortOrder : null,
          member.is_published === true
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
      })
      .join(', ');

    if (seedPlaceholders) {
      await pool.query(
        `
          INSERT INTO faculty (id, name, role, bio, photo_url, sort_order, is_published)
          VALUES ${seedPlaceholders}
          ON CONFLICT (id) DO NOTHING;
        `,
        seedValues
      );
    }
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS blog_posts (
      id UUID PRIMARY KEY,
      title TEXT NOT NULL,
      slug TEXT UNIQUE,
      excerpt TEXT,
      content TEXT,
      cover_image_url TEXT,
      published_at TIMESTAMPTZ,
      is_published BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS partners (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      logo_url TEXT,
      partner_type TEXT NOT NULL CHECK (partner_type IN ('generale', 'patrocinio', 'collaborazione')),
      description TEXT,
      website_url TEXT,
      sort_order INTEGER,
      is_published BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Update existing partners table to support 'generale' type
  await pool.query(`
    ALTER TABLE partners DROP CONSTRAINT IF EXISTS partners_partner_type_check;
  `);
  await pool.query(`
    ALTER TABLE partners ADD CONSTRAINT partners_partner_type_check
    CHECK (partner_type IN ('generale', 'patrocinio', 'collaborazione'));
  `);

  const defaultPartners = [
    {
      name: 'Università della Tuscia',
      logo_url: null,
      logoText: 'UNITUS',
      partner_type: 'generale',
      type_label: 'Partner Principale',
      description: 'Partner accademico principale e sede del Master. Coordinamento scientifico e infrastrutture per le attività didattiche e di ricerca.',
      sort_order: 1,
      is_published: false  // Nascosto perché ora ha una sezione dedicata come organizzatore
    },
    {
      name: 'Collaborazioni in definizione',
      logo_url: null,
      logoText: '🔬',
      partner_type: 'generale',
      type_label: 'Partner Scientifici',
      description: 'In collaborazione con partner scientifici nazionali e internazionali (in fase di definizione). Attività congiunte su ricerca, formazione e innovazione.',
      sort_order: 2,
      is_published: true
    },
    {
      name: 'Progetti LIFE e Horizon Europe',
      logo_url: null,
      logoText: 'EU',
      partner_type: 'generale',
      type_label: 'Partner di Progetto',
      description: 'Accesso a case study e progetti pilota europei. Opportunità di stage presso enti della rete europea per l\'ambiente.',
      sort_order: 3,
      is_published: true
    },
    {
      name: 'Aziende Agricole e Agroforestali',
      logo_url: null,
      logoText: '🏭',
      partner_type: 'generale',
      type_label: 'Partner Privati',
      description: 'Network di aziende agricole, agroalimentari e agroforestali per stage, tirocini e applicazioni pratiche delle competenze acquisite.',
      sort_order: 4,
      is_published: true
    },
    {
      name: 'Associazioni di Categoria',
      logo_url: null,
      logoText: '🤝',
      partner_type: 'generale',
      type_label: 'Partner Settoriali',
      description: 'Collaborazioni con associazioni di categoria del settore agricolo e forestale per collegamenti con il mondo professionale e opportunità di networking.',
      sort_order: 5,
      is_published: true
    },
    {
      name: 'Società di Certificazione del Carbonio',
      logo_url: null,
      logoText: '✓',
      partner_type: 'generale',
      type_label: 'Partner Tecnici',
      description: 'Esperienza pratica sulla validazione dei crediti di carbonio attraverso collaborazioni con società specializzate nel monitoraggio e certificazione.',
      sort_order: 6,
      is_published: true
    },
    {
      name: 'Enti Pubblici e Istituzioni Europee',
      logo_url: null,
      logoText: '🏛️',
      partner_type: 'generale',
      type_label: 'Partner Istituzionali',
      description: 'Collaborazione per l\'analisi delle politiche e normative di settore. Accesso a dati ufficiali e orientamenti normativi europei.',
      sort_order: 7,
      is_published: true
    }
  ];

  const { rows: partnerCountRows } = await pool.query('SELECT COUNT(*)::INT AS count FROM partners;');
  const partnerCount = partnerCountRows?.[0]?.count || 0;

  if (!partnerCount && defaultPartners.length) {
    const seedValues = [];
    const seedPlaceholders = defaultPartners
      .map((partner, index) => {
        const base = index * 7;
        seedValues.push(
          uuidv4(),
          partner.name,
          partner.logo_url,
          partner.partner_type,
          partner.description,
          partner.website_url || null,
          partner.sort_order,
          partner.is_published === true
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
      })
      .join(', ');

    if (seedPlaceholders) {
      await pool.query(
        `
          INSERT INTO partners (id, name, logo_url, partner_type, description, website_url, sort_order, is_published)
          VALUES ${seedPlaceholders}
          ON CONFLICT (id) DO NOTHING;
        `,
        seedValues
      );
    }
  }

  // Assicurati che Unitus sia nascosto (ha una sezione dedicata come organizzatore)
  await pool.query(`
    UPDATE partners
    SET is_published = false
    WHERE name = 'Università della Tuscia';
  `);

  // ============================================
  // TABELLE CALENDARIO
  // ============================================

  // Tabella Moduli del Master
  await pool.query(`
    CREATE TABLE IF NOT EXISTS modules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      description TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Aggiungi colonne syllabus alla tabella modules se non esistono
  const moduleColumns = [
    { name: 'cfu', type: 'INTEGER' },
    { name: 'ssd', type: 'TEXT' },  // Settore Scientifico Disciplinare
    { name: 'period', type: 'TEXT' },  // Periodo indicativo (es. "Marzo 2026")
    { name: 'hours_lectures', type: 'INTEGER DEFAULT 0' },  // Ore lezioni frontali
    { name: 'hours_lab', type: 'INTEGER DEFAULT 0' },  // Ore esercitazioni/laboratori
    { name: 'hours_study', type: 'INTEGER DEFAULT 0' },  // Ore studio individuale
    { name: 'description_short', type: 'TEXT' },  // Descrizione sintetica
    { name: 'contents_main', type: 'TEXT' },  // Contenuti principali (JSON array o testo)
    { name: 'contents_detailed', type: 'TEXT' },  // Contenuti dettagliati
    { name: 'learning_objectives', type: 'TEXT' },  // Obiettivi formativi specifici
    { name: 'evaluation', type: 'TEXT' },  // Modalità di valutazione
    { name: 'bibliography', type: 'TEXT' },  // Bibliografia e materiali didattici
    { name: 'schedule_info', type: 'TEXT' }  // Info calendario (es. "Venerdì 14:00-20:00")
  ];

  for (const col of moduleColumns) {
    await pool.query(`
      ALTER TABLE modules ADD COLUMN IF NOT EXISTS ${col.name} ${col.type};
    `).catch(() => {});  // Ignora errore se colonna esiste già
  }

  // Tabella Lezioni
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lessons (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      module_id UUID REFERENCES modules(id) ON DELETE SET NULL,
      teacher_id UUID REFERENCES faculty(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT,
      start_datetime TIMESTAMPTZ NOT NULL,
      end_datetime TIMESTAMPTZ,
      duration_minutes INTEGER DEFAULT 120,
      location_physical TEXT,
      location_remote TEXT,
      status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'completed', 'cancelled')),
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Indici per performance
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_lessons_start ON lessons(start_datetime);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_lessons_module ON lessons(module_id);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_lessons_teacher ON lessons(teacher_id);
  `);
}

let initPromise = null;

async function ensureDatabaseInitialized() {
  if (!hasDatabaseUrl) {
    return;
  }

  if (!initPromise) {
    initPromise = initDatabase().catch((error) => {
      initPromise = null;
      throw error;
    });
  }

  return initPromise;
}

function ensurePool(res) {
  if (!pool) {
    res.status(503).json({ error: 'Database not configured. Set DATABASE_URL to connect to Neon.' });
    return false;
  }
  return true;
}

function buildUpdateQuery(table, fields, id) {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (!entries.length) {
    throw new Error('No fields provided for update');
  }

  const setClauses = entries.map(([key], index) => `${key} = $${index + 1}`);
  const values = entries.map(([, value]) => value);
  setClauses.push(`updated_at = NOW()`);
  const query = `UPDATE ${table} SET ${setClauses.join(', ')} WHERE id = $${entries.length + 1} RETURNING *`;
  values.push(id);
  return { query, values };
}

app.get('/api/faculty', async (req, res) => {
  if (!ensurePool(res)) {
    return;
  }

  try {
    const { published } = req.query;
    const filters = [];
    const values = [];

    if (published !== undefined) {
      filters.push(`is_published = $${filters.length + 1}`);
      values.push(published === 'true');
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const sql = `
      SELECT id, name, role, bio, photo_url AS "photoUrl", profile_link AS "profileLink", sort_order AS "sortOrder", is_published AS "isPublished"
      FROM faculty
      ${where}
      ORDER BY sort_order NULLS LAST, created_at ASC
    `;

    const { rows } = await pool.query(sql, values);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching faculty', error);
    res.status(500).json({ error: 'Unable to retrieve faculty' });
  }
});

app.post('/api/faculty', async (req, res) => {
  if (!ensurePool(res)) {
    return;
  }

  const { name, role, bio, photoUrl, profileLink, sortOrder, isPublished } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }

  // Normalizza URL della foto (converte GitHub blob in raw)
  const normalizedPhotoUrl = normalizeImageUrl(photoUrl);

  try {
    const id = uuidv4();
    const insert = `
      INSERT INTO faculty (id, name, role, bio, photo_url, profile_link, sort_order, is_published)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, name, role, bio, photo_url AS "photoUrl", profile_link AS "profileLink", sort_order AS "sortOrder", is_published AS "isPublished"
    `;
    const values = [
      id,
      name,
      role || null,
      bio || null,
      normalizedPhotoUrl || null,
      profileLink || null,
      typeof sortOrder === 'number' ? sortOrder : null,
      Boolean(isPublished)
    ];

    const { rows } = await pool.query(insert, values);
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Error creating faculty', error);
    res.status(500).json({ error: 'Unable to create faculty member' });
  }
});

app.put('/api/faculty/:id', async (req, res) => {
  if (!ensurePool(res)) {
    return;
  }

  const { id } = req.params;
  const { name, role, bio, photoUrl, profileLink, sortOrder, isPublished } = req.body;

  // Normalizza URL della foto (converte GitHub blob in raw)
  const normalizedPhotoUrl = photoUrl !== undefined ? normalizeImageUrl(photoUrl) : undefined;

  try {
    const updateFields = {
      name,
      role,
      bio,
      photo_url: normalizedPhotoUrl,
      profile_link: profileLink,
      sort_order: sortOrder,
      is_published: typeof isPublished === 'boolean' ? isPublished : undefined
    };

    const { query, values } = buildUpdateQuery('faculty', updateFields, id);
    const { rows } = await pool.query(query, values);

    if (!rows.length) {
      return res.status(404).json({ error: 'Faculty member not found' });
    }

    const row = rows[0];
    res.json({
      id: row.id,
      name: row.name,
      role: row.role,
      bio: row.bio,
      photoUrl: row.photo_url,
      profileLink: row.profile_link,
      sortOrder: row.sort_order,
      isPublished: row.is_published
    });
  } catch (error) {
    console.error('Error updating faculty', error);
    res.status(500).json({ error: 'Unable to update faculty member' });
  }
});

app.delete('/api/faculty/:id', async (req, res) => {
  if (!ensurePool(res)) {
    return;
  }

  const { id } = req.params;
  try {
    const { rowCount } = await pool.query('DELETE FROM faculty WHERE id = $1', [id]);
    if (!rowCount) {
      return res.status(404).json({ error: 'Faculty member not found' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting faculty', error);
    res.status(500).json({ error: 'Unable to delete faculty member' });
  }
});

app.get('/api/blog-posts', async (req, res) => {
  if (!ensurePool(res)) {
    return;
  }

  try {
    const { published, limit } = req.query;
    const filters = [];
    const values = [];

    if (published !== undefined) {
      filters.push(`is_published = $${filters.length + 1}`);
      values.push(published === 'true');
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const limitClause = limit ? `LIMIT ${Number(limit)}` : '';

    const sql = `
      SELECT id, title, slug, excerpt, content, cover_image_url AS "coverImageUrl",
             published_at AS "publishedAt", is_published AS "isPublished"
      FROM blog_posts
      ${where}
      ORDER BY published_at DESC NULLS LAST, created_at DESC
      ${limitClause}
    `;

    const { rows } = await pool.query(sql, values);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching blog posts', error);
    res.status(500).json({ error: 'Unable to retrieve blog posts' });
  }
});

app.post('/api/blog-posts', async (req, res) => {
  if (!ensurePool(res)) {
    return;
  }

  const { title, slug, excerpt, content, coverImageUrl, publishedAt, isPublished } = req.body;

  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }

  try {
    const id = uuidv4();
    const insert = `
      INSERT INTO blog_posts (id, title, slug, excerpt, content, cover_image_url, published_at, is_published)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, title, slug, excerpt, content, cover_image_url AS "coverImageUrl",
                published_at AS "publishedAt", is_published AS "isPublished"
    `;

    const values = [
      id,
      title,
      slug || null,
      excerpt || null,
      content || null,
      coverImageUrl || null,
      publishedAt ? new Date(publishedAt) : null,
      Boolean(isPublished)
    ];

    const { rows } = await pool.query(insert, values);
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Error creating blog post', error);
    if (error.code === '23505') {
      res.status(409).json({ error: 'Slug already exists' });
      return;
    }
    res.status(500).json({ error: 'Unable to create blog post' });
  }
});

app.put('/api/blog-posts/:id', async (req, res) => {
  if (!ensurePool(res)) {
    return;
  }

  const { id } = req.params;
  const { title, slug, excerpt, content, coverImageUrl, publishedAt, isPublished } = req.body;

  try {
    const updateFields = {
      title,
      slug,
      excerpt,
      content,
      cover_image_url: coverImageUrl,
      published_at:
        publishedAt === undefined ? undefined : publishedAt ? new Date(publishedAt) : null,
      is_published: typeof isPublished === 'boolean' ? isPublished : undefined
    };

    const { query, values } = buildUpdateQuery('blog_posts', updateFields, id);
    const { rows } = await pool.query(query, values);

    if (!rows.length) {
      return res.status(404).json({ error: 'Blog post not found' });
    }

    const row = rows[0];
    res.json({
      id: row.id,
      title: row.title,
      slug: row.slug,
      excerpt: row.excerpt,
      content: row.content,
      coverImageUrl: row.cover_image_url,
      publishedAt: row.published_at,
      isPublished: row.is_published
    });
  } catch (error) {
    console.error('Error updating blog post', error);
    if (error.code === '23505') {
      res.status(409).json({ error: 'Slug already exists' });
      return;
    }
    res.status(500).json({ error: 'Unable to update blog post' });
  }
});

app.delete('/api/blog-posts/:id', async (req, res) => {
  if (!ensurePool(res)) {
    return;
  }

  const { id } = req.params;
  try {
    const { rowCount } = await pool.query('DELETE FROM blog_posts WHERE id = $1', [id]);
    if (!rowCount) {
      return res.status(404).json({ error: 'Blog post not found' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting blog post', error);
    res.status(500).json({ error: 'Unable to delete blog post' });
  }
});

app.get('/api/partners', async (req, res) => {
  if (!ensurePool(res)) {
    return;
  }

  try {
    const { published, type } = req.query;
    const filters = [];
    const values = [];

    if (published !== undefined) {
      filters.push(`is_published = $${filters.length + 1}`);
      values.push(published === 'true');
    }

    if (type !== undefined) {
      filters.push(`partner_type = $${filters.length + 1}`);
      values.push(type);
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const sql = `
      SELECT id, name, logo_url AS "logoUrl", partner_type AS "partnerType",
             description, website_url AS "websiteUrl", sort_order AS "sortOrder",
             is_published AS "isPublished"
      FROM partners
      ${where}
      ORDER BY sort_order NULLS LAST, created_at ASC
    `;

    const { rows } = await pool.query(sql, values);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching partners', error);
    res.status(500).json({ error: 'Unable to retrieve partners' });
  }
});

// Helper function per normalizzare URL delle immagini
// Converte URL GitHub "blob" in URL "raw" per immagini dirette
function normalizeImageUrl(url) {
  if (!url) return null;

  // Pattern per rilevare URL GitHub formato "blob"
  // Esempio: https://github.com/user/repo/blob/main/path/to/image.png
  const githubBlobPattern = /^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/blob\/(.+)$/;
  const match = url.match(githubBlobPattern);

  if (match) {
    const [, owner, repo, path] = match;
    // Converte in formato "raw"
    // Esempio: https://raw.githubusercontent.com/user/repo/main/path/to/image.png
    return `https://raw.githubusercontent.com/${owner}/${repo}/${path}`;
  }

  return url;
}

app.post('/api/partners', async (req, res) => {
  if (!ensurePool(res)) {
    return;
  }

  const { name, logoUrl, partnerType, description, websiteUrl, sortOrder, isPublished } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }

  if (!partnerType || !['generale', 'patrocinio', 'collaborazione'].includes(partnerType)) {
    return res.status(400).json({ error: 'Partner type must be "generale", "patrocinio", or "collaborazione"' });
  }

  // Normalizza URL del logo (converte GitHub blob in raw)
  const normalizedLogoUrl = normalizeImageUrl(logoUrl);

  try {
    const id = uuidv4();
    const insert = `
      INSERT INTO partners (id, name, logo_url, partner_type, description, website_url, sort_order, is_published)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, name, logo_url AS "logoUrl", partner_type AS "partnerType",
                description, website_url AS "websiteUrl", sort_order AS "sortOrder",
                is_published AS "isPublished"
    `;
    const values = [
      id,
      name,
      normalizedLogoUrl || null,
      partnerType,
      description || null,
      websiteUrl || null,
      typeof sortOrder === 'number' ? sortOrder : null,
      Boolean(isPublished)
    ];

    const { rows } = await pool.query(insert, values);
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Error creating partner', error);
    res.status(500).json({ error: 'Unable to create partner' });
  }
});

app.put('/api/partners/:id', async (req, res) => {
  if (!ensurePool(res)) {
    return;
  }

  const { id } = req.params;
  const { name, logoUrl, partnerType, description, websiteUrl, sortOrder, isPublished } = req.body;

  if (partnerType !== undefined && !['generale', 'patrocinio', 'collaborazione'].includes(partnerType)) {
    return res.status(400).json({ error: 'Partner type must be "generale", "patrocinio", or "collaborazione"' });
  }

  // Normalizza URL del logo (converte GitHub blob in raw)
  const normalizedLogoUrl = logoUrl !== undefined ? normalizeImageUrl(logoUrl) : undefined;

  try {
    const updateFields = {
      name,
      logo_url: normalizedLogoUrl,
      partner_type: partnerType,
      description,
      website_url: websiteUrl,
      sort_order: sortOrder,
      is_published: typeof isPublished === 'boolean' ? isPublished : undefined
    };

    const { query, values } = buildUpdateQuery('partners', updateFields, id);
    const { rows } = await pool.query(query, values);

    if (!rows.length) {
      return res.status(404).json({ error: 'Partner not found' });
    }

    const row = rows[0];
    res.json({
      id: row.id,
      name: row.name,
      logoUrl: row.logo_url,
      partnerType: row.partner_type,
      description: row.description,
      websiteUrl: row.website_url,
      sortOrder: row.sort_order,
      isPublished: row.is_published
    });
  } catch (error) {
    console.error('Error updating partner', error);
    res.status(500).json({ error: 'Unable to update partner' });
  }
});

app.delete('/api/partners/:id', async (req, res) => {
  if (!ensurePool(res)) {
    return;
  }

  const { id } = req.params;
  try {
    const { rowCount } = await pool.query('DELETE FROM partners WHERE id = $1', [id]);
    if (!rowCount) {
      return res.status(404).json({ error: 'Partner not found' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting partner', error);
    res.status(500).json({ error: 'Unable to delete partner' });
  }
});

// ============================================
// API MODULI
// ============================================

app.get('/api/modules', async (req, res) => {
  if (!ensurePool(res)) return;

  try {
    const sql = `
      SELECT id, name, description, sort_order AS "sortOrder",
             cfu, ssd, period,
             hours_lectures AS "hoursLectures",
             hours_lab AS "hoursLab",
             hours_study AS "hoursStudy",
             description_short AS "descriptionShort",
             contents_main AS "contentsMain",
             contents_detailed AS "contentsDetailed",
             learning_objectives AS "learningObjectives",
             evaluation, bibliography,
             schedule_info AS "scheduleInfo",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM modules
      ORDER BY sort_order ASC, created_at ASC
    `;
    const { rows } = await pool.query(sql);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching modules', error);
    res.status(500).json({ error: 'Unable to retrieve modules' });
  }
});

app.get('/api/modules/:id', async (req, res) => {
  if (!ensurePool(res)) return;

  const { id } = req.params;
  try {
    const sql = `
      SELECT id, name, description, sort_order AS "sortOrder",
             cfu, ssd, period,
             hours_lectures AS "hoursLectures",
             hours_lab AS "hoursLab",
             hours_study AS "hoursStudy",
             description_short AS "descriptionShort",
             contents_main AS "contentsMain",
             contents_detailed AS "contentsDetailed",
             learning_objectives AS "learningObjectives",
             evaluation, bibliography,
             schedule_info AS "scheduleInfo",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM modules
      WHERE id = $1
    `;
    const { rows } = await pool.query(sql, [id]);
    if (!rows.length) {
      return res.status(404).json({ error: 'Module not found' });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching module', error);
    res.status(500).json({ error: 'Unable to retrieve module' });
  }
});

app.post('/api/modules', async (req, res) => {
  if (!ensurePool(res)) return;

  const {
    name, description, sortOrder,
    cfu, ssd, period,
    hoursLectures, hoursLab, hoursStudy,
    descriptionShort, contentsMain, contentsDetailed,
    learningObjectives, evaluation, bibliography, scheduleInfo
  } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }

  try {
    const id = uuidv4();
    const insert = `
      INSERT INTO modules (
        id, name, description, sort_order,
        cfu, ssd, period,
        hours_lectures, hours_lab, hours_study,
        description_short, contents_main, contents_detailed,
        learning_objectives, evaluation, bibliography, schedule_info
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING id, name, description, sort_order AS "sortOrder",
                cfu, ssd, period,
                hours_lectures AS "hoursLectures",
                hours_lab AS "hoursLab",
                hours_study AS "hoursStudy",
                description_short AS "descriptionShort",
                contents_main AS "contentsMain",
                contents_detailed AS "contentsDetailed",
                learning_objectives AS "learningObjectives",
                evaluation, bibliography,
                schedule_info AS "scheduleInfo",
                created_at AS "createdAt", updated_at AS "updatedAt"
    `;
    const values = [
      id,
      name,
      description || null,
      typeof sortOrder === 'number' ? sortOrder : null,
      typeof cfu === 'number' ? cfu : null,
      ssd || null,
      period || null,
      typeof hoursLectures === 'number' ? hoursLectures : null,
      typeof hoursLab === 'number' ? hoursLab : null,
      typeof hoursStudy === 'number' ? hoursStudy : null,
      descriptionShort || null,
      contentsMain || null,
      contentsDetailed || null,
      learningObjectives || null,
      evaluation || null,
      bibliography || null,
      scheduleInfo || null
    ];
    const { rows } = await pool.query(insert, values);
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Error creating module', error);
    res.status(500).json({ error: 'Unable to create module' });
  }
});

app.put('/api/modules/:id', async (req, res) => {
  if (!ensurePool(res)) return;

  const { id } = req.params;
  const {
    name, description, sortOrder,
    cfu, ssd, period,
    hoursLectures, hoursLab, hoursStudy,
    descriptionShort, contentsMain, contentsDetailed,
    learningObjectives, evaluation, bibliography, scheduleInfo
  } = req.body;

  try {
    const updateFields = {
      name,
      description,
      sort_order: sortOrder,
      cfu: typeof cfu === 'number' ? cfu : cfu,
      ssd,
      period,
      hours_lectures: hoursLectures,
      hours_lab: hoursLab,
      hours_study: hoursStudy,
      description_short: descriptionShort,
      contents_main: contentsMain,
      contents_detailed: contentsDetailed,
      learning_objectives: learningObjectives,
      evaluation,
      bibliography,
      schedule_info: scheduleInfo
    };
    const { query, values } = buildUpdateQuery('modules', updateFields, id);
    const { rows } = await pool.query(query, values);

    if (!rows.length) {
      return res.status(404).json({ error: 'Module not found' });
    }

    const row = rows[0];
    res.json({
      id: row.id,
      name: row.name,
      description: row.description,
      sortOrder: row.sort_order,
      cfu: row.cfu,
      ssd: row.ssd,
      period: row.period,
      hoursLectures: row.hours_lectures,
      hoursLab: row.hours_lab,
      hoursStudy: row.hours_study,
      descriptionShort: row.description_short,
      contentsMain: row.contents_main,
      contentsDetailed: row.contents_detailed,
      learningObjectives: row.learning_objectives,
      evaluation: row.evaluation,
      bibliography: row.bibliography,
      scheduleInfo: row.schedule_info,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  } catch (error) {
    console.error('Error updating module', error);
    res.status(500).json({ error: 'Unable to update module' });
  }
});

app.delete('/api/modules/:id', async (req, res) => {
  if (!ensurePool(res)) return;

  const { id } = req.params;
  try {
    const { rowCount } = await pool.query('DELETE FROM modules WHERE id = $1', [id]);
    if (!rowCount) {
      return res.status(404).json({ error: 'Module not found' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting module', error);
    res.status(500).json({ error: 'Unable to delete module' });
  }
});

// ============================================
// API LEZIONI
// ============================================

app.get('/api/lessons', async (req, res) => {
  if (!ensurePool(res)) return;

  try {
    const { module_id, teacher_id, month, year, status } = req.query;
    const filters = [];
    const values = [];

    if (module_id) {
      filters.push(`l.module_id = $${filters.length + 1}`);
      values.push(module_id);
    }

    if (teacher_id) {
      filters.push(`l.teacher_id = $${filters.length + 1}`);
      values.push(teacher_id);
    }

    if (status) {
      filters.push(`l.status = $${filters.length + 1}`);
      values.push(status);
    }

    if (month && year) {
      filters.push(`EXTRACT(MONTH FROM l.start_datetime) = $${filters.length + 1}`);
      values.push(parseInt(month));
      filters.push(`EXTRACT(YEAR FROM l.start_datetime) = $${filters.length + 1}`);
      values.push(parseInt(year));
    } else if (year) {
      filters.push(`EXTRACT(YEAR FROM l.start_datetime) = $${filters.length + 1}`);
      values.push(parseInt(year));
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const sql = `
      SELECT l.id, l.title, l.description, l.start_datetime AS "startDatetime",
             l.end_datetime AS "endDatetime", l.duration_minutes AS "durationMinutes",
             l.location_physical AS "locationPhysical", l.location_remote AS "locationRemote",
             l.status, l.notes, l.created_at AS "createdAt", l.updated_at AS "updatedAt",
             l.module_id AS "moduleId", m.name AS "moduleName",
             l.teacher_id AS "teacherId", f.name AS "teacherName"
      FROM lessons l
      LEFT JOIN modules m ON l.module_id = m.id
      LEFT JOIN faculty f ON l.teacher_id = f.id
      ${where}
      ORDER BY l.start_datetime ASC
    `;

    const { rows } = await pool.query(sql, values);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching lessons', error);
    res.status(500).json({ error: 'Unable to retrieve lessons' });
  }
});

app.get('/api/lessons/:id', async (req, res) => {
  if (!ensurePool(res)) return;

  const { id } = req.params;
  try {
    const sql = `
      SELECT l.id, l.title, l.description, l.start_datetime AS "startDatetime",
             l.end_datetime AS "endDatetime", l.duration_minutes AS "durationMinutes",
             l.location_physical AS "locationPhysical", l.location_remote AS "locationRemote",
             l.status, l.notes, l.created_at AS "createdAt", l.updated_at AS "updatedAt",
             l.module_id AS "moduleId", m.name AS "moduleName",
             l.teacher_id AS "teacherId", f.name AS "teacherName"
      FROM lessons l
      LEFT JOIN modules m ON l.module_id = m.id
      LEFT JOIN faculty f ON l.teacher_id = f.id
      WHERE l.id = $1
    `;
    const { rows } = await pool.query(sql, [id]);
    if (!rows.length) {
      return res.status(404).json({ error: 'Lesson not found' });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching lesson', error);
    res.status(500).json({ error: 'Unable to retrieve lesson' });
  }
});

app.post('/api/lessons', async (req, res) => {
  if (!ensurePool(res)) return;

  const {
    title, description, startDatetime, endDatetime, durationMinutes,
    locationPhysical, locationRemote, status, notes, moduleId, teacherId
  } = req.body;

  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }

  if (!startDatetime) {
    return res.status(400).json({ error: 'Start datetime is required' });
  }

  try {
    const id = uuidv4();
    const insert = `
      INSERT INTO lessons (id, title, description, start_datetime, end_datetime, duration_minutes,
                          location_physical, location_remote, status, notes, module_id, teacher_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id, title, description, start_datetime AS "startDatetime",
                end_datetime AS "endDatetime", duration_minutes AS "durationMinutes",
                location_physical AS "locationPhysical", location_remote AS "locationRemote",
                status, notes, module_id AS "moduleId", teacher_id AS "teacherId",
                created_at AS "createdAt", updated_at AS "updatedAt"
    `;

    const values = [
      id,
      title,
      description || null,
      new Date(startDatetime),
      endDatetime ? new Date(endDatetime) : null,
      typeof durationMinutes === 'number' ? durationMinutes : 120,
      locationPhysical || null,
      locationRemote || null,
      status || 'draft',
      notes || null,
      moduleId || null,
      teacherId || null
    ];

    const { rows } = await pool.query(insert, values);
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Error creating lesson', error);
    res.status(500).json({ error: 'Unable to create lesson' });
  }
});

app.put('/api/lessons/:id', async (req, res) => {
  if (!ensurePool(res)) return;

  const { id } = req.params;
  const {
    title, description, startDatetime, endDatetime, durationMinutes,
    locationPhysical, locationRemote, status, notes, moduleId, teacherId
  } = req.body;

  try {
    const updateFields = {
      title,
      description,
      start_datetime: startDatetime ? new Date(startDatetime) : undefined,
      end_datetime: endDatetime === undefined ? undefined : endDatetime ? new Date(endDatetime) : null,
      duration_minutes: durationMinutes,
      location_physical: locationPhysical,
      location_remote: locationRemote,
      status,
      notes,
      module_id: moduleId,
      teacher_id: teacherId
    };

    const { query, values } = buildUpdateQuery('lessons', updateFields, id);
    const { rows } = await pool.query(query, values);

    if (!rows.length) {
      return res.status(404).json({ error: 'Lesson not found' });
    }

    const row = rows[0];
    res.json({
      id: row.id,
      title: row.title,
      description: row.description,
      startDatetime: row.start_datetime,
      endDatetime: row.end_datetime,
      durationMinutes: row.duration_minutes,
      locationPhysical: row.location_physical,
      locationRemote: row.location_remote,
      status: row.status,
      notes: row.notes,
      moduleId: row.module_id,
      teacherId: row.teacher_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  } catch (error) {
    console.error('Error updating lesson', error);
    res.status(500).json({ error: 'Unable to update lesson' });
  }
});

app.delete('/api/lessons/:id', async (req, res) => {
  if (!ensurePool(res)) return;

  const { id } = req.params;
  try {
    const { rowCount } = await pool.query('DELETE FROM lessons WHERE id = $1', [id]);
    if (!rowCount) {
      return res.status(404).json({ error: 'Lesson not found' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting lesson', error);
    res.status(500).json({ error: 'Unable to delete lesson' });
  }
});

app.get('*', (req, res) => {
  const filePath = path.join(staticRoot, req.path);
  res.sendFile(filePath, (err) => {
    if (err) {
      res.status(404).send('Not found');
    }
  });
});

async function handler(req, res) {
  try {
    await ensureDatabaseInitialized();
  } catch (error) {
    console.error('Failed to initialise database', error);
    res.status(500).json({ error: 'Failed to initialise database connection' });
    return;
  }

  return app(req, res);
}

if (require.main === module) {
  ensureDatabaseInitialized()
    .catch((error) => {
      console.error('Failed to initialise database', error);
      process.exit(1);
    })
    .then(() => {
      app.listen(port, () => {
        console.log(`Server running on http://localhost:${port}`);
      });
    });
}

module.exports = handler;
module.exports.app = app;
