require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const app = express();
const port = process.env.PORT || 3000;

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);

// ============================================
// AUTENTICAZIONE ADMIN
// ============================================
const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;
const JWT_SECRET = process.env.JWT_SECRET || (ADMIN_PASSWORD ? crypto.randomBytes(32).toString('hex') : null);

function generateToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifyToken(token) {
  try {
    const [header, body, signature] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    if (signature !== expected) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function requireAdmin(req, res, next) {
  // Se ADMIN_PASSWORD non è configurata, l'admin è disabilitato (503)
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ error: 'Admin authentication not configured. Set ADMIN_PASSWORD environment variable.' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.slice(7);
  const payload = verifyToken(token);
  if (!payload || payload.role !== 'admin') {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  next();
}

function requireStudent(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.slice(7);
  const payload = verifyToken(token);
  if (!payload || !['student', 'teacher', 'admin'].includes(payload.role)) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = payload;
  next();
}

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

// ============================================
// AUTH ENDPOINTS
// ============================================

// Controlla se l'autenticazione è richiesta
app.get('/api/auth/status', (_req, res) => {
  res.json({ authRequired: Boolean(ADMIN_PASSWORD) });
});

// Login admin
app.post('/api/auth/login', (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ error: 'Admin authentication not configured. Set ADMIN_PASSWORD environment variable.' });
  }

  const { password } = req.body;
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Password non valida' });
  }

  const token = generateToken({ role: 'admin' });
  res.json({ token, expiresIn: 86400 });
});

// Verifica token
app.get('/api/auth/verify', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ valid: false });
  }

  const payload = verifyToken(authHeader.slice(7));
  if (!payload) {
    return res.status(401).json({ valid: false });
  }

  res.json({ valid: true, role: payload.role });
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

  // Aggiunge colonna per docente esterno (non nel sistema)
  await pool.query(`
    ALTER TABLE lessons
    ADD COLUMN IF NOT EXISTS external_teacher_name TEXT;
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

  // ============================================
  // MIGRAZIONI SQL DA db/migrations/
  // ============================================
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      executed_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  const migrationsDir = path.join(__dirname, 'db', 'migrations');
  if (fs.existsSync(migrationsDir)) {
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    const { rows: executed } = await pool.query('SELECT filename FROM _migrations');
    const executedSet = new Set(executed.map(r => r.filename));

    for (const file of files) {
      if (executedSet.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      console.log(`Running migration: ${file}`);
      await pool.query(sql);
      await pool.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
      console.log(`Migration completed: ${file}`);
    }
  }
}

let initPromise = null;

async function ensureDatabaseInitialized() {
  if (!hasDatabaseUrl) {
    return;
  }

  if (!initPromise) {
    initPromise = (async () => {
      const maxRetries = 3;
      let lastError;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await initDatabase();
          return;
        } catch (error) {
          lastError = error;
          console.warn(`Database init attempt ${attempt}/${maxRetries} failed:`, error.message);
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 500 * attempt));
          }
        }
      }
      initPromise = null;
      throw lastError;
    })();
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

app.post('/api/faculty', requireAdmin, async (req, res) => {
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

app.put('/api/faculty/:id', requireAdmin, async (req, res) => {
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

app.delete('/api/faculty/:id', requireAdmin, async (req, res) => {
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

app.post('/api/blog-posts', requireAdmin, async (req, res) => {
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

app.put('/api/blog-posts/:id', requireAdmin, async (req, res) => {
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

app.delete('/api/blog-posts/:id', requireAdmin, async (req, res) => {
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

app.post('/api/partners', requireAdmin, async (req, res) => {
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

app.put('/api/partners/:id', requireAdmin, async (req, res) => {
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

app.delete('/api/partners/:id', requireAdmin, async (req, res) => {
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

app.post('/api/modules', requireAdmin, async (req, res) => {
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

app.put('/api/modules/:id', requireAdmin, async (req, res) => {
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

app.delete('/api/modules/:id', requireAdmin, async (req, res) => {
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
             l.teacher_id AS "teacherId", f.name AS "teacherName",
             l.external_teacher_name AS "externalTeacherName"
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
             l.teacher_id AS "teacherId", f.name AS "teacherName",
             l.external_teacher_name AS "externalTeacherName"
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

app.post('/api/lessons', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;

  const {
    title, description, startDatetime, endDatetime, durationMinutes,
    locationPhysical, locationRemote, status, notes, moduleId, teacherId, externalTeacherName
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
                          location_physical, location_remote, status, notes, module_id, teacher_id, external_teacher_name)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id, title, description, start_datetime AS "startDatetime",
                end_datetime AS "endDatetime", duration_minutes AS "durationMinutes",
                location_physical AS "locationPhysical", location_remote AS "locationRemote",
                status, notes, module_id AS "moduleId", teacher_id AS "teacherId",
                external_teacher_name AS "externalTeacherName",
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
      teacherId || null,
      externalTeacherName || null
    ];

    const { rows } = await pool.query(insert, values);
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Error creating lesson', error);
    res.status(500).json({ error: 'Unable to create lesson' });
  }
});

app.put('/api/lessons/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;

  const { id } = req.params;
  const {
    title, description, startDatetime, endDatetime, durationMinutes,
    locationPhysical, locationRemote, status, notes, moduleId, teacherId, externalTeacherName
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
      teacher_id: teacherId,
      external_teacher_name: externalTeacherName
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
      externalTeacherName: row.external_teacher_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  } catch (error) {
    console.error('Error updating lesson', error);
    res.status(500).json({ error: 'Unable to update lesson' });
  }
});

app.delete('/api/lessons/:id', requireAdmin, async (req, res) => {
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

// ============================================
// LMS CORE API
// ============================================

// --- COURSES ---

app.get('/api/lms/courses', async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT id, title, slug, description, cover_image_url AS "coverImageUrl",
             is_published AS "isPublished", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM courses
      ORDER BY created_at DESC
    `);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching courses', error);
    res.status(500).json({ error: 'Unable to retrieve courses' });
  }
});

