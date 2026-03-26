require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const { put } = require('@vercel/blob');

const app = express();
const port = process.env.PORT || 3000;

// Configurazione multer per upload in memoria (per Vercel Blob)
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.mp3', '.mp4', '.m4a', '.jpg', '.jpeg', '.png', '.gif'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo file non supportato'));
    }
  }
});
const BUILD_VERSION = '2026-03-26-v13'; // Per debug deploy

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: BUILD_VERSION, timestamp: new Date().toISOString() });
});

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

// Whitelist colonne aggiornabili per tabella (sicurezza)
const ALLOWED_UPDATE_FIELDS = {
  faculty: ['name', 'role', 'bio', 'photo_url', 'sort_order', 'is_published'],
  blog_posts: ['title', 'slug', 'content', 'excerpt', 'cover_image_url', 'author', 'is_published', 'published_at'],
  partners: ['name', 'logo_url', 'website_url', 'category', 'sort_order', 'is_visible'],
  modules: ['name', 'ssd', 'cfu', 'hours', 'description', 'sort_order'],
  lessons: ['title', 'module_id', 'teacher_id', 'external_teacher_name', 'start_datetime', 'duration_hours', 'location_physical', 'location_remote', 'status', 'notes'],
  courses: ['title', 'slug', 'description', 'cover_image_url', 'is_published'],
  course_editions: ['name', 'start_date', 'end_date', 'max_students', 'is_active'],
  lms_modules: ['title', 'description', 'sort_order', 'is_published'],
  lms_lessons: ['title', 'description', 'video_url', 'duration_minutes', 'sort_order', 'is_published'],
  quizzes: ['title', 'description', 'passing_score', 'max_attempts', 'time_limit_minutes', 'is_active'],
};

function buildUpdateQuery(table, fields, id) {
  const allowed = ALLOWED_UPDATE_FIELDS[table];
  const entries = Object.entries(fields).filter(([key, value]) => value !== undefined && (!allowed || allowed.includes(key)));
  if (!entries.length) {
    throw new Error('No valid fields provided for update');
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
// API RISORSE
// ============================================

app.get('/api/resources', async (req, res) => {
  if (!ensurePool(res)) return;

  try {
    const { published, type } = req.query;
    const filters = [];
    const values = [];

    if (published !== undefined) {
      filters.push(`is_published = $${filters.length + 1}`);
      values.push(published === 'true');
    }

    if (type !== undefined) {
      filters.push(`resource_type = $${filters.length + 1}`);
      values.push(type);
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const sql = `
      SELECT id, title, description, resource_type AS "resourceType",
             url, thumbnail_url AS "thumbnailUrl", file_size_bytes AS "fileSizeBytes",
             sort_order AS "sortOrder", is_published AS "isPublished",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM resources
      ${where}
      ORDER BY sort_order NULLS LAST, created_at DESC
    `;

    const { rows } = await pool.query(sql, values);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching resources', error);
    res.status(500).json({ error: 'Unable to retrieve resources' });
  }
});

// Get single resource by ID
app.get('/api/resources/:id', async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT id, title, description, resource_type AS "resourceType",
             url, thumbnail_url AS "thumbnailUrl", is_published AS "isPublished"
      FROM resources WHERE id = $1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Resource not found' });
    res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching resource', error);
    res.status(500).json({ error: 'Unable to retrieve resource' });
  }
});

app.post('/api/resources', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;

  const { title, description, resourceType, url, thumbnailUrl, fileSizeBytes, sortOrder, isPublished } = req.body;

  if (!title || !resourceType || !url) {
    return res.status(400).json({ error: 'Title, resourceType, and url are required' });
  }

  if (!['video', 'pdf', 'document', 'audio', 'link', 'quiz'].includes(resourceType)) {
    return res.status(400).json({ error: 'Invalid resource type' });
  }

  try {
    const id = uuidv4();
    const insert = `
      INSERT INTO resources (id, title, description, resource_type, url, thumbnail_url, file_size_bytes, sort_order, is_published)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, title, description, resource_type AS "resourceType",
                url, thumbnail_url AS "thumbnailUrl", file_size_bytes AS "fileSizeBytes",
                sort_order AS "sortOrder", is_published AS "isPublished",
                created_at AS "createdAt", updated_at AS "updatedAt"
    `;
    const values = [
      id,
      title,
      description || null,
      resourceType,
      url,
      thumbnailUrl || null,
      fileSizeBytes || null,
      typeof sortOrder === 'number' ? sortOrder : null,
      Boolean(isPublished)
    ];

    const { rows } = await pool.query(insert, values);
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Error creating resource', error);
    res.status(500).json({ error: 'Unable to create resource' });
  }
});

app.put('/api/resources/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;

  const { id } = req.params;
  const { title, description, resourceType, url, thumbnailUrl, fileSizeBytes, sortOrder, isPublished } = req.body;

  try {
    const update = `
      UPDATE resources
      SET title = COALESCE($2, title),
          description = COALESCE($3, description),
          resource_type = COALESCE($4, resource_type),
          url = COALESCE($5, url),
          thumbnail_url = COALESCE($6, thumbnail_url),
          file_size_bytes = COALESCE($7, file_size_bytes),
          sort_order = COALESCE($8, sort_order),
          is_published = COALESCE($9, is_published),
          updated_at = NOW()
      WHERE id = $1
      RETURNING id, title, description, resource_type AS "resourceType",
                url, thumbnail_url AS "thumbnailUrl", file_size_bytes AS "fileSizeBytes",
                sort_order AS "sortOrder", is_published AS "isPublished",
                created_at AS "createdAt", updated_at AS "updatedAt"
    `;
    const values = [
      id,
      title || null,
      description,
      resourceType || null,
      url || null,
      thumbnailUrl,
      fileSizeBytes,
      typeof sortOrder === 'number' ? sortOrder : null,
      typeof isPublished === 'boolean' ? isPublished : null
    ];

    const { rows } = await pool.query(update, values);
    if (!rows.length) {
      return res.status(404).json({ error: 'Resource not found' });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error('Error updating resource', error);
    res.status(500).json({ error: 'Unable to update resource' });
  }
});

app.delete('/api/resources/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;

  const { id } = req.params;
  try {
    const { rowCount } = await pool.query('DELETE FROM resources WHERE id = $1', [id]);
    if (!rowCount) {
      return res.status(404).json({ error: 'Resource not found' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting resource', error);
    res.status(500).json({ error: 'Unable to delete resource' });
  }
});

// Upload file per risorse
app.post('/api/resources/upload', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nessun file caricato' });
  }

  try {
    // Sanitizza il nome file
    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    
    // Upload su Vercel Blob
    const blob = await put(safeName, req.file.buffer, {
      access: 'public',
      contentType: req.file.mimetype
    });

    res.json({ 
      url: blob.url,
      filename: safeName,
      size: req.file.size,
      mimetype: req.file.mimetype
    });
  } catch (error) {
    console.error('Error uploading to Vercel Blob:', error);
    res.status(500).json({ error: 'Errore durante il caricamento: ' + error.message });
  }
});