app.get('/api/lms/courses/:id', async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT id, title, slug, description, cover_image_url AS "coverImageUrl",
             is_published AS "isPublished", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM courses WHERE id = $1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Course not found' });
    res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching course', error);
    res.status(500).json({ error: 'Unable to retrieve course' });
  }
});

app.post('/api/lms/courses', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { title, slug, description, coverImageUrl, isPublished } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  try {
    const id = uuidv4();
    const { rows } = await pool.query(`
      INSERT INTO courses (id, title, slug, description, cover_image_url, is_published)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, title, slug, description, cover_image_url AS "coverImageUrl",
                is_published AS "isPublished", created_at AS "createdAt", updated_at AS "updatedAt"
    `, [id, title, slug || null, description || null, coverImageUrl || null, Boolean(isPublished)]);
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Error creating course', error);
    res.status(500).json({ error: 'Unable to create course' });
  }
});

app.put('/api/lms/courses/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { title, slug, description, coverImageUrl, isPublished } = req.body;
  try {
    const { query, values } = buildUpdateQuery('courses', {
      title, slug, description,
      cover_image_url: coverImageUrl,
      is_published: typeof isPublished === 'boolean' ? isPublished : undefined
    }, req.params.id);
    const { rows } = await pool.query(query, values);
    if (!rows.length) return res.status(404).json({ error: 'Course not found' });
    const r = rows[0];
    res.json({
      id: r.id, title: r.title, slug: r.slug, description: r.description,
      coverImageUrl: r.cover_image_url, isPublished: r.is_published,
      createdAt: r.created_at, updatedAt: r.updated_at
    });
  } catch (error) {
    console.error('Error updating course', error);
    res.status(500).json({ error: 'Unable to update course' });
  }
});