// Notifica studenti via email
app.post('/api/resources/notify', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  
  const { subject, message, courseEditionId } = req.body;
  
  if (!subject || !message) {
    return res.status(400).json({ error: 'Oggetto e messaggio sono obbligatori' });
  }

  try {
    // Prendi tutti gli studenti iscritti (attivi) alla course edition
    const editionId = courseEditionId || '563e9876-8a08-4ee7-954a-79a16c39ab53'; // Default Master CF
    
    const { rows: students } = await pool.query(`
      SELECT DISTINCT u.email, u.first_name, u.last_name
      FROM enrollments e
      JOIN users u ON u.id = e.user_id
      WHERE e.course_edition_id = $1 AND e.status = 'active'
    `, [editionId]);

    if (students.length === 0) {
      return res.json({ sent: 0, message: 'Nessuno studente iscritto trovato' });
    }

    // Invia email a ciascuno studente
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    
    let sent = 0;
    let errors = [];

    for (const student of students) {
      try {
        const personalizedMessage = message
          .replace('{nome}', student.first_name || 'Studente')
          .replace('{cognome}', student.last_name || '');

        await resend.emails.send({
          from: process.env.RESEND_FROM || 'Master Carbon Farming <noreply@carbonfarmingmaster.it>',
          to: student.email,
          subject: subject,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <div style="background: linear-gradient(135deg, #166534 0%, #22c55e 100%); padding: 20px; border-radius: 12px 12px 0 0;">
                <h1 style="color: white; margin: 0; font-size: 1.5rem;">🌱 Master Carbon Farming</h1>
              </div>
              <div style="background: #f9fafb; padding: 24px; border-radius: 0 0 12px 12px;">
                <p style="white-space: pre-line; line-height: 1.6;">${personalizedMessage}</p>
                <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
                <p style="color: #6b7280; font-size: 0.875rem;">
                  Università della Tuscia - Master di II livello in Carbon Farming
                </p>
              </div>
            </div>
          `
        });
        sent++;
      } catch (emailError) {
        console.error(`Error sending to ${student.email}:`, emailError);
        errors.push(student.email);
      }
    }

    res.json({ 
      sent, 
      total: students.length,
      errors: errors.length > 0 ? errors : undefined,
      message: `Email inviata a ${sent}/${students.length} studenti`
    });
  } catch (error) {
    console.error('Error notifying students:', error);
    res.status(500).json({ error: 'Errore durante l\'invio delle notifiche' });
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
    const { moduleId, courseId } = req.query;
    const filters = [];
    const values = [];
    if (moduleId) {
      filters.push(`ll.lms_module_id = $${filters.length + 1}`);
      values.push(moduleId);
    }
    if (courseId) {
      filters.push(`m.course_id = $${filters.length + 1}`);
      values.push(courseId);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const needsJoin = courseId;
    const { rows } = await pool.query(`
      SELECT ll.id, ll.lms_module_id AS "moduleId", ll.title, ll.description,
             ll.video_url AS "videoUrl", ll.video_provider AS "videoProvider",
             ll.duration_seconds AS "durationSeconds", ll.sort_order AS "sortOrder",
             ll.is_free AS "isFree", ll.is_published AS "isPublished",
             ll.created_at AS "createdAt", ll.updated_at AS "updatedAt"
      FROM lms_lessons ll
      ${needsJoin ? 'JOIN lms_modules m ON m.id = ll.lms_module_id' : ''}
      ${where}
      ORDER BY ll.sort_order ASC, ll.created_at ASC
    `, values);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching LMS lessons', error);
    res.status(500).json({ error: 'Unable to retrieve LMS lessons' });
  }
});

// Progresso individuale per lezione (usato nella pagina corso) - DEVE essere prima di /lessons/:id
app.get('/api/lms/lessons/progress', requireStudent, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { courseId } = req.query;
    let query = `
      SELECT lp.lms_lesson_id AS "lessonId",
             lp.progress_percent AS "progressPercent",
             lp.completed_at AS "completedAt"
      FROM lesson_progress lp
      WHERE lp.user_id = $1
    `;
    const values = [req.user.userId];
    if (courseId) {
      query += ` AND lp.lms_lesson_id IN (
        SELECT ll.id FROM lms_lessons ll
        JOIN lms_modules m ON m.id = ll.lms_module_id
        WHERE m.course_id = $2
      )`;
      values.push(courseId);
    }
    const { rows } = await pool.query(query, values);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching lesson progress', error);
    res.status(500).json({ error: 'Unable to retrieve lesson progress' });
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
             materials,
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM lms_lessons WHERE id = $1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Lesson not found' });

    const lesson = rows[0];

    // If student is authenticated, include their progress
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const payload = verifyToken(authHeader.slice(7));
      if (payload && payload.userId) {
        const { rows: progressRows } = await pool.query(`
          SELECT progress_percent AS "progressPercent",
                 last_position_seconds AS "lastPositionSeconds",
                 time_spent_seconds AS "timeSpentSeconds",
                 watched_segments AS "watchedSegments",
                 completed_at AS "completedAt"
          FROM lesson_progress
          WHERE user_id = $1 AND lms_lesson_id = $2
        `, [payload.userId, req.params.id]);
        lesson.progress = progressRows[0] || null;
      }
    }

    res.json(lesson);
  } catch (error) {
    console.error('Error fetching LMS lesson', error);
    res.status(500).json({ error: 'Unable to retrieve LMS lesson' });
  }
});

app.post('/api/lms/lessons', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { moduleId, title, description, videoUrl, videoProvider, durationSeconds, sortOrder, isFree, isPublished, materials } = req.body;
  if (!moduleId || !title) return res.status(400).json({ error: 'moduleId and title are required' });
  try {
    const id = uuidv4();
    const { rows } = await pool.query(`
      INSERT INTO lms_lessons (id, lms_module_id, title, description, video_url, video_provider, duration_seconds, sort_order, is_free, is_published, materials)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id, lms_module_id AS "moduleId", title, description,
                video_url AS "videoUrl", video_provider AS "videoProvider",
                duration_seconds AS "durationSeconds", sort_order AS "sortOrder",
                is_free AS "isFree", is_published AS "isPublished",
                materials,
                created_at AS "createdAt", updated_at AS "updatedAt"
    `, [id, moduleId, title, description || null, videoUrl || null, videoProvider || null,
        durationSeconds || null, typeof sortOrder === 'number' ? sortOrder : 0, Boolean(isFree), isPublished !== false,
        JSON.stringify(materials || [])]);
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Error creating LMS lesson', error);
    res.status(500).json({ error: 'Unable to create LMS lesson' });
  }
});

app.put('/api/lms/lessons/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { moduleId, title, description, videoUrl, videoProvider, durationSeconds, sortOrder, isFree, isPublished, materials } = req.body;
  try {
    const updateFields = {
      lms_module_id: moduleId, title, description,
      video_url: videoUrl, video_provider: videoProvider,
      duration_seconds: durationSeconds, sort_order: sortOrder,
      is_free: typeof isFree === 'boolean' ? isFree : undefined,
      is_published: typeof isPublished === 'boolean' ? isPublished : undefined
    };
    if (materials !== undefined) {
      updateFields.materials = JSON.stringify(materials);
    }
    const { query, values } = buildUpdateQuery('lms_lessons', updateFields, req.params.id);
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

// Admin: stato magic link degli studenti
app.get('/api/admin/magic-link-status', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { courseEditionId } = req.query;
  try {
    let query = `
      SELECT u.email, u.first_name AS "firstName", u.last_name AS "lastName",
             CASE WHEN u.token_hash IS NOT NULL THEN true ELSE false END AS "hasRequestedLink",
             u.last_login_at AS "lastLoginAt"
      FROM users u
    `;
    const values = [];
    if (courseEditionId) {
      query += `
        JOIN enrollments e ON e.user_id = u.id
        WHERE e.course_edition_id = $1
      `;
      values.push(courseEditionId);
    }
    query += ' ORDER BY u.last_login_at DESC NULLS LAST, u.email';
    
    const { rows } = await pool.query(query, values);
    
    const requested = rows.filter(r => r.hasRequestedLink || r.lastLoginAt);
    const notRequested = rows.filter(r => !r.hasRequestedLink && !r.lastLoginAt);
    
    res.json({
      total: rows.length,
      requested: requested.length,
      notRequested: notRequested.length,
      students: rows
    });
  } catch (error) {
    console.error('Error fetching magic link status', error);
    res.status(500).json({ error: 'Unable to retrieve status' });
  }
});

app.post('/api/lms/enrollments/bulk', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const items = req.body;
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'Request body must be a non-empty array of {email, courseEditionId, role, firstName?, lastName?}' });
  }
  try {
    const results = [];
    for (const item of items) {
      const { email, courseEditionId, role, firstName, lastName } = item;
      if (!email || !courseEditionId) {
        results.push({ email, error: 'email and courseEditionId are required' });
        continue;
      }
      // Find or create user
      let userId;
      const { rows: existingUsers } = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
      if (existingUsers.length) {
        userId = existingUsers[0].id;
        // Update user data if provided
        await pool.query(`
          UPDATE users SET 
            role = COALESCE($1, role),
            first_name = COALESCE(NULLIF($2, ''), first_name),
            last_name = COALESCE(NULLIF($3, ''), last_name),
            updated_at = NOW() 
          WHERE id = $4
        `, [role, firstName || '', lastName || '', userId]);
      } else {
        // Create user with a random password hash (they'll reset it)
        const newId = uuidv4();
        const placeholderHash = crypto.randomBytes(32).toString('hex');
        await pool.query(`
          INSERT INTO users (id, email, password_hash, first_name, last_name, role)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [newId, email, placeholderHash, firstName || '', lastName || '', role || 'student']);
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

app.get('/api/lms/enrollments', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { courseEditionId } = req.query;
    if (!courseEditionId) return res.status(400).json({ error: 'courseEditionId query parameter is required' });
    const { rows } = await pool.query(`
      SELECT e.id, e.user_id AS "userId", e.course_edition_id AS "courseEditionId",
             e.status, e.enrolled_at AS "enrolledAt", e.completed_at AS "completedAt",
             u.email, u.first_name AS "firstName", u.last_name AS "lastName", u.role,
             u.last_login_at AS "lastLoginAt"
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

// Update enrollment
app.put('/api/lms/enrollments/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { id } = req.params;
  const { email, firstName, lastName, role, status } = req.body;
  
  try {
    // Get enrollment to find user_id
    const { rows: enrollments } = await pool.query('SELECT user_id FROM enrollments WHERE id = $1', [id]);
    if (!enrollments.length) {
      return res.status(404).json({ error: 'Enrollment not found' });
    }
    const userId = enrollments[0].user_id;
    
    // Update user
    await pool.query(`
      UPDATE users SET
        email = COALESCE($1, email),
        first_name = COALESCE($2, first_name),
        last_name = COALESCE($3, last_name),
        role = COALESCE($4, role),
        updated_at = NOW()
      WHERE id = $5
    `, [email, firstName, lastName, role, userId]);
    
    // Update enrollment status if provided
    if (status) {
      await pool.query('UPDATE enrollments SET status = $1 WHERE id = $2', [status, id]);
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating enrollment', error);
    res.status(500).json({ error: 'Unable to update enrollment' });
  }
});

// Delete enrollment
app.delete('/api/lms/enrollments/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { id } = req.params;
  
  try {
    const { rowCount } = await pool.query('DELETE FROM enrollments WHERE id = $1', [id]);
    if (rowCount === 0) {
      return res.status(404).json({ error: 'Enrollment not found' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting enrollment', error);
    res.status(500).json({ error: 'Unable to delete enrollment' });
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
    const { rows } = await pool.query('SELECT id, role, is_active FROM users WHERE LOWER(email) = LOWER($1)', [email.trim()]);
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

// Verifica magic link token - mostra pagina di conferma (per evitare prefetch Outlook)
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
    const firstName = user.first_name || '';

    // Mostra pagina di conferma con JavaScript submit (evita prefetch Outlook che fa anche POST)
    res.send(`
      <!DOCTYPE html>
      <html><head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Accedi - Carbon Farming Master</title>
        <style>
          body { font-family: Inter, system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f3f4f6; }
          .card { background: white; border-radius: 20px; padding: 48px; text-align: center; box-shadow: 0 18px 45px rgba(31,41,55,0.12); max-width: 400px; }
          h2 { color: #1b3a2d; margin: 0 0 12px; }
          p { color: #6b6b6b; margin: 0 0 24px; }
          button { background: linear-gradient(120deg,#ff7a1a,#fbbc42); color: white; border: none; padding: 14px 32px; border-radius: 999px; font-weight: 600; font-size: 1rem; cursor: pointer; box-shadow: 0 12px 28px rgba(255,122,26,0.28); }
          button:hover { transform: translateY(-1px); }
          button:disabled { opacity: 0.6; cursor: wait; }
        </style>
      </head><body>
        <div class="card">
          <h2>Ciao${firstName ? ' ' + firstName : ''}!</h2>
          <p>Clicca il pulsante per accedere alla piattaforma.</p>
          <button id="login-btn" onclick="doLogin()">Accedi alla piattaforma</button>
        </div>
        <script>
          async function doLogin() {
            const btn = document.getElementById('login-btn');
            btn.disabled = true;
            btn.textContent = 'Accesso in corso...';
            try {
              const res = await fetch('/api/auth/confirm-magic/${rawToken}', { method: 'POST' });
              const data = await res.json();
              if (data.token) {
                localStorage.setItem('learnToken', data.token);
                localStorage.setItem('learnUser', JSON.stringify(data.user || {}));
                window.location.href = '/learn/index.html';
              } else {
                alert(data.error || 'Errore di accesso');
                window.location.href = '/learn/login.html';
              }
            } catch (e) {
              alert('Errore di connessione');
              btn.disabled = false;
              btn.textContent = 'Accedi alla piattaforma';
            }
          }
        </script>
      </body></html>
    `);
  } catch (error) {
    console.error('Error verifying magic link', error);
    res.status(500).send('Errore interno');
  }
});

// Conferma magic link (POST) - consuma il token, risponde JSON
app.post('/api/auth/confirm-magic/:token', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Database not configured' });

  try {
    const rawToken = req.params.token;
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const { rows } = await pool.query(
      'SELECT id, email, first_name, last_name, role FROM users WHERE token_hash = $1 AND token_expires_at > NOW() AND is_active = true',
      [tokenHash]
    );

    if (!rows.length) {
      return res.status(400).json({ error: 'Link scaduto o non valido' });
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

    // Risponde JSON invece di redirect
    res.json({
      token: jwt,
      user: {
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Error confirming magic link', error);
    res.status(500).json({ error: 'Errore interno' });
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

// Salva progresso video lezione
app.post('/api/lms/lessons/:id/progress', requireStudent, async (req, res) => {
  if (!ensurePool(res)) return;
  const { lastPositionSec, watchPercentage, timeSpentSeconds, watchedSegments } = req.body;
  const lessonId = req.params.id;
  const userId = req.user.userId;

  // Validazione timeSpentSeconds: max 4 ore per singolo aggiornamento (14400 sec)
  const sanitizedTime = Math.min(Math.max(Math.round(timeSpentSeconds || 0), 0), 14400);

  try {
    const { rows } = await pool.query(`
      INSERT INTO lesson_progress (id, user_id, lms_lesson_id, last_position_seconds, progress_percent, time_spent_seconds, watched_segments)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (user_id, lms_lesson_id) DO UPDATE SET
        last_position_seconds = GREATEST(lesson_progress.last_position_seconds, $4),
        progress_percent = GREATEST(lesson_progress.progress_percent, $5),
        time_spent_seconds = GREATEST(lesson_progress.time_spent_seconds, $6),
        watched_segments = $7,
        updated_at = NOW()
      RETURNING progress_percent AS "progressPercent",
                last_position_seconds AS "lastPositionSeconds",
                time_spent_seconds AS "timeSpentSeconds",
                completed_at AS "completedAt"
    `, [uuidv4(), userId, lessonId,
        lastPositionSec || 0,
        Math.min(Math.max(Math.round(watchPercentage || 0), 0), 100),
        sanitizedTime,
        JSON.stringify(watchedSegments || [])]);
    res.json(rows[0]);
  } catch (error) {
    console.error('Error saving lesson progress', error);
    res.status(500).json({ error: 'Unable to save progress' });
  }
});

// --- QUIZ ---

// Get quizzes - public for students (only published), full access for admin
app.get('/api/lms/quizzes', async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { lessonId } = req.query;
    const filters = [];
    const values = [];
    
    // Check if admin token is present
    const authHeader = req.headers.authorization;
    const isAdmin = authHeader && authHeader.startsWith('Bearer ') && 
                    authHeader.slice(7) === ADMIN_PASSWORD;
    
    // Non-admin users only see published quizzes
    if (!isAdmin) {
      filters.push('is_published = true');
    }
    
    if (lessonId) {
      filters.push(`lms_lesson_id = $${values.length + 1}`);
      values.push(lessonId);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const { rows } = await pool.query(`
      SELECT id, lms_lesson_id AS "lessonId", lms_module_id AS "moduleId",
             title, description, passing_score AS "passingScore",
             max_attempts AS "maxAttempts", time_limit_minutes AS "timeLimitMinutes",
             is_published AS "isPublished",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM quizzes ${where}
      ORDER BY created_at ASC
    `, values);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching quizzes', error);
    res.status(500).json({ error: 'Unable to retrieve quizzes' });
  }
});

// Student: carica quiz con domande (senza risposte corrette)
app.get('/api/lms/quizzes/:id', async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows: quizRows } = await pool.query(`
      SELECT id, lms_lesson_id AS "lessonId", lms_module_id AS "moduleId",
             title, description, passing_score AS "passingScore",
             max_attempts AS "maxAttempts", time_limit_minutes AS "timeLimitMinutes",
             is_published AS "isPublished"
      FROM quizzes WHERE id = $1
    `, [req.params.id]);
    if (!quizRows.length) return res.status(404).json({ error: 'Quiz not found' });

    const quiz = quizRows[0];

    const { rows: questions } = await pool.query(`
      SELECT id, question_text AS "questionText",
             question_type AS "questionType", options, points,
             sort_order AS "sortOrder"
      FROM quiz_questions WHERE quiz_id = $1
      ORDER BY sort_order ASC, created_at ASC
    `, [req.params.id]);

    quiz.questions = questions;
    res.json(quiz);
  } catch (error) {
    console.error('Error fetching quiz', error);
    res.status(500).json({ error: 'Unable to retrieve quiz' });
  }
});

app.post('/api/lms/quizzes', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { lessonId, moduleId, title, description, passingScore, maxAttempts, timeLimitMinutes, isPublished } = req.body;
  if (!title || (!lessonId && !moduleId)) {
    return res.status(400).json({ error: 'title and lessonId or moduleId are required' });
  }
  try {
    const id = uuidv4();
    const { rows } = await pool.query(`
      INSERT INTO quizzes (id, lms_lesson_id, lms_module_id, title, description, passing_score, max_attempts, time_limit_minutes, is_published)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, lms_lesson_id AS "lessonId", lms_module_id AS "moduleId",
                title, description, passing_score AS "passingScore",
                max_attempts AS "maxAttempts", time_limit_minutes AS "timeLimitMinutes",
                is_published AS "isPublished"
    `, [id, lessonId || null, moduleId || null, title, description || null,
        passingScore || 70, maxAttempts || 0, timeLimitMinutes || null, isPublished !== false]);
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Error creating quiz', error);
    res.status(500).json({ error: 'Unable to create quiz' });
  }
});

app.put('/api/lms/quizzes/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { title, description, passingScore, maxAttempts, timeLimitMinutes, isPublished } = req.body;
  try {
    const { query, values } = buildUpdateQuery('quizzes', {
      title, description,
      passing_score: passingScore,
      max_attempts: maxAttempts,
      time_limit_minutes: timeLimitMinutes,
      is_published: typeof isPublished === 'boolean' ? isPublished : undefined
    }, req.params.id);
    const { rows } = await pool.query(query, values);
    if (!rows.length) return res.status(404).json({ error: 'Quiz not found' });
    const r = rows[0];
    res.json({
      id: r.id, lessonId: r.lms_lesson_id, moduleId: r.lms_module_id,
      title: r.title, description: r.description, passingScore: r.passing_score,
      maxAttempts: r.max_attempts, timeLimitMinutes: r.time_limit_minutes,
      isPublished: r.is_published
    });
  } catch (error) {
    console.error('Error updating quiz', error);
    res.status(500).json({ error: 'Unable to update quiz' });
  }
});

app.delete('/api/lms/quizzes/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rowCount } = await pool.query('DELETE FROM quizzes WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Quiz not found' });
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting quiz', error);
    res.status(500).json({ error: 'Unable to delete quiz' });
  }
});

// --- GENERA QUIZ CON AI ---
app.post('/api/lms/quizzes/generate', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  
  const { lessonId, numQuestions = 5, difficulty = 'intermediate' } = req.body;
  
  if (!lessonId) {
    return res.status(400).json({ error: 'lessonId è obbligatorio' });
  }

  try {
    // 1. Recupera i materiali della lezione
    const { rows: lessons } = await pool.query(`
      SELECT title, description, materials FROM lessons WHERE id = $1
    `, [lessonId]);
    
    if (!lessons.length) {
      return res.status(404).json({ error: 'Lezione non trovata' });
    }
    
    const lesson = lessons[0];
    const materials = lesson.materials || [];
    
    // Costruisci il contesto dai materiali
    let context = `Titolo lezione: ${lesson.title}\n`;
    if (lesson.description) context += `Descrizione: ${lesson.description}\n`;
    if (materials.length > 0) {
      context += `\nMateriali disponibili:\n`;
      materials.forEach(m => {
        context += `- ${m.name} (${m.type}): ${m.url}\n`;
      });
    }

    // 2. Chiama Claude per generare le domande
    const Anthropic = require('@anthropic-ai/sdk').default;
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });

    const difficultyMap = {
      easy: 'semplice, adatta a principianti',
      intermediate: 'di livello intermedio',
      advanced: 'avanzata, che richiede conoscenza approfondita'
    };

    const prompt = `Sei un esperto di formazione e valutazione. Devi creare un quiz di verifica per una lezione universitaria.

CONTESTO DELLA LEZIONE:
${context}

ISTRUZIONI:
Genera esattamente ${numQuestions} domande a risposta multipla con difficoltà ${difficultyMap[difficulty] || 'intermedia'}.

Per ogni domanda:
- 4 opzioni di risposta (A, B, C, D)
- Solo UNA risposta corretta
- Le opzioni errate devono essere plausibili ma chiaramente distinguibili
- Le domande devono testare la comprensione, non solo la memorizzazione

FORMATO OUTPUT (JSON valido):
{
  "questions": [
    {
      "questionText": "Testo della domanda?",
      "options": ["Opzione A", "Opzione B", "Opzione C", "Opzione D"],
      "correctAnswer": "Opzione A",
      "points": 1
    }
  ]
}

Rispondi SOLO con il JSON, nessun altro testo.`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    });

    // 3. Parsa la risposta
    const responseText = message.content[0].text;
    let generated;
    try {
      // Cerca il JSON nella risposta
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Nessun JSON trovato');
      generated = JSON.parse(jsonMatch[0]);
    } catch (parseError) {
      console.error('Error parsing AI response:', responseText);
      return res.status(500).json({ error: 'Errore nel parsing della risposta AI' });
    }

    // 4. Restituisci le domande generate (non le salva ancora, l'admin deve confermare)
    res.json({
      lessonTitle: lesson.title,
      numQuestions: generated.questions?.length || 0,
      questions: generated.questions || []
    });

  } catch (error) {
    console.error('Error generating quiz:', error);
    res.status(500).json({ error: 'Errore nella generazione del quiz: ' + error.message });
  }
});

// --- GENERA QUIZ PRELIMINARE DA RISORSE ---
app.post('/api/resources/generate-quiz', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  
  const { numQuestions = 10, difficulty = 'intermediate', title = 'Quiz Preliminare' } = req.body;

  try {
    // 1. Recupera le risorse pubblicate
    const { rows: resources } = await pool.query(`
      SELECT title, description, resource_type, url FROM resources WHERE is_published = true ORDER BY sort_order
    `);
    
    if (!resources.length) {
      return res.status(400).json({ error: 'Nessuna risorsa pubblicata trovata. Pubblica almeno una risorsa prima di generare il quiz.' });
    }
    
    // Costruisci il contesto dalle risorse
    let context = `Risorse disponibili per il Master Carbon Farming:\n\n`;
    resources.forEach((r, i) => {
      context += `${i + 1}. ${r.title} (${r.resource_type})`;
      if (r.description) context += ` - ${r.description}`;
      context += `\n`;
    });

    // 2. Chiama Claude per generare le domande
    const Anthropic = require('@anthropic-ai/sdk').default;
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });

    const difficultyMap = {
      easy: 'semplice, adatta a principianti che non conoscono l\'argomento',
      intermediate: 'di livello intermedio, per verificare conoscenze di base',
      advanced: 'avanzata, che richiede conoscenza approfondita del tema'
    };

    const prompt = `Sei un esperto di Carbon Farming e formazione. Devi creare un quiz preliminare di valutazione per un Master universitario.

CONTESTO - MASTER CARBON FARMING:
Il Carbon Farming è l'insieme di pratiche agricole che mirano a sequestrare carbonio nel suolo e nella biomassa vegetale, contribuendo alla mitigazione del cambiamento climatico e generando crediti di carbonio certificati.

RISORSE DEL CORSO:
${context}

ISTRUZIONI:
Genera esattamente ${numQuestions} domande a risposta multipla con difficoltà ${difficultyMap[difficulty] || 'intermedia'}.

Le domande devono coprire:
- Concetti base del carbon farming
- Pratiche agricole sostenibili
- Sequestro del carbonio nel suolo
- Mercato dei crediti di carbonio
- Normative e certificazioni
- Benefici ambientali ed economici

Per ogni domanda:
- 4 opzioni di risposta (A, B, C, D)
- Solo UNA risposta corretta
- Le opzioni errate devono essere plausibili
- Mescola domande teoriche e pratiche

FORMATO OUTPUT (JSON valido):
{
  "questions": [
    {
      "questionText": "Testo della domanda?",
      "options": ["Opzione A", "Opzione B", "Opzione C", "Opzione D"],
      "correctAnswer": "Opzione A",
      "points": 1
    }
  ]
}

Rispondi SOLO con il JSON, nessun altro testo.`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    });

    // 3. Parsa la risposta
    const responseText = message.content[0].text;
    let generated;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Nessun JSON trovato');
      generated = JSON.parse(jsonMatch[0]);
    } catch (parseError) {
      console.error('Error parsing AI response:', responseText);
      return res.status(500).json({ error: 'Errore nel parsing della risposta AI' });
    }

    res.json({
      title: title,
      numQuestions: generated.questions?.length || 0,
      questions: generated.questions || []
    });

  } catch (error) {
    console.error('Error generating preliminary quiz:', error);
    res.status(500).json({ error: 'Errore nella generazione del quiz: ' + error.message });
  }
});

// --- QUIZ QUESTIONS ---

app.get('/api/lms/quiz-questions', async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { quizId } = req.query;
    if (!quizId) return res.status(400).json({ error: 'quizId is required' });
    const { rows } = await pool.query(`
      SELECT id, quiz_id AS "quizId", question_text AS "questionText",
             question_type AS "questionType", options,
             correct_answer AS "correctAnswer", points,
             sort_order AS "sortOrder"
      FROM quiz_questions WHERE quiz_id = $1
      ORDER BY sort_order ASC, created_at ASC
    `, [quizId]);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching quiz questions', error);
    res.status(500).json({ error: 'Unable to retrieve questions' });
  }
});

app.post('/api/lms/quiz-questions', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { quizId, questionText, questionType, options, correctAnswer, points, sortOrder } = req.body;
  if (!quizId || !questionText) {
    return res.status(400).json({ error: 'quizId and questionText are required' });
  }
  try {
    const id = uuidv4();
    const { rows } = await pool.query(`
      INSERT INTO quiz_questions (id, quiz_id, question_text, question_type, options, correct_answer, points, sort_order)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, quiz_id AS "quizId", question_text AS "questionText",
                question_type AS "questionType", options,
                correct_answer AS "correctAnswer", points,
                sort_order AS "sortOrder"
    `, [id, quizId, questionText, questionType || 'single_choice',
        JSON.stringify(options || []), JSON.stringify(correctAnswer || null),
        points || 1, sortOrder || 0]);
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Error creating quiz question', error);
    res.status(500).json({ error: 'Unable to create question' });
  }
});

app.put('/api/lms/quiz-questions/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { questionText, questionType, options, correctAnswer, points, sortOrder } = req.body;
  try {
    const { query, values } = buildUpdateQuery('quiz_questions', {
      question_text: questionText,
      question_type: questionType,
      options: options !== undefined ? JSON.stringify(options) : undefined,
      correct_answer: correctAnswer !== undefined ? JSON.stringify(correctAnswer) : undefined,
      points, sort_order: sortOrder
    }, req.params.id);
    const { rows } = await pool.query(query, values);
    if (!rows.length) return res.status(404).json({ error: 'Question not found' });
    const r = rows[0];
    res.json({
      id: r.id, quizId: r.quiz_id, questionText: r.question_text,
      questionType: r.question_type, options: r.options,
      correctAnswer: r.correct_answer, points: r.points, sortOrder: r.sort_order
    });
  } catch (error) {
    console.error('Error updating quiz question', error);
    res.status(500).json({ error: 'Unable to update question' });
  }
});

app.delete('/api/lms/quiz-questions/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rowCount } = await pool.query('DELETE FROM quiz_questions WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Question not found' });
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting quiz question', error);
    res.status(500).json({ error: 'Unable to delete question' });
  }
});

// --- QUIZ SUBMIT & ATTEMPTS ---

// Studente invia risposte quiz
app.post('/api/lms/quizzes/:id/submit', requireStudent, async (req, res) => {
  if (!ensurePool(res)) return;
  const { answers } = req.body;
  const quizId = req.params.id;
  const userId = req.user.userId;

  if (!answers || typeof answers !== 'object') {
    return res.status(400).json({ error: 'answers object is required' });
  }

  try {
    // Load quiz
    const { rows: quizRows } = await pool.query(
      'SELECT * FROM quizzes WHERE id = $1', [quizId]
    );
    if (!quizRows.length) return res.status(404).json({ error: 'Quiz not found' });
    const quiz = quizRows[0];

    // Check max attempts
    if (quiz.max_attempts > 0) {
      const { rows: countRows } = await pool.query(
        'SELECT COUNT(*)::int AS total FROM quiz_attempts WHERE user_id = $1 AND quiz_id = $2 AND completed_at IS NOT NULL',
        [userId, quizId]
      );
      if (countRows[0].total >= quiz.max_attempts) {
        return res.status(400).json({ error: 'Numero massimo di tentativi raggiunto' });
      }
    }

    // Load questions with correct answers
    const { rows: questions } = await pool.query(
      'SELECT id, correct_answer, points, question_type FROM quiz_questions WHERE quiz_id = $1',
      [quizId]
    );

    // Score calculation
    let totalPoints = 0;
    let earnedPoints = 0;
    const results = {};

    questions.forEach(q => {
      totalPoints += q.points;
      const studentAnswer = answers[q.id];
      const correct = q.correct_answer;
      let isCorrect = false;

      if (q.question_type === 'multiple_choice') {
        // Both are arrays — compare sorted
        const sa = Array.isArray(studentAnswer) ? [...studentAnswer].sort() : [];
        const ca = Array.isArray(correct) ? [...correct].sort() : [];
        isCorrect = sa.length === ca.length && sa.every((v, i) => v === ca[i]);
      } else {
        // single_choice or true_false — direct compare
        isCorrect = JSON.stringify(studentAnswer) === JSON.stringify(correct);
      }

      if (isCorrect) earnedPoints += q.points;
      results[q.id] = { correct: isCorrect, correctAnswer: correct };
    });

    const score = totalPoints > 0 ? Math.round((earnedPoints / totalPoints) * 100) : 0;
    const passed = score >= quiz.passing_score;

    // Save attempt
    const attemptId = uuidv4();
    await pool.query(`
      INSERT INTO quiz_attempts (id, user_id, quiz_id, score, passed, answers, completed_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, [attemptId, userId, quizId, score, passed, JSON.stringify(answers)]);

    res.json({ attemptId, score, passed, passingScore: quiz.passing_score, results });
  } catch (error) {
    console.error('Error submitting quiz', error);
    res.status(500).json({ error: 'Unable to submit quiz' });
  }
});

// Storico tentativi studente per un quiz
app.get('/api/lms/quizzes/:id/attempts', requireStudent, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT id, score, passed, started_at AS "startedAt", completed_at AS "completedAt"
      FROM quiz_attempts
      WHERE user_id = $1 AND quiz_id = $2
      ORDER BY completed_at DESC
    `, [req.user.userId, req.params.id]);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching quiz attempts', error);
    res.status(500).json({ error: 'Unable to retrieve attempts' });
  }
});

// --- COMPLETAMENTO LEZIONE ---

// Verifica criteri e segna lezione come completata
app.post('/api/lms/lessons/:id/complete', requireStudent, async (req, res) => {
  if (!ensurePool(res)) return;
  const lessonId = req.params.id;
  const userId = req.user.userId;

  try {
    // 1. Carica lezione
    const { rows: lessonRows } = await pool.query(
      'SELECT id, duration_seconds FROM lms_lessons WHERE id = $1', [lessonId]
    );
    if (!lessonRows.length) return res.status(404).json({ error: 'Lesson not found' });
    const lesson = lessonRows[0];

    // 2. Carica progresso studente
    const { rows: progressRows } = await pool.query(
      'SELECT progress_percent, time_spent_seconds, completed_at FROM lesson_progress WHERE user_id = $1 AND lms_lesson_id = $2',
      [userId, lessonId]
    );

    if (!progressRows.length) {
      return res.status(400).json({ error: 'Nessun progresso registrato', criteria: { video: false, time: false, quiz: false } });
    }

    const progress = progressRows[0];
    if (progress.completed_at) {
      return res.json({ completed: true, message: 'Lezione già completata', completedAt: progress.completed_at });
    }

    // Criterio 1: video >= 80%
    const videoOk = progress.progress_percent >= 80;

    // Criterio 2: tempo permanenza >= 75% durata video
    const minTime = lesson.duration_seconds ? Math.floor(lesson.duration_seconds * 0.75) : 0;
    const timeOk = !lesson.duration_seconds || (progress.time_spent_seconds >= minTime);

    // Criterio 3: quiz superato (se esiste)
    const { rows: quizRows } = await pool.query(
      'SELECT id, passing_score FROM quizzes WHERE lms_lesson_id = $1 AND is_published = true LIMIT 1',
      [lessonId]
    );

    let quizOk = true;
    if (quizRows.length) {
      const quiz = quizRows[0];
      const { rows: passedRows } = await pool.query(
        'SELECT id FROM quiz_attempts WHERE user_id = $1 AND quiz_id = $2 AND passed = true LIMIT 1',
        [userId, quiz.id]
      );
      quizOk = passedRows.length > 0;
    }

    const criteria = { video: videoOk, time: timeOk, quiz: quizOk };

    if (!videoOk || !timeOk || !quizOk) {
      return res.status(400).json({
        error: 'Criteri di completamento non soddisfatti',
        criteria,
        details: {
          videoPercent: progress.progress_percent,
          videoRequired: 80,
          timeSpent: progress.time_spent_seconds,
          timeRequired: minTime,
          quizPassed: quizOk,
          hasQuiz: quizRows.length > 0
        }
      });
    }

    // Tutti i criteri soddisfatti — segna completata (WHERE completed_at IS NULL evita race condition)
    const { rowCount } = await pool.query(
      'UPDATE lesson_progress SET completed_at = NOW(), updated_at = NOW() WHERE user_id = $1 AND lms_lesson_id = $2 AND completed_at IS NULL',
      [userId, lessonId]
    );

    // Crea automaticamente presenza asincrona
    await pool.query(`
      INSERT INTO attendance (id, user_id, lms_lesson_id, attendance_type, method)
      VALUES ($1, $2, $3, 'async', 'auto_tracking')
      ON CONFLICT (user_id, lms_lesson_id) DO NOTHING
    `, [uuidv4(), userId, lessonId]);

    res.json({ completed: true, message: 'Lezione completata!', criteria });
  } catch (error) {
    console.error('Error completing lesson', error);
    res.status(500).json({ error: 'Unable to complete lesson' });
  }
});

// --- PRESENZE ---

// Admin: genera codice PIN per una lezione
app.post('/api/attendance/generate-code', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { lessonId } = req.body;
  if (!lessonId) return res.status(400).json({ error: 'lessonId is required' });

  try {
    // Genera PIN 6 cifre
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minuti
    const id = uuidv4();

    await pool.query(`
      INSERT INTO attendance_codes (id, lesson_id, code, code_type, expires_at)
      VALUES ($1, $2, $3, 'pin', $4)
    `, [id, lessonId, code, expiresAt]);

    res.status(201).json({ id, code, expiresAt: expiresAt.toISOString(), lessonId });
  } catch (error) {
    console.error('Error generating attendance code', error);
    res.status(500).json({ error: 'Unable to generate code' });
  }
});

// Studente: check-in con PIN
app.post('/api/attendance/checkin', requireStudent, async (req, res) => {
  if (!ensurePool(res)) return;
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code is required' });

  try {
    const { rows: codes } = await pool.query(
      `SELECT ac.id, ac.lesson_id FROM attendance_codes ac
       WHERE ac.code = $1 AND ac.expires_at > NOW()
       LIMIT 1`,
      [code.trim()]
    );

    if (!codes.length) {
      return res.status(400).json({ error: 'Codice non valido o scaduto' });
    }

    const lessonId = codes[0].lesson_id;

    // Carica info lezione per la risposta
    const { rows: lessonRows } = await pool.query(
      'SELECT title, start_datetime FROM lessons WHERE id = $1', [lessonId]
    );

    const { rows } = await pool.query(`
      INSERT INTO attendance (id, user_id, lesson_id, attendance_type, method)
      VALUES ($1, $2, $3, 'in_person', 'pin')
      ON CONFLICT (user_id, lesson_id) DO NOTHING
      RETURNING id
    `, [uuidv4(), req.user.userId, lessonId]);

    const lessonTitle = lessonRows.length ? lessonRows[0].title : '';

    if (rows.length) {
      res.json({ success: true, message: 'Presenza registrata', lessonTitle });
    } else {
      res.json({ success: true, message: 'Presenza già registrata', lessonTitle });
    }
  } catch (error) {
    console.error('Error checking in', error);
    res.status(500).json({ error: 'Unable to process check-in' });
  }
});

// Admin: check-in manuale per ritardatari
app.post('/api/attendance/manual-checkin', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { lessonId, userId, type } = req.body;
  if (!lessonId || !userId) {
    return res.status(400).json({ error: 'lessonId and userId are required' });
  }
  
  try {
    const attendanceId = uuidv4();
    const attendanceType = type || 'in_person';
    
    // Controlla se esiste già
    const { rows: existing } = await pool.query(
      'SELECT id FROM attendance WHERE lesson_id = $1 AND user_id = $2',
      [lessonId, userId]
    );
    
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Presenza già registrata per questa lezione' });
    }
    
    await pool.query(`
      INSERT INTO attendance (id, lesson_id, user_id, check_in_time, attendance_type, verified)
      VALUES ($1, $2, $3, NOW(), $4, true)
    `, [attendanceId, lessonId, userId, attendanceType]);
    
    res.status(201).json({ success: true, id: attendanceId });
  } catch (error) {
    console.error('Error manual check-in', error);
    res.status(500).json({ error: 'Unable to register attendance' });
  }
});

// Admin: import CSV report partecipanti Zoom/Teams
app.post('/api/attendance/import-csv', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { lessonId, participants } = req.body;
  if (!lessonId || !Array.isArray(participants)) {
    return res.status(400).json({ error: 'lessonId and participants array are required' });
  }

  try {
    let imported = 0;
    let skipped = 0;
    let notFound = 0;

    for (const p of participants) {
      const email = (p.email || '').trim().toLowerCase();
      if (!email) { skipped++; continue; }

      // Cerca utente per email
      const { rows: userRows } = await pool.query(
        'SELECT id FROM users WHERE LOWER(email) = $1', [email]
      );

      if (!userRows.length) { notFound++; continue; }

      const { rowCount } = await pool.query(`
        INSERT INTO attendance (id, user_id, lesson_id, attendance_type, method, check_in_at, check_out_at)
        VALUES ($1, $2, $3, 'remote_live', 'csv_import', $4, $5)
        ON CONFLICT (user_id, lesson_id) DO NOTHING
      `, [uuidv4(), userRows[0].id, lessonId,
          p.joinTime || new Date().toISOString(),
          p.leaveTime || null]);

      if (rowCount > 0) imported++; else skipped++;
    }

    res.json({ imported, skipped, notFound });
  } catch (error) {
    console.error('Error importing attendance CSV', error);
    res.status(500).json({ error: 'Unable to import attendance' });
  }
});

// Admin: report presenze aggregato per course edition
app.get('/api/attendance/report/:courseEditionId', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { courseEditionId } = req.params;
  const { lessonId, studentId, type } = req.query;

  try {
    // Studenti iscritti a questa edizione
    const { rows: students } = await pool.query(`
      SELECT u.id, u.email, u.first_name AS "firstName", u.last_name AS "lastName"
      FROM enrollments e
      JOIN users u ON u.id = e.user_id
      WHERE e.course_edition_id = $1 AND e.status = 'active'
      ORDER BY u.last_name ASC, u.first_name ASC
    `, [courseEditionId]);

    // Lezioni del calendario per i moduli del corso di questa edizione
    const { rows: calendarLessons } = await pool.query(`
      SELECT l.id, l.title, l.start_datetime AS "startDatetime"
      FROM lessons l
      JOIN modules m ON m.id = l.module_id
      JOIN course_editions ce ON ce.course_id = (
        SELECT course_id FROM course_editions WHERE id = $1
      )
      WHERE l.status != 'cancelled'
      ORDER BY l.start_datetime ASC
    `, [courseEditionId]);

    // LMS lessons del corso (per presenze async)
    const { rows: lmsLessons } = await pool.query(`
      SELECT ll.id, ll.title
      FROM lms_lessons ll
      JOIN lms_modules lm ON lm.id = ll.lms_module_id
      JOIN course_editions ce ON ce.course_id = lm.course_id
      WHERE ce.id = $1 AND ll.is_published = true
      ORDER BY lm.sort_order ASC, ll.sort_order ASC
    `, [courseEditionId]);

    const totalLessons = calendarLessons.length + lmsLessons.length;
    const studentIds = students.map(s => s.id);

    // Build filters for attendance query
    let attendanceQuery = `
      SELECT a.user_id, a.lesson_id, a.lms_lesson_id, a.attendance_type, a.method,
             a.check_in_at, a.check_out_at
      FROM attendance a
      WHERE a.user_id = ANY($1)
    `;
    const values = [studentIds];
    let paramIdx = 2;

    if (lessonId) {
      attendanceQuery += ` AND (a.lesson_id = $${paramIdx} OR a.lms_lesson_id = $${paramIdx})`;
      values.push(lessonId);
      paramIdx++;
    }
    if (type) {
      attendanceQuery += ` AND a.attendance_type = $${paramIdx}`;
      values.push(type);
      paramIdx++;
    }

    const { rows: attendances } = await pool.query(attendanceQuery, values);

    // Aggregate per student
    const report = students.map(s => {
      const studentAttendances = attendances.filter(a => a.user_id === s.id);
      let filteredAttendances = studentAttendances;
      if (studentId && s.id !== studentId) return null;

      const inPerson = filteredAttendances.filter(a => a.attendance_type === 'in_person').length;
      const remoteLive = filteredAttendances.filter(a => a.attendance_type === 'remote_live').length;
      const async = filteredAttendances.filter(a => a.attendance_type === 'async').length;
      const total = inPerson + remoteLive + async;
      const percentage = totalLessons > 0 ? Math.round((total / totalLessons) * 100) : 0;

      return {
        id: s.id,
        email: s.email,
        firstName: s.firstName,
        lastName: s.lastName,
        inPerson,
        remoteLive,
        async: async,
        total,
        totalLessons,
        percentage,
        attendances: filteredAttendances.map(a => ({
          lessonId: a.lesson_id,
          lmsLessonId: a.lms_lesson_id,
          type: a.attendance_type,
          method: a.method,
          checkInAt: a.check_in_at
        }))
      };
    }).filter(Boolean);

    res.json({
      students: report,
      calendarLessons,
      lmsLessons,
      totalLessons
    });
  } catch (error) {
    console.error('Error fetching attendance report', error);
    res.status(500).json({ error: 'Unable to retrieve attendance report' });
  }
});

// Admin: export CSV del report presenze
app.get('/api/attendance/export/:courseEditionId', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { courseEditionId } = req.params;

  try {
    const { rows: students } = await pool.query(`
      SELECT u.id, u.email, u.first_name, u.last_name
      FROM enrollments e
      JOIN users u ON u.id = e.user_id
      WHERE e.course_edition_id = $1 AND e.status = 'active'
      ORDER BY u.last_name ASC, u.first_name ASC
    `, [courseEditionId]);

    const studentIds = students.map(s => s.id);

    const { rows: attendances } = await pool.query(
      'SELECT user_id, attendance_type FROM attendance WHERE user_id = ANY($1)',
      [studentIds]
    );

    // Count total lessons
    const { rows: countRows } = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM lessons l
         JOIN modules m ON m.id = l.module_id
         WHERE l.status != 'cancelled') +
        (SELECT COUNT(*)::int FROM lms_lessons ll
         JOIN lms_modules lm ON lm.id = ll.lms_module_id
         JOIN course_editions ce ON ce.course_id = lm.course_id
         WHERE ce.id = $1 AND ll.is_published = true) AS total
    `, [courseEditionId]);
    const totalLessons = countRows[0]?.total || 0;

    let csv = 'cognome,nome,email,in_persona,da_remoto,asincrona,totale,lezioni_totali,percentuale\n';
    students.forEach(s => {
      const sa = attendances.filter(a => a.user_id === s.id);
      const inPerson = sa.filter(a => a.attendance_type === 'in_person').length;
      const remoteLive = sa.filter(a => a.attendance_type === 'remote_live').length;
      const asyncCount = sa.filter(a => a.attendance_type === 'async').length;
      const total = inPerson + remoteLive + asyncCount;
      const pct = totalLessons > 0 ? Math.round((total / totalLessons) * 100) : 0;
      csv += `"${s.last_name}","${s.first_name}","${s.email}",${inPerson},${remoteLive},${asyncCount},${total},${totalLessons},${pct}%\n`;
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="presenze_${courseEditionId}.csv"`);
    res.send(csv);
  } catch (error) {
    console.error('Error exporting attendance CSV', error);
    res.status(500).json({ error: 'Unable to export attendance' });
  }
});

// Admin: lista presenze per una lezione specifica
app.get('/api/attendance/lesson/:lessonId', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT a.id, a.user_id AS "userId", u.email, u.first_name AS "firstName", u.last_name AS "lastName",
             a.attendance_type AS "attendanceType", a.method, a.check_in_at AS "checkInAt"
      FROM attendance a
      JOIN users u ON u.id = a.user_id
      WHERE a.lesson_id = $1
      ORDER BY a.check_in_at DESC
    `, [req.params.lessonId]);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching lesson attendance', error);
    res.status(500).json({ error: 'Unable to retrieve attendance' });
  }
});

// --- WORKFLOW PRODUZIONE CONTENUTI ---

// Admin: carica URL registrazione per una lezione LMS
app.post('/api/workflow/upload-recording', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { lmsLessonId, sourceVideoUrl } = req.body;
  if (!lmsLessonId || !sourceVideoUrl) {
    return res.status(400).json({ error: 'lmsLessonId and sourceVideoUrl are required' });
  }
  try {
    const id = uuidv4();
    const { rows } = await pool.query(`
      INSERT INTO content_workflow (id, lms_lesson_id, source_video_url, stage, started_at)
      VALUES ($1, $2, $3, 'uploaded', NOW())
      ON CONFLICT (lms_lesson_id) DO UPDATE SET
        source_video_url = $3, stage = 'uploaded', updated_at = NOW()
      RETURNING *
    `, [id, lmsLessonId, sourceVideoUrl]);
    res.status(201).json(formatWorkflow(rows[0]));
  } catch (error) {
    console.error('Error uploading recording', error);
    res.status(500).json({ error: 'Unable to upload recording' });
  }
});

// Admin: avvia trascrizione (simulata)
app.post('/api/workflow/:id/transcribe', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      UPDATE content_workflow
      SET stage = 'transcript_ready',
          transcript_text = '[Trascrizione automatica placeholder — in futuro Whisper API]\n\nBuongiorno a tutti. Oggi parleremo di carbon farming e delle pratiche agricole sostenibili per il sequestro del carbonio nel suolo...',
          updated_at = NOW()
      WHERE id = $1 AND stage = 'uploaded'
      RETURNING *
    `, [req.params.id]);
    if (!rows.length) return res.status(400).json({ error: 'Workflow not found or not in uploaded stage' });
    res.json(formatWorkflow(rows[0]));
  } catch (error) {
    console.error('Error starting transcription', error);
    res.status(500).json({ error: 'Unable to start transcription' });
  }
});

// Admin/docente: legge transcript
app.get('/api/workflow/:id/transcript', async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(
      'SELECT id, transcript_text, stage FROM content_workflow WHERE id = $1', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Workflow not found' });
    res.json({ id: rows[0].id, transcriptText: rows[0].transcript_text, stage: rows[0].stage });
  } catch (error) {
    console.error('Error fetching transcript', error);
    res.status(500).json({ error: 'Unable to retrieve transcript' });
  }
});

// Admin: invia transcript al docente per revisione (genera review token)
app.post('/api/workflow/:id/send-for-review', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const reviewToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 giorni

    const { rows } = await pool.query(`
      UPDATE content_workflow
      SET stage = 'teacher_review_transcript',
          review_token = $2,
          review_token_expires_at = $3,
          updated_at = NOW()
      WHERE id = $1 AND stage = 'transcript_ready'
      RETURNING *
    `, [req.params.id, reviewToken, expiresAt]);
    if (!rows.length) return res.status(400).json({ error: 'Workflow not found or not in transcript_ready stage' });

    const wf = formatWorkflow(rows[0]);
    wf.reviewUrl = `/review.html?token=${reviewToken}`;
    res.json(wf);
  } catch (error) {
    console.error('Error sending for review', error);
    res.status(500).json({ error: 'Unable to send for review' });
  }
});

// Docente: approva transcript (via review token)
app.put('/api/workflow/:id/approve-transcript', async (req, res) => {
  if (!ensurePool(res)) return;
  const { reviewToken } = req.body;

  try {
    // Accept via admin auth OR review token
    let condition = 'id = $1';
    const values = [req.params.id];

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const payload = verifyToken(authHeader.slice(7));
      if (!payload || payload.role !== 'admin') {
        if (!reviewToken) return res.status(401).json({ error: 'Authentication required' });
      }
    }

    if (reviewToken) {
      condition += ' AND review_token = $2 AND review_token_expires_at > NOW()';
      values.push(reviewToken);
    }

    const { rows } = await pool.query(`
      UPDATE content_workflow
      SET stage = 'avatar_rendering', review_token = NULL, review_token_expires_at = NULL, updated_at = NOW()
      WHERE ${condition} AND stage = 'teacher_review_transcript'
      RETURNING *
    `, values);
    if (!rows.length) return res.status(400).json({ error: 'Workflow not found, invalid token, or not in review stage' });
    res.json(formatWorkflow(rows[0]));
  } catch (error) {
    console.error('Error approving transcript', error);
    res.status(500).json({ error: 'Unable to approve transcript' });
  }
});

// Docente: richiedi modifiche transcript (via review token)
app.put('/api/workflow/:id/request-changes', async (req, res) => {
  if (!ensurePool(res)) return;
  const { reviewToken, notes } = req.body;

  try {
    let condition = 'id = $1';
    const values = [req.params.id];

    if (reviewToken) {
      condition += ' AND review_token = $2 AND review_token_expires_at > NOW()';
      values.push(reviewToken);
    } else {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
      const payload = verifyToken(authHeader.slice(7));
      if (!payload || payload.role !== 'admin') return res.status(401).json({ error: 'Invalid token' });
    }

    const notesIdx = values.length + 1;
    const { rows } = await pool.query(`
      UPDATE content_workflow
      SET stage = 'transcript_ready', reviewer_notes = $${notesIdx}, updated_at = NOW()
      WHERE ${condition} AND stage IN ('teacher_review_transcript', 'teacher_review_video')
      RETURNING *
    `, [...values, notes || null]);
    if (!rows.length) return res.status(400).json({ error: 'Workflow not found or not in review stage' });
    res.json(formatWorkflow(rows[0]));
  } catch (error) {
    console.error('Error requesting changes', error);
    res.status(500).json({ error: 'Unable to request changes' });
  }
});

// Admin: simula generazione avatar
app.post('/api/workflow/:id/generate-avatar', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const avatarUrl = `https://placeholder-avatar.example.com/video_${req.params.id}.mp4`;
    const reviewToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const { rows } = await pool.query(`
      UPDATE content_workflow
      SET stage = 'teacher_review_video',
          avatar_video_url = $2,
          review_token = $3,
          review_token_expires_at = $4,
          updated_at = NOW()
      WHERE id = $1 AND stage = 'avatar_rendering'
      RETURNING *
    `, [req.params.id, avatarUrl, reviewToken, expiresAt]);
    if (!rows.length) return res.status(400).json({ error: 'Workflow not found or not in avatar_rendering stage' });

    const wf = formatWorkflow(rows[0]);
    wf.reviewUrl = `/review.html?token=${reviewToken}`;
    res.json(wf);
  } catch (error) {
    console.error('Error generating avatar', error);
    res.status(500).json({ error: 'Unable to generate avatar' });
  }
});

// Docente: approva video (via review token)
app.put('/api/workflow/:id/approve-video', async (req, res) => {
  if (!ensurePool(res)) return;
  const { reviewToken } = req.body;

  try {
    let condition = 'id = $1';
    const values = [req.params.id];

    if (reviewToken) {
      condition += ' AND review_token = $2 AND review_token_expires_at > NOW()';
      values.push(reviewToken);
    } else {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
      const payload = verifyToken(authHeader.slice(7));
      if (!payload || payload.role !== 'admin') return res.status(401).json({ error: 'Invalid token' });
    }

    const { rows } = await pool.query(`
      UPDATE content_workflow
      SET stage = 'published', review_token = NULL, review_token_expires_at = NULL,
          completed_at = NOW(), updated_at = NOW()
      WHERE ${condition} AND stage = 'teacher_review_video'
      RETURNING *
    `, values);
    if (!rows.length) return res.status(400).json({ error: 'Workflow not found or not in teacher_review_video stage' });
    res.json(formatWorkflow(rows[0]));
  } catch (error) {
    console.error('Error approving video', error);
    res.status(500).json({ error: 'Unable to approve video' });
  }
});

// Admin: pubblica — copia avatar_video_url in lesson_assets
app.post('/api/workflow/:id/publish', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows: wfRows } = await pool.query(
      'SELECT * FROM content_workflow WHERE id = $1 AND stage = \'published\'', [req.params.id]
    );
    if (!wfRows.length) return res.status(400).json({ error: 'Workflow not found or not in published stage' });

    const wf = wfRows[0];
    const videoUrl = wf.avatar_video_url || wf.source_video_url;
    if (!videoUrl) return res.status(400).json({ error: 'No video URL available' });

    // Remove existing recording_final and insert new one
    await pool.query(
      "DELETE FROM lesson_assets WHERE lms_lesson_id = $1 AND asset_type = 'recording_final'",
      [wf.lms_lesson_id]
    );
    await pool.query(`
      INSERT INTO lesson_assets (id, lms_lesson_id, title, asset_type, url, sort_order)
      VALUES ($1, $2, 'Video lezione', 'recording_final', $3, 0)
    `, [uuidv4(), wf.lms_lesson_id, videoUrl]);

    // Aggiorna anche video_url nella lezione LMS
    await pool.query(
      'UPDATE lms_lessons SET video_url = $1, updated_at = NOW() WHERE id = $2',
      [videoUrl, wf.lms_lesson_id]
    );

    res.json({ published: true, lessonId: wf.lms_lesson_id, videoUrl });
  } catch (error) {
    console.error('Error publishing workflow', error);
    res.status(500).json({ error: 'Unable to publish' });
  }
});

// Admin: lista workflow con stato
app.get('/api/workflow/status', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { courseId } = req.query;
    let query = `
      SELECT cw.*, ll.title AS lesson_title, lm.title AS module_title
      FROM content_workflow cw
      JOIN lms_lessons ll ON ll.id = cw.lms_lesson_id
      JOIN lms_modules lm ON lm.id = ll.lms_module_id
    `;
    const values = [];
    if (courseId) {
      query += ' WHERE lm.course_id = $1';
      values.push(courseId);
    }
    query += ' ORDER BY cw.updated_at DESC';

    const { rows } = await pool.query(query, values);
    res.json(rows.map(formatWorkflow));
  } catch (error) {
    console.error('Error fetching workflow status', error);
    res.status(500).json({ error: 'Unable to retrieve workflow status' });
  }
});

// Review token: carica dati per la pagina di revisione docente
app.get('/api/workflow/review/:token', async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT cw.*, ll.title AS lesson_title, lm.title AS module_title
      FROM content_workflow cw
      JOIN lms_lessons ll ON ll.id = cw.lms_lesson_id
      JOIN lms_modules lm ON lm.id = ll.lms_module_id
      WHERE cw.review_token = $1 AND cw.review_token_expires_at > NOW()
    `, [req.params.token]);
    if (!rows.length) return res.status(404).json({ error: 'Link non valido o scaduto' });
    const wf = formatWorkflow(rows[0]);
    res.json(wf);
  } catch (error) {
    console.error('Error fetching review', error);
    res.status(500).json({ error: 'Unable to retrieve review data' });
  }
});

function formatWorkflow(r) {
  return {
    id: r.id,
    lmsLessonId: r.lms_lesson_id,
    lessonTitle: r.lesson_title,
    moduleTitle: r.module_title,
    stage: r.stage,
    sourceVideoUrl: r.source_video_url,
    transcriptText: r.transcript_text,
    transcriptUrl: r.transcript_url,
    avatarVideoUrl: r.avatar_video_url,
    reviewerNotes: r.reviewer_notes,
    assignedTo: r.assigned_to,
    reviewToken: r.review_token,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

// --- CONSENSI DOCENTI ---

app.post('/api/teacher-consents', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { teacherId, lessonId, consentType, isGranted, documentUrl, notes } = req.body;
  if (!teacherId || !consentType) {
    return res.status(400).json({ error: 'teacherId and consentType are required' });
  }
  try {
    const id = uuidv4();
    const { rows } = await pool.query(`
      INSERT INTO teacher_consents (id, teacher_id, lesson_id, consent_type, is_granted, signed_at, document_url, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, teacher_id AS "teacherId", lesson_id AS "lessonId",
                consent_type AS "consentType", is_granted AS "isGranted",
                signed_at AS "signedAt", document_url AS "documentUrl", notes
    `, [id, teacherId, lessonId || null, consentType, Boolean(isGranted),
        isGranted ? new Date() : null, documentUrl || null, notes || null]);
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Error creating teacher consent', error);
    res.status(500).json({ error: 'Unable to create consent' });
  }
});

app.get('/api/teacher-consents', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { teacherId } = req.query;
    let query = `
      SELECT tc.id, tc.teacher_id AS "teacherId", f.name AS "teacherName",
             tc.lesson_id AS "lessonId", tc.consent_type AS "consentType",
             tc.is_granted AS "isGranted", tc.signed_at AS "signedAt",
             tc.document_url AS "documentUrl", tc.notes, tc.created_at AS "createdAt"
      FROM teacher_consents tc
      JOIN faculty f ON f.id = tc.teacher_id
    `;
    const values = [];
    if (teacherId) {
      query += ' WHERE tc.teacher_id = $1';
      values.push(teacherId);
    }
    query += ' ORDER BY tc.created_at DESC';
    const { rows } = await pool.query(query, values);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching teacher consents', error);
    res.status(500).json({ error: 'Unable to retrieve consents' });
  }
});

app.delete('/api/teacher-consents/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rowCount } = await pool.query('DELETE FROM teacher_consents WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Consent not found' });
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting consent', error);
    res.status(500).json({ error: 'Unable to delete consent' });
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

// ============================================
// QUIZ ATTEMPTS API
// ============================================

// Get quiz attempts for admin (all or filtered by quiz/resource/user)
app.get('/api/quiz-attempts', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { quizId, resourceId, userId } = req.query;
    let sql = `
      SELECT qa.*, u.email, u.first_name AS "firstName", u.last_name AS "lastName",
             q.title AS "quizTitle", r.title AS "resourceTitle"
      FROM quiz_attempts qa
      JOIN users u ON u.id = qa.user_id
      LEFT JOIN quizzes q ON q.id = qa.quiz_id
      LEFT JOIN resources r ON r.id = qa.resource_id
      WHERE 1=1
    `;
    const params = [];
    if (quizId) { params.push(quizId); sql += ` AND qa.quiz_id = $${params.length}`; }
    if (resourceId) { params.push(resourceId); sql += ` AND qa.resource_id = $${params.length}`; }
    if (userId) { params.push(userId); sql += ` AND qa.user_id = $${params.length}`; }
    sql += ' ORDER BY qa.created_at DESC LIMIT 500';
    
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching quiz attempts', error);
    res.status(500).json({ error: 'Unable to fetch quiz attempts' });
  }
});

// Start a quiz attempt (student)
app.post('/api/quiz-attempts/start', async (req, res) => {
  if (!ensurePool(res)) return;
  
  // Get user from Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Non autenticato. Effettua il login.' });
  }
  const token = authHeader.split(' ')[1];

  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.userId;

    const { quizId, resourceId } = req.body;
    if (!quizId && !resourceId) {
      return res.status(400).json({ error: 'quizId o resourceId obbligatorio' });
    }

    // Count previous attempts
    const countSql = quizId 
      ? 'SELECT COUNT(*) FROM quiz_attempts WHERE user_id = $1 AND quiz_id = $2'
      : 'SELECT COUNT(*) FROM quiz_attempts WHERE user_id = $1 AND resource_id = $2';
    const { rows: countRows } = await pool.query(countSql, [userId, quizId || resourceId]);
    const attemptNumber = parseInt(countRows[0].count) + 1;

    // Create attempt
    const { rows } = await pool.query(`
      INSERT INTO quiz_attempts (user_id, quiz_id, resource_id, attempt_number, started_at)
      VALUES ($1, $2, $3, $4, NOW())
      RETURNING id, attempt_number AS "attemptNumber", started_at AS "startedAt"
    `, [userId, quizId || null, resourceId || null, attemptNumber]);

    res.json(rows[0]);
  } catch (error) {
    console.error('Error starting quiz attempt', error);
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Sessione non valida. Effettua il login.' });
    }
    res.status(500).json({ error: 'Errore nell\'avvio del quiz' });
  }
});

// Submit quiz answers (student)
app.post('/api/quiz-attempts/:id/submit', async (req, res) => {
  if (!ensurePool(res)) return;
  
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Non autenticato' });
  }
  const token = authHeader.split(' ')[1];

  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.userId;
    const attemptId = req.params.id;
    const { answers } = req.body; // [{questionIndex, selectedAnswer}]

    // Verify attempt belongs to user
    const { rows: attempts } = await pool.query(
      'SELECT * FROM quiz_attempts WHERE id = $1 AND user_id = $2',
      [attemptId, userId]
    );
    if (!attempts.length) {
      return res.status(404).json({ error: 'Tentativo non trovato' });
    }
    const attempt = attempts[0];
    if (attempt.completed_at) {
      return res.status(400).json({ error: 'Quiz già completato' });
    }

    // Get questions based on quiz_id or resource_id
    let questions = [];
    let passingScore = 70;

    if (attempt.quiz_id) {
      const { rows: quizRows } = await pool.query('SELECT passing_score FROM quizzes WHERE id = $1', [attempt.quiz_id]);
      passingScore = quizRows[0]?.passing_score || 70;
      
      const { rows: questionRows } = await pool.query(`
        SELECT question_text, options, correct_answer, points 
        FROM quiz_questions WHERE quiz_id = $1 ORDER BY sort_order
      `, [attempt.quiz_id]);
      questions = questionRows;
    } else if (attempt.resource_id) {
      // Resource quiz - get from URL data
      const { rows: resourceRows } = await pool.query('SELECT url FROM resources WHERE id = $1', [attempt.resource_id]);
      if (resourceRows.length && resourceRows[0].url.startsWith('data:application/json,')) {
        const quizData = JSON.parse(decodeURIComponent(resourceRows[0].url.replace('data:application/json,', '')));
        questions = quizData.questions.map(q => ({
          question_text: q.questionText,
          options: q.options,
          correct_answer: q.correctAnswer,
          points: q.points || 1
        }));
      }
    }

    // Calculate score
    let score = 0;
    let totalPoints = 0;
    const gradedAnswers = answers.map((a, i) => {
      const question = questions[a.questionIndex] || questions[i];
      if (!question) return { ...a, isCorrect: false, points: 0 };
      
      totalPoints += question.points || 1;
      const isCorrect = a.selectedAnswer === question.correct_answer;
      if (isCorrect) score += question.points || 1;
      
      return {
        ...a,
        isCorrect,
        correctAnswer: question.correct_answer,
        points: isCorrect ? (question.points || 1) : 0
      };
    });

    const percentage = totalPoints > 0 ? Math.round((score / totalPoints) * 100) : 0;
    const passed = percentage >= passingScore;
    const timeSpent = Math.floor((Date.now() - new Date(attempt.started_at).getTime()) / 1000);

    // Update attempt
    const { rows: updated } = await pool.query(`
      UPDATE quiz_attempts SET
        answers = $1,
        score = $2,
        total_points = $3,
        percentage = $4,
        passed = $5,
        completed_at = NOW(),
        time_spent_seconds = $6
      WHERE id = $7
      RETURNING *
    `, [JSON.stringify(gradedAnswers), score, totalPoints, percentage, passed, timeSpent, attemptId]);

    res.json({
      score,
      totalPoints,
      percentage,
      passed,
      passingScore,
      timeSpentSeconds: timeSpent,
      answers: gradedAnswers
    });
  } catch (error) {
    console.error('Error submitting quiz', error);
    res.status(500).json({ error: 'Errore nell\'invio del quiz' });
  }
});

// Get student's own attempts
app.get('/api/quiz-attempts/my', async (req, res) => {
  if (!ensurePool(res)) return;
  
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Non autenticato' });
  }
  const token = authHeader.split(' ')[1];

  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.userId;

    const { rows } = await pool.query(`
      SELECT qa.*, q.title AS "quizTitle", r.title AS "resourceTitle"
      FROM quiz_attempts qa
      LEFT JOIN quizzes q ON q.id = qa.quiz_id
      LEFT JOIN resources r ON r.id = qa.resource_id
      WHERE qa.user_id = $1
      ORDER BY qa.created_at DESC
    `, [userId]);

    res.json(rows);
  } catch (error) {
    console.error('Error fetching my attempts', error);
    res.status(500).json({ error: 'Errore nel recupero dei tentativi' });
  }
});

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