app.delete('/api/lms/courses/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rowCount } = await pool.query('DELETE FROM courses WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Course not found' });
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting course', error);
    res.status(500).json({ error: 'Unable to delete course' });
  }
});

// --- COURSE EDITIONS ---

app.get('/api/lms/course-editions', async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { courseId } = req.query;
    const filters = [];
    const values = [];
    if (courseId) {
      filters.push(`course_id = $${filters.length + 1}`);
      values.push(courseId);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const { rows } = await pool.query(`
      SELECT id, course_id AS "courseId", edition_name AS "editionName",
             start_date AS "startDate", end_date AS "endDate",
             max_students AS "maxStudents", is_active AS "isActive",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM course_editions ${where}
      ORDER BY start_date DESC NULLS LAST, created_at DESC
    `, values);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching course editions', error);
    res.status(500).json({ error: 'Unable to retrieve course editions' });
  }
});

app.get('/api/lms/course-editions/:id', async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT id, course_id AS "courseId", edition_name AS "editionName",
             start_date AS "startDate", end_date AS "endDate",
             max_students AS "maxStudents", is_active AS "isActive",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM course_editions WHERE id = $1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Course edition not found' });
    res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching course edition', error);
    res.status(500).json({ error: 'Unable to retrieve course edition' });
  }
});

app.post('/api/lms/course-editions', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { courseId, editionName, startDate, endDate, maxStudents, isActive } = req.body;
  if (!courseId || !editionName) return res.status(400).json({ error: 'courseId and editionName are required' });
  try {
    const id = uuidv4();
    const { rows } = await pool.query(`
      INSERT INTO course_editions (id, course_id, edition_name, start_date, end_date, max_students, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, course_id AS "courseId", edition_name AS "editionName",
                start_date AS "startDate", end_date AS "endDate",
                max_students AS "maxStudents", is_active AS "isActive",
                created_at AS "createdAt", updated_at AS "updatedAt"
    `, [id, courseId, editionName, startDate || null, endDate || null, maxStudents || null, isActive !== false]);
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Error creating course edition', error);
    res.status(500).json({ error: 'Unable to create course edition' });
  }
});

app.put('/api/lms/course-editions/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { courseId, editionName, startDate, endDate, maxStudents, isActive } = req.body;
  try {
    const { query, values } = buildUpdateQuery('course_editions', {
      course_id: courseId, edition_name: editionName,
      start_date: startDate, end_date: endDate,
      max_students: maxStudents,
      is_active: typeof isActive === 'boolean' ? isActive : undefined
    }, req.params.id);
    const { rows } = await pool.query(query, values);
    if (!rows.length) return res.status(404).json({ error: 'Course edition not found' });
    const r = rows[0];
    res.json({
      id: r.id, courseId: r.course_id, editionName: r.edition_name,
      startDate: r.start_date, endDate: r.end_date,
      maxStudents: r.max_students, isActive: r.is_active,
      createdAt: r.created_at, updatedAt: r.updated_at
    });
  } catch (error) {
    console.error('Error updating course edition', error);
    res.status(500).json({ error: 'Unable to update course edition' });
  }
});

app.delete('/api/lms/course-editions/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rowCount } = await pool.query('DELETE FROM course_editions WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Course edition not found' });
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting course edition', error);
    res.status(500).json({ error: 'Unable to delete course edition' });
  }
});

// --- LMS MODULES ---

app.get('/api/lms/modules', async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { courseId } = req.query;
    const filters = [];
    const values = [];
    if (courseId) {
      filters.push(`course_id = $${filters.length + 1}`);
      values.push(courseId);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const { rows } = await pool.query(`
      SELECT id, course_id AS "courseId", title, description,
             sort_order AS "sortOrder", is_published AS "isPublished",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM lms_modules ${where}
      ORDER BY sort_order ASC, created_at ASC
    `, values);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching LMS modules', error);
    res.status(500).json({ error: 'Unable to retrieve LMS modules' });
  }
});

app.get('/api/lms/modules/:id', async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT id, course_id AS "courseId", title, description,
             sort_order AS "sortOrder", is_published AS "isPublished",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM lms_modules WHERE id = $1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Module not found' });
    res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching LMS module', error);
    res.status(500).json({ error: 'Unable to retrieve LMS module' });
  }
});

app.post('/api/lms/modules', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { courseId, title, description, sortOrder, isPublished } = req.body;
  if (!courseId || !title) return res.status(400).json({ error: 'courseId and title are required' });
  try {
    const id = uuidv4();
    const { rows } = await pool.query(`
      INSERT INTO lms_modules (id, course_id, title, description, sort_order, is_published)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, course_id AS "courseId", title, description,
                sort_order AS "sortOrder", is_published AS "isPublished",
                created_at AS "createdAt", updated_at AS "updatedAt"
    `, [id, courseId, title, description || null, typeof sortOrder === 'number' ? sortOrder : 0, isPublished !== false]);
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Error creating LMS module', error);
    res.status(500).json({ error: 'Unable to create LMS module' });
  }
});

app.put('/api/lms/modules/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { courseId, title, description, sortOrder, isPublished } = req.body;
  try {
    const { query, values } = buildUpdateQuery('lms_modules', {
      course_id: courseId, title, description,
      sort_order: sortOrder,
      is_published: typeof isPublished === 'boolean' ? isPublished : undefined
    }, req.params.id);
    const { rows } = await pool.query(query, values);
    if (!rows.length) return res.status(404).json({ error: 'Module not found' });
    const r = rows[0];
    res.json({
      id: r.id, courseId: r.course_id, title: r.title, description: r.description,
      sortOrder: r.sort_order, isPublished: r.is_published,
      createdAt: r.created_at, updatedAt: r.updated_at
    });
  } catch (error) {
    console.error('Error updating LMS module', error);
    res.status(500).json({ error: 'Unable to update LMS module' });
  }
});

app.delete('/api/lms/modules/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rowCount } = await pool.query('DELETE FROM lms_modules WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Module not found' });
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting LMS module', error);
    res.status(500).json({ error: 'Unable to delete LMS module' });
  }
});

// --- LMS LESSONS ---

app.get('/api/lms/lessons', async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { moduleId } = req.query;
    const filters = [];
    const values = [];
    if (moduleId) {
      filters.push(`lms_module_id = $${filters.length + 1}`);
      values.push(moduleId);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const { rows } = await pool.query(`
      SELECT id, lms_module_id AS "moduleId", title, description,
             video_url AS "videoUrl", video_provider AS "videoProvider",
             duration_seconds AS "durationSeconds", sort_order AS "sortOrder",
             is_free AS "isFree", is_published AS "isPublished",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM lms_lessons ${where}
      ORDER BY sort_order ASC, created_at ASC
    `, values);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching LMS lessons', error);
    res.status(500).json({ error: 'Unable to retrieve LMS lessons' });
  }
});

app.get('/api/lms/lessons/:id', async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT id, lms_module_id AS "moduleId", title, description,
             video_url AS "videoUrl", video_provider AS "videoProvider",
             duration_seconds AS "durationSeconds", sort_order AS "sortOrder",
             is_free AS "isFree", is_published AS "isPublished",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM lms_lessons WHERE id = $1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Lesson not found' });
    res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching LMS lesson', error);
    res.status(500).json({ error: 'Unable to retrieve LMS lesson' });
  }
});

app.post('/api/lms/lessons', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { moduleId, title, description, videoUrl, videoProvider, durationSeconds, sortOrder, isFree, isPublished } = req.body;
  if (!moduleId || !title) return res.status(400).json({ error: 'moduleId and title are required' });
  try {
    const id = uuidv4();
    const { rows } = await pool.query(`
      INSERT INTO lms_lessons (id, lms_module_id, title, description, video_url, video_provider, duration_seconds, sort_order, is_free, is_published)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, lms_module_id AS "moduleId", title, description,
                video_url AS "videoUrl", video_provider AS "videoProvider",
                duration_seconds AS "durationSeconds", sort_order AS "sortOrder",
                is_free AS "isFree", is_published AS "isPublished",
                created_at AS "createdAt", updated_at AS "updatedAt"
    `, [id, moduleId, title, description || null, videoUrl || null, videoProvider || null,
        durationSeconds || null, typeof sortOrder === 'number' ? sortOrder : 0, Boolean(isFree), isPublished !== false]);
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Error creating LMS lesson', error);
    res.status(500).json({ error: 'Unable to create LMS lesson' });
  }
});

app.put('/api/lms/lessons/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { moduleId, title, description, videoUrl, videoProvider, durationSeconds, sortOrder, isFree, isPublished } = req.body;
  try {
    const { query, values } = buildUpdateQuery('lms_lessons', {
      lms_module_id: moduleId, title, description,
      video_url: videoUrl, video_provider: videoProvider,
      duration_seconds: durationSeconds, sort_order: sortOrder,
      is_free: typeof isFree === 'boolean' ? isFree : undefined,
      is_published: typeof isPublished === 'boolean' ? isPublished : undefined
    }, req.params.id);
    const { rows } = await pool.query(query, values);
    if (!rows.length) return res.status(404).json({ error: 'Lesson not found' });
    const r = rows[0];
    res.json({
      id: r.id, moduleId: r.lms_module_id, title: r.title, description: r.description,
      videoUrl: r.video_url, videoProvider: r.video_provider,
      durationSeconds: r.duration_seconds, sortOrder: r.sort_order,
      isFree: r.is_free, isPublished: r.is_published,
      createdAt: r.created_at, updatedAt: r.updated_at
    });
  } catch (error) {
    console.error('Error updating LMS lesson', error);
    res.status(500).json({ error: 'Unable to update LMS lesson' });
  }
});

app.delete('/api/lms/lessons/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rowCount } = await pool.query('DELETE FROM lms_lessons WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Lesson not found' });
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting LMS lesson', error);
    res.status(500).json({ error: 'Unable to delete LMS lesson' });
  }
});

// --- LESSON ASSETS ---

app.get('/api/lms/lesson-assets', async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { lessonId } = req.query;
    const filters = [];
    const values = [];
    if (lessonId) {
      filters.push(`lms_lesson_id = $${filters.length + 1}`);
      values.push(lessonId);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const { rows } = await pool.query(`
      SELECT id, lms_lesson_id AS "lessonId", title, asset_type AS "assetType",
             url, sort_order AS "sortOrder", created_at AS "createdAt"
      FROM lesson_assets ${where}
      ORDER BY sort_order ASC, created_at ASC
    `, values);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching lesson assets', error);
    res.status(500).json({ error: 'Unable to retrieve lesson assets' });
  }
});

app.post('/api/lms/lesson-assets', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { lessonId, title, assetType, url, sortOrder } = req.body;
  if (!lessonId || !title || !assetType || !url) {
    return res.status(400).json({ error: 'lessonId, title, assetType and url are required' });
  }
  try {
    const id = uuidv4();
    const { rows } = await pool.query(`
      INSERT INTO lesson_assets (id, lms_lesson_id, title, asset_type, url, sort_order)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, lms_lesson_id AS "lessonId", title, asset_type AS "assetType",
                url, sort_order AS "sortOrder", created_at AS "createdAt"
    `, [id, lessonId, title, assetType, url, typeof sortOrder === 'number' ? sortOrder : 0]);
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Error creating lesson asset', error);
    res.status(500).json({ error: 'Unable to create lesson asset' });
  }
});

app.delete('/api/lms/lesson-assets/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rowCount } = await pool.query('DELETE FROM lesson_assets WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Lesson asset not found' });
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting lesson asset', error);
    res.status(500).json({ error: 'Unable to delete lesson asset' });
  }
});

// --- ENROLLMENTS ---

app.post('/api/lms/enrollments/bulk', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const items = req.body;
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'Request body must be a non-empty array of {email, courseEditionId, role}' });
  }
  try {
    const results = [];
    for (const item of items) {
      const { email, courseEditionId, role } = item;
      if (!email || !courseEditionId) {
        results.push({ email, error: 'email and courseEditionId are required' });
        continue;
      }
      // Find or create user
      let userId;
      const { rows: existingUsers } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
      if (existingUsers.length) {
        userId = existingUsers[0].id;
        // Update role if provided
        if (role) {
          await pool.query('UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2', [role, userId]);
        }
      } else {
        // Create user with a random password hash (they'll reset it)
        const newId = uuidv4();
        const placeholderHash = crypto.randomBytes(32).toString('hex');
        await pool.query(`
          INSERT INTO users (id, email, password_hash, first_name, last_name, role)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [newId, email, placeholderHash, '', '', role || 'student']);
        userId = newId;
      }
      // Enroll
      const enrollId = uuidv4();
      const { rows: enrolled } = await pool.query(`
        INSERT INTO enrollments (id, user_id, course_edition_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id, course_edition_id) DO NOTHING
        RETURNING id, user_id AS "userId", course_edition_id AS "courseEditionId",
                  status, enrolled_at AS "enrolledAt"
      `, [enrollId, userId, courseEditionId]);
      if (enrolled.length) {
        results.push({ email, ...enrolled[0] });
      } else {
        results.push({ email, skipped: true, reason: 'already enrolled' });
      }
    }
    res.status(201).json(results);
  } catch (error) {
    console.error('Error bulk enrolling', error);
    res.status(500).json({ error: 'Unable to process enrollments' });
  }
});

app.get('/api/lms/enrollments', async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { courseEditionId } = req.query;
    if (!courseEditionId) return res.status(400).json({ error: 'courseEditionId query parameter is required' });
    const { rows } = await pool.query(`
      SELECT e.id, e.user_id AS "userId", e.course_edition_id AS "courseEditionId",
             e.status, e.enrolled_at AS "enrolledAt", e.completed_at AS "completedAt",
             u.email, u.first_name AS "firstName", u.last_name AS "lastName", u.role
      FROM enrollments e
      JOIN users u ON u.id = e.user_id
      WHERE e.course_edition_id = $1
      ORDER BY e.enrolled_at ASC
    `, [courseEditionId]);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching enrollments', error);
    res.status(500).json({ error: 'Unable to retrieve enrollments' });
  }
});

// ============================================
// STUDENT AUTH & API
// ============================================

// Magic link login - genera token e stampa link nel log
app.post('/api/auth/magic-link', async (req, res) => {
  if (!ensurePool(res)) return;
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    const { rows } = await pool.query('SELECT id, role, is_active FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    if (!rows.length) {
      // Non rivelare se l'utente esiste o meno
      return res.json({ message: 'Se l\'indirizzo email è registrato, riceverai un link di accesso.' });
    }
    const user = rows[0];
    if (!user.is_active) {
      return res.json({ message: 'Se l\'indirizzo email è registrato, riceverai un link di accesso.' });
    }

    // Genera token casuale
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minuti

    await pool.query(
      'UPDATE users SET token_hash = $1, token_expires_at = $2, updated_at = NOW() WHERE id = $3',
      [tokenHash, expiresAt, user.id]
    );

    const baseUrl = req.protocol + '://' + req.get('host');
    const magicLink = `${baseUrl}/api/auth/verify-magic/${rawToken}`;

    // Invio email con Resend
    if (RESEND_API_KEY) {
      const fromEmail = process.env.RESEND_FROM || 'Carbon Farming Master <onboarding@resend.dev>';
      try {
        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: fromEmail,
            to: [email.trim().toLowerCase()],
            subject: 'Accedi al Master Carbon Farming',
            html: `
              <div style="font-family: 'Inter', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
                <div style="text-align: center; margin-bottom: 30px;">
                  <h2 style="color: #2c7a4b; margin: 0;">Master Carbon Farming</h2>
                  <p style="color: #666; font-size: 14px;">Università della Tuscia</p>
                </div>
                <div style="background: #f9fafb; border-radius: 12px; padding: 30px; text-align: center;">
                  <p style="font-size: 16px; color: #333; margin-bottom: 20px;">
                    Clicca il pulsante qui sotto per accedere alla piattaforma:
                  </p>
                  <a href="${magicLink}" style="display: inline-block; background: #2c7a4b; color: white; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 16px;">
                    Accedi alla piattaforma
                  </a>
                  <p style="font-size: 13px; color: #999; margin-top: 20px;">
                    Il link è valido per 15 minuti. Se non hai richiesto l'accesso, ignora questa email.
                  </p>
                </div>
                <p style="font-size: 12px; color: #ccc; text-align: center; margin-top: 30px;">
                  Master Universitario di II livello in Carbon Farming — UNITUS Academy
                </p>
              </div>
            `
          })
        });
        const emailResult = await emailRes.json();
        if (!emailRes.ok) {
          console.error('Resend error:', emailResult);
        } else {
          console.log('Magic link email sent to', email, 'id:', emailResult.id);
        }
      } catch (emailErr) {
        console.error('Failed to send magic link email:', emailErr);
      }
    } else {
      // Fallback: stampa il link nel log (development)
      console.log(`\n========== MAGIC LINK ==========`);
      console.log(`User: ${email}`);
      console.log(`Link: ${magicLink}`);
      console.log(`Expires: ${expiresAt.toISOString()}`);
      console.log(`================================\n`);
    }

    res.json({ message: 'Se l\'indirizzo email è registrato, riceverai un link di accesso.' });
  } catch (error) {
    console.error('Error generating magic link', error);
    res.status(500).json({ error: 'Unable to process request' });
  }
});

// Verifica magic link token e crea sessione JWT
app.get('/api/auth/verify-magic/:token', async (req, res) => {
  if (!pool) return res.status(503).send('Database not configured');

  try {
    const rawToken = req.params.token;
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const { rows } = await pool.query(
      'SELECT id, email, first_name, last_name, role FROM users WHERE token_hash = $1 AND token_expires_at > NOW() AND is_active = true',
      [tokenHash]
    );

    if (!rows.length) {
      return res.status(400).send(`
        <html><body style="font-family: Inter, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f3f4f6;">
          <div style="text-align: center; padding: 40px;">
            <h2>Link scaduto o non valido</h2>
            <p>Richiedi un nuovo link di accesso.</p>
            <a href="/learn/login.html" style="color: #2c7a4b;">Torna al login</a>
          </div>
        </body></html>
      `);
    }

    const user = rows[0];

    // Invalida il token (single-use)
    await pool.query('UPDATE users SET token_hash = NULL, token_expires_at = NULL, last_login_at = NOW(), updated_at = NOW() WHERE id = $1', [user.id]);

    // Genera JWT di sessione
    const jwt = generateToken({
      userId: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      role: user.role
    });

    // Redirect a learn/ con token nel fragment (non va al server)
    res.redirect(`/learn/index.html#token=${jwt}`);
  } catch (error) {
    console.error('Error verifying magic link', error);
    res.status(500).send('Errore interno');
  }
});

// Corsi dello studente loggato
app.get('/api/lms/my-courses', requireStudent, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT c.id, c.title, c.slug, c.description, c.cover_image_url AS "coverImageUrl",
             ce.id AS "editionId", ce.edition_name AS "editionName",
             e.status AS "enrollmentStatus", e.enrolled_at AS "enrolledAt",
             (SELECT COUNT(*)::int FROM lms_modules m WHERE m.course_id = c.id) AS "totalModules",
             (SELECT COUNT(*)::int FROM lms_lessons ll
              JOIN lms_modules m2 ON m2.id = ll.lms_module_id
              WHERE m2.course_id = c.id AND ll.is_published = true) AS "totalLessons",
             (SELECT COUNT(*)::int FROM lesson_progress lp
              JOIN lms_lessons ll2 ON ll2.id = lp.lms_lesson_id
              JOIN lms_modules m3 ON m3.id = ll2.lms_module_id
              WHERE m3.course_id = c.id AND lp.user_id = $1 AND lp.completed_at IS NOT NULL) AS "completedLessons"
      FROM enrollments e
      JOIN course_editions ce ON ce.id = e.course_edition_id
      JOIN courses c ON c.id = ce.course_id
      WHERE e.user_id = $1 AND e.status = 'active'
      ORDER BY e.enrolled_at DESC
    `, [req.user.userId]);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching student courses', error);
    res.status(500).json({ error: 'Unable to retrieve courses' });
  }
});

// Progresso complessivo studente
app.get('/api/lms/my-progress', requireStudent, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    // Lezioni completate e totali per ogni corso
    const { rows: courseProgress } = await pool.query(`
      SELECT c.id AS "courseId", c.title AS "courseTitle",
             COUNT(DISTINCT ll.id) FILTER (WHERE ll.is_published = true) AS "totalLessons",
             COUNT(DISTINCT lp.lms_lesson_id) FILTER (WHERE lp.completed_at IS NOT NULL) AS "completedLessons"
      FROM enrollments e
      JOIN course_editions ce ON ce.id = e.course_edition_id
      JOIN courses c ON c.id = ce.course_id
      LEFT JOIN lms_modules m ON m.course_id = c.id
      LEFT JOIN lms_lessons ll ON ll.lms_module_id = m.id AND ll.is_published = true
      LEFT JOIN lesson_progress lp ON lp.lms_lesson_id = ll.id AND lp.user_id = $1
      WHERE e.user_id = $1 AND e.status = 'active'
      GROUP BY c.id, c.title
    `, [req.user.userId]);

    // Presenze totali
    const { rows: attendanceRows } = await pool.query(
      'SELECT COUNT(*)::int AS total FROM attendance WHERE user_id = $1',
      [req.user.userId]
    );

    res.json({
      courses: courseProgress,
      totalAttendances: attendanceRows[0]?.total || 0
    });
  } catch (error) {
    console.error('Error fetching student progress', error);
    res.status(500).json({ error: 'Unable to retrieve progress' });
  }
});

// Check-in presenze con PIN
app.post('/api/attendance/checkin', requireStudent, async (req, res) => {
  if (!ensurePool(res)) return;
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code is required' });

  try {
    // Trova il codice valido
    const { rows: codes } = await pool.query(
      `SELECT ac.id, ac.lesson_id FROM attendance_codes ac
       WHERE ac.code = $1 AND ac.expires_at > NOW() AND ac.is_used = false
       LIMIT 1`,
      [code.trim()]
    );

    if (!codes.length) {
      return res.status(400).json({ error: 'Codice non valido o scaduto' });
    }

    const lessonId = codes[0].lesson_id;

    // Registra presenza
    const { rows } = await pool.query(`
      INSERT INTO attendance (id, user_id, lesson_id, method)
      VALUES ($1, $2, $3, 'pin')
      ON CONFLICT (user_id, lesson_id) DO NOTHING
      RETURNING id
    `, [uuidv4(), req.user.userId, lessonId]);

    if (rows.length) {
      res.json({ success: true, message: 'Presenza registrata' });
    } else {
      res.json({ success: true, message: 'Presenza già registrata' });
    }
  } catch (error) {
    console.error('Error checking in', error);
    res.status(500).json({ error: 'Unable to process check-in' });
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
