require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const { put } = require('@vercel/blob');
const JSZip = require('jszip');
const { OpenAI } = require('openai');
const { v2: cloudinary } = require('cloudinary');
const { parseBlogPostsFromDocxBuffer, slugify } = require('./blog-import');
const { buildCalendarFeed } = require('./calendar-ics');
const {
  buildTeacherLessonAccessQuery,
  buildMaterialsPendingInsertPayload,
  getTeacherMaterialResourceTitle
} = require('./teacher-materials');

const app = express();
const port = process.env.PORT || 3000;

// Configurazione multer per upload in memoria (per Vercel Blob)
// Upload per risorse generali (limite 4MB)
const uploadSmall = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 }, // 4MB max per Vercel Functions
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.txt', '.md', '.srt', '.vtt', '.mp3', '.mp4', '.m4a', '.jpg', '.jpeg', '.png', '.gif'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo file non supportato'));
    }
  }
});

// Upload per materiali lezioni (limite 20MB)
const uploadMaterials = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max per materiali lezioni
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.txt', '.md', '.srt', '.vtt', '.mp3', '.mp4', '.m4a', '.jpg', '.jpeg', '.png', '.gif'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo file non supportato'));
    }
  }
});

const uploadBlogDocx = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ext === '.docx') {
      cb(null, true);
      return;
    }
    cb(new Error('Carica un file .docx valido'));
  }
});
const BUILD_VERSION = '2026-04-10-v25-QUIZ-CONTENT-EXTRACTION'; // Per debug deploy

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: BUILD_VERSION, timestamp: new Date().toISOString() });
});

app.post('/api/upload-test', (req, res) => {
  res.json({ ok: true, version: BUILD_VERSION, hasBlob: Boolean(process.env.BLOB_READ_WRITE_TOKEN), hasAuth: Boolean(req.headers.authorization) });
});

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);

// ============================================
// AUTENTICAZIONE ADMIN
// ============================================
const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
const BREVO_API_KEY = process.env.BREVO_API_KEY || null;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;
const PIPELINE_API_KEY = process.env.PIPELINE_API_KEY || null;

// Helper per invio email con fallback Resend -> Brevo
async function sendEmail({ to, subject, html, bcc, from }) {
  const fromEmail = from || process.env.RESEND_FROM || 'Master Carbon Farming <noreply@carbonfarmingmaster.it>';
  
  // Prova prima con Resend
  if (RESEND_API_KEY) {
    try {
      const { Resend } = require('resend');
      const resend = new Resend(RESEND_API_KEY);
      const emailData = { from: fromEmail, to, subject, html };
      if (bcc) emailData.bcc = bcc;
      await resend.emails.send(emailData);
      return { success: true, provider: 'resend' };
    } catch (resendError) {
      console.log('Resend failed, trying Brevo...', resendError.message);
    }
  }
  
  // Fallback a Brevo
  if (BREVO_API_KEY) {
    try {
      const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'api-key': BREVO_API_KEY,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          sender: { name: 'Master Carbon Farming', email: 'noreply@carbonfarmingmaster.it' },
          to: [{ email: to }],
          bcc: bcc ? [{ email: bcc }] : undefined,
          subject,
          htmlContent: html
        })
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || 'Brevo error');
      }
      return { success: true, provider: 'brevo' };
    } catch (brevoError) {
      console.error('Brevo failed:', brevoError.message);
      throw brevoError;
    }
  }
  
  throw new Error('Nessun provider email configurato');
}

function normalizeEmailList(input) {
  const raw = Array.isArray(input) ? input : [input];
  const seen = new Set();
  const emails = [];

  for (const value of raw) {
    if (!value) continue;
    const parts = String(value).split(',');
    for (const part of parts) {
      const email = part.trim().toLowerCase();
      if (!email || seen.has(email)) continue;
      seen.add(email);
      emails.push(email);
    }
  }

  return emails;
}

function buildStudentNotificationHtml(message, { isTest = false } = {}) {
  const testBanner = isTest
    ? `
          <div style="background: #fef3c7; padding: 12px; border-radius: 8px; margin-bottom: 16px; border: 1px solid #f59e0b;">
            <strong>⚠️ QUESTA È UN'EMAIL DI TEST</strong><br>
            I placeholder {nome} e {cognome} sono stati sostituiti con "Mario Rossi"
          </div>
      `
    : '';

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${testBanner}
      <div style="background: linear-gradient(135deg, #166534 0%, #22c55e 100%); padding: 20px; border-radius: 12px 12px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 1.5rem;">🌱 Master Carbon Farming</h1>
      </div>
      <div style="background: #f9fafb; padding: 24px; border-radius: 0 0 12px 12px;">
        <p style="white-space: pre-line; line-height: 1.6;">${message}</p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
        <p style="color: #6b7280; font-size: 0.875rem;">
          Università della Tuscia - Master di II livello in Carbon Farming
        </p>
      </div>
    </div>
  `;
}

async function sendStudentNotificationsBatch({ students, subject, message, bccEmail }) {
  let sent = 0;
  const failed = [];
  const delivered = [];
  const BATCH_SIZE = 8;

  for (let i = 0; i < students.length; i += BATCH_SIZE) {
    const batch = students.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(async (student) => {
      const personalizedMessage = message
        .replaceAll('{nome}', student.first_name || 'Studente')
        .replaceAll('{cognome}', student.last_name || '');

      await sendEmail({
        to: student.email,
        subject,
        bcc: bccEmail,
        html: buildStudentNotificationHtml(personalizedMessage)
      });

      return student.email;
    }));

    results.forEach((result, index) => {
      const email = batch[index]?.email || null;
      if (result.status === 'fulfilled') {
        sent += 1;
        if (email) delivered.push(email);
        return;
      }

      failed.push({
        email,
        reason: result.reason?.message || 'Errore di invio sconosciuto'
      });
    });
  }

  return {
    sent,
    total: students.length,
    delivered,
    failed,
    failedEmails: failed.map(item => item.email).filter(Boolean)
  };
}

async function createNotificationBatchLog({ scope, subject, message, courseEditionId, bccEmail, recipients }) {
  const batchId = uuidv4();
  const requestedTotal = recipients.length;

  await pool.query(
    `INSERT INTO notification_batches (
      id, scope, subject, message, course_edition_id, bcc_email, requested_total, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
    [batchId, scope, subject, message, courseEditionId || null, bccEmail || null, requestedTotal]
  );

  if (recipients.length > 0) {
    const values = [];
    const placeholders = recipients.map((recipient, index) => {
      const base = index * 7;
      values.push(
        batchId,
        recipient.email,
        recipient.first_name || null,
        recipient.last_name || null,
        recipient.status || 'pending',
        recipient.error_message || null,
        recipient.provider || null
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
    }).join(', ');

    await pool.query(
      `INSERT INTO notification_batch_recipients (
        batch_id, email, first_name, last_name, status, error_message, provider
      ) VALUES ${placeholders}`,
      values
    );
  }

  return batchId;
}

async function updateNotificationRecipientLog(batchId, { email, status, reason, provider }) {
  await pool.query(
    `UPDATE notification_batch_recipients
     SET status = $3,
         error_message = $4,
         provider = COALESCE($5, provider),
         sent_at = CASE WHEN $3 = 'sent' THEN NOW() ELSE sent_at END,
         updated_at = NOW()
     WHERE batch_id = $1 AND LOWER(email) = LOWER($2)`,
    [batchId, email, status, reason || null, provider || null]
  );
}

async function finalizeNotificationBatchLog(batchId) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'sent')::int AS sent_count,
       COUNT(*) FILTER (WHERE status IN ('failed', 'not_found'))::int AS failed_count
     FROM notification_batch_recipients
     WHERE batch_id = $1`,
    [batchId]
  );

  const stats = rows[0] || { total: 0, sent_count: 0, failed_count: 0 };
  const status = stats.failed_count === 0
    ? 'completed'
    : (stats.sent_count === 0 ? 'failed' : 'partial');

  await pool.query(
    `UPDATE notification_batches
     SET requested_total = $2,
         sent_count = $3,
         failed_count = $4,
         status = $5,
         updated_at = NOW()
     WHERE id = $1`,
    [batchId, stats.total, stats.sent_count, stats.failed_count, status]
  );

  return {
    total: stats.total,
    sent: stats.sent_count,
    failedCount: stats.failed_count,
    status
  };
}
const JWT_SECRET = process.env.JWT_SECRET || (ADMIN_PASSWORD ? crypto.createHash('sha256').update('jwt-secret-' + ADMIN_PASSWORD).digest('hex') : null);

function generateToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + (7 * 24 * 3600) })).toString('base64url'); // 7 giorni
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
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ error: 'Admin authentication not configured. Set ADMIN_PASSWORD environment variable.' });
  }
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = authHeader.slice(7);

  // Machine-to-machine: pipeline API key (no expiry).
  // Used by cf-lesson-pipeline scheduled task to publish lessons/materials.
  if (PIPELINE_API_KEY && token === PIPELINE_API_KEY) {
    req.admin = { role: 'admin', source: 'pipeline_api_key' };
    return next();
  }

  const payload = verifyToken(token);
  if (!payload || payload.role !== 'admin') {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  req.admin = payload;
  next();
}

function requireStudent(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.slice(7);
  const payload = verifyToken(token);
  if (!payload || !['student', 'teacher', 'admin', 'guest'].includes(payload.role)) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = payload;
  next();
}

function requireNonGuest(req, res, next) {
  if (req.user && req.user.role === 'guest') {
    return res.status(403).json({ error: 'Questa funzionalità non è disponibile per gli ospiti' });
  }
  next();
}

let pool = null;

async function resolveValidFacultyId(candidateFacultyId, lessonId = null) {
  if (!pool) return null;

  if (candidateFacultyId) {
    const { rows } = await pool.query(
      'SELECT id FROM faculty WHERE id = $1 LIMIT 1',
      [candidateFacultyId]
    );
    if (rows.length) return rows[0].id;
  }

  if (lessonId) {
    const { rows } = await pool.query(
      `SELECT f.id
       FROM lessons l
       JOIN faculty f ON f.id = l.teacher_id
       WHERE l.id = $1
       LIMIT 1`,
      [lessonId]
    );
    if (rows.length) return rows[0].id;
  }

  return null;
}

function normalizeQuestionRow(row) {
  return {
    id: row.id,
    userId: row.userId,
    studentName: row.studentName,
    studentEmail: row.studentEmail,
    moduleId: row.moduleId,
    moduleTitle: row.moduleTitle,
    lmsLessonId: row.lmsLessonId,
    lessonTitle: row.lessonTitle,
    questionText: row.questionText,
    status: row.status,
    assignedTo: row.assignedTo,
    assignedTeacherName: row.assignedTeacherName,
    isFaq: row.isFaq,
    faqCategory: row.faqCategory,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    replies: []
  };
}

async function getRepliesForQuestionIds(questionIds) {
  if (!pool || !Array.isArray(questionIds) || !questionIds.length) return [];

  const { rows } = await pool.query(`
    SELECT qr.id,
           qr.question_id AS "questionId",
           qr.author_id AS "authorId",
           qr.author_role AS "authorRole",
           qr.reply_text AS "replyText",
           qr.created_at AS "createdAt",
           CASE
             WHEN qr.author_role = 'student' THEN COALESCE(NULLIF(TRIM(COALESCE(us.first_name, '') || ' ' || COALESCE(us.last_name, '')), ''), us.email, 'Studente')
             WHEN qr.author_role = 'teacher' THEN COALESCE(ft.name, NULLIF(TRIM(COALESCE(ft.first_name, '') || ' ' || COALESCE(ft.last_name, '')), ''), ft.email, 'Docente')
             ELSE 'Amministrazione'
           END AS "authorName"
    FROM question_replies qr
    LEFT JOIN users us ON qr.author_role = 'student' AND us.id = qr.author_id
    LEFT JOIN faculty ft ON qr.author_role = 'teacher' AND ft.id = qr.author_id
    WHERE qr.question_id = ANY($1::uuid[])
    ORDER BY qr.created_at ASC
  `, [questionIds]);

  return rows;
}

async function attachRepliesToQuestions(questionRows) {
  const items = (questionRows || []).map(normalizeQuestionRow);
  if (!items.length) return items;

  const replies = await getRepliesForQuestionIds(items.map((item) => item.id));
  const repliesByQuestion = new Map();
  replies.forEach((reply) => {
    const list = repliesByQuestion.get(reply.questionId) || [];
    list.push(reply);
    repliesByQuestion.set(reply.questionId, list);
  });

  items.forEach((item) => {
    item.replies = repliesByQuestion.get(item.id) || [];
  });

  return items;
}

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
    ssl: sslOption,
    max: 5,
    idleTimeoutMillis: 20000,
    connectionTimeoutMillis: 10000
  });

  pool.on('error', (err) => {
    console.error('Unexpected pool error', err.message);
  });
}

app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

const staticRoot = path.join(__dirname);
app.use(express.static(staticRoot));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', database: hasDatabaseUrl });
});

// PDF Proxy endpoint to handle CORS issues
app.get('/api/pdf-proxy', async (req, res) => {
    try {
        const { url } = req.query;
        if (!url) {
            return res.status(400).json({ error: 'URL parameter required' });
        }
        
        // Validate URL
        let pdfUrl;
        try {
            pdfUrl = new URL(url);
        } catch (e) {
            return res.status(400).json({ error: 'Invalid URL' });
        }
        
        // Handle local files (starting with /upload/)
        if (url.startsWith('/upload/')) {
            const fs = require('fs');
            const path = require('path');
            const filePath = path.join(__dirname, '..', url);
            
            try {
                if (!fs.existsSync(filePath)) {
                    return res.status(404).json({ error: 'File not found' });
                }
                
                res.set({
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': 'Content-Type',
                    'Content-Type': 'application/pdf'
                });
                
                return fs.createReadStream(filePath).pipe(res);
            } catch (error) {
                return res.status(500).json({ error: 'Failed to read file' });
            }
        }
        
        // Only allow specific domains for external URLs
        const allowedDomains = [
            'public.blob.vercel-storage.com',
            'tc0ghxf0np2o2zbw.public.blob.vercel-storage.com'
        ];
        
        if (!allowedDomains.includes(pdfUrl.hostname)) {
            return res.status(403).json({ error: 'Domain not allowed' });
        }
        
        const https = require('https');
        const http = require('http');
        const client = pdfUrl.protocol === 'https:' ? https : http;
        
        const request = client.get(url, (pdfRes) => {
            if (pdfRes.statusCode !== 200) {
                return res.status(pdfRes.statusCode).json({ error: 'Failed to fetch PDF' });
            }
            
            // Set CORS headers
            res.set({
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Content-Type': pdfRes.headers['content-type'] || 'application/pdf',
                'Content-Length': pdfRes.headers['content-length']
            });
            
            pdfRes.pipe(res);
        });
        
        request.on('error', (error) => {
            console.error('PDF proxy error:', error);
            res.status(500).json({ error: 'Failed to fetch PDF' });
        });
        
        request.setTimeout(30000, () => {
            request.destroy();
            res.status(408).json({ error: 'Timeout fetching PDF' });
        });
        
    } catch (error) {
        console.error('PDF proxy error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============================================
// TEACHERS AUTH & MANAGEMENT
// ============================================

// Teachers JWT auth middleware
function requireTeacher(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.slice(7);
  const payload = verifyToken(token);
  if (!payload || payload.role !== 'teacher') {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.teacher = payload;
  next();
}

// Teachers login
app.post('/api/teachers/login', async (req, res) => {
  if (!ensurePool(res)) return;
  
  const { email, password } = req.body;
  
  if (!email) {
    return res.status(400).json({ error: 'Email richiesta' });
  }

  try {
    // Find teacher by email
    const { rows: teachers } = await pool.query(
      'SELECT * FROM faculty WHERE LOWER(email) = LOWER($1) AND is_active = true',
      [email]
    );
    
    if (teachers.length === 0) {
      return res.status(401).json({ error: 'Docente non trovato o non attivo' });
    }
    
    const teacher = teachers[0];
    
    // For now, allow login with any password (magic link style)
    // TODO: Implement proper password or magic link system
    
    // Update last login
    await pool.query(
      'UPDATE faculty SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1',
      [teacher.id]
    );
    
    // Generate JWT token
    const token = generateToken({ 
      id: teacher.id, 
      email: teacher.email, 
      role: 'teacher',
      name: `${teacher.first_name} ${teacher.last_name}`
    });
    
    res.json({ 
      token,
      teacher: {
        id: teacher.id,
        email: teacher.email,
        first_name: teacher.first_name,
        last_name: teacher.last_name,
        role: teacher.role
      }
    });
    
  } catch (error) {
    console.error('Teacher login error:', error);
    res.status(500).json({ error: 'Errore durante il login' });
  }
});

// Self-service magic link request (public, no auth required)
app.post('/api/teachers/request-magic-link', async (req, res) => {
  if (!ensurePool(res)) return;
  const safeMsg = 'Se la tua email è registrata, riceverai un link di accesso.';

  const { email } = req.body;
  if (!email) return res.json({ message: safeMsg });

  try {
    const { rows: teachers } = await pool.query(
      'SELECT * FROM faculty WHERE LOWER(email) = LOWER($1) AND is_active = true',
      [email]
    );

    if (teachers.length > 0) {
      const teacher = teachers[0];
      const magicToken = generateToken({
        id: teacher.id,
        email: teacher.email,
        role: 'teacher',
        purpose: 'magic_login'
      });
      const magicLink = `https://unitus.carbonfarmingmaster.it/teachers/?token=${magicToken}`;

      try {
        await sendEmail({
          to: teacher.email,
          subject: 'Accesso Pannello Docenti - Master Carbon Farming',
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <div style="background: linear-gradient(135deg, #166534 0%, #22c55e 100%); padding: 20px; border-radius: 12px 12px 0 0;">
                <h1 style="color: white; margin: 0; font-size: 1.5rem;">Master Carbon Farming</h1>
                <p style="color: rgba(255,255,255,0.9); margin: 8px 0 0; font-size: 14px;">Universita della Tuscia</p>
              </div>
              <div style="background: #f9fafb; padding: 24px; border-radius: 0 0 12px 12px;">
                <h2 style="color: #166534; margin: 0 0 16px;">Accesso Pannello Docenti</h2>
                <p style="margin: 16px 0; line-height: 1.6;">
                  Ciao <strong>${teacher.first_name}</strong>,<br><br>
                  Clicca il pulsante qui sotto per accedere al pannello docenti:
                </p>
                <div style="text-align: center; margin: 24px 0;">
                  <a href="${magicLink}" style="display: inline-block; background: #16a34a; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">
                    Accedi al Pannello Docenti
                  </a>
                </div>
                <p style="font-size: 14px; color: #6b7280; margin-top: 24px;">
                  Questo link è valido per 7 giorni.
                </p>
              </div>
            </div>
          `
        });
        console.log('Magic link sent to', teacher.email);
      } catch (emailError) {
        // Email not configured — log the link for manual delivery
        console.log('EMAIL NOT CONFIGURED — Magic link for', teacher.email, ':', magicLink);
      }
    }
    // Always respond with same message (don't reveal if email exists)
    res.json({ message: safeMsg });
  } catch (error) {
    console.error('Request magic link error:', error);
    res.json({ message: safeMsg });
  }
});

// Magic link login for teachers
app.post('/api/teachers/magic-login', async (req, res) => {
  if (!ensurePool(res)) return;
  
  const { token } = req.body;
  
  if (!token) {
    return res.status(400).json({ error: 'Token richiesto' });
  }
  
  try {
    // Verify magic token
    const payload = verifyToken(token);
    if (!payload || payload.role !== 'teacher' || payload.purpose !== 'magic_login') {
      return res.status(401).json({ error: 'Token non valido o scaduto' });
    }
    
    // Get teacher info
    const { rows: teachers } = await pool.query(
      'SELECT * FROM faculty WHERE id = $1 AND is_active = true',
      [payload.id]
    );
    
    if (teachers.length === 0) {
      return res.status(401).json({ error: 'Docente non trovato o non attivo' });
    }
    
    const teacher = teachers[0];
    
    // Update last login
    await pool.query(
      'UPDATE faculty SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1',
      [teacher.id]
    );
    
    // Generate new session token
    const sessionToken = generateToken({ 
      id: teacher.id, 
      email: teacher.email, 
      role: 'teacher',
      name: `${teacher.first_name} ${teacher.last_name}`
    });
    
    res.json({ 
      token: sessionToken,
      teacher: {
        id: teacher.id,
        email: teacher.email,
        first_name: teacher.first_name,
        last_name: teacher.last_name,
        role: teacher.role
      }
    });
    
  } catch (error) {
    console.error('Magic login error:', error);
    res.status(500).json({ error: 'Errore durante il magic login' });
  }
});

// Get teacher profile
app.get('/api/teachers/me', requireTeacher, async (req, res) => {
  if (!ensurePool(res)) return;
  
  try {
    const { rows: teachers } = await pool.query(
      'SELECT id, email, first_name, last_name, role, bio, is_active, last_login_at, created_at FROM faculty WHERE id = $1',
      [req.teacher.id]
    );
    
    if (teachers.length === 0) {
      return res.status(404).json({ error: 'Docente non trovato' });
    }
    
    res.json(teachers[0]);
  } catch (error) {
    console.error('Get teacher profile error:', error);
    res.status(500).json({ error: 'Errore nel recupero profilo' });
  }
});

// Get teacher statistics
app.get('/api/teachers/stats', requireTeacher, async (req, res) => {
  if (!ensurePool(res)) return;

  try {
    const facultyId = req.teacher.id;
    
    // Teacher lessons in scope: future OR completed, excluding cancelled
    const { rows: lessonStats } = await pool.query(
      `SELECT
         COUNT(*)::int AS total_lessons,
         COUNT(*) FILTER (WHERE l.status = 'completed')::int AS completed_lessons,
         COUNT(*) FILTER (WHERE COALESCE(l.status, 'scheduled') != 'completed')::int AS planned_lessons,
         COALESCE(SUM(COALESCE(l.duration_minutes, 0)) FILTER (WHERE COALESCE(l.status, 'scheduled') != 'completed'), 0)::int AS planned_minutes,
         COALESCE(SUM(COALESCE(l.duration_minutes, 0)) FILTER (WHERE l.status = 'completed'), 0)::int AS completed_minutes
       FROM lessons l
       WHERE l.teacher_id = $1
         AND COALESCE(l.status, 'scheduled') != 'cancelled'
         AND (
           l.start_datetime >= NOW()
           OR l.status = 'completed'
         )`,
      [facultyId]
    );

    // Count published materials
    const { rows: materialsCount } = await pool.query(
      `SELECT (
          (SELECT COUNT(*)::int FROM materials_pending WHERE faculty_id = $1 AND status = 'approved') +
          (SELECT COUNT(*)::int FROM resources WHERE teacher_id = $1 AND is_published = true)
        ) AS total`,
      [facultyId]
    );

    // Count pending materials
    const { rows: pendingCount } = await pool.query(
      `SELECT COUNT(*) as total FROM materials_pending
       WHERE faculty_id = $1 AND status = 'pending'`,
      [facultyId]
    );

    // Count pending documents to sign
    const { rows: docsCount } = await pool.query(
      `SELECT COUNT(*) as total FROM teacher_documents td
       WHERE td.status != 'archived'
         AND (td.faculty_id IS NULL OR td.faculty_id = $1)
         AND NOT EXISTS (
         SELECT 1 FROM teacher_document_signatures tds WHERE tds.document_id = td.id AND tds.faculty_id = $1
      )`,
      [facultyId]
    );

    const { rows: facultyPermissionRows } = await pool.query(
      'SELECT can_view_all_materials FROM faculty WHERE id = $1',
      [facultyId]
    );

    const plannedHours = Math.round(((lessonStats[0]?.planned_minutes || 0) / 60) * 100) / 100;
    const completedHours = Math.round(((lessonStats[0]?.completed_minutes || 0) / 60) * 100) / 100;
    const plannedCfu = Math.round((plannedHours / 8) * 100) / 100;
    const completedCfu = Math.round((completedHours / 8) * 100) / 100;

    res.json({
      total_lessons: lessonStats[0]?.total_lessons || 0,
      planned_lessons: lessonStats[0]?.planned_lessons || 0,
      completed_lessons: lessonStats[0]?.completed_lessons || 0,
      planned_hours: plannedHours,
      completed_hours: completedHours,
      planned_cfu: plannedCfu,
      completed_cfu: completedCfu,
      materials_published: parseInt(materialsCount[0].total),
      materials_pending: parseInt(pendingCount[0].total),
      documents_pending: parseInt(docsCount[0].total),
      can_view_all_materials: Boolean(facultyPermissionRows[0]?.can_view_all_materials)
    });
  } catch (error) {
    console.error('Get teacher stats error:', error);
    res.status(500).json({ error: 'Errore nel recupero statistiche' });
  }
});

// Get teacher's lessons
app.get('/api/teachers/lessons', requireTeacher, async (req, res) => {
  if (!ensurePool(res)) return;

  try {
    const { month, year, includeCancelled } = req.query;
    const values = [req.teacher.id];
    const filters = ['l.teacher_id = $1'];

    if (month) {
      values.push(Number(month));
      filters.push(`EXTRACT(MONTH FROM l.start_datetime) = $${values.length}`);
    }

    if (year) {
      values.push(Number(year));
      filters.push(`EXTRACT(YEAR FROM l.start_datetime) = $${values.length}`);
    }

    if (includeCancelled !== 'true') {
      filters.push(`COALESCE(l.status, 'scheduled') != 'cancelled'`);
    }

    if (!month && !year) {
      filters.push(`(l.start_datetime >= NOW() OR l.status = 'completed')`);
    }

    const { rows: lessons } = await pool.query(
      `SELECT l.id, l.title, l.start_datetime, l.duration_minutes,
              l.location_physical, l.location_remote, l.status, l.notes,
              m.name AS module_name,
              CASE
                WHEN COALESCE(l.status, 'scheduled') = 'cancelled' THEN 'cancelled'
                WHEN l.status = 'completed' THEN 'completed'
                ELSE 'planned'
              END AS lesson_state,
              (
                SELECT COUNT(*)::int
                FROM attendance a
                WHERE a.lesson_id = l.id
              ) AS attendance_count,
              (
                SELECT COUNT(*)::int
                FROM materials_pending mp
                WHERE mp.lesson_id = l.id
              ) AS materials_uploaded_count
       FROM lessons l
       LEFT JOIN modules m ON l.module_id = m.id
       WHERE ${filters.join(' AND ')}
       ORDER BY l.start_datetime ASC`,
      values
    );

    res.json(lessons);
  } catch (error) {
    console.error('Get teacher lessons error:', error);
    res.status(500).json({ error: 'Errore nel recupero lezioni' });
  }
});

// Upload materials for approval
app.post('/api/teachers/upload', requireTeacher, uploadMaterials.single('file'), async (req, res) => {
  if (!ensurePool(res)) return;
  
  const { lesson_id, title, description } = req.body;
  const file = req.file;
  
  if (!file || !lesson_id || !title) {
    return res.status(400).json({ error: 'File, lesson_id e title sono obbligatori' });
  }
  
  try {
    console.log('Upload attempt:', { teacherFacultyId: req.teacher.id, lessonId: lesson_id });

    // Verify teacher has access to this lesson
    const accessQuery = buildTeacherLessonAccessQuery(req.teacher.id, lesson_id);
    const { rows: teacherLessons } = await pool.query(accessQuery.text, accessQuery.values);

    if (teacherLessons.length === 0) {
      const { rows: lessonRows } = await pool.query(
        `SELECT l.id, l.teacher_id AS "teacherId", f.email AS "lessonTeacherEmail"
         FROM lessons l
         LEFT JOIN faculty f ON f.id = l.teacher_id
         WHERE l.id = $1
         LIMIT 1`,
        [lesson_id]
      );
      console.log('403 - No matching lesson. Teacher faculty_id:', req.teacher.id, 'Lesson data:', lessonRows[0] || null);
      return res.status(403).json({ error: 'Non hai accesso a questa lezione' });
    }
    
    // Upload to Vercel Blob
    const { url, pathname } = await put(file.originalname, file.buffer, {
      access: 'public',
      token: process.env.BLOB_READ_WRITE_TOKEN
    });
    
    // Save to materials_pending
    const insertPayload = buildMaterialsPendingInsertPayload({
      teacherFacultyId: req.teacher.id,
      lessonId: lesson_id,
      url,
      fileOriginalName: file.originalname,
      fileMimeType: file.mimetype,
      title,
      description
    });
    const { rows: materials } = await pool.query(insertPayload.text, insertPayload.values);
    
    res.json({
      id: materials[0].id,
      message: 'Materiale caricato con successo. In attesa di approvazione.',
      file_url: url,
      filename: file.originalname
    });
    
  } catch (error) {
    console.error('Teacher upload error:', error);
    res.status(500).json({ error: 'Errore durante il caricamento' });
  }
});

// Get teacher's uploaded materials (from materials_pending + resources)
app.get('/api/teachers/materials', requireTeacher, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const facultyId = req.teacher.id;

    // Materials uploaded by teacher (pending approval)
    const { rows: pending } = await pool.query(
      `SELECT id, title, description, file_url, file_name, file_type, status, notes, created_at, 'upload' AS source
       FROM materials_pending
       WHERE faculty_id = $1
         AND status != 'approved'
       ORDER BY created_at DESC`,
      [facultyId]
    );

    // Resources assigned to this teacher by admin
    const { rows: resources } = await pool.query(
      `SELECT id, title, description, url AS file_url, NULL AS file_name, file_size_bytes AS file_size,
              resource_type AS file_type, CASE WHEN is_published THEN 'approved' ELSE 'pending' END AS status,
              created_at, 'admin' AS source
       FROM resources
       WHERE teacher_id = $1
         AND resource_type <> 'quiz'
       ORDER BY created_at DESC`,
      [facultyId]
    );

    // Merge and sort by date
    const all = [...pending, ...resources].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json(all);
  } catch (error) {
    console.error('Get teacher materials error:', error);
    res.status(500).json({ error: 'Errore nel recupero materiali' });
  }
});

app.get('/api/teachers/all-materials', requireTeacher, async (req, res) => {
  if (!ensurePool(res)) return;

  try {
    const facultyId = req.teacher.id;
    const { rows: permissionRows } = await pool.query(
      'SELECT can_view_all_materials FROM faculty WHERE id = $1 LIMIT 1',
      [facultyId]
    );

    if (!permissionRows[0]?.can_view_all_materials) {
      return res.status(403).json({ error: 'Accesso non autorizzato' });
    }

    const { rows } = await pool.query(
      `SELECT r.id,
              r.title,
              r.description,
              r.url,
              r.resource_type AS "resourceType",
              r.created_at AS "createdAt",
              COALESCE(m.name, 'Senza modulo') AS "moduleName",
              m.id AS "moduleId",
              ll.title AS "lessonTitle",
              NULLIF(TRIM(COALESCE(f.first_name, '') || ' ' || COALESCE(f.last_name, '')), '') AS "uploadedBy"
       FROM resources r
       LEFT JOIN lms_lessons ll_direct ON ll_direct.id = r.lesson_id
       LEFT JOIN lessons cal ON cal.id = r.lesson_id
       LEFT JOIN lms_lessons ll_from_calendar ON ll_from_calendar.calendar_lesson_id = cal.id
       LEFT JOIN lms_lessons ll ON ll.id = COALESCE(ll_direct.id, ll_from_calendar.id)
       LEFT JOIN modules m ON m.id = ll.lms_module_id
       LEFT JOIN faculty f ON f.id = r.teacher_id
       WHERE r.is_published = true
       ORDER BY COALESCE(m.name, 'Senza modulo') ASC,
                COALESCE(ll.sort_order, 9999) ASC,
                r.created_at ASC`
    );

    res.json(rows);
  } catch (error) {
    console.error('Get all teacher materials error:', error);
    res.status(500).json({ error: 'Errore nel recupero dei materiali del Master' });
  }
});

// Get pending documents for teacher to sign
app.get('/api/teachers/documents/pending', requireTeacher, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT td.id, td.title, td.content, td.type AS document_type
      FROM teacher_documents td
      WHERE td.status != 'archived'
        AND (td.faculty_id IS NULL OR td.faculty_id = $1)
        AND NOT EXISTS (
          SELECT 1 FROM teacher_document_signatures tds
          WHERE tds.document_id = td.id AND tds.faculty_id = $1
        )
      ORDER BY td.created_at
    `, [req.teacher.id]);
    res.json(rows);
  } catch (error) {
    console.error('Get pending teacher docs error:', error);
    res.status(500).json({ error: 'Errore nel caricamento documenti' });
  }
});

// Get teacher's signed documents
app.get('/api/teachers/documents/signed', requireTeacher, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT tds.id, tds.document_id, tds.signed_at, tds.consent_given, tds.signature_image,
             tds.signature_method, tds.signer_name, tds.signer_surname,
             td.title, td.type AS document_type
      FROM teacher_document_signatures tds
      JOIN teacher_documents td ON td.id = tds.document_id
      WHERE tds.faculty_id = $1
      ORDER BY tds.signed_at DESC
    `, [req.teacher.id]);
    res.json(rows);
  } catch (error) {
    console.error('Get signed teacher docs error:', error);
    res.status(500).json({ error: 'Errore nel caricamento firme' });
  }
});

// Teacher signs a document
app.post('/api/teachers/documents/:id/sign', requireTeacher, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const documentId = req.params.id;
    const { consentGiven, signatureImage, signatureMethod, signerName, signerSurname } = req.body;

    if (consentGiven === undefined || !signatureImage || !signerName || !signerSurname) {
      return res.status(400).json({ error: 'Nome, cognome, consenso e firma sono obbligatori' });
    }

    // Verify document exists and is active
    const { rows: docs } = await pool.query(
      'SELECT id FROM teacher_documents WHERE id = $1 AND status != \'archived\'',
      [documentId]
    );
    if (docs.length === 0) {
      return res.status(404).json({ error: 'Documento non trovato' });
    }

    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];

    // signature_data stores a JSON with all signature details
    const signaturePayload = JSON.stringify({
      consentGiven,
      signatureImage,
      signatureMethod: signatureMethod || 'draw',
      signerName,
      signerSurname,
      userAgent
    });

    const { rows: existing } = await pool.query(
      'SELECT id FROM teacher_document_signatures WHERE document_id = $1 AND faculty_id = $2 LIMIT 1',
      [documentId, req.teacher.id]
    );

    if (existing.length) {
      await pool.query(`
        UPDATE teacher_document_signatures
        SET signature_data = $3,
            consent_given = $4,
            signature_image = $5,
            signature_method = $6,
            signer_name = $7,
            signer_surname = $8,
            user_agent = $9,
            ip_address = $10,
            signed_at = NOW()
        WHERE document_id = $1 AND faculty_id = $2
      `, [documentId, req.teacher.id, signaturePayload, consentGiven, signatureImage, signatureMethod || 'draw', signerName, signerSurname, userAgent, ipAddress]);
    } else {
      await pool.query(`
        INSERT INTO teacher_document_signatures
          (document_id, faculty_id, signature_data, consent_given, signature_image, signature_method, signer_name, signer_surname, user_agent, ip_address, signed_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      `, [documentId, req.teacher.id, signaturePayload, consentGiven, signatureImage, signatureMethod || 'draw', signerName, signerSurname, userAgent, ipAddress]);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Teacher sign doc error:', error);
    res.status(500).json({ error: 'Errore nella firma del documento' });
  }
});

// Admin: create teacher document
app.post('/api/teacher-documents', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { title, content, documentType, facultyId } = req.body;
    if (!title || !content) {
      return res.status(400).json({ error: 'Titolo e contenuto sono obbligatori' });
    }
    const { rows } = await pool.query(
      `INSERT INTO teacher_documents (faculty_id, title, content, type) VALUES ($1, $2, $3, $4) RETURNING *`,
      [facultyId || null, title, content, documentType || 'liberatoria']
    );
    res.json(rows[0]);
  } catch (error) {
    console.error('Create teacher doc error:', error);
    res.status(500).json({ error: 'Errore nella creazione documento' });
  }
});

// Admin: update teacher document
app.put('/api/teacher-documents/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { id } = req.params;
    const { title, content, documentType, status } = req.body;

    const updates = [];
    const values = [];
    let idx = 1;

    if (title !== undefined) { updates.push(`title = $${idx++}`); values.push(title); }
    if (content !== undefined) { updates.push(`content = $${idx++}`); values.push(content); }
    if (documentType !== undefined) { updates.push(`type = $${idx++}`); values.push(documentType); }
    if (status !== undefined) { updates.push(`status = $${idx++}`); values.push(status); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Nessun campo da aggiornare' });
    }

    updates.push('updated_at = NOW()');
    values.push(id);

    const { rows } = await pool.query(
      `UPDATE teacher_documents SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Documento non trovato' });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error('Update teacher document error:', error);
    res.status(500).json({ error: 'Errore aggiornamento documento' });
  }
});

// Admin: delete teacher document and its signatures
app.delete('/api/teacher-documents/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { id } = req.params;

    await pool.query('DELETE FROM teacher_document_signatures WHERE document_id = $1', [id]);

    const { rows } = await pool.query(
      'DELETE FROM teacher_documents WHERE id = $1 RETURNING id, title',
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Documento non trovato' });
    }

    res.json({ success: true, deleted: rows[0] });
  } catch (error) {
    console.error('Delete teacher document error:', error);
    res.status(500).json({ error: 'Errore eliminazione documento' });
  }
});

// Admin: list teacher documents with signature counts
app.get('/api/teacher-documents', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT td.*,
        (SELECT COUNT(*) FROM teacher_document_signatures tds WHERE tds.document_id = td.id) as signature_count,
        (SELECT COUNT(*) FROM teacher_document_signatures tds WHERE tds.document_id = td.id AND tds.consent_given = true) as consent_count
      FROM teacher_documents td ORDER BY td.created_at DESC
    `);
    res.json(rows);
  } catch (error) {
    console.error('List teacher docs error:', error);
    res.status(500).json({ error: 'Errore nel caricamento documenti' });
  }
});

// Admin: get signatures for a teacher document
app.get('/api/teacher-documents/:id/signatures', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT tds.id, tds.document_id, tds.faculty_id, tds.signed_at, tds.ip_address,
             tds.consent_given, tds.signature_image, tds.signature_method,
             tds.signer_name, tds.signer_surname,
             f.email, f.first_name, f.last_name
      FROM teacher_document_signatures tds
      JOIN faculty f ON f.id = tds.faculty_id
      WHERE tds.document_id = $1
      ORDER BY tds.signed_at DESC
    `, [req.params.id]);
    res.json(rows);
  } catch (error) {
    console.error('Get teacher doc signatures error:', error);
    res.status(500).json({ error: 'Errore nel caricamento firme' });
  }
});

app.get('/api/teachers/documents/:id/my-pdf', requireTeacher, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT td.title, td.content, tds.consent_given, tds.signature_image, tds.signed_at,
             tds.signer_name, tds.signer_surname, tds.ip_address
      FROM teacher_document_signatures tds
      JOIN teacher_documents td ON td.id = tds.document_id
      WHERE td.id = $1 AND tds.faculty_id = $2
    `, [req.params.id, req.teacher.id]);

    if (!rows.length) {
      return res.status(404).json({ error: 'Firma non trovata' });
    }

    const data = rows[0];
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 50, size: 'A4' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="liberatoria_docente_${(data.signer_surname || 'firmata').replace(/\s+/g, '_')}.pdf"`);
    doc.pipe(res);

    const plainContent = (data.content || '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    doc.fillColor('#166534').fontSize(20).text('Master Carbon Farming', { align: 'center' });
    doc.fillColor('#666').fontSize(10).text('Documento firmato dal docente', { align: 'center' });
    doc.moveDown(2);
    doc.fillColor('#000').fontSize(16).text(data.title, { align: 'center' });
    doc.moveDown();
    doc.fontSize(11).fillColor('#333').text(plainContent, { align: 'justify', lineGap: 4 });
    doc.moveDown(2);
    doc.strokeColor('#ccc').lineWidth(1).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown();
    doc.fillColor('#166534').fontSize(14).text('DICHIARAZIONE', { align: 'center' });
    doc.moveDown();
    doc.fillColor('#000').fontSize(11);
    doc.text(`Nome: ${data.signer_name || 'N/D'}`, 50);
    doc.text(`Cognome: ${data.signer_surname || 'N/D'}`, 300, doc.y - 14);
    doc.moveDown();
    const consensoText = data.consent_given
      ? '✓ PRESTO IL CONSENSO - Autorizzo l\'utilizzo di immagini e video'
      : '✗ NEGO IL CONSENSO - Non desidero essere ripreso/a';
    doc.fillColor(data.consent_given ? '#166534' : '#dc2626').fontSize(12).text(consensoText);
    doc.moveDown(2);
    doc.fillColor('#000').fontSize(11).text('Firma:');
    if (data.signature_image && data.signature_image.startsWith('data:image')) {
      try {
        const base64Data = data.signature_image.split(',')[1];
        const imgBuffer = Buffer.from(base64Data, 'base64');
        doc.image(imgBuffer, { width: 200, height: 80 });
      } catch (_e) {
        doc.text('[Firma non disponibile]');
      }
    }
    doc.moveDown(2);
    doc.fontSize(9).fillColor('#666');
    doc.text(`Data firma: ${new Date(data.signed_at).toLocaleString('it-IT')}`, 50);
    doc.text(`IP: ${data.ip_address || 'N/D'}`);
    doc.moveDown();
    doc.text('Documento generato automaticamente dalla piattaforma Master Carbon Farming', { align: 'center' });
    doc.end();
  } catch (error) {
    console.error('Error generating teacher signed PDF:', error);
    res.status(500).json({ error: 'Errore nella generazione del PDF' });
  }
});

app.get('/api/teacher-signatures/:id/pdf', (req, res, next) => {
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = 'Bearer ' + req.query.token;
  }
  requireAdmin(req, res, next);
}, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT tds.id, tds.consent_given, tds.signature_image, tds.signature_method, tds.signed_at,
             tds.signer_name, tds.signer_surname, tds.ip_address,
             f.email, f.first_name, f.last_name, td.title, td.content
      FROM teacher_document_signatures tds
      JOIN faculty f ON f.id = tds.faculty_id
      JOIN teacher_documents td ON td.id = tds.document_id
      WHERE tds.id = $1
    `, [req.params.id]);
    if (!rows.length) {
      return res.status(404).json({ error: 'Firma non trovata' });
    }
    const data = rows[0];
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const surname = data.signer_surname || data.last_name || 'docente';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="liberatoria_docente_${surname}.pdf"`);
    doc.pipe(res);

    const plainContent = (data.content || '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    doc.fillColor('#166534').fontSize(20).text('Master Carbon Farming', { align: 'center' });
    doc.fillColor('#666').fontSize(10).text('Firma docente', { align: 'center' });
    doc.moveDown(2);
    doc.fillColor('#000').fontSize(16).text(data.title, { align: 'center' });
    doc.moveDown();
    doc.fontSize(11).fillColor('#333').text(plainContent, { align: 'justify', lineGap: 4 });
    doc.moveDown(2);
    doc.strokeColor('#ccc').lineWidth(1).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown();
    doc.fillColor('#166534').fontSize(14).text('DICHIARAZIONE', { align: 'center' });
    doc.moveDown();
    doc.fillColor('#000').fontSize(11);
    doc.text(`Nome: ${data.signer_name || data.first_name || 'N/D'}`, 50);
    doc.text(`Cognome: ${data.signer_surname || data.last_name || 'N/D'}`, 300, doc.y - 14);
    doc.text(`Email: ${data.email || 'N/D'}`, 50);
    doc.moveDown();
    const consensoText = data.consent_given
      ? '✓ PRESTO IL CONSENSO - Autorizzo l\'utilizzo di immagini e video'
      : '✗ NEGO IL CONSENSO - Non desidero essere ripreso/a';
    doc.fillColor(data.consent_given ? '#166534' : '#dc2626').fontSize(12).text(consensoText);
    doc.moveDown(2);
    doc.fillColor('#000').fontSize(11).text('Firma:');
    if (data.signature_image && data.signature_image.startsWith('data:image')) {
      try {
        const base64Data = data.signature_image.split(',')[1];
        const imgBuffer = Buffer.from(base64Data, 'base64');
        doc.image(imgBuffer, { width: 200, height: 80 });
      } catch (_e) {
        doc.text('[Firma non disponibile]');
      }
    }
    doc.moveDown(2);
    doc.fontSize(9).fillColor('#666');
    doc.text(`Data firma: ${new Date(data.signed_at).toLocaleString('it-IT')}`, 50);
    doc.text(`IP: ${data.ip_address || 'N/D'}`);
    doc.end();
  } catch (error) {
    console.error('Error generating teacher admin PDF:', error);
    res.status(500).json({ error: 'Errore nella generazione del PDF' });
  }
});

app.get('/api/teacher-signatures/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT tds.id, tds.consent_given, tds.signature_image, tds.signature_method, tds.signed_at,
             tds.signer_name, tds.signer_surname, tds.ip_address,
             f.email, f.first_name, f.last_name, td.title, td.content
      FROM teacher_document_signatures tds
      JOIN faculty f ON f.id = tds.faculty_id
      JOIN teacher_documents td ON td.id = tds.document_id
      WHERE tds.id = $1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Firma non trovata' });
    res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching teacher signature:', error);
    res.status(500).json({ error: 'Errore nel caricamento firma' });
  }
});

app.get('/api/teacher-documents/:id/export', (req, res, next) => {
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = 'Bearer ' + req.query.token;
  }
  requireAdmin(req, res, next);
}, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT f.email, f.first_name, f.last_name,
             tds.consent_given, tds.signature_method, tds.signed_at, tds.ip_address
      FROM teacher_document_signatures tds
      JOIN faculty f ON f.id = tds.faculty_id
      WHERE tds.document_id = $1
      ORDER BY tds.signed_at DESC NULLS LAST, f.last_name, f.first_name
    `, [req.params.id]);
    let csv = 'email,nome,cognome,consenso,metodo_firma,data_firma,ip\n';
    rows.forEach(r => {
      csv += `"${r.email || ''}","${r.first_name || ''}","${r.last_name || ''}","${r.consent_given ? 'SI' : 'NO'}","${r.signature_method || ''}","${r.signed_at || ''}","${r.ip_address || ''}"\n`;
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="teacher_signatures_export.csv"');
    res.send('\uFEFF' + csv);
  } catch (error) {
    console.error('Error exporting teacher signatures:', error);
    res.status(500).json({ error: 'Errore nell\'export firme docenti' });
  }
});

// Sync faculty member for login (now a no-op since faculty IS the teachers table)
app.post('/api/faculty/sync-teacher', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email richiesta' });
  try {
    const { rows } = await pool.query('SELECT * FROM faculty WHERE LOWER(email) = LOWER($1)', [email]);
    if (!rows.length) return res.status(404).json({ error: 'Docente non trovato' });
    res.json({ teacher: rows[0], message: 'OK' });
  } catch (error) {
    console.error('Sync teacher error:', error);
    res.status(500).json({ error: 'Errore' });
  }
});

// Send magic link to faculty member
app.post('/api/faculty/send-magic-link', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  
  const { email } = req.body;
  
  if (!email) {
    return res.status(400).json({ error: 'Email richiesta' });
  }
  
  try {
    // Get teacher from teachers table
    const { rows: teachers } = await pool.query(
      'SELECT * FROM faculty WHERE LOWER(email) = LOWER($1)',
      [email]
    );
    
    if (teachers.length === 0) {
      return res.status(404).json({ error: 'Teacher not found. Sync first.' });
    }
    
    const teacher = teachers[0];
    
    // Generate magic link
    const magicToken = generateToken({
      id: teacher.id,
      email: teacher.email,
      role: 'teacher',
      purpose: 'magic_login'
    });
    
    const magicLink = `https://unitus.carbonfarmingmaster.it/teachers/?token=${magicToken}`;
    
    await sendEmail({
      to: teacher.email,
      subject: 'Accesso Pannello Docenti - Master Carbon Farming',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #166534 0%, #22c55e 100%); padding: 20px; border-radius: 12px 12px 0 0;">
            <h1 style="color: white; margin: 0; font-size: 1.5rem;">🌱 Master Carbon Farming</h1>
            <p style="color: rgba(255,255,255,0.9); margin: 8px 0 0; font-size: 14px;">Università della Tuscia</p>
          </div>
          <div style="background: #f9fafb; padding: 24px; border-radius: 0 0 12px 12px;">
            <h2 style="color: #166534; margin: 0 0 16px;">Accesso Pannello Docenti</h2>
            <p style="margin: 16px 0; line-height: 1.6;">
              Ciao <strong>${teacher.first_name}</strong>,<br><br>
              Clicca il pulsante qui sotto per accedere al pannello docenti e caricare i materiali didattici:
            </p>
            <div style="text-align: center; margin: 24px 0;">
              <a href="${magicLink}" style="display: inline-block; background: #16a34a; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">
                🚀 Accedi al Pannello Docenti
              </a>
            </div>
            <p style="font-size: 14px; color: #6b7280; margin-top: 24px;">
              Questo link è valido per 7 giorni. In futuro potrai richiedere un nuovo link quando necessario.
            </p>
            <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
            <p style="color: #6b7280; font-size: 0.875rem;">
              Università della Tuscia - Master di II livello in Carbon Farming
            </p>
          </div>
        </div>
      `
    });
    
    res.json({ message: 'Magic link inviato con successo' });
    
  } catch (error) {
    console.error('Send magic link error:', error);
    res.status(500).json({ error: 'Errore nell\'invio del magic link' });
  }
});

// ============================================
// ADMIN - TEACHERS MANAGEMENT
// ============================================

// Get all teachers for admin
app.get('/api/admin/teachers', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  
  try {
    const { rows: teachers } = await pool.query(`
      SELECT
        f.id, f.name, f.email, f.first_name, f.last_name, f.role, f.bio,
        f.is_active, f.last_login_at, f.created_at,
        COUNT(mp.id) as pending_materials_count
      FROM faculty f
      LEFT JOIN materials_pending mp ON f.id = mp.faculty_id AND mp.status = 'pending'
      WHERE f.email IS NOT NULL
      GROUP BY f.id
      ORDER BY f.created_at DESC
    `);
    
    res.json(teachers);
  } catch (error) {
    console.error('Get teachers error:', error);
    res.status(500).json({ error: 'Errore nel recupero docenti' });
  }
});

// Add new teacher
app.post('/api/admin/teachers', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  
  const { email, first_name, last_name, role, bio, send_email } = req.body;
  
  if (!email || !first_name || !last_name) {
    return res.status(400).json({ error: 'Email, nome e cognome sono obbligatori' });
  }
  
  try {
    // Check if teacher already exists
    const { rows: existing } = await pool.query(
      'SELECT id FROM faculty WHERE LOWER(email) = LOWER($1)',
      [email]
    );
    
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Docente con questa email già esistente' });
    }
    
    // Insert new teacher
    const { rows: teachers } = await pool.query(
      `INSERT INTO faculty (id, name, email, first_name, last_name, role, bio, is_published, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, true)
       RETURNING *`,
      [uuidv4(), `${first_name} ${last_name}`, email.toLowerCase(), first_name, last_name, role || 'Docente', bio || null]
    );
    
    const newTeacher = teachers[0];
    
    // Send magic link if requested
    if (send_email) {
      try {
        // Generate magic link token
        const magicToken = generateToken({
          id: newTeacher.id,
          email: newTeacher.email,
          role: 'teacher',
          purpose: 'magic_login'
        });
        
        const magicLink = `https://unitus.carbonfarmingmaster.it/teachers/?token=${magicToken}`;
        
        await sendEmail({
          to: email,
          subject: 'Accesso Pannello Docenti - Master Carbon Farming',
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <div style="background: linear-gradient(135deg, #166534 0%, #22c55e 100%); padding: 20px; border-radius: 12px 12px 0 0;">
                <h1 style="color: white; margin: 0; font-size: 1.5rem;">🌱 Master Carbon Farming</h1>
                <p style="color: rgba(255,255,255,0.9); margin: 8px 0 0; font-size: 14px;">Università della Tuscia</p>
              </div>
              <div style="background: #f9fafb; padding: 24px; border-radius: 0 0 12px 12px;">
                <h2 style="color: #166534; margin: 0 0 16px;">Benvenuto nel Pannello Docenti!</h2>
                <p style="margin: 16px 0; line-height: 1.6;">
                  Ciao <strong>${first_name}</strong>,<br><br>
                  Sei stato aggiunto come <strong>${role || 'Docente'}</strong> al sistema del Master Carbon Farming.
                  Potrai caricare materiali didattici e gestire le tue lezioni.
                </p>
                <div style="text-align: center; margin: 24px 0;">
                  <a href="${magicLink}" style="display: inline-block; background: #16a34a; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">
                    🚀 Accedi al Pannello Docenti
                  </a>
                </div>
                <p style="font-size: 14px; color: #6b7280; margin-top: 24px;">
                  In futuro potrai accedere direttamente con la tua email: <strong>${email}</strong>
                </p>
                <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
                <p style="color: #6b7280; font-size: 0.875rem;">
                  Università della Tuscia - Master di II livello in Carbon Farming
                </p>
              </div>
            </div>
          `
        });
      } catch (emailError) {
        console.error('Failed to send welcome email:', emailError);
        // Don't fail the request if email fails
      }
    }
    
    res.json({
      ...newTeacher,
      message: `Docente aggiunto con successo${send_email ? '. Email di benvenuto inviata.' : '.'}`
    });
    
  } catch (error) {
    console.error('Add teacher error:', error);
    res.status(500).json({ error: 'Errore nell\'aggiunta del docente' });
  }
});

// Update teacher
app.put('/api/admin/teachers/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  
  const teacherId = req.params.id;
  const { first_name, last_name, role, bio, is_active } = req.body;
  
  try {
    const { rows: teachers } = await pool.query(
      `UPDATE faculty
       SET first_name = $1, last_name = $2, name = $1 || ' ' || $2, role = $3, bio = $4, is_active = $5, updated_at = CURRENT_TIMESTAMP
       WHERE id = $6
       RETURNING *`,
      [first_name, last_name, role, bio, is_active !== false, teacherId]
    );
    
    if (teachers.length === 0) {
      return res.status(404).json({ error: 'Docente non trovato' });
    }
    
    res.json(teachers[0]);
  } catch (error) {
    console.error('Update teacher error:', error);
    res.status(500).json({ error: 'Errore nell\'aggiornamento del docente' });
  }
});

// Send magic link to teacher
app.post('/api/admin/teachers/:id/send-link', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  
  const teacherId = req.params.id;
  
  try {
    const { rows: teachers } = await pool.query(
      'SELECT * FROM faculty WHERE id = $1',
      [teacherId]
    );
    
    if (teachers.length === 0) {
      return res.status(404).json({ error: 'Docente non trovato' });
    }
    
    const teacher = teachers[0];
    
    // Generate magic link
    const magicToken = generateToken({
      id: teacher.id,
      email: teacher.email,
      role: 'teacher',
      purpose: 'magic_login'
    });
    
    const magicLink = `https://unitus.carbonfarmingmaster.it/teachers/?token=${magicToken}`;
    
    await sendEmail({
      to: teacher.email,
      subject: 'Link di Accesso - Pannello Docenti Master Carbon Farming',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #166534 0%, #22c55e 100%); padding: 20px; border-radius: 12px 12px 0 0;">
            <h1 style="color: white; margin: 0; font-size: 1.5rem;">🌱 Master Carbon Farming</h1>
          </div>
          <div style="background: #f9fafb; padding: 24px; border-radius: 0 0 12px 12px;">
            <h2 style="color: #166534; margin: 0 0 16px;">Accesso Pannello Docenti</h2>
            <p style="margin: 16px 0; line-height: 1.6;">
              Ciao <strong>${teacher.first_name}</strong>,<br><br>
              Clicca il pulsante qui sotto per accedere al pannello docenti:
            </p>
            <div style="text-align: center; margin: 24px 0;">
              <a href="${magicLink}" style="display: inline-block; background: #16a34a; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">
                🔑 Accedi Ora
              </a>
            </div>
            <p style="font-size: 14px; color: #6b7280; margin-top: 24px;">
              Questo link è valido per 7 giorni e ti darà accesso immediato al sistema.
            </p>
          </div>
        </div>
      `
    });
    
    res.json({ message: 'Magic link inviato con successo' });
    
  } catch (error) {
    console.error('Send magic link error:', error);
    res.status(500).json({ error: 'Errore nell\'invio del magic link' });
  }
});

// Delete teacher
app.delete('/api/admin/teachers/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  
  const teacherId = req.params.id;
  
  try {
    const { rows } = await pool.query(
      'DELETE FROM faculty WHERE id = $1 RETURNING email',
      [teacherId]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Docente non trovato' });
    }
    
    res.json({ message: 'Docente eliminato con successo' });
  } catch (error) {
    console.error('Delete teacher error:', error);
    res.status(500).json({ error: 'Errore nell\'eliminazione del docente' });
  }
});

// Admin: list materials uploaded by teachers (with optional filters)
app.get('/api/admin/teacher-materials', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { status, facultyId, lessonId } = req.query;
    const values = [];
    let idx = 1;
    let where = 'WHERE 1=1';

    if (status) {
      where += ` AND mp.status = $${idx++}`;
      values.push(status);
    }
    if (facultyId) {
      where += ` AND mp.faculty_id = $${idx++}`;
      values.push(facultyId);
    }
    if (lessonId) {
      where += ` AND mp.lesson_id = $${idx++}`;
      values.push(lessonId);
    }

    const { rows } = await pool.query(
      `SELECT mp.id, mp.faculty_id AS "facultyId", mp.lesson_id AS "lessonId",
              mp.file_url AS "fileUrl", mp.file_name AS "fileName", mp.file_type AS "fileType",
              mp.title, mp.description, mp.status, mp.notes, mp.created_at AS "createdAt", mp.updated_at AS "updatedAt",
              f.first_name AS "teacherFirstName", f.last_name AS "teacherLastName", f.email AS "teacherEmail",
              l.title AS "lessonTitle", l.start_datetime AS "lessonStartDateTime"
       FROM materials_pending mp
       LEFT JOIN faculty f ON f.id = mp.faculty_id
       LEFT JOIN lessons l ON l.id = mp.lesson_id
       ${where}
       ORDER BY mp.created_at DESC`,
      values
    );

    res.json(rows);
  } catch (error) {
    console.error('List teacher materials error:', error);
    res.status(500).json({ error: 'Errore nel recupero materiali docenti' });
  }
});

// Admin: approve/reject teacher uploaded material
app.put('/api/admin/teacher-materials/:id/review', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { id } = req.params;
  const { action, notes } = req.body || {};

  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'action must be approve or reject' });
  }
  if (action === 'reject' && (!notes || !String(notes).trim())) {
    return res.status(400).json({ error: 'notes are required when rejecting' });
  }

  try {
    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    const reviewNotes = action === 'reject' ? String(notes).trim() : null;
    await pool.query('BEGIN');
    try {
      const { rows } = await pool.query(
        `UPDATE materials_pending
         SET status = $1::varchar,
             notes = CASE WHEN $1::varchar = 'rejected' THEN $2::text ELSE NULL END,
             updated_at = NOW()
         WHERE id = $3
         RETURNING id, faculty_id AS "facultyId", lesson_id AS "lessonId",
                   file_url AS "fileUrl", file_name AS "fileName", file_type AS "fileType",
                   title, description, status, notes, updated_at AS "updatedAt"`,
        [newStatus, reviewNotes, id]
      );

      if (!rows.length) {
        await pool.query('ROLLBACK');
        return res.status(404).json({ error: 'Material not found' });
      }

      // On approval, publish as resource automatically for students.
      if (action === 'approve') {
        const item = rows[0];
        const resourceTypeFromFile = (mimeOrName = '') => {
          const v = String(mimeOrName).toLowerCase();
          if (v.includes('pdf') || v.endsWith('.pdf')) return 'pdf';
          if (v.includes('video') || v.endsWith('.mp4') || v.endsWith('.mov') || v.endsWith('.webm')) return 'video';
          if (v.includes('audio') || v.endsWith('.mp3') || v.endsWith('.wav')) return 'audio';
          return 'document';
        };
        const resourceType = resourceTypeFromFile(item.fileType || item.fileName);
        const resourceTitle = getTeacherMaterialResourceTitle(item);
        const normalizedFacultyId = await resolveValidFacultyId(item.facultyId, item.lessonId);

        if (normalizedFacultyId !== item.facultyId) {
          await pool.query(
            `UPDATE materials_pending
             SET faculty_id = $1, updated_at = NOW()
             WHERE id = $2`,
            [normalizedFacultyId, item.id]
          );
          item.facultyId = normalizedFacultyId;
        }

        const { rows: existing } = await pool.query(
          `SELECT id FROM resources
           WHERE url = $1
             AND COALESCE(lesson_id::text, '') = COALESCE($2::text, '')
             AND COALESCE(teacher_id::text, '') = COALESCE($3::text, '')
           LIMIT 1`,
          [item.fileUrl, item.lessonId || null, normalizedFacultyId || null]
        );

        let approvedResourceId = null;
        if (existing.length) {
          await pool.query(
            `UPDATE resources
             SET title = $2,
                 description = $3,
                 resource_type = $4,
                 teacher_id = $5,
                 lesson_id = $6,
                 is_published = true,
                 updated_at = NOW()
             WHERE id = $1`,
            [existing[0].id, resourceTitle, item.description || null, resourceType, normalizedFacultyId || null, item.lessonId || null]
          );
          approvedResourceId = existing[0].id;
        } else {
          approvedResourceId = uuidv4();
          await pool.query(
            `INSERT INTO resources
               (id, title, description, resource_type, url, is_published, teacher_id, lesson_id, created_at, updated_at)
             VALUES
               ($1, $2, $3, $4, $5, true, $6, $7, NOW(), NOW())`,
            [approvedResourceId, resourceTitle, item.description || null, resourceType, item.fileUrl, normalizedFacultyId || null, item.lessonId || null]
          );
        }
        await pool.query('COMMIT');
        try {
          await extractAndPersistResourceContent(approvedResourceId, { force: true });
        } catch (extractionError) {
          console.error('Teacher material extraction failed', extractionError);
        }
        return res.json({ success: true, material: rows[0] });
      }

      await pool.query('COMMIT');
      res.json({ success: true, material: rows[0] });
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
  } catch (error) {
    console.error('Review teacher material error:', error);
    res.status(500).json({ error: 'Errore nella revisione del materiale', detail: error.message });
  }
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
      email VARCHAR(255),
      first_name VARCHAR(255),
      last_name VARCHAR(255),
      bio TEXT,
      photo_url TEXT,
      sort_order INTEGER,
      is_published BOOLEAN DEFAULT FALSE,
      is_active BOOLEAN DEFAULT TRUE,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Add profile_link column if it doesn't exist
  await pool.query(`
    ALTER TABLE faculty
    ADD COLUMN IF NOT EXISTS profile_link TEXT;
  `);
  
  // Add email column if it doesn't exist  
  await pool.query(`
    ALTER TABLE faculty
    ADD COLUMN IF NOT EXISTS email VARCHAR(255);
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
    ALTER TABLE blog_posts
    ADD COLUMN IF NOT EXISTS author VARCHAR(255),
    ADD COLUMN IF NOT EXISTS source_module VARCHAR(100),
    ADD COLUMN IF NOT EXISTS cover_image_prompt TEXT,
    ADD COLUMN IF NOT EXISTS reviewer_teacher_id UUID REFERENCES faculty(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS sources JSONB DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb;
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
      course_id UUID REFERENCES courses(id) ON DELETE SET NULL,
      is_published BOOLEAN DEFAULT true,
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

  // Aggiunge colonna materials per file allegati alla lezione
  await pool.query(`
    ALTER TABLE lessons
    ADD COLUMN IF NOT EXISTS materials JSONB DEFAULT '[]'::jsonb;
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

  const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
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

  // ============================================
  // HOTFIX: Ensure attendance_type includes 'remote_partial'
  // (runs idempotently on every cold start)
  // ============================================
  try {
    await pool.query(`
      ALTER TABLE attendance DROP CONSTRAINT IF EXISTS attendance_attendance_type_check;
      ALTER TABLE attendance ADD CONSTRAINT attendance_attendance_type_check
        CHECK (attendance_type IN ('in_person', 'remote_live', 'remote_partial', 'async'));
    `);
    console.log('Attendance type constraint updated (includes remote_partial)');
  } catch (e) {
    console.warn('Could not update attendance_type constraint:', e.message);
  }
}

let initPromise = null;

async function ensureDatabaseInitialized() {
  if (!hasDatabaseUrl) {
    return;
  }

  if (!initPromise) {
    initPromise = (async () => {
      const maxRetries = 4;
      let lastError;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await initDatabase();
          return;
        } catch (error) {
          lastError = error;
          console.warn(`Database init attempt ${attempt}/${maxRetries} failed:`, error.message);
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 1000 * attempt));
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

async function getTableColumns(tableName) {
  const { rows } = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [tableName]
  );
  return new Set(rows.map(row => row.column_name));
}

async function getCourseEditionSchemaConfig() {
  const columns = await getTableColumns('course_editions');
  return {
    hasTotalPlannedHours: columns.has('total_planned_hours'),
    hasMinimumInPersonAttendanceRatio: columns.has('minimum_in_person_attendance_ratio')
  };
}

function buildCourseEditionSelectFragments(config, alias = '') {
  const prefix = alias ? `${alias}.` : '';
  return {
    totalPlannedHours: config.hasTotalPlannedHours
      ? `COALESCE(${prefix}total_planned_hours, 432) AS "totalPlannedHours"`
      : `432 AS "totalPlannedHours"`,
    minimumInPersonAttendanceRatio: config.hasMinimumInPersonAttendanceRatio
      ? `COALESCE(${prefix}minimum_in_person_attendance_ratio, 0.7) AS "minimumInPersonAttendanceRatio"`
      : `0.7 AS "minimumInPersonAttendanceRatio"`
  };
}

function normalizeBoolean(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function buildBlogPostPayload(row, columns = null) {
  const has = (column) => !columns || columns.has(column);
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    excerpt: row.excerpt,
    content: row.content,
    coverImageUrl: row.cover_image_url,
    publishedAt: row.published_at,
    isPublished: row.is_published,
    ...(has('author') ? { author: row.author } : {}),
    ...(has('source_module') ? { sourceModule: row.source_module } : {}),
    ...(has('cover_image_prompt') ? { coverImagePrompt: row.cover_image_prompt } : {}),
    ...(has('reviewer_teacher_id') ? { reviewerTeacherId: row.reviewer_teacher_id } : {}),
    ...(has('sources') ? { sources: Array.isArray(row.sources) ? row.sources : [] } : {}),
    ...(has('tags') ? { tags: Array.isArray(row.tags) ? row.tags : [] } : {})
  };
}

function pickBlogInsertColumns(columns, post) {
  const mappings = [
    ['id', post.id],
    ['title', post.title],
    ['slug', post.slug || null],
    ['excerpt', post.excerpt || null],
    ['content', post.content || null],
    ['cover_image_url', post.coverImageUrl || null],
    ['published_at', post.publishedAt ? new Date(post.publishedAt) : null],
    ['is_published', normalizeBoolean(post.isPublished, false)]
  ];

  if (columns.has('author')) mappings.push(['author', post.author || null]);
  if (columns.has('source_module')) mappings.push(['source_module', post.sourceModule || null]);
  if (columns.has('cover_image_prompt')) mappings.push(['cover_image_prompt', post.coverImagePrompt || null]);
  if (columns.has('reviewer_teacher_id')) mappings.push(['reviewer_teacher_id', post.reviewerTeacherId || null]);
  if (columns.has('sources')) mappings.push(['sources', JSON.stringify(Array.isArray(post.sources) ? post.sources : [])]);
  if (columns.has('tags')) mappings.push(['tags', JSON.stringify(Array.isArray(post.tags) ? post.tags : [])]);

  const insertColumns = mappings.map(([column]) => column);
  const placeholders = mappings.map((_, index) => `$${index + 1}`);
  const values = mappings.map(([, value]) => value);
  return { insertColumns, placeholders, values };
}

function createPublicUploadsPath(...parts) {
  return path.join(__dirname, ...parts);
}

async function saveBlogCoverToStorage(buffer, postId) {
  const fileName = `${postId}-${Date.now()}.png`;

  if (process.env.CLOUDINARY_URL) {
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: 'blog-covers',
          public_id: `${postId}-${Date.now()}`,
          resource_type: 'image'
        },
        (error, result) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(result);
        }
      );
      stream.end(buffer);
    });

    return uploadResult.secure_url || uploadResult.url;
  }

  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const blob = await put(`blog-covers/${fileName}`, buffer, {
      access: 'public',
      token: process.env.BLOB_READ_WRITE_TOKEN,
      addRandomSuffix: false,
      contentType: 'image/png'
    });
    return blob.url;
  }

  if (process.env.VERCEL) {
    throw new Error('Storage cover non configurato su Vercel. Imposta CLOUDINARY_URL oppure BLOB_READ_WRITE_TOKEN.');
  }

  const uploadDir = createPublicUploadsPath('uploads', 'blog-covers');
  await fs.promises.mkdir(uploadDir, { recursive: true });
  const filePath = path.join(uploadDir, fileName);
  await fs.promises.writeFile(filePath, buffer);
  return `/uploads/blog-covers/${fileName}`;
}

async function generateBlogCoverImage(prompt) {
  if (process.env.MOCK_OPENAI_IMAGE_BASE64) {
    return Buffer.from(process.env.MOCK_OPENAI_IMAGE_BASE64, 'base64');
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY non configurata');
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.images.generate({
    model: 'gpt-image-1',
    prompt,
    size: '1536x1024'
  });

  const image = response.data && response.data[0];
  if (!image) {
    throw new Error('Il servizio immagini non ha restituito un risultato');
  }

  if (image.b64_json) {
    return Buffer.from(image.b64_json, 'base64');
  }

  if (image.url) {
    const imageResponse = await fetch(image.url);
    if (!imageResponse.ok) {
      throw new Error('Impossibile scaricare l\'immagine generata');
    }
    return Buffer.from(await imageResponse.arrayBuffer());
  }

  throw new Error('Formato immagine generata non supportato');
}

async function importBlogPostsFromDocxBufferIntoDatabase(buffer, options = {}) {
  const parsed = await parseBlogPostsFromDocxBuffer(buffer, { now: options.now || new Date() });
  const blogColumns = await getTableColumns('blog_posts');
  const createdPosts = [];

  for (const post of parsed.posts) {
    const id = uuidv4();
    const { insertColumns, placeholders, values } = pickBlogInsertColumns(blogColumns, {
      id,
      title: post.title,
      slug: post.slug,
      excerpt: post.excerpt,
      content: post.content,
      coverImageUrl: post.coverImageUrl,
      publishedAt: post.publishedAt,
      isPublished: false,
      author: post.author,
      sourceModule: post.sourceModule,
      coverImagePrompt: post.coverImagePrompt,
      sources: post.sources,
      tags: post.tags
    });

    const insertQuery = `
      INSERT INTO blog_posts (${insertColumns.join(', ')})
      VALUES (${placeholders.join(', ')})
      RETURNING *
    `;
    const { rows } = await pool.query(insertQuery, values);
    createdPosts.push(buildBlogPostPayload(rows[0], blogColumns));
  }

  return {
    imported: createdPosts.length,
    warnings: parsed.warnings,
    posts: createdPosts
  };
}

async function generateCoverForBlogPost(postId) {
  const blogColumns = await getTableColumns('blog_posts');
  if (!blogColumns.has('cover_image_prompt')) {
    throw new Error('La colonna cover_image_prompt non è disponibile. Applica la migration del blog import.');
  }

  const { rows } = await pool.query(
    'SELECT * FROM blog_posts WHERE id = $1 LIMIT 1',
    [postId]
  );

  if (!rows.length) {
    const error = new Error('Blog post not found');
    error.status = 404;
    throw error;
  }

  const post = rows[0];
  if (post.cover_image_url) {
    return { coverImageUrl: post.cover_image_url, reused: true };
  }
  if (!post.cover_image_prompt) {
    const error = new Error('Nessun prompt cover salvato per questo articolo');
    error.status = 400;
    throw error;
  }

  const imageBuffer = await generateBlogCoverImage(post.cover_image_prompt);
  const coverImageUrl = await saveBlogCoverToStorage(imageBuffer, post.id);

  await pool.query(
    'UPDATE blog_posts SET cover_image_url = $2, updated_at = NOW() WHERE id = $1',
    [post.id, coverImageUrl]
  );

  return { coverImageUrl, reused: false };
}

function decodeXmlEntities(text = '') {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)));
}

function normalizeExtractedText(text = '') {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/\u0000/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function truncateText(text = '', maxChars = 6000) {
  const normalized = normalizeExtractedText(text);
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars).trim() + '\n[contenuto troncato]';
}

function guessUrlExtension(url = '') {
  try {
    const parsed = new URL(url);
    return path.extname(parsed.pathname || '').toLowerCase();
  } catch (_error) {
    return path.extname(String(url).split('?')[0] || '').toLowerCase();
  }
}

function stripHtml(html = '') {
  return normalizeExtractedText(
    decodeXmlEntities(
      String(html)
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
    )
  );
}

let pdfParseModulePromise = null;

async function getPdfParse() {
  if (!pdfParseModulePromise) {
    pdfParseModulePromise = import('pdf-parse').then(mod => mod.default || mod);
  }
  return pdfParseModulePromise;
}

function stripTimedText(text = '') {
  return normalizeExtractedText(
    String(text)
      .replace(/^WEBVTT.*$/gim, '')
      .replace(/^\d+\s*$/gim, '')
      .replace(/^\d{2}:\d{2}:\d{2}[,\.]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[,\.]\d{3}.*$/gim, '')
      .replace(/^\d{2}:\d{2}[,\.]\d{3}\s+-->\s+\d{2}:\d{2}[,\.]\d{3}.*$/gim, '')
  );
}

function xmlNodesToText(xml = '', tagPattern) {
  const matches = [];
  let match;
  while ((match = tagPattern.exec(xml)) !== null) {
    matches.push(decodeXmlEntities(match[1]));
  }
  return normalizeExtractedText(matches.join('\n'));
}

async function extractDocxText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const candidates = Object.keys(zip.files)
    .filter(name => /^word\/(document|header\d+|footer\d+)\.xml$/.test(name))
    .sort();
  const chunks = [];
  for (const name of candidates) {
    const xml = await zip.files[name].async('string');
    const text = xmlNodesToText(xml, /<w:t[^>]*>([\s\S]*?)<\/w:t>/g);
    if (text) chunks.push(text);
  }
  return normalizeExtractedText(chunks.join('\n\n'));
}

async function extractPptxText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const aNum = Number(a.match(/slide(\d+)\.xml$/)?.[1] || 0);
      const bNum = Number(b.match(/slide(\d+)\.xml$/)?.[1] || 0);
      return aNum - bNum;
    });
  const chunks = [];
  for (const name of slideFiles) {
    const xml = await zip.files[name].async('string');
    const text = xmlNodesToText(xml, /<a:t>([\s\S]*?)<\/a:t>/g);
    if (text) chunks.push(text);
  }
  return normalizeExtractedText(chunks.join('\n\n'));
}

async function extractXlsxText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const sharedStringsXml = zip.file('xl/sharedStrings.xml')
    ? await zip.file('xl/sharedStrings.xml').async('string')
    : '';
  const sharedStrings = [];
  let sharedMatch;
  const sharedRegex = /<t[^>]*>([\s\S]*?)<\/t>/g;
  while ((sharedMatch = sharedRegex.exec(sharedStringsXml)) !== null) {
    sharedStrings.push(decodeXmlEntities(sharedMatch[1]));
  }

  const sheetFiles = Object.keys(zip.files)
    .filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort();
  const chunks = [];
  for (const name of sheetFiles) {
    const xml = await zip.files[name].async('string');
    const values = [];
    let cellMatch;
    const cellRegex = /<c\b[^>]*?(?: t="([^"]+)")?[^>]*>([\s\S]*?)<\/c>/g;
    while ((cellMatch = cellRegex.exec(xml)) !== null) {
      const cellType = cellMatch[1];
      const body = cellMatch[2];
      const vMatch = body.match(/<v>([\s\S]*?)<\/v>/);
      if (!vMatch) continue;
      const rawValue = decodeXmlEntities(vMatch[1]);
      if (cellType === 's') {
        const idx = Number(rawValue);
        if (Number.isInteger(idx) && sharedStrings[idx]) values.push(sharedStrings[idx]);
      } else {
        values.push(rawValue);
      }
    }
    const text = normalizeExtractedText(values.join('\n'));
    if (text) chunks.push(text);
  }
  return normalizeExtractedText(chunks.join('\n\n'));
}

function parseQuizDataUrl(url = '') {
  if (!String(url).startsWith('data:application/json,')) return null;
  try {
    return JSON.parse(decodeURIComponent(String(url).slice('data:application/json,'.length)));
  } catch (_error) {
    return null;
  }
}

function extractQuizTextFromResourceUrl(url = '') {
  const payload = parseQuizDataUrl(url);
  if (!payload) return '';
  try {
    const parts = [];
    if (payload.title) parts.push(`Titolo quiz: ${payload.title}`);
    (payload.questions || []).forEach((question, index) => {
      parts.push(`Domanda ${index + 1}: ${question.questionText || ''}`);
      (question.options || []).forEach((option, optionIndex) => {
        parts.push(`Opzione ${optionIndex + 1}: ${option}`);
      });
      if (question.correctAnswer) {
        parts.push(`Risposta corretta: ${Array.isArray(question.correctAnswer) ? question.correctAnswer.join(', ') : question.correctAnswer}`);
      }
    });
    return normalizeExtractedText(parts.join('\n'));
  } catch (_error) {
    return '';
  }
}

async function fetchUrlBuffer(url) {
  const resolvedUrl = String(url).startsWith('/')
    ? new URL(url, process.env.PUBLIC_BASE_URL || 'https://unitus.carbonfarmingmaster.it').toString()
    : url;
  const response = await fetch(resolvedUrl);
  if (!response.ok) {
    throw new Error(`Unable to fetch source (${response.status})`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: response.headers.get('content-type') || ''
  };
}

async function extractTextFromUrl(url, resourceType = null) {
  const ext = guessUrlExtension(url);
  const { buffer, contentType } = await fetchUrlBuffer(url);
  const lowerType = String(contentType).toLowerCase();

  if (ext === '.pdf' || lowerType.includes('application/pdf')) {
    const pdfParse = await getPdfParse();
    const parsed = await pdfParse(buffer);
    return { text: parsed.text || '', metadata: { strategy: 'pdf', contentType } };
  }
  if (ext === '.docx') {
    return { text: await extractDocxText(buffer), metadata: { strategy: 'docx', contentType } };
  }
  if (ext === '.pptx') {
    return { text: await extractPptxText(buffer), metadata: { strategy: 'pptx', contentType } };
  }
  if (ext === '.xlsx') {
    return { text: await extractXlsxText(buffer), metadata: { strategy: 'xlsx', contentType } };
  }
  if (['.txt', '.md', '.csv'].includes(ext) || lowerType.startsWith('text/plain') || lowerType.includes('text/csv')) {
    return { text: buffer.toString('utf8'), metadata: { strategy: 'plain_text', contentType } };
  }
  if (['.srt', '.vtt'].includes(ext)) {
    return { text: stripTimedText(buffer.toString('utf8')), metadata: { strategy: 'timed_text', contentType } };
  }
  if (lowerType.includes('text/html') || ext === '.html' || ext === '.htm') {
    return { text: stripHtml(buffer.toString('utf8')), metadata: { strategy: 'html', contentType } };
  }
  if (resourceType === 'link') {
    return { text: stripHtml(buffer.toString('utf8')), metadata: { strategy: 'link_html_fallback', contentType } };
  }

  return { text: '', metadata: { strategy: 'unsupported', contentType, extension: ext } };
}

async function getLatestWorkflowTranscriptForLesson(lmsLessonId) {
  if (!lmsLessonId) return '';
  const { rows } = await pool.query(`
    SELECT transcript_text AS "transcriptText", transcript_url AS "transcriptUrl"
    FROM content_workflow
    WHERE lms_lesson_id = $1
      AND (transcript_text IS NOT NULL OR transcript_url IS NOT NULL)
      AND stage IN ('transcript_ready', 'teacher_review_transcript', 'avatar_rendering', 'teacher_review_video', 'published')
    ORDER BY updated_at DESC NULLS LAST, created_at DESC
    LIMIT 1
  `, [lmsLessonId]);
  const row = rows[0];
  const transcriptText = normalizeExtractedText(row?.transcriptText || '');
  if (transcriptText) return transcriptText;
  if (row?.transcriptUrl) {
    try {
      const extracted = await extractTextFromUrl(row.transcriptUrl, 'document');
      return normalizeExtractedText(extracted.text);
    } catch (_error) {
      return '';
    }
  }
  return '';
}

async function getLatestWorkflowTranscriptForCalendarLesson(calendarLessonId) {
  if (!calendarLessonId) return '';
  const { rows } = await pool.query(`
    SELECT cw.transcript_text AS "transcriptText", cw.transcript_url AS "transcriptUrl"
    FROM content_workflow cw
    JOIN lms_lessons ll ON ll.id = cw.lms_lesson_id
    WHERE ll.calendar_lesson_id = $1
      AND (cw.transcript_text IS NOT NULL OR cw.transcript_url IS NOT NULL)
      AND cw.stage IN ('transcript_ready', 'teacher_review_transcript', 'avatar_rendering', 'teacher_review_video', 'published')
    ORDER BY cw.updated_at DESC NULLS LAST, cw.created_at DESC
    LIMIT 1
  `, [calendarLessonId]);
  const row = rows[0];
  const transcriptText = normalizeExtractedText(row?.transcriptText || '');
  if (transcriptText) return transcriptText;
  if (row?.transcriptUrl) {
    try {
      const extracted = await extractTextFromUrl(row.transcriptUrl, 'document');
      return normalizeExtractedText(extracted.text);
    } catch (_error) {
      return '';
    }
  }
  return '';
}

async function persistResourceExtraction(resourceId, { text, status, metadata, error }) {
  await pool.query(
    `UPDATE resources
     SET extracted_text = $2,
         extraction_status = $3,
         extraction_metadata = $4::jsonb,
         extracted_at = CASE WHEN $3 = 'ready' THEN NOW() ELSE extracted_at END,
         updated_at = NOW()
     WHERE id = $1`,
    [
      resourceId,
      text || null,
      status,
      JSON.stringify({
        ...(metadata || {}),
        ...(error ? { error: error.message || String(error) } : {})
      })
    ]
  );
}

async function extractAndPersistResourceContent(resourceId, options = {}) {
  const { force = false } = options;
  const { rows } = await pool.query(`
    SELECT id, title, resource_type AS "resourceType", url, lesson_id AS "lessonId",
           extracted_text AS "extractedText", extraction_status AS "extractionStatus"
    FROM resources
    WHERE id = $1
  `, [resourceId]);
  if (!rows.length) return null;

  const resource = rows[0];
  if (!force && resource.extractionStatus === 'ready' && resource.extractedText) {
    return resource.extractedText;
  }

  try {
    let text = '';
    let metadata = {};

    if (resource.resourceType === 'quiz') {
      text = extractQuizTextFromResourceUrl(resource.url);
      metadata = { strategy: 'quiz_data_url' };
    } else if ((resource.resourceType === 'video' || resource.resourceType === 'audio') && resource.lessonId) {
      text = await getLatestWorkflowTranscriptForCalendarLesson(resource.lessonId);
      metadata = { strategy: 'workflow_transcript', calendarLessonId: resource.lessonId };
      if (!text && resource.url) {
        const extracted = await extractTextFromUrl(resource.url, resource.resourceType);
        text = extracted.text;
        metadata = extracted.metadata;
      }
    } else if (resource.url) {
      const extracted = await extractTextFromUrl(resource.url, resource.resourceType);
      text = extracted.text;
      metadata = extracted.metadata;
    }

    text = normalizeExtractedText(text);
    const status = text ? 'ready' : 'unavailable';
    await persistResourceExtraction(resourceId, { text, status, metadata });
    return text;
  } catch (error) {
    await persistResourceExtraction(resourceId, { text: null, status: 'failed', metadata: {}, error });
    return '';
  }
}

async function getResourceQuizSourceText(resource) {
  let text = normalizeExtractedText(resource.extractedText || '');
  if (!text && resource.id) {
    text = await extractAndPersistResourceContent(resource.id);
  }
  return normalizeExtractedText(text);
}

function appendContextSection(sections, title, text, options = {}) {
  const { perSectionLimit = 5000, totalLimit = 35000, tracker = { total: 0 } } = options;
  const cleaned = truncateText(text, perSectionLimit);
  if (!cleaned) return;
  if (tracker.total >= totalLimit) return;
  const remaining = totalLimit - tracker.total;
  const finalText = cleaned.length > remaining ? truncateText(cleaned, remaining) : cleaned;
  if (!finalText) return;
  sections.push(`${title}:\n${finalText}`);
  tracker.total += finalText.length;
}

function summarizePreview(text = '', maxChars = 240) {
  const cleaned = normalizeExtractedText(text).replace(/\n/g, ' ');
  if (!cleaned) return '';
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, maxChars).trim() + '...';
}

async function getLessonCompletionStatus(lessonId, userId, preloaded = {}) {
  const lesson = preloaded.lesson || (await pool.query(
    'SELECT id, lms_module_id AS "moduleId", duration_seconds AS "durationSeconds", calendar_lesson_id AS "calendarLessonId" FROM lms_lessons WHERE id = $1',
    [lessonId]
  )).rows[0];

  if (!lesson) {
    const error = new Error('Lesson not found');
    error.statusCode = 404;
    throw error;
  }

  const progress = preloaded.progress || (await pool.query(
    'SELECT progress_percent, time_spent_seconds, completed_at FROM lesson_progress WHERE user_id = $1 AND lms_lesson_id = $2',
    [userId, lessonId]
  )).rows[0] || null;

  const videoPercent = Number(progress?.progress_percent || 0);
  const videoOk = videoPercent >= 80;

  const { rows: materialRows } = lesson.calendarLessonId
    ? await pool.query(`
      SELECT COUNT(DISTINCT r.id)::int AS "materialTotal",
             COUNT(DISTINCT rv.resource_id)::int AS "materialViewed",
             COALESCE(array_agg(DISTINCT rv.resource_id) FILTER (WHERE rv.resource_id IS NOT NULL), '{}') AS "viewedResourceIds"
      FROM resources r
      LEFT JOIN resource_views rv ON rv.resource_id = r.id AND rv.user_id = $2
      WHERE r.lesson_id = $1
        AND r.is_published = true
        AND r.resource_type <> 'quiz'
    `, [lesson.calendarLessonId, userId])
    : [{ rows: [{ materialTotal: 0, materialViewed: 0, viewedResourceIds: [] }] }][0];
  const materialTotal = Number(materialRows[0]?.materialTotal || 0);
  const materialViewed = Number(materialRows[0]?.materialViewed || 0);
  const viewedResourceIds = Array.isArray(materialRows[0]?.viewedResourceIds) ? materialRows[0].viewedResourceIds.filter(Boolean) : [];
  const materialsOk = materialTotal === 0 || (materialViewed / materialTotal) >= 0.50;

  const { rows: quizRows } = await pool.query(`
    SELECT id
    FROM quizzes
    WHERE is_published = true
      AND (lms_lesson_id = $1 OR lms_module_id = $2)
    ORDER BY CASE WHEN lms_lesson_id = $1 THEN 0 ELSE 1 END, created_at ASC
  `, [lessonId, lesson.moduleId]);
  const quizIds = quizRows.map(row => row.id);

  let quizBestScore = null;
  let quizOk = true;
  if (quizIds.length) {
    const { rows: attemptRows } = await pool.query(
      'SELECT MAX(score)::int AS "bestScore" FROM quiz_attempts WHERE user_id = $1 AND quiz_id = ANY($2) AND completed_at IS NOT NULL',
      [userId, quizIds]
    );
    quizBestScore = attemptRows[0]?.bestScore === null || attemptRows[0]?.bestScore === undefined
      ? null
      : Number(attemptRows[0].bestScore);
    quizOk = (quizBestScore ?? -1) >= 70;
  }

  const criteria = { video: videoOk, materials: materialsOk, quiz: quizOk };
  const details = {
    videoPercent,
    videoRequired: 80,
    materialViewed,
    materialTotal,
    materialRequiredPercent: 50,
    quizBestScore,
    quizRequired: quizIds.length ? 70 : null,
    hasQuiz: quizIds.length > 0,
    viewedResourceIds
  };

  return {
    criteria,
    details,
    allMet: videoOk && materialsOk && quizOk,
    completedAt: progress?.completed_at || null
  };
}

function buildGenerationSource({ kind, title, resourceType = null, extractionStatus = null, preview = '', note = null }) {
  return {
    kind,
    title,
    resourceType,
    extractionStatus,
    preview: summarizePreview(preview),
    note: note || null
  };
}

async function buildLessonQuizGenerationContext(lessonId) {
  const { rows: lessons } = await pool.query(
    `SELECT ll.id, ll.title, ll.description, ll.materials, ll.calendar_lesson_id AS "calendarLessonId",
            cal.title AS "calendarLessonTitle", cal.notes
     FROM lms_lessons ll
     LEFT JOIN lessons cal ON cal.id = ll.calendar_lesson_id
     WHERE ll.id = $1`,
    [lessonId]
  );
  if (!lessons.length) {
    const error = new Error('Lezione non trovata');
    error.statusCode = 404;
    throw error;
  }

  const lesson = lessons[0];
  const contextTitle = lesson.title || lesson.calendarLessonTitle || 'Lezione';
  const sections = [];
  const tracker = { total: 0 };
  const sources = [];
  appendContextSection(sections, `Lezione`, [
    `Titolo: ${contextTitle}`,
    lesson.description ? `Descrizione: ${lesson.description}` : '',
    lesson.notes ? `Note docente: ${lesson.notes}` : ''
  ].filter(Boolean).join('\n'), { tracker, perSectionLimit: 3000, totalLimit: 40000 });

  const transcriptText = await getLatestWorkflowTranscriptForLesson(lessonId);
  appendContextSection(sections, 'Trascrizione video lezione', transcriptText, {
    tracker,
    perSectionLimit: 12000,
    totalLimit: 40000
  });
  if (transcriptText) {
    sources.push(buildGenerationSource({
      kind: 'transcript',
      title: `Trascrizione video - ${contextTitle}`,
      resourceType: 'video',
      extractionStatus: 'ready',
      preview: transcriptText
    }));
  }

  const { rows: resourceRows } = lesson.calendarLessonId
    ? await pool.query(`
        SELECT id, title, resource_type AS "resourceType", url,
               extracted_text AS "extractedText", extraction_status AS "extractionStatus"
        FROM resources
        WHERE lesson_id = $1
          AND resource_type <> 'quiz'
        ORDER BY sort_order NULLS LAST, created_at
      `, [lesson.calendarLessonId])
    : { rows: [] };

  const resourceTextsByUrl = new Map();
  for (const resource of resourceRows) {
    const text = await getResourceQuizSourceText(resource);
    if (!text) continue;
    resourceTextsByUrl.set(resource.url, text);
    sources.push(buildGenerationSource({
      kind: 'resource',
      title: resource.title,
      resourceType: resource.resourceType,
      extractionStatus: resource.extractionStatus || (text ? 'ready' : 'unavailable'),
      preview: text
    }));
    appendContextSection(sections, `Materiale: ${resource.title} (${resource.resourceType})`, text, {
      tracker,
      perSectionLimit: 7000,
      totalLimit: 40000
    });
  }

  const lessonMaterials = Array.isArray(lesson.materials) ? lesson.materials : [];
  for (const material of lessonMaterials) {
    if (!material || !material.url || material.type === 'quiz' || resourceTextsByUrl.has(material.url)) continue;
    try {
      const extracted = await extractTextFromUrl(material.url, material.type || null);
      if (normalizeExtractedText(extracted.text)) {
        sources.push(buildGenerationSource({
          kind: 'lesson_material',
          title: material.name || material.url,
          resourceType: material.type || 'document',
          extractionStatus: 'ready',
          preview: extracted.text
        }));
      }
      appendContextSection(sections, `Materiale lezione: ${material.name || material.url}`, extracted.text, {
        tracker,
        perSectionLimit: 5000,
        totalLimit: 40000
      });
    } catch (error) {
      appendContextSection(sections, `Materiale lezione: ${material.name || material.url}`, [
        `Tipo: ${material.type || 'file'}`,
        `URL: ${material.url}`
      ].join('\n'), { tracker, perSectionLimit: 1200, totalLimit: 40000 });
    }
  }

  return {
    contextTitle,
    context: sections.join('\n\n'),
    generationReport: {
      mode: 'lesson',
      contextTitle,
      sourceCount: sources.length,
      sources
    }
  };
}

async function buildModuleQuizGenerationContext(moduleId) {
  const { rows: modRows } = await pool.query('SELECT name AS title FROM modules WHERE id = $1', [moduleId]);
  if (!modRows.length) {
    const error = new Error('Modulo non trovato');
    error.statusCode = 404;
    throw error;
  }

  const contextTitle = modRows[0].title;
  const { rows: lessons } = await pool.query(`
    SELECT ll.id, ll.title, ll.description, ll.materials,
           ll.calendar_lesson_id AS "calendarLessonId",
           cal.title AS "calendarLessonTitle", cal.notes
    FROM lms_lessons ll
    LEFT JOIN lessons cal ON cal.id = ll.calendar_lesson_id
    WHERE ll.lms_module_id = $1
    ORDER BY ll.sort_order
  `, [moduleId]);

  const sections = [];
  const tracker = { total: 0 };
  const sources = [];
  appendContextSection(sections, 'Modulo', `Titolo modulo: ${contextTitle}`, {
    tracker,
    perSectionLimit: 2000,
    totalLimit: 50000
  });

  for (const lesson of lessons) {
    appendContextSection(sections, `Lezione del modulo: ${lesson.title}`, [
      lesson.description ? `Descrizione: ${lesson.description}` : '',
      lesson.notes ? `Note docente: ${lesson.notes}` : ''
    ].filter(Boolean).join('\n'), { tracker, perSectionLimit: 2500, totalLimit: 50000 });

    const transcriptText = await getLatestWorkflowTranscriptForLesson(lesson.id);
    appendContextSection(sections, `Trascrizione video: ${lesson.title}`, transcriptText, {
      tracker,
      perSectionLimit: 6000,
      totalLimit: 50000
    });
    if (transcriptText) {
      sources.push(buildGenerationSource({
        kind: 'transcript',
        title: `Trascrizione video - ${lesson.title}`,
        resourceType: 'video',
        extractionStatus: 'ready',
        preview: transcriptText
      }));
    }

    const resourceTextsByUrl = new Map();
    if (lesson.calendarLessonId) {
      const { rows: resourceRows } = await pool.query(`
        SELECT id, title, resource_type AS "resourceType", url,
               extracted_text AS "extractedText", extraction_status AS "extractionStatus"
        FROM resources
        WHERE lesson_id = $1
          AND resource_type <> 'quiz'
        ORDER BY sort_order NULLS LAST, created_at
      `, [lesson.calendarLessonId]);

      for (const resource of resourceRows) {
        const text = await getResourceQuizSourceText(resource);
        if (text) resourceTextsByUrl.set(resource.url, text);
        if (text) {
          sources.push(buildGenerationSource({
            kind: 'resource',
            title: `${lesson.title} / ${resource.title}`,
            resourceType: resource.resourceType,
            extractionStatus: resource.extractionStatus || 'ready',
            preview: text
          }));
        }
        appendContextSection(sections, `Fonte modulo: ${lesson.title} / ${resource.title}`, text, {
          tracker,
          perSectionLimit: 4000,
          totalLimit: 50000
        });
      }
    }

    const lessonMaterials = Array.isArray(lesson.materials) ? lesson.materials : [];
    for (const material of lessonMaterials) {
      if (!material || !material.url || material.type === 'quiz' || resourceTextsByUrl.has(material.url)) continue;
      try {
        const extracted = await extractTextFromUrl(material.url, material.type || null);
        if (normalizeExtractedText(extracted.text)) {
          sources.push(buildGenerationSource({
            kind: 'lesson_material',
            title: `${lesson.title} / ${material.name || material.url}`,
            resourceType: material.type || 'document',
            extractionStatus: 'ready',
            preview: extracted.text
          }));
        }
        appendContextSection(sections, `Materiale modulo: ${lesson.title} / ${material.name || material.url}`, extracted.text, {
          tracker,
          perSectionLimit: 3500,
          totalLimit: 50000
        });
      } catch (_error) {
        appendContextSection(sections, `Materiale modulo: ${lesson.title} / ${material.name || material.url}`, [
          `Tipo: ${material.type || 'file'}`,
          `URL: ${material.url}`
        ].join('\n'), { tracker, perSectionLimit: 800, totalLimit: 50000 });
      }
    }
  }

  return {
    contextTitle,
    context: sections.join('\n\n'),
    generationReport: {
      mode: 'module',
      contextTitle,
      sourceCount: sources.length,
      sources
    }
  };
}

async function getLmsQuizResourceContext(quizId) {
  const quizColumns = await getTableColumns('quizzes');
  const hasGenerationReport = quizColumns.has('generation_report');
  const { rows: quizRows } = await pool.query(`
    SELECT q.id, q.lms_module_id AS "moduleId", q.lms_lesson_id AS "lessonId",
           q.resource_id AS "resourceId", q.title, q.description,
           q.passing_score AS "passingScore", q.max_attempts AS "maxAttempts",
           q.time_limit_minutes AS "timeLimitMinutes", q.is_published AS "isPublished",
           ${hasGenerationReport ? `q.generation_report AS "generationReport",` : `NULL::jsonb AS "generationReport",`}
           ll.title AS "lessonTitle", ll.description AS "lessonDescription",
           ll.calendar_lesson_id AS "calendarLessonId",
           cal.title AS "calendarLessonTitle", cal.teacher_id AS "calendarTeacherId",
           m.name AS "moduleTitle"
    FROM quizzes q
    LEFT JOIN lms_lessons ll ON ll.id = q.lms_lesson_id
    LEFT JOIN lessons cal ON cal.id = ll.calendar_lesson_id
    LEFT JOIN modules m ON m.id = q.lms_module_id
    WHERE q.id = $1
  `, [quizId]);
  if (!quizRows.length) return null;

  const quiz = quizRows[0];
  const { rows: questionRows } = await pool.query(`
    SELECT id, question_text AS "questionText", question_type AS "questionType",
           options, correct_answer AS "correctAnswer", points, sort_order AS "sortOrder"
    FROM quiz_questions
    WHERE quiz_id = $1
    ORDER BY sort_order ASC, created_at ASC
  `, [quizId]);

  let teacherId = quiz.calendarTeacherId || null;
  if (!teacherId && quiz.moduleId) {
    const { rows: teacherRows } = await pool.query(`
      SELECT DISTINCT cal.teacher_id AS "teacherId"
      FROM lms_lessons ll
      JOIN lessons cal ON cal.id = ll.calendar_lesson_id
      WHERE ll.lms_module_id = $1
        AND cal.teacher_id IS NOT NULL
    `, [quiz.moduleId]);
    if (teacherRows.length === 1) {
      teacherId = teacherRows[0].teacherId;
    }
  }

  const title = quiz.title || (quiz.lessonTitle ? `Quiz di verifica - ${quiz.lessonTitle}` : `Quiz Modulo - ${quiz.moduleTitle || 'Modulo'}`);
  const descriptor = quiz.lessonTitle
    ? `Quiz LMS collegato alla lezione: ${quiz.lessonTitle}`
    : `Quiz LMS collegato al modulo: ${quiz.moduleTitle || 'Modulo'}`;
  const quizData = {
    source: 'lms_quiz',
    quizId: quiz.id,
    moduleId: quiz.moduleId || null,
    lessonId: quiz.lessonId || null,
    title,
    description: quiz.description || null,
    passingScore: quiz.passingScore,
    maxAttempts: quiz.maxAttempts,
    timeLimitMinutes: quiz.timeLimitMinutes,
    generationReport: quiz.generationReport || null,
    questions: questionRows,
    updatedAt: new Date().toISOString()
  };

  return {
    quiz,
    questionRows,
    resourcePayload: {
      title,
      description: quiz.description || descriptor,
      resourceType: 'quiz',
      url: 'data:application/json,' + encodeURIComponent(JSON.stringify(quizData)),
      isPublished: Boolean(quiz.isPublished),
      teacherId,
      // Lesson quizzes use a backing resource only for teacher review workflow.
      // They must not surface again as linked lesson resources in the student UI.
      lessonId: quiz.lessonId ? null : (quiz.calendarLessonId || null)
    }
  };
}

async function syncQuizResource(quizId) {
  const context = await getLmsQuizResourceContext(quizId);
  if (!context) return null;

  const { quiz, resourcePayload } = context;
  let resourceId = quiz.resourceId || null;

  if (resourceId) {
    const { rows } = await pool.query(`
      UPDATE resources
      SET title = $2,
          description = $3,
          resource_type = $4,
          url = $5,
          is_published = $6,
          teacher_id = $7,
          lesson_id = $8,
          updated_at = NOW()
      WHERE id = $1
      RETURNING id
    `, [
      resourceId,
      resourcePayload.title,
      resourcePayload.description,
      resourcePayload.resourceType,
      resourcePayload.url,
      resourcePayload.isPublished,
      resourcePayload.teacherId || null,
      resourcePayload.lessonId || null
    ]);
    if (rows.length) {
      await extractAndPersistResourceContent(rows[0].id, { force: true });
      return rows[0].id;
    }
  }

  resourceId = uuidv4();
  await pool.query(`
    INSERT INTO resources (
      id, title, description, resource_type, url, is_published, teacher_id, lesson_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [
    resourceId,
    resourcePayload.title,
    resourcePayload.description,
    resourcePayload.resourceType,
    resourcePayload.url,
    resourcePayload.isPublished,
    resourcePayload.teacherId || null,
    resourcePayload.lessonId || null
  ]);

  await pool.query('UPDATE quizzes SET resource_id = $2, updated_at = NOW() WHERE id = $1', [quizId, resourceId]);
  await extractAndPersistResourceContent(resourceId, { force: true });
  return resourceId;
}

async function syncQuizIntoLessonMaterials(quizId) {
  const context = await getLmsQuizResourceContext(quizId);
  if (!context) return null;

  const { quiz } = context;
  if (!quiz.lessonId) return null;

  const { rows: lessonRows } = await pool.query(
    'SELECT materials FROM lms_lessons WHERE id = $1',
    [quiz.lessonId]
  );
  if (!lessonRows.length) return null;

  const currentMaterials = Array.isArray(lessonRows[0].materials) ? lessonRows[0].materials : [];
  const quizUrl = `/learn/quiz.html?quizId=${quiz.id}`;
  const nextMaterials = currentMaterials.filter(item => {
    if (!item) return true;
    if (item.quizId === quiz.id) return false;
    if (quiz.resourceId && item.resourceId === quiz.resourceId) return false;
    if (item.url === quizUrl) return false;
    if (item.type === 'quiz') return false;
    return true;
  });

  await pool.query(
    'UPDATE lms_lessons SET materials = $2, updated_at = NOW() WHERE id = $1',
    [quiz.lessonId, JSON.stringify(nextMaterials)]
  );
  return null;
}

async function ensureLessonQuizTeacherReviewState(quizId) {
  const context = await getLmsQuizResourceContext(quizId);
  if (!context) return null;

  const { quiz, resourcePayload } = context;
  if (!quiz.lessonId || !quiz.resourceId) return null;

  const resourceColumns = await getTableColumns('resources');
  if (!resourceColumns.has('teacher_id')) return null;

  const setClauses = [
    'teacher_id = COALESCE($2, teacher_id)',
    'is_published = false',
    'updated_at = NOW()'
  ];
  const values = [quiz.resourceId, resourcePayload.teacherId || null];

  if (resourceColumns.has('review_status')) {
    setClauses.push(`review_status = 'pending_teacher_approval'`);
  }
  if (resourceColumns.has('teacher_review_notes')) {
    setClauses.push('teacher_review_notes = NULL');
  }
  if (resourceColumns.has('teacher_reviewed_at')) {
    setClauses.push('teacher_reviewed_at = NULL');
  }

  await pool.query(
    `UPDATE resources
     SET ${setClauses.join(', ')}
     WHERE id = $1`,
    values
  );

  await pool.query(
    `UPDATE quizzes
     SET is_published = false,
         updated_at = NOW()
     WHERE id = $1`,
    [quizId]
  );

  return quiz.resourceId;
}

async function removeQuizFromLessonMaterials(quizId) {
  const { rows: quizRows } = await pool.query(
    'SELECT id, lms_lesson_id AS "lessonId", resource_id AS "resourceId" FROM quizzes WHERE id = $1',
    [quizId]
  );
  if (!quizRows.length || !quizRows[0].lessonId) return;

  const quiz = quizRows[0];
  const { rows: lessonRows } = await pool.query(
    'SELECT materials FROM lms_lessons WHERE id = $1',
    [quiz.lessonId]
  );
  if (!lessonRows.length) return;

  const currentMaterials = Array.isArray(lessonRows[0].materials) ? lessonRows[0].materials : [];
  const quizUrl = `/learn/quiz.html?quizId=${quiz.id}`;
  const nextMaterials = currentMaterials.filter(item => {
    if (!item) return true;
    if (item.quizId === quiz.id) return false;
    if (quiz.resourceId && item.resourceId === quiz.resourceId) return false;
    if (item.url === quizUrl) return false;
    if (item.type === 'quiz') return false;
    return true;
  });

  await pool.query(
    'UPDATE lms_lessons SET materials = $2, updated_at = NOW() WHERE id = $1',
    [quiz.lessonId, JSON.stringify(nextMaterials)]
  );
}

// Whitelist colonne aggiornabili per tabella (sicurezza)
const ALLOWED_UPDATE_FIELDS = {
  faculty: ['name', 'first_name', 'last_name', 'role', 'email', 'bio', 'photo_url', 'profile_link', 'sort_order', 'is_published', 'is_active', 'can_view_all_materials'],
  blog_posts: ['title', 'slug', 'content', 'excerpt', 'cover_image_url', 'author', 'source_module', 'cover_image_prompt', 'reviewer_teacher_id', 'sources', 'tags', 'is_published', 'published_at'],
  partners: ['name', 'logo_url', 'website_url', 'category', 'sort_order', 'is_visible'],
  modules: ['name', 'ssd', 'cfu', 'hours', 'description', 'sort_order', 'course_id', 'is_published'],
  lessons: ['title', 'module_id', 'teacher_id', 'external_teacher_name', 'start_datetime', 'duration_minutes', 'location_physical', 'location_remote', 'status', 'notes', 'materials'],
  courses: ['title', 'slug', 'description', 'cover_image_url', 'is_published'],
  course_editions: ['edition_name', 'course_id', 'start_date', 'end_date', 'max_students', 'is_active'],
  lms_lessons: ['title', 'description', 'video_url', 'duration_minutes', 'sort_order', 'is_published', 'calendar_lesson_id'],
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
    const { published, role } = req.query;
    const filters = [];
    const values = [];

    if (published !== undefined) {
      filters.push(`is_published = $${filters.length + 1}`);
      values.push(published === 'true');
    }

    if (role) {
      filters.push(`LOWER(COALESCE(role, '')) LIKE $${filters.length + 1}`);
      values.push(`%${String(role).trim().toLowerCase()}%`);
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const sql = `
      SELECT id, name, role, email, bio, photo_url AS "photoUrl", profile_link AS "profileLink", sort_order AS "sortOrder", is_published AS "isPublished", can_view_all_materials AS "canViewAllMaterials"
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

  const { name, role, email, bio, photoUrl, profileLink, sortOrder, isPublished, canViewAllMaterials } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }

  // Normalizza URL della foto (converte GitHub blob in raw)
  const normalizedPhotoUrl = normalizeImageUrl(photoUrl);

  try {
    const id = uuidv4();
    const insert = `
      INSERT INTO faculty (id, name, role, email, bio, photo_url, profile_link, sort_order, is_published, can_view_all_materials)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, name, role, email, bio, photo_url AS "photoUrl", profile_link AS "profileLink", sort_order AS "sortOrder", is_published AS "isPublished", can_view_all_materials AS "canViewAllMaterials"
    `;
    const values = [
      id,
      name,
      role || null,
      email || null,
      bio || null,
      normalizedPhotoUrl || null,
      profileLink || null,
      typeof sortOrder === 'number' ? sortOrder : null,
      Boolean(isPublished),
      Boolean(canViewAllMaterials)
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
  const { name, role, email, bio, photoUrl, profileLink, sortOrder, isPublished, canViewAllMaterials, can_view_all_materials } = req.body;

  // Normalizza URL della foto (converte GitHub blob in raw)
  const normalizedPhotoUrl = photoUrl !== undefined ? normalizeImageUrl(photoUrl) : undefined;

  try {
    const updateFields = {
      name,
      role,
      email,
      bio,
      photo_url: normalizedPhotoUrl,
      profile_link: profileLink,
      sort_order: sortOrder,
      is_published: typeof isPublished === 'boolean' ? isPublished : undefined,
      can_view_all_materials: typeof canViewAllMaterials === 'boolean'
        ? canViewAllMaterials
        : (typeof can_view_all_materials === 'boolean' ? can_view_all_materials : undefined)
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
      isPublished: row.is_published,
      canViewAllMaterials: row.can_view_all_materials
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
    const blogColumns = await getTableColumns('blog_posts');
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
      SELECT *
      FROM blog_posts
      ${where}
      ORDER BY published_at DESC NULLS LAST, created_at DESC
      ${limitClause}
    `;

    const { rows } = await pool.query(sql, values);
    res.json(rows.map((row) => buildBlogPostPayload(row, blogColumns)));
  } catch (error) {
    console.error('Error fetching blog posts', error);
    res.status(500).json({ error: 'Unable to retrieve blog posts' });
  }
});

app.post('/api/blog-posts', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) {
    return;
  }

  const { title, slug, excerpt, content, coverImageUrl, publishedAt, isPublished, author, sourceModule, coverImagePrompt, reviewerTeacherId, sources, tags } = req.body;

  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }

  try {
    const blogColumns = await getTableColumns('blog_posts');
    const id = uuidv4();
    const { insertColumns, placeholders, values } = pickBlogInsertColumns(blogColumns, {
      id,
      title,
      slug: slug || slugify(title),
      excerpt,
      content,
      coverImageUrl,
      publishedAt,
      isPublished,
      author,
      sourceModule,
      coverImagePrompt,
      reviewerTeacherId,
      sources,
      tags
    });
    const insert = `
      INSERT INTO blog_posts (${insertColumns.join(', ')})
      VALUES (${placeholders.join(', ')})
      RETURNING *
    `;

    const { rows } = await pool.query(insert, values);
    res.status(201).json(buildBlogPostPayload(rows[0], blogColumns));
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
  const { title, slug, excerpt, content, coverImageUrl, publishedAt, isPublished, author, sourceModule, coverImagePrompt, reviewerTeacherId, sources, tags } = req.body;

  try {
    const updateFields = {
      title,
      slug,
      excerpt,
      content,
      cover_image_url: coverImageUrl,
      author,
      source_module: sourceModule,
      cover_image_prompt: coverImagePrompt,
      reviewer_teacher_id: reviewerTeacherId,
      sources: Array.isArray(sources) ? JSON.stringify(sources) : undefined,
      tags: Array.isArray(tags) ? JSON.stringify(tags) : undefined,
      published_at:
        publishedAt === undefined ? undefined : publishedAt ? new Date(publishedAt) : null,
      is_published: typeof isPublished === 'boolean' ? isPublished : undefined
    };

    const blogColumns = await getTableColumns('blog_posts');
    const { query, values } = buildUpdateQuery('blog_posts', updateFields, id);
    const { rows } = await pool.query(query, values);

    if (!rows.length) {
      return res.status(404).json({ error: 'Blog post not found' });
    }

    res.json(buildBlogPostPayload(rows[0], blogColumns));
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

app.post('/api/blog-posts/import-docx', requireAdmin, uploadBlogDocx.single('docx'), async (req, res) => {
  if (!ensurePool(res)) {
    return;
  }

  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ error: 'Carica un file Word .docx' });
  }

  try {
    const result = await importBlogPostsFromDocxBufferIntoDatabase(req.file.buffer, { now: new Date() });

    res.status(201).json({
      imported: result.imported,
      warnings: result.warnings,
      posts: result.posts.map((post) => ({
        id: post.id,
        title: post.title,
        slug: post.slug,
        publishedAt: post.publishedAt,
        coverImageUrl: post.coverImageUrl || null,
        isPublished: post.isPublished
      }))
    });
  } catch (error) {
    console.error('Error importing blog posts from docx', error);
    if (error.code === '23505') {
      res.status(409).json({ error: 'Uno degli slug generati esiste già. Modifica il titolo o lo slug del post duplicato.' });
      return;
    }
    res.status(400).json({ error: error.message || 'Impossibile importare il file Word' });
  }
});

app.post('/api/blog-posts/:id/generate-cover', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) {
    return;
  }

  try {
    const result = await generateCoverForBlogPost(req.params.id);
    res.json(result);
  } catch (error) {
    console.error('Error generating blog cover', error);
    res.status(error.status || 500).json({ error: error.message || 'Impossibile generare la cover AI' });
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
      filters.push(`r.is_published = $${filters.length + 1}`);
      values.push(published === 'true');
    }

    if (type !== undefined) {
      filters.push(`r.resource_type = $${filters.length + 1}`);
      values.push(type);
    }

    if (req.query.lessonId !== undefined) {
      if (req.query.lessonId === 'null') {
        filters.push('r.lesson_id IS NULL');
      } else {
        filters.push(`r.lesson_id = $${filters.length + 1}`);
        values.push(req.query.lessonId);
      }
    }

    if (req.query.teacherId !== undefined) {
      filters.push(`r.teacher_id = $${filters.length + 1}`);
      values.push(req.query.teacherId);
    }

    if (req.query.source !== undefined) {
      filters.push(`r.source = $${filters.length + 1}`);
      values.push(req.query.source);
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const sql = `
      SELECT r.id, r.title, r.description, r.resource_type AS "resourceType",
             r.url, r.thumbnail_url AS "thumbnailUrl", r.file_size_bytes AS "fileSizeBytes",
             r.sort_order AS "sortOrder", r.is_published AS "isPublished",
             r.teacher_id AS "teacherId", r.lesson_id AS "lessonId",
             r.source, r.tags,
             r.extraction_status AS "extractionStatus", r.extracted_at AS "extractedAt",
             f.name AS "teacherName", l.title AS "lessonTitle",
             l.start_datetime AS "lessonStartDatetime",
             m.name AS "moduleName",
             r.created_at AS "createdAt", r.updated_at AS "updatedAt"
      FROM resources r
      LEFT JOIN faculty f ON f.id = r.teacher_id
      LEFT JOIN lessons l ON l.id = r.lesson_id
      LEFT JOIN modules m ON m.id = l.module_id
      ${where}
      ORDER BY r.sort_order NULLS LAST, l.start_datetime NULLS LAST, r.created_at DESC
    `;

    const { rows } = await pool.query(sql, values);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching resources', error);
    res.status(500).json({ error: 'Unable to retrieve resources' });
  }
});

app.post('/api/resources', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;

  const {
    title,
    description,
    resourceType,
    url,
    thumbnailUrl,
    fileSizeBytes,
    sortOrder,
    isPublished,
    teacherId,
    lessonId,
    source,
    tags
  } = req.body;

  if (!title || !resourceType || !url) {
    return res.status(400).json({ error: 'Title, resourceType, and url are required' });
  }

  if (!['video', 'pdf', 'document', 'audio', 'link', 'quiz'].includes(resourceType)) {
    return res.status(400).json({ error: 'Invalid resource type' });
  }

  if (source !== undefined && !['admin', 'teacher', 'calendar_lesson', 'ai_generated'].includes(source)) {
    return res.status(400).json({ error: 'Invalid resource source' });
  }

  try {
    const id = uuidv4();
    const insert = `
      INSERT INTO resources (id, title, description, resource_type, url, thumbnail_url, file_size_bytes, sort_order, is_published, teacher_id, lesson_id, source, tags)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id, title, description, resource_type AS "resourceType",
                url, thumbnail_url AS "thumbnailUrl", file_size_bytes AS "fileSizeBytes",
                sort_order AS "sortOrder", is_published AS "isPublished",
                teacher_id AS "teacherId", lesson_id AS "lessonId",
                source, tags,
                extraction_status AS "extractionStatus", extracted_at AS "extractedAt",
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
      Boolean(isPublished),
      teacherId || null,
      lessonId || null,
      source || 'admin',
      Array.isArray(tags) ? tags : []
    ];

    const { rows } = await pool.query(insert, values);
    try {
      await extractAndPersistResourceContent(rows[0].id, { force: true });
    } catch (extractionError) {
      console.error('Resource extraction failed on create', extractionError);
    }
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Error creating resource', error);
    res.status(500).json({ error: 'Unable to create resource' });
  }
});

app.put('/api/resources/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;

  const { id } = req.params;
  const {
    title,
    description,
    resourceType,
    url,
    thumbnailUrl,
    fileSizeBytes,
    sortOrder,
    isPublished,
    teacherId,
    lessonId,
    source,
    tags
  } = req.body;

  if (source !== undefined && source !== null && !['admin', 'teacher', 'calendar_lesson', 'ai_generated'].includes(source)) {
    return res.status(400).json({ error: 'Invalid resource source' });
  }

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
          teacher_id = $10,
          lesson_id = $11,
          source = COALESCE($12, source),
          tags = COALESCE($13, tags),
          updated_at = NOW()
      WHERE id = $1
      RETURNING id, title, description, resource_type AS "resourceType",
                url, thumbnail_url AS "thumbnailUrl", file_size_bytes AS "fileSizeBytes",
                sort_order AS "sortOrder", is_published AS "isPublished",
                teacher_id AS "teacherId", lesson_id AS "lessonId",
                source, tags,
                extraction_status AS "extractionStatus", extracted_at AS "extractedAt",
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
      typeof isPublished === 'boolean' ? isPublished : null,
      teacherId || null,
      lessonId || null,
      source || null,
      Array.isArray(tags) ? tags : null
    ];

    const { rows } = await pool.query(update, values);
    if (!rows.length) {
      return res.status(404).json({ error: 'Resource not found' });
    }
    try {
      await extractAndPersistResourceContent(rows[0].id, { force: true });
    } catch (extractionError) {
      console.error('Resource extraction failed on update', extractionError);
    }
    res.json(rows[0]);
  } catch (error) {
    console.error('Error updating resource', error);
    res.status(500).json({ error: 'Unable to update resource' });
  }
});

// Admin: send quiz to teacher review
app.put('/api/resources/:id/request-review', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { id } = req.params;
  const { teacherId } = req.body || {};

  if (!teacherId) return res.status(400).json({ error: 'teacherId is required' });

  try {
    const { rows: facultyRows } = await pool.query(
      'SELECT id FROM faculty WHERE id = $1 LIMIT 1',
      [teacherId]
    );
    if (!facultyRows.length) {
      return res.status(400).json({ error: 'Teacher not found' });
    }

    const resourceColumns = await getTableColumns('resources');
    const hasReviewWorkflowColumns =
      resourceColumns.has('review_status') &&
      resourceColumns.has('teacher_review_notes') &&
      resourceColumns.has('teacher_reviewed_at');

    if (!resourceColumns.has('teacher_id')) {
      return res.status(500).json({ error: 'Resources schema missing teacher_id column' });
    }

    const setClauses = ['teacher_id = $1', 'updated_at = NOW()'];
    const returningClauses = [
      'id',
      'title',
      'resource_type AS "resourceType"',
      'teacher_id AS "teacherId"',
      'is_published AS "isPublished"'
    ];
    if (hasReviewWorkflowColumns) {
      setClauses.push(
        `review_status = 'pending_teacher_approval'`,
        'teacher_review_notes = NULL',
        'teacher_reviewed_at = NULL'
      );
      returningClauses.push('review_status AS "reviewStatus"');
    } else {
      returningClauses.push(`'pending_teacher_approval' AS "reviewStatus"`);
    }

    const { rows } = await pool.query(
      `UPDATE resources
       SET ${setClauses.join(', ')}
       WHERE id = $2 AND resource_type = 'quiz'
       RETURNING ${returningClauses.join(', ')}`,
      [teacherId, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Quiz resource not found' });
    res.json(rows[0]);
  } catch (error) {
    console.error('Error requesting quiz teacher review', error);
    res.status(500).json({ error: 'Unable to request teacher review' });
  }
});

// Teacher: list own quizzes for review/approval
app.get('/api/teachers/quizzes', requireTeacher, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const resourceColumns = await getTableColumns('resources');
    const quizColumns = await getTableColumns('quizzes');
    if (!resourceColumns.has('teacher_id')) {
      return res.status(500).json({ error: 'Resources schema missing teacher_id column' });
    }

    const hasReviewStatus = resourceColumns.has('review_status');
    const hasReviewNotes = resourceColumns.has('teacher_review_notes');
    const hasReviewedAt = resourceColumns.has('teacher_reviewed_at');
    const hasLessonId = resourceColumns.has('lesson_id');
    const hasGenerationReport = quizColumns.has('generation_report');
    const { status } = req.query;
    const values = [req.teacher.id];
    let where = `WHERE r.teacher_id = $1 AND r.resource_type = 'quiz'`;
    if (status && hasReviewStatus) {
      where += ` AND r.review_status = $2`;
      values.push(status);
    } else if (hasReviewStatus) {
      where += ` AND r.review_status IN ('pending_teacher_approval', 'teacher_rejected', 'teacher_approved')`;
    }

    const selectClauses = [
      'r.id',
      'r.title',
      'r.description',
      'r.url',
      hasReviewStatus ? 'r.review_status AS "reviewStatus"' : `'pending_teacher_approval' AS "reviewStatus"`,
      hasReviewNotes ? 'r.teacher_review_notes AS "reviewNotes"' : 'NULL::text AS "reviewNotes"',
      hasReviewedAt ? 'r.teacher_reviewed_at AS "reviewedAt"' : 'NULL::timestamptz AS "reviewedAt"',
      'r.is_published AS "isPublished"',
      'r.created_at AS "createdAt"',
      'r.updated_at AS "updatedAt"',
      hasGenerationReport ? 'q.generation_report AS "generationReport"' : 'NULL::jsonb AS "generationReport"',
      'cal.id AS "lessonId"',
      'cal.title AS "lessonTitle"'
    ];

    const joinLessonClause = `
      LEFT JOIN quizzes q ON q.resource_id = r.id
      LEFT JOIN lms_lessons ll ON ll.id = q.lms_lesson_id
      LEFT JOIN lessons cal ON cal.id = COALESCE(${hasLessonId ? 'r.lesson_id' : 'NULL::uuid'}, ll.calendar_lesson_id)
    `;

    const { rows } = await pool.query(
      `SELECT ${selectClauses.join(', ')}
       FROM resources r
       ${joinLessonClause}
       ${where}
       ORDER BY r.updated_at DESC`,
      values
    );
    res.json(rows);
  } catch (error) {
    console.error('Error fetching teacher quizzes', error);
    res.status(500).json({ error: 'Unable to fetch teacher quizzes' });
  }
});

// Teacher: edit + approve/reject quiz generated by admin
app.put('/api/teachers/quizzes/:id/review', requireTeacher, async (req, res) => {
  if (!ensurePool(res)) return;
  const { id } = req.params;
  const { action, notes, quizData } = req.body || {};

  if (!['approve', 'reject', 'save', 'unpublish'].includes(action)) {
    return res.status(400).json({ error: 'action must be approve, reject, save or unpublish' });
  }
  if (action === 'reject' && (!notes || !String(notes).trim())) {
    return res.status(400).json({ error: 'notes are required when rejecting' });
  }

  try {
    const resourceColumns = await getTableColumns('resources');
    if (!resourceColumns.has('teacher_id')) {
      return res.status(500).json({ error: 'Resources schema missing teacher_id column' });
    }

    const hasReviewStatus = resourceColumns.has('review_status');
    const hasReviewNotes = resourceColumns.has('teacher_review_notes');
    const hasReviewedAt = resourceColumns.has('teacher_reviewed_at');
    let nextUrl = null;
    if (quizData && Array.isArray(quizData.questions)) {
      const payload = {
        title: quizData.title || 'Quiz',
        questions: quizData.questions,
        generationReport: quizData.generationReport || null,
        updatedAt: new Date().toISOString()
      };
      nextUrl = 'data:application/json,' + encodeURIComponent(JSON.stringify(payload));
    }

    const status = action === 'approve'
      ? 'teacher_approved'
      : action === 'reject'
        ? 'teacher_rejected'
        : action === 'unpublish'
          ? 'teacher_approved'
        : 'pending_teacher_approval';
    const isPublished = action === 'approve' ? true : action === 'reject' || action === 'unpublish' ? false : null;
    const reviewNotes = action === 'save'
      ? 'Bozza modificata dal docente'
      : action === 'unpublish'
        ? 'Pubblicazione ritirata dal docente'
        : (notes || null);
    const setClauses = [
      'url = COALESCE($1, url)',
      'is_published = COALESCE($4, is_published)',
      'updated_at = NOW()'
    ];
    if (hasReviewStatus) {
      setClauses.push('review_status = $2');
    }
    if (hasReviewNotes) {
      setClauses.push('teacher_review_notes = $3');
    }
    if (hasReviewedAt) {
      if (hasReviewStatus) {
        setClauses.push(`teacher_reviewed_at = CASE WHEN $2 = 'pending_teacher_approval' THEN teacher_reviewed_at ELSE NOW() END`);
      } else {
        setClauses.push('teacher_reviewed_at = NOW()');
      }
    }

    const returningClauses = [
      'id',
      'title',
      hasReviewStatus ? 'review_status AS "reviewStatus"' : `$2 AS "reviewStatus"`,
      hasReviewNotes ? 'teacher_review_notes AS "reviewNotes"' : '$3::text AS "reviewNotes"',
      'is_published AS "isPublished"'
    ];

    const { rows } = await pool.query(
      `UPDATE resources
       SET ${setClauses.join(', ')}
       WHERE id = $5
         AND teacher_id = $6
         AND resource_type = 'quiz'
       RETURNING ${returningClauses.join(', ')}`,
      [nextUrl, status, reviewNotes, isPublished, id, req.teacher.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Quiz not found for this teacher' });

    // Keep LMS quiz visibility/title aligned when this resource is the public-facing wrapper.
    await pool.query(
      `UPDATE quizzes
       SET title = COALESCE($2, title),
           is_published = COALESCE($3, is_published),
           updated_at = NOW()
       WHERE resource_id = $1`,
      [id, quizData?.title || null, typeof isPublished === 'boolean' ? isPublished : null]
    );
    await extractAndPersistResourceContent(id, { force: true });

    res.json(rows[0]);
  } catch (error) {
    console.error('Error reviewing teacher quiz', error);
    res.status(500).json({ error: 'Unable to review quiz' });
  }
});

app.get('/api/teachers/quizzes/:id/pdf', requireTeacher, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT r.id, r.title, r.url, r.review_status AS "reviewStatus",
             q.id AS "quizId",
             ll.title AS "lessonTitle",
             m.name AS "moduleTitle"
      FROM resources r
      LEFT JOIN quizzes q ON q.resource_id = r.id
      LEFT JOIN lms_lessons ll ON ll.id = q.lms_lesson_id
      LEFT JOIN modules m ON m.id = q.lms_module_id
      WHERE r.id = $1
        AND r.teacher_id = $2
        AND r.resource_type = 'quiz'
      LIMIT 1
    `, [req.params.id, req.teacher.id]);

    if (!rows.length) {
      return res.status(404).json({ error: 'Quiz non trovato' });
    }

    const resource = rows[0];
    const payload = parseQuizDataUrl(resource.url);
    if (!payload || !Array.isArray(payload.questions)) {
      return res.status(400).json({ error: 'Contenuto quiz non disponibile' });
    }

    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const safeName = String(payload.title || resource.title || 'quiz')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'quiz';

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pdf"`);
    doc.pipe(res);

    const writeLine = (text = '', options = {}) => {
      const safeText = String(text ?? '').replace(/\s+/g, ' ').trim() || ' ';
      if (doc.y > 740) doc.addPage();
      doc.text(safeText, options);
    };

    doc.fillColor('#166534').fontSize(20).text(payload.title || resource.title || 'Quiz', { align: 'center' });
    doc.moveDown(0.5);
    doc.fillColor('#666666').fontSize(10);
    if (resource.lessonTitle) writeLine(`Lezione: ${resource.lessonTitle}`, { align: 'center' });
    if (resource.moduleTitle) writeLine(`Modulo: ${resource.moduleTitle}`, { align: 'center' });
    writeLine(`Stato review: ${resource.reviewStatus || 'N/D'}`, { align: 'center' });
    doc.moveDown(1.2);

    doc.fillColor('#000000').fontSize(12);
    payload.questions.forEach((question, questionIndex) => {
      writeLine(`${questionIndex + 1}. ${question.questionText || 'Domanda senza testo'}`, { lineGap: 3 });
      doc.moveDown(0.3);
      (question.options || []).forEach((option, optionIndex) => {
        const isCorrect = option === question.correctAnswer || (Array.isArray(question.correctAnswer) && question.correctAnswer.includes(option));
        doc.fillColor(isCorrect ? '#166534' : '#333333');
        writeLine(`   ${String.fromCharCode(65 + optionIndex)}. ${option}${isCorrect ? '  [corretta]' : ''}`);
      });
      doc.fillColor('#000000');
      doc.moveDown(0.8);
    });

    if (payload.generationReport?.sources?.length) {
      if (doc.y > 680) doc.addPage();
      doc.fillColor('#166534').fontSize(14).text('Fonti usate per la generazione');
      doc.moveDown(0.6);
      doc.fillColor('#333333').fontSize(10);
      payload.generationReport.sources.forEach((source, index) => {
        writeLine(`${index + 1}. ${source.title || 'Fonte'} (${source.resourceType || source.kind || 'contenuto'})`);
        if (source.preview) writeLine(`   Estratto: ${summarizePreview(source.preview, 260)}`);
        doc.moveDown(0.4);
      });
    }

    doc.end();
  } catch (error) {
    console.error('Error generating teacher quiz PDF', error);
    res.status(500).json({ error: 'Errore nella generazione del PDF del quiz' });
  }
});

app.delete('/api/teachers/quizzes/:id', requireTeacher, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT r.id AS "resourceId", q.id AS "quizId"
      FROM resources r
      LEFT JOIN quizzes q ON q.resource_id = r.id
      WHERE r.id = $1
        AND r.teacher_id = $2
        AND r.resource_type = 'quiz'
      LIMIT 1
    `, [req.params.id, req.teacher.id]);

    if (!rows.length) {
      return res.status(404).json({ error: 'Quiz non trovato' });
    }

    const target = rows[0];
    if (target.quizId) {
      await removeQuizFromLessonMaterials(target.quizId);
      await pool.query('DELETE FROM quizzes WHERE id = $1', [target.quizId]);
    }
    await pool.query('DELETE FROM resources WHERE id = $1', [target.resourceId]);
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting teacher quiz', error);
    res.status(500).json({ error: 'Errore nella cancellazione del quiz' });
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

// Upload file per materiali lezioni (limite 10MB)
app.post('/api/materials/upload', requireAdmin, uploadMaterials.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nessun file caricato' });
  }

  console.log('Upload materiale lezione:', {
    originalname: req.file.originalname,
    size: req.file.size,
    mimetype: req.file.mimetype
  });

  if (req.file.size > 20 * 1024 * 1024) {
    return res.status(413).json({ error: 'File troppo grande (max 20MB per materiali lezioni)' });
  }

  try {
    // Sanitizza il nome file
    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    
    // Upload su Vercel Blob
    const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    if (!blobToken) {
      console.error('BLOB_READ_WRITE_TOKEN non configurato!');
      return res.status(500).json({ error: 'Storage non configurato (BLOB_READ_WRITE_TOKEN mancante).' });
    }

    const blob = await put(safeName, req.file.buffer, {
      access: 'public',
      addRandomSuffix: true,
      contentType: req.file.mimetype,
      token: blobToken
    });

    res.json({ url: blob.url, filename: safeName });

  } catch (error) {
    console.error('Errore upload materiale:', error);
    res.status(500).json({ error: 'Upload fallito: ' + error.message });
  }
});

// Upload file per risorse con compressione automatica
app.post('/api/resources/upload', requireAdmin, uploadMaterials.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nessun file caricato' });
  }

  console.log('Upload file:', {
    originalname: req.file.originalname,
    size: req.file.size,
    mimetype: req.file.mimetype
  });

  if (req.file.size > 4 * 1024 * 1024) {
    return res.status(413).json({ error: 'File troppo grande (max 4MB). Comprimi ulteriormente il PDF.' });
  }

  try {
    // Sanitizza il nome file
    let fileBuffer = req.file.buffer;
    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    
    // Comprimi PDF se >5MB usando approccio semplificato
    if (req.file.mimetype === 'application/pdf' && req.file.size > 5 * 1024 * 1024) {
      console.log('📦 Comprimendo PDF grande...');
      // Per ora manteniamo originale - compressione richiede librerie esterne
      // TODO: implementare compressione PDF reale
    }
    
    // Upload su Vercel Blob
    const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    if (!blobToken) {
      console.error('BLOB_READ_WRITE_TOKEN non configurato!');
      return res.status(500).json({ error: 'Storage non configurato (BLOB_READ_WRITE_TOKEN mancante).' });
    }

    const blob = await put(safeName, fileBuffer, {
      access: 'public',
      addRandomSuffix: true,
      contentType: req.file.mimetype,
      token: blobToken
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

// Storage status check
app.get('/api/storage/status', requireAdmin, (_req, res) => {
  res.json({
    blobConfigured: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    resendConfigured: Boolean(RESEND_API_KEY),
    brevoConfigured: Boolean(BREVO_API_KEY)
  });
});

// Invio email di TEST (solo a un indirizzo specifico per anteprima)
app.post('/api/resources/notify-test', requireAdmin, async (req, res) => {
  const { subject, message, testEmail } = req.body;
  
  if (!subject || !message || !testEmail) {
    return res.status(400).json({ error: 'Oggetto, messaggio e email di test sono obbligatori' });
  }

  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    
    // Usa valori di esempio per i placeholder
    const personalizedMessage = message
      .replace('{nome}', 'Mario')
      .replace('{cognome}', 'Rossi');

    await resend.emails.send({
      from: process.env.RESEND_FROM || 'Master Carbon Farming <noreply@carbonfarmingmaster.it>',
      to: testEmail,
      subject: `[TEST] ${subject}`,
      html: buildStudentNotificationHtml(personalizedMessage, { isTest: true })
    });

    res.json({ success: true, message: `Email di test inviata a ${testEmail}` });
  } catch (error) {
    console.error('Error sending test email:', error);
    res.status(500).json({ error: 'Errore durante l\'invio dell\'email di test', details: error.message || String(error) });
  }
});

// Invio email a uno studente specifico (email reale, no banner test)
app.post('/api/resources/notify-single', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  
  const { subject, message, studentEmail, studentEmails, bccEmail } = req.body;
  
  const requestedEmails = normalizeEmailList(studentEmails && studentEmails.length ? studentEmails : studentEmail);

  if (!subject || !message || requestedEmails.length === 0) {
    return res.status(400).json({ error: 'Oggetto, messaggio e email studente sono obbligatori' });
  }

  try {
    // Trova gli studenti nel DB per avere nome/cognome e poter gestire invio batch / retry
    const { rows: students } = await pool.query(
      'SELECT email, first_name, last_name FROM users WHERE LOWER(email) = ANY($1::text[])',
      [requestedEmails]
    );

    const foundEmailSet = new Set(students.map(student => String(student.email || '').trim().toLowerCase()));
    const missingStudents = requestedEmails.filter(email => !foundEmailSet.has(email)).map(email => ({
      email,
      reason: 'Studente non trovato nel database'
    }));

    const batchId = await createNotificationBatchLog({
      scope: 'manual',
      subject,
      message,
      bccEmail,
      recipients: [
        ...students.map(student => ({
          email: student.email,
          first_name: student.first_name,
          last_name: student.last_name,
          status: 'pending'
        })),
        ...missingStudents.map(item => ({
          email: item.email,
          status: 'not_found',
          error_message: item.reason
        }))
      ]
    });

    const batchResult = students.length > 0
      ? await sendStudentNotificationsBatch({ students, subject, message, bccEmail })
      : { sent: 0, total: 0, delivered: [], failed: [], failedEmails: [] };

    const failed = [...batchResult.failed, ...missingStudents];
    for (const email of batchResult.delivered) {
      await updateNotificationRecipientLog(batchId, { email, status: 'sent' });
    }
    for (const item of batchResult.failed) {
      await updateNotificationRecipientLog(batchId, {
        email: item.email,
        status: 'failed',
        reason: item.reason,
        provider: item.provider
      });
    }
    await finalizeNotificationBatchLog(batchId);

    const failedEmails = failed.map(item => item.email).filter(Boolean);
    const requestedCount = requestedEmails.length;
    const statusCode = batchResult.sent === 0 && failed.length > 0 ? 404 : 200;

    return res.status(statusCode).json({
      batchId,
      success: failed.length === 0,
      sent: batchResult.sent,
      total: requestedCount,
      delivered: batchResult.delivered,
      failed,
      failedEmails,
      missingStudents,
      message: failed.length === 0
        ? `Email inviate a ${batchResult.sent}/${requestedCount} destinatari`
        : `Email inviate a ${batchResult.sent}/${requestedCount} destinatari. ${failed.length} mancanti/fallite.`
    });
  } catch (error) {
    console.error('Error sending single email:', error);
    res.status(500).json({ error: 'Errore durante l\'invio dell\'email', details: error.message || String(error) });
  }
});

// Notifica studenti via email
app.post('/api/resources/notify', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  
  const { subject, message, courseEditionId, bccEmail } = req.body;
  
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
      WHERE e.course_edition_id = $1
    `, [editionId]);

    if (students.length === 0) {
      return res.json({ sent: 0, message: 'Nessuno studente iscritto trovato' });
    }

    const batchId = await createNotificationBatchLog({
      scope: 'all',
      subject,
      message,
      courseEditionId: editionId,
      bccEmail,
      recipients: students.map(student => ({
        email: student.email,
        first_name: student.first_name,
        last_name: student.last_name,
        status: 'pending'
      }))
    });

    const result = await sendStudentNotificationsBatch({ students, subject, message, bccEmail });
    for (const email of result.delivered) {
      await updateNotificationRecipientLog(batchId, { email, status: 'sent' });
    }
    for (const item of result.failed) {
      await updateNotificationRecipientLog(batchId, {
        email: item.email,
        status: 'failed',
        reason: item.reason,
        provider: item.provider
      });
    }
    await finalizeNotificationBatchLog(batchId);

    res.json({ 
      batchId,
      sent: result.sent,
      total: result.total,
      delivered: result.delivered,
      failed: result.failed.length > 0 ? result.failed : undefined,
      failedEmails: result.failedEmails.length > 0 ? result.failedEmails : undefined,
      message: result.failed.length === 0
        ? `Email inviata a ${result.sent}/${result.total} studenti`
        : `Email inviata a ${result.sent}/${result.total} studenti. ${result.failed.length} fallite.`
    });
  } catch (error) {
    console.error('Error notifying students:', error);
    res.status(500).json({ error: 'Errore durante l\'invio delle notifiche' });
  }
});

app.get('/api/resources/notify-logs', requireAdmin, async (_req, res) => {
  if (!ensurePool(res)) return;

  try {
    const { rows } = await pool.query(`
      SELECT
        b.id,
        b.scope,
        b.subject,
        b.message,
        b.bcc_email AS "bccEmail",
        b.requested_total AS "requestedTotal",
        b.sent_count AS "sentCount",
        b.failed_count AS "failedCount",
        b.status,
        b.created_at AS "createdAt",
        COALESCE(
          json_agg(
            json_build_object(
              'email', r.email,
              'status', r.status,
              'reason', r.error_message
            )
            ORDER BY r.created_at ASC
          ) FILTER (WHERE r.status IN ('failed', 'not_found')),
          '[]'::json
        ) AS "failedRecipients",
        COALESCE(
          json_agg(
            json_build_object(
              'email', r.email,
              'status', r.status,
              'reason', r.error_message
            )
            ORDER BY r.created_at ASC
          ) FILTER (WHERE r.id IS NOT NULL),
          '[]'::json
        ) AS "allRecipients"
      FROM notification_batches b
      LEFT JOIN notification_batch_recipients r ON r.batch_id = b.id
      GROUP BY b.id
      ORDER BY b.created_at DESC
      LIMIT 20
    `);

    res.json(rows);
  } catch (error) {
    console.error('Error fetching notification logs:', error);
    res.status(500).json({ error: 'Errore durante il recupero dello storico notifiche' });
  }
});

// Get single resource by ID
app.get('/api/resources/:id', async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT id, title, description, resource_type AS "resourceType",
             url, thumbnail_url AS "thumbnailUrl", is_published AS "isPublished",
             extracted_text AS "extractedText", extraction_status AS "extractionStatus",
             extraction_metadata AS "extractionMetadata", extracted_at AS "extractedAt"
      FROM resources WHERE id = $1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Resource not found' });
    res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching resource', error);
    res.status(500).json({ error: 'Unable to retrieve resource' });
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

app.get('/api/calendar/feed.ics', async (req, res) => {
  if (!ensurePool(res)) return;

  try {
    const { rows } = await pool.query(`
      SELECT l.id, l.title, l.description, l.start_datetime AS "startDatetime",
             l.end_datetime AS "endDatetime", l.duration_minutes AS "durationMinutes",
             l.location_physical AS "locationPhysical",
             COALESCE(f.name, l.external_teacher_name) AS "teacherName",
             COALESCE(l.status, 'confirmed') AS status
      FROM lessons l
      LEFT JOIN faculty f ON f.id = l.teacher_id
      WHERE COALESCE(l.status, 'scheduled') = 'confirmed'
        AND l.start_datetime >= NOW()
      ORDER BY l.start_datetime ASC
    `);

    const ics = buildCalendarFeed(rows, {
      calendarName: 'Master Carbon Farming - Calendario Lezioni'
    });

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(ics);
  } catch (error) {
    console.error('Error generating ICS feed', error);
    res.status(500).json({ error: 'Unable to generate calendar feed' });
  }
});

app.get('/api/calendar/lessons/:id.ics', async (req, res) => {
  if (!ensurePool(res)) return;

  try {
    const { rows } = await pool.query(`
      SELECT l.id, l.title, l.description, l.start_datetime AS "startDatetime",
             l.end_datetime AS "endDatetime", l.duration_minutes AS "durationMinutes",
             l.location_physical AS "locationPhysical",
             COALESCE(f.name, l.external_teacher_name) AS "teacherName",
             COALESCE(l.status, 'confirmed') AS status
      FROM lessons l
      LEFT JOIN faculty f ON f.id = l.teacher_id
      WHERE l.id = $1
        AND COALESCE(l.status, 'scheduled') <> 'cancelled'
      LIMIT 1
    `, [req.params.id]);

    if (!rows.length) {
      return res.status(404).json({ error: 'Lesson not found' });
    }

    const ics = buildCalendarFeed(rows, {
      calendarName: 'Master Carbon Farming - Evento'
    });

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Disposition', `attachment; filename="lesson-${req.params.id}.ics"`);
    res.send(ics);
  } catch (error) {
    console.error('Error generating single lesson ICS', error);
    res.status(500).json({ error: 'Unable to generate lesson calendar event' });
  }
});

app.post('/api/lessons', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;

  const {
    title, description, startDatetime, endDatetime, durationMinutes,
    locationPhysical, locationRemote, status, notes, moduleId, teacherId, externalTeacherName, materials
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
                          location_physical, location_remote, status, notes, module_id, teacher_id, external_teacher_name, materials)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING id, title, description, start_datetime AS "startDatetime",
                end_datetime AS "endDatetime", duration_minutes AS "durationMinutes",
                location_physical AS "locationPhysical", location_remote AS "locationRemote",
                status, notes, module_id AS "moduleId", teacher_id AS "teacherId",
                external_teacher_name AS "externalTeacherName", materials,
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
      externalTeacherName || null,
      materials ? JSON.stringify(materials) : null
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
    locationPhysical, locationRemote, status, notes, moduleId, teacherId, externalTeacherName, materials
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
      external_teacher_name: externalTeacherName,
      materials: materials !== undefined ? JSON.stringify(materials) : undefined
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
    const schema = await getCourseEditionSchemaConfig();
    const fragments = buildCourseEditionSelectFragments(schema);
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
             ${fragments.totalPlannedHours},
             ${fragments.minimumInPersonAttendanceRatio},
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
    const schema = await getCourseEditionSchemaConfig();
    const fragments = buildCourseEditionSelectFragments(schema);
    const { rows } = await pool.query(`
      SELECT id, course_id AS "courseId", edition_name AS "editionName",
             start_date AS "startDate", end_date AS "endDate",
             max_students AS "maxStudents", is_active AS "isActive",
             ${fragments.totalPlannedHours},
             ${fragments.minimumInPersonAttendanceRatio},
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
  const schema = await getCourseEditionSchemaConfig();
  const {
    courseId,
    editionName,
    startDate,
    endDate,
    maxStudents,
    isActive,
    totalPlannedHours,
    minimumInPersonAttendanceRatio
  } = req.body;
  if (!courseId || !editionName) return res.status(400).json({ error: 'courseId and editionName are required' });
  try {
    const id = uuidv4();
    const insertColumns = ['id', 'course_id', 'edition_name', 'start_date', 'end_date', 'max_students', 'is_active'];
    const insertValues = [id, courseId, editionName, startDate || null, endDate || null, maxStudents || null, isActive !== false];

    if (schema.hasTotalPlannedHours) {
      insertColumns.push('total_planned_hours');
      insertValues.push(totalPlannedHours || 432);
    }
    if (schema.hasMinimumInPersonAttendanceRatio) {
      insertColumns.push('minimum_in_person_attendance_ratio');
      insertValues.push(minimumInPersonAttendanceRatio || 0.7);
    }

    const placeholders = insertValues.map((_, index) => `$${index + 1}`).join(', ');
    const fragments = buildCourseEditionSelectFragments(schema);
    const { rows } = await pool.query(`
      INSERT INTO course_editions (
        ${insertColumns.join(', ')}
      )
      VALUES (${placeholders})
      RETURNING id, course_id AS "courseId", edition_name AS "editionName",
                start_date AS "startDate", end_date AS "endDate",
                max_students AS "maxStudents", is_active AS "isActive",
                ${fragments.totalPlannedHours},
                ${fragments.minimumInPersonAttendanceRatio},
                created_at AS "createdAt", updated_at AS "updatedAt"
    `, insertValues);
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Error creating course edition', error);
    res.status(500).json({ error: 'Unable to create course edition' });
  }
});

app.put('/api/lms/course-editions/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const schema = await getCourseEditionSchemaConfig();
  const {
    courseId,
    editionName,
    startDate,
    endDate,
    maxStudents,
    isActive,
    totalPlannedHours,
    minimumInPersonAttendanceRatio
  } = req.body;
  try {
    const updateFields = {
      course_id: courseId, edition_name: editionName,
      start_date: startDate, end_date: endDate,
      max_students: maxStudents,
      is_active: typeof isActive === 'boolean' ? isActive : undefined
    };

    if (schema.hasTotalPlannedHours) {
      updateFields.total_planned_hours = totalPlannedHours;
    }
    if (schema.hasMinimumInPersonAttendanceRatio) {
      updateFields.minimum_in_person_attendance_ratio = minimumInPersonAttendanceRatio;
    }

    const { query, values } = buildUpdateQuery('course_editions', updateFields, req.params.id);
    const { rows } = await pool.query(query, values);
    if (!rows.length) return res.status(404).json({ error: 'Course edition not found' });
    const r = rows[0];
    res.json({
      id: r.id, courseId: r.course_id, editionName: r.edition_name,
      startDate: r.start_date, endDate: r.end_date,
      maxStudents: r.max_students, isActive: r.is_active,
      totalPlannedHours: schema.hasTotalPlannedHours ? r.total_planned_hours : 432,
      minimumInPersonAttendanceRatio: schema.hasMinimumInPersonAttendanceRatio ? r.minimum_in_person_attendance_ratio : 0.7,
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
      SELECT id, course_id AS "courseId", name AS title, description,
             sort_order AS "sortOrder", is_published AS "isPublished",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM modules ${where}
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
      SELECT id, course_id AS "courseId", name AS title, description,
             sort_order AS "sortOrder", is_published AS "isPublished",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM modules WHERE id = $1
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
      INSERT INTO modules (id, course_id, name, description, sort_order, is_published)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, course_id AS "courseId", name AS title, description,
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
    const { query, values } = buildUpdateQuery('modules', {
      course_id: courseId, name: title, description,
      sort_order: sortOrder,
      is_published: typeof isPublished === 'boolean' ? isPublished : undefined
    }, req.params.id);
    const { rows } = await pool.query(query, values);
    if (!rows.length) return res.status(404).json({ error: 'Module not found' });
    const r = rows[0];
    res.json({
      id: r.id, courseId: r.course_id, title: r.name, description: r.description,
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
    const { rowCount } = await pool.query('DELETE FROM modules WHERE id = $1', [req.params.id]);
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
             ll.calendar_lesson_id AS "calendarLessonId",
             cal.start_datetime AS "startDatetime",
             ll.created_at AS "createdAt", ll.updated_at AS "updatedAt"
      FROM lms_lessons ll
      LEFT JOIN lessons cal ON cal.id = ll.calendar_lesson_id
      ${needsJoin ? 'JOIN modules m ON m.id = ll.lms_module_id' : ''}
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
  if (req.user.role === 'guest') {
    return res.json([]);
  }
  try {
    const { courseId } = req.query;
    // Get all lms_lessons for this course (or all) with progress + attendance
    let query = `
      SELECT ll.id AS "lessonId",
             lp.progress_percent AS "progressPercent",
             lp.completed_at AS "completedAt",
             EXISTS (SELECT 1 FROM attendance a2 WHERE a2.lesson_id = ll.calendar_lesson_id AND a2.user_id = $1 AND a2.attendance_type IN ('in_person', 'remote_live')) AS "hasAttendance",
             a.attendance_type AS "attendanceType",
             cal.start_datetime AS "startDatetime"
      FROM lms_lessons ll
      LEFT JOIN lesson_progress lp ON lp.lms_lesson_id = ll.id AND lp.user_id = $1
      LEFT JOIN attendance a ON a.lesson_id = ll.calendar_lesson_id AND a.user_id = $1
      LEFT JOIN lessons cal ON cal.id = ll.calendar_lesson_id
    `;
    const values = [req.user.userId];
    if (courseId) {
      query += ` WHERE ll.lms_module_id IN (
        SELECT m.id FROM modules m WHERE m.course_id = $2
      )`;
      values.push(courseId);
    }
    const { rows } = await pool.query(query, values);
    // Filter to only lessons with some data
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
             materials, calendar_lesson_id AS "calendarLessonId",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM lms_lessons WHERE id = $1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Lesson not found' });

    const lesson = rows[0];

    // Load linked resources from calendar lesson
    if (lesson.calendarLessonId) {
      const { rows: resRows } = await pool.query(`
        SELECT r.id, r.title, r.url, r.resource_type AS "resourceType",
               r.description, f.name AS "teacherName"
        FROM resources r
        LEFT JOIN faculty f ON f.id = r.teacher_id
        WHERE r.lesson_id = $1
          AND r.is_published = true
          AND r.resource_type <> 'quiz'
        ORDER BY r.sort_order NULLS LAST, r.created_at
      `, [lesson.calendarLessonId]);
      lesson.linkedResources = resRows;
    } else {
      lesson.linkedResources = [];
    }

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
        lesson.completionStatus = await getLessonCompletionStatus(req.params.id, payload.userId, {
          lesson,
          progress: progressRows[0]
            ? {
                progress_percent: progressRows[0].progressPercent,
                time_spent_seconds: progressRows[0].timeSpentSeconds,
                completed_at: progressRows[0].completedAt
              }
            : null
        });
      }
    }

    res.json(lesson);
  } catch (error) {
    console.error('Error fetching LMS lesson', error);
    res.status(500).json({ error: 'Unable to retrieve LMS lesson' });
  }
});

app.post('/api/lms/resources/:id/view', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows: resources } = await pool.query(
      'SELECT id FROM resources WHERE id = $1 AND is_published = true',
      [req.params.id]
    );
    if (!resources.length) {
      return res.status(404).json({ error: 'Resource not found' });
    }

    await pool.query(`
      INSERT INTO resource_views (user_id, resource_id, first_viewed_at, view_count)
      VALUES ($1, $2, NOW(), 1)
      ON CONFLICT (user_id, resource_id) DO UPDATE SET
        first_viewed_at = COALESCE(resource_views.first_viewed_at, NOW()),
        view_count = resource_views.view_count + 1
    `, [req.user.userId, req.params.id]);

    res.json({ success: true });
  } catch (error) {
    console.error('Error tracking resource view', error);
    res.status(500).json({ error: 'Unable to track resource view' });
  }
});

app.post('/api/lms/lessons', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { moduleId, title, description, videoUrl, videoProvider, durationSeconds, sortOrder, isFree, isPublished, materials, calendarLessonId } = req.body;
  if (!moduleId || !title) return res.status(400).json({ error: 'moduleId and title are required' });
  try {
    const id = uuidv4();
    const { rows } = await pool.query(`
      INSERT INTO lms_lessons (id, lms_module_id, title, description, video_url, video_provider, duration_seconds, sort_order, is_free, is_published, materials, calendar_lesson_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id, lms_module_id AS "moduleId", title, description,
                video_url AS "videoUrl", video_provider AS "videoProvider",
                duration_seconds AS "durationSeconds", sort_order AS "sortOrder",
                is_free AS "isFree", is_published AS "isPublished",
                materials, calendar_lesson_id AS "calendarLessonId",
                created_at AS "createdAt", updated_at AS "updatedAt"
    `, [id, moduleId, title, description || null, videoUrl || null, videoProvider || null,
        durationSeconds || null, typeof sortOrder === 'number' ? sortOrder : 0, Boolean(isFree), isPublished !== false,
        JSON.stringify(materials || []), calendarLessonId || null]);
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Error creating LMS lesson', error);
    res.status(500).json({ error: 'Unable to create LMS lesson' });
  }
});

app.put('/api/lms/lessons/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { moduleId, title, description, videoUrl, videoProvider, durationSeconds, sortOrder, isFree, isPublished, materials, calendarLessonId } = req.body;
  try {
    const updateFields = {
      lms_module_id: moduleId, title, description,
      video_url: videoUrl, video_provider: videoProvider,
      duration_seconds: durationSeconds, sort_order: sortOrder,
      is_free: typeof isFree === 'boolean' ? isFree : undefined,
      is_published: typeof isPublished === 'boolean' ? isPublished : undefined,
      calendar_lesson_id: calendarLessonId !== undefined ? (calendarLessonId || null) : undefined
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
             e.enrollment_type AS "enrollmentType", e.partner_company AS "partnerCompany", e.notes,
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
  const { email, firstName, lastName, role, status, enrollmentType, partnerCompany, notes } = req.body;
  
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
    
    // Update enrollment fields
    await pool.query(`
      UPDATE enrollments SET 
        status = COALESCE($1, status),
        enrollment_type = COALESCE($2, enrollment_type),
        partner_company = COALESCE($3, partner_company),
        notes = COALESCE($4, notes)
      WHERE id = $5
    `, [status, enrollmentType, partnerCompany, notes, id]);
    
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
app.get('/api/students/me', requireStudent, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(
      'SELECT id, email, first_name AS "firstName", last_name AS "lastName", role, updated_at AS "updatedAt" FROM users WHERE id = $1',
      [req.user.userId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Studente non trovato' });
    }
    res.json({ ...rows[0], role: req.user.role });
  } catch (error) {
    console.error('Get student profile error:', error);
    res.status(500).json({ error: 'Errore nel recupero profilo studente' });
  }
});

// Corsi dello studente loggato
app.get('/api/lms/my-courses', requireStudent, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const schema = await getCourseEditionSchemaConfig();
    const fragments = buildCourseEditionSelectFragments(schema, 'ce');
    const { rows } = await pool.query(`
      SELECT c.id, c.title, c.slug, c.description, c.cover_image_url AS "coverImageUrl",
             ce.id AS "editionId", ce.edition_name AS "editionName",
             ${fragments.totalPlannedHours},
             ${fragments.minimumInPersonAttendanceRatio},
             e.status AS "enrollmentStatus", e.enrolled_at AS "enrolledAt",
             (SELECT COUNT(*)::int FROM modules m WHERE m.course_id = c.id) AS "totalModules",
             (SELECT COUNT(*)::int FROM lms_lessons ll
              JOIN modules m2 ON m2.id = ll.lms_module_id
              WHERE m2.course_id = c.id AND ll.is_published = true) AS "totalLessons",
             (SELECT COALESCE(SUM(COALESCE(les.duration_minutes, 0)), 0) / 60.0
              FROM attendance a
              JOIN lessons les ON les.id = a.lesson_id
              JOIN modules m_att ON m_att.id = les.module_id
              WHERE a.user_id = $1
                AND m_att.course_id = c.id
                AND a.attendance_type IN ('in_person', 'remote_live', 'remote_partial')
             ) AS "attendedHours",
             (SELECT COALESCE(SUM(COALESCE(les.duration_minutes, 0)), 0) / 60.0
              FROM attendance a
              JOIN lessons les ON les.id = a.lesson_id
              JOIN modules m_att ON m_att.id = les.module_id
              WHERE a.user_id = $1
                AND m_att.course_id = c.id
                AND a.attendance_type = 'in_person'
             ) AS "inPersonHours",
             (SELECT COUNT(DISTINCT ll2.id)::int FROM lms_lessons ll2
              JOIN modules m3 ON m3.id = ll2.lms_module_id
              WHERE m3.course_id = c.id AND (
                EXISTS (SELECT 1 FROM lesson_progress lp WHERE lp.lms_lesson_id = ll2.id AND lp.user_id = $1 AND lp.completed_at IS NOT NULL)
                OR
                EXISTS (SELECT 1 FROM attendance a WHERE a.lesson_id = ll2.calendar_lesson_id AND a.user_id = $1 AND a.attendance_type IN ('in_person', 'remote_live'))
              )) AS "completedLessons"
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

app.get('/api/lms/my-upcoming-lessons', requireStudent, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const requestedLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 10) : 2;
    const values = [req.user.userId];
    let courseFilter = '';

    if (req.query.courseId) {
      values.push(req.query.courseId);
      courseFilter = ` AND c.id = $${values.length}`;
    }

    values.push(limit);

    const { rows } = await pool.query(`
      SELECT l.id, l.title, l.description, l.start_datetime AS "startDatetime",
             l.end_datetime AS "endDatetime", l.duration_minutes AS "durationMinutes",
             l.location_physical AS "locationPhysical", l.location_remote AS "locationRemote",
             l.status, l.module_id AS "moduleId", m.name AS "moduleName",
             c.id AS "courseId", c.title AS "courseTitle",
             ce.id AS "editionId", ce.edition_name AS "editionName",
             l.teacher_id AS "teacherId", f.name AS "teacherName",
             l.external_teacher_name AS "externalTeacherName"
      FROM enrollments e
      JOIN course_editions ce ON ce.id = e.course_edition_id
      JOIN courses c ON c.id = ce.course_id
      JOIN modules m ON m.course_id = c.id
      JOIN lessons l ON l.module_id = m.id
      LEFT JOIN faculty f ON f.id = l.teacher_id
      WHERE e.user_id = $1
        AND e.status = 'active'
        AND COALESCE(l.status, 'scheduled') <> 'cancelled'
        AND l.start_datetime >= NOW()
        ${courseFilter}
      ORDER BY l.start_datetime ASC
      LIMIT $${values.length}
    `, values);

    res.json(rows);
  } catch (error) {
    console.error('Error fetching upcoming lessons for student', error);
    res.status(500).json({ error: 'Unable to retrieve upcoming lessons' });
  }
});

// Progresso complessivo studente
app.get('/api/lms/my-progress', requireStudent, async (req, res) => {
  if (!ensurePool(res)) return;
  if (req.user.role === 'guest') {
    return res.json({
      lessons: [],
      completedCount: 0,
      totalCount: 0,
      overallPercent: 0,
      courses: [],
      totalAttendances: 0,
      isGuest: true
    });
  }
  try {
    // Lezioni completate e totali per ogni corso
    const { rows: courseProgress } = await pool.query(`
      SELECT c.id AS "courseId", c.title AS "courseTitle",
             COALESCE(ce.total_planned_hours, 432) AS "totalPlannedHours",
             COUNT(DISTINCT ll.id) FILTER (WHERE ll.is_published = true) AS "totalLessons",
             (SELECT COALESCE(SUM(COALESCE(les.duration_minutes, 0)), 0) / 60.0
              FROM attendance a
              JOIN lessons les ON les.id = a.lesson_id
              JOIN modules m_att ON m_att.id = les.module_id
              WHERE a.user_id = $1
                AND m_att.course_id = c.id
                AND a.attendance_type IN ('in_person', 'remote_live', 'remote_partial')
             ) AS "attendedHours",
             COUNT(DISTINCT ll.id) FILTER (WHERE
               EXISTS (SELECT 1 FROM lesson_progress lp2 WHERE lp2.lms_lesson_id = ll.id AND lp2.user_id = $1 AND lp2.completed_at IS NOT NULL)
               OR EXISTS (SELECT 1 FROM attendance a2 WHERE a2.lesson_id = ll.calendar_lesson_id AND a2.user_id = $1 AND a2.attendance_type IN ('in_person', 'remote_live'))
             ) AS "completedLessons"
      FROM enrollments e
      JOIN course_editions ce ON ce.id = e.course_edition_id
      JOIN courses c ON c.id = ce.course_id
      LEFT JOIN modules m ON m.course_id = c.id
      LEFT JOIN lms_lessons ll ON ll.lms_module_id = m.id AND ll.is_published = true
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

app.get('/api/lms/progress/summary', requireStudent, async (req, res) => {
  if (!ensurePool(res)) return;
  if (req.user.role === 'guest') {
    return res.json({
      totalHours: 0,
      completedHours: 0,
      progressPercent: 0,
      modulesProgress: [],
      courses: [],
      totalAttendances: 0,
      isGuest: true
    });
  }
  try {
    const { rows: courseProgress } = await pool.query(`
      SELECT c.id AS "courseId", c.title AS "courseTitle",
             COALESCE(ce.total_planned_hours, 432) AS "totalPlannedHours",
             COUNT(DISTINCT ll.id) FILTER (WHERE ll.is_published = true) AS "totalLessons",
             (SELECT COALESCE(SUM(COALESCE(les.duration_minutes, 0)), 0) / 60.0
              FROM attendance a
              JOIN lessons les ON les.id = a.lesson_id
              JOIN modules m_att ON m_att.id = les.module_id
              WHERE a.user_id = $1
                AND m_att.course_id = c.id
                AND a.attendance_type IN ('in_person', 'remote_live', 'remote_partial')
             ) AS "attendedHours",
             COUNT(DISTINCT ll.id) FILTER (WHERE
               EXISTS (SELECT 1 FROM lesson_progress lp2 WHERE lp2.lms_lesson_id = ll.id AND lp2.user_id = $1 AND lp2.completed_at IS NOT NULL)
               OR EXISTS (SELECT 1 FROM attendance a2 WHERE a2.lesson_id = ll.calendar_lesson_id AND a2.user_id = $1 AND a2.attendance_type IN ('in_person', 'remote_live'))
             ) AS "completedLessons"
      FROM enrollments e
      JOIN course_editions ce ON ce.id = e.course_edition_id
      JOIN courses c ON c.id = ce.course_id
      LEFT JOIN modules m ON m.course_id = c.id
      LEFT JOIN lms_lessons ll ON ll.lms_module_id = m.id AND ll.is_published = true
      WHERE e.user_id = $1 AND e.status = 'active'
      GROUP BY c.id, c.title, ce.total_planned_hours
    `, [req.user.userId]);

    const { rows: attendanceRows } = await pool.query(
      'SELECT COUNT(*)::int AS total FROM attendance WHERE user_id = $1',
      [req.user.userId]
    );

    res.json({
      courses: courseProgress,
      totalAttendances: attendanceRows[0]?.total || 0
    });
  } catch (error) {
    console.error('Error fetching student progress summary', error);
    res.status(500).json({ error: 'Unable to retrieve progress summary' });
  }
});

// ============================================
// STUDENT Q&A / FAQ
// ============================================

app.get('/api/lms/questions', requireStudent, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const values = [req.user.userId];
    let where = 'WHERE sq.user_id = $1';
    if (req.query.moduleId) {
      values.push(req.query.moduleId);
      where += ` AND sq.module_id = $${values.length}`;
    }

    const { rows } = await pool.query(`
      SELECT sq.id,
             sq.user_id AS "userId",
             sq.module_id AS "moduleId",
             m.name AS "moduleTitle",
             sq.lms_lesson_id AS "lmsLessonId",
             ll.title AS "lessonTitle",
             sq.question_text AS "questionText",
             sq.status,
             sq.assigned_to AS "assignedTo",
             COALESCE(ft.name, NULLIF(TRIM(COALESCE(ft.first_name, '') || ' ' || COALESCE(ft.last_name, '')), ''), ft.email) AS "assignedTeacherName",
             sq.is_faq AS "isFaq",
             sq.faq_category AS "faqCategory",
             sq.created_at AS "createdAt",
             sq.updated_at AS "updatedAt"
      FROM student_questions sq
      LEFT JOIN modules m ON m.id = sq.module_id
      LEFT JOIN lms_lessons ll ON ll.id = sq.lms_lesson_id
      LEFT JOIN faculty ft ON ft.id = sq.assigned_to
      ${where}
      ORDER BY sq.created_at DESC
    `, values);

    res.json(await attachRepliesToQuestions(rows));
  } catch (error) {
    console.error('Error fetching student questions', error);
    res.status(500).json({ error: 'Unable to retrieve questions' });
  }
});

app.post('/api/lms/questions', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  const { questionText, moduleId, lessonId } = req.body || {};
  if (!questionText || !String(questionText).trim()) {
    return res.status(400).json({ error: 'questionText is required' });
  }

  try {
    const { rows } = await pool.query(`
      INSERT INTO student_questions (id, user_id, module_id, lms_lesson_id, question_text, status)
      VALUES ($1, $2, $3, $4, $5, 'open')
      RETURNING id,
                user_id AS "userId",
                module_id AS "moduleId",
                lms_lesson_id AS "lmsLessonId",
                question_text AS "questionText",
                status,
                is_faq AS "isFaq",
                faq_category AS "faqCategory",
                created_at AS "createdAt",
                updated_at AS "updatedAt"
    `, [uuidv4(), req.user.userId, moduleId || null, lessonId || null, String(questionText).trim()]);

    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Error creating student question', error);
    res.status(500).json({ error: 'Unable to create question' });
  }
});

app.get('/api/lms/faq', async (_req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT sq.id,
             sq.user_id AS "userId",
             sq.module_id AS "moduleId",
             m.name AS "moduleTitle",
             sq.lms_lesson_id AS "lmsLessonId",
             ll.title AS "lessonTitle",
             sq.question_text AS "questionText",
             sq.status,
             sq.assigned_to AS "assignedTo",
             COALESCE(ft.name, NULLIF(TRIM(COALESCE(ft.first_name, '') || ' ' || COALESCE(ft.last_name, '')), ''), ft.email) AS "assignedTeacherName",
             sq.is_faq AS "isFaq",
             COALESCE(NULLIF(sq.faq_category, ''), 'Generale') AS "faqCategory",
             sq.created_at AS "createdAt",
             sq.updated_at AS "updatedAt"
      FROM student_questions sq
      LEFT JOIN modules m ON m.id = sq.module_id
      LEFT JOIN lms_lessons ll ON ll.id = sq.lms_lesson_id
      LEFT JOIN faculty ft ON ft.id = sq.assigned_to
      WHERE sq.is_faq = true
      ORDER BY COALESCE(NULLIF(sq.faq_category, ''), 'Generale'), sq.created_at DESC
    `);

    const items = await attachRepliesToQuestions(rows);
    const grouped = {};
    items.forEach((item) => {
      const category = item.faqCategory || 'Generale';
      if (!grouped[category]) grouped[category] = [];
      grouped[category].push(item);
    });
    res.json(grouped);
  } catch (error) {
    console.error('Error fetching FAQ', error);
    res.status(500).json({ error: 'Unable to retrieve FAQ' });
  }
});

app.get('/api/questions', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const values = [];
    let where = '';
    if (req.query.status) {
      values.push(req.query.status);
      where = `WHERE sq.status = $${values.length}`;
    }

    const { rows } = await pool.query(`
      SELECT sq.id,
             sq.user_id AS "userId",
             COALESCE(NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), ''), u.email, 'Studente') AS "studentName",
             u.email AS "studentEmail",
             sq.module_id AS "moduleId",
             m.name AS "moduleTitle",
             sq.lms_lesson_id AS "lmsLessonId",
             ll.title AS "lessonTitle",
             sq.question_text AS "questionText",
             sq.status,
             sq.assigned_to AS "assignedTo",
             COALESCE(ft.name, NULLIF(TRIM(COALESCE(ft.first_name, '') || ' ' || COALESCE(ft.last_name, '')), ''), ft.email) AS "assignedTeacherName",
             sq.is_faq AS "isFaq",
             sq.faq_category AS "faqCategory",
             sq.created_at AS "createdAt",
             sq.updated_at AS "updatedAt"
      FROM student_questions sq
      JOIN users u ON u.id = sq.user_id
      LEFT JOIN modules m ON m.id = sq.module_id
      LEFT JOIN lms_lessons ll ON ll.id = sq.lms_lesson_id
      LEFT JOIN faculty ft ON ft.id = sq.assigned_to
      ${where}
      ORDER BY
        CASE sq.status
          WHEN 'open' THEN 1
          WHEN 'assigned' THEN 2
          WHEN 'answered' THEN 3
          WHEN 'promoted_faq' THEN 4
          ELSE 5
        END,
        sq.created_at DESC
    `, values);

    res.json(await attachRepliesToQuestions(rows));
  } catch (error) {
    console.error('Error fetching admin questions', error);
    res.status(500).json({ error: 'Unable to retrieve questions' });
  }
});

app.put('/api/questions/:id/assign', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { teacherId } = req.body || {};
  if (!teacherId) {
    return res.status(400).json({ error: 'teacherId is required' });
  }
  try {
    const { rows: teachers } = await pool.query('SELECT id FROM faculty WHERE id = $1', [teacherId]);
    if (!teachers.length) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    const { rows } = await pool.query(`
      UPDATE student_questions
      SET assigned_to = $1, status = 'assigned', updated_at = NOW()
      WHERE id = $2
      RETURNING id,
                user_id AS "userId",
                module_id AS "moduleId",
                lms_lesson_id AS "lmsLessonId",
                question_text AS "questionText",
                status,
                assigned_to AS "assignedTo",
                is_faq AS "isFaq",
                faq_category AS "faqCategory",
                created_at AS "createdAt",
                updated_at AS "updatedAt"
    `, [teacherId, req.params.id]);

    if (!rows.length) {
      return res.status(404).json({ error: 'Question not found' });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error('Error assigning question', error);
    res.status(500).json({ error: 'Unable to assign question' });
  }
});

app.post('/api/questions/:id/reply', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { replyText } = req.body || {};
  if (!replyText || !String(replyText).trim()) {
    return res.status(400).json({ error: 'replyText is required' });
  }
  try {
    const { rows: questions } = await pool.query('SELECT id FROM student_questions WHERE id = $1', [req.params.id]);
    if (!questions.length) {
      return res.status(404).json({ error: 'Question not found' });
    }

    const replyId = uuidv4();
    const adminAuthorId = req.admin?.userId || '00000000-0000-0000-0000-000000000000';
    const { rows } = await pool.query(`
      WITH reply AS (
        INSERT INTO question_replies (id, question_id, author_id, author_role, reply_text)
        VALUES ($1, $2, $3, 'admin', $4)
        RETURNING id,
                  question_id AS "questionId",
                  author_id AS "authorId",
                  author_role AS "authorRole",
                  reply_text AS "replyText",
                  created_at AS "createdAt"
      )
      UPDATE student_questions
      SET status = 'answered', updated_at = NOW()
      WHERE id = $2
      RETURNING (SELECT row_to_json(reply) FROM reply) AS reply
    `, [replyId, req.params.id, adminAuthorId, String(replyText).trim()]);

    const reply = rows[0]?.reply || null;
    if (reply) reply.authorName = 'Amministrazione';
    res.status(201).json({ questionId: req.params.id, ...reply });
  } catch (error) {
    console.error('Error replying to question as admin', error);
    res.status(500).json({ error: 'Unable to reply to question' });
  }
});

app.put('/api/questions/:id/promote-faq', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { faqCategory } = req.body || {};
  try {
    const { rows } = await pool.query(`
      UPDATE student_questions
      SET is_faq = true,
          status = 'promoted_faq',
          faq_category = COALESCE($1, faq_category),
          updated_at = NOW()
      WHERE id = $2
      RETURNING id,
                user_id AS "userId",
                module_id AS "moduleId",
                lms_lesson_id AS "lmsLessonId",
                question_text AS "questionText",
                status,
                assigned_to AS "assignedTo",
                is_faq AS "isFaq",
                faq_category AS "faqCategory",
                created_at AS "createdAt",
                updated_at AS "updatedAt"
    `, [faqCategory || null, req.params.id]);

    if (!rows.length) {
      return res.status(404).json({ error: 'Question not found' });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error('Error promoting question to FAQ', error);
    res.status(500).json({ error: 'Unable to promote question to FAQ' });
  }
});

app.get('/api/teachers/questions', requireTeacher, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT sq.id,
             sq.user_id AS "userId",
             COALESCE(NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), ''), u.email, 'Studente') AS "studentName",
             u.email AS "studentEmail",
             sq.module_id AS "moduleId",
             m.name AS "moduleTitle",
             sq.lms_lesson_id AS "lmsLessonId",
             ll.title AS "lessonTitle",
             sq.question_text AS "questionText",
             sq.status,
             sq.assigned_to AS "assignedTo",
             COALESCE(ft.name, NULLIF(TRIM(COALESCE(ft.first_name, '') || ' ' || COALESCE(ft.last_name, '')), ''), ft.email) AS "assignedTeacherName",
             sq.is_faq AS "isFaq",
             sq.faq_category AS "faqCategory",
             sq.created_at AS "createdAt",
             sq.updated_at AS "updatedAt"
      FROM student_questions sq
      JOIN users u ON u.id = sq.user_id
      LEFT JOIN modules m ON m.id = sq.module_id
      LEFT JOIN lms_lessons ll ON ll.id = sq.lms_lesson_id
      LEFT JOIN faculty ft ON ft.id = sq.assigned_to
      WHERE sq.assigned_to = $1
      ORDER BY sq.created_at DESC
    `, [req.teacher.id]);

    res.json(await attachRepliesToQuestions(rows));
  } catch (error) {
    console.error('Error fetching teacher questions', error);
    res.status(500).json({ error: 'Unable to retrieve questions' });
  }
});

app.post('/api/teachers/questions/:id/reply', requireTeacher, async (req, res) => {
  if (!ensurePool(res)) return;
  const { replyText } = req.body || {};
  if (!replyText || !String(replyText).trim()) {
    return res.status(400).json({ error: 'replyText is required' });
  }
  try {
    const { rows: questions } = await pool.query(
      'SELECT id FROM student_questions WHERE id = $1 AND assigned_to = $2',
      [req.params.id, req.teacher.id]
    );
    if (!questions.length) {
      return res.status(404).json({ error: 'Question not found' });
    }

    const replyId = uuidv4();
    const { rows } = await pool.query(`
      WITH reply AS (
        INSERT INTO question_replies (id, question_id, author_id, author_role, reply_text)
        VALUES ($1, $2, $3, 'teacher', $4)
        RETURNING id,
                  question_id AS "questionId",
                  author_id AS "authorId",
                  author_role AS "authorRole",
                  reply_text AS "replyText",
                  created_at AS "createdAt"
      )
      UPDATE student_questions
      SET status = 'answered', updated_at = NOW()
      WHERE id = $2
      RETURNING (SELECT row_to_json(reply) FROM reply) AS reply
    `, [replyId, req.params.id, req.teacher.id, String(replyText).trim()]);

    const reply = rows[0]?.reply || null;
    if (reply) reply.authorName = req.teacher.name || 'Docente';
    res.status(201).json({ questionId: req.params.id, ...reply });
  } catch (error) {
    console.error('Error replying to question as teacher', error);
    res.status(500).json({ error: 'Unable to reply to question' });
  }
});

// Salva progresso video lezione
app.post('/api/lms/lessons/:id/progress', requireStudent, requireNonGuest, async (req, res) => {
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
    const quizColumns = await getTableColumns('quizzes');
    const hasGenerationReport = quizColumns.has('generation_report');
    const { lessonId, moduleId } = req.query;
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
    if (moduleId) {
      filters.push(`lms_module_id = $${values.length + 1}`);
      values.push(moduleId);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const { rows } = await pool.query(`
      SELECT id, lms_lesson_id AS "lessonId", lms_module_id AS "moduleId",
             resource_id AS "resourceId",
             title, description, passing_score AS "passingScore",
             max_attempts AS "maxAttempts", time_limit_minutes AS "timeLimitMinutes",
             ${hasGenerationReport ? `generation_report AS "generationReport",` : `NULL::jsonb AS "generationReport",`}
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
    const quizColumns = await getTableColumns('quizzes');
    const hasGenerationReport = quizColumns.has('generation_report');
    const { rows: quizRows } = await pool.query(`
      SELECT id, lms_lesson_id AS "lessonId", lms_module_id AS "moduleId",
             resource_id AS "resourceId",
             title, description, passing_score AS "passingScore",
             max_attempts AS "maxAttempts", time_limit_minutes AS "timeLimitMinutes",
             ${hasGenerationReport ? `generation_report AS "generationReport",` : `NULL::jsonb AS "generationReport",`}
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
  const { lessonId, moduleId, title, description, passingScore, maxAttempts, timeLimitMinutes, isPublished, generationReport } = req.body;
  if (!title || (!lessonId && !moduleId)) {
    return res.status(400).json({ error: 'title and lessonId or moduleId are required' });
  }
  try {
    const quizColumns = await getTableColumns('quizzes');
    const hasGenerationReport = quizColumns.has('generation_report');
    const id = uuidv4();
    const nextIsPublished = lessonId ? false : (isPublished !== false);
    const insertColumns = ['id', 'lms_lesson_id', 'lms_module_id', 'title', 'description', 'passing_score', 'max_attempts', 'time_limit_minutes', 'is_published'];
    const insertValues = ['$1', '$2', '$3', '$4', '$5', '$6', '$7', '$8', '$9'];
    const params = [id, lessonId || null, moduleId || null, title, description || null,
      passingScore || 70, maxAttempts || 0, timeLimitMinutes || null, nextIsPublished];
    if (hasGenerationReport) {
      insertColumns.push('generation_report');
      insertValues.push(`$${params.length + 1}`);
      params.push(JSON.stringify(generationReport || {}));
    }
    const { rows } = await pool.query(`
      INSERT INTO quizzes (${insertColumns.join(', ')})
      VALUES (${insertValues.join(', ')})
      RETURNING id, lms_lesson_id AS "lessonId", lms_module_id AS "moduleId",
                resource_id AS "resourceId", title, description, passing_score AS "passingScore",
                max_attempts AS "maxAttempts", time_limit_minutes AS "timeLimitMinutes",
                ${hasGenerationReport ? `generation_report AS "generationReport",` : `NULL::jsonb AS "generationReport",`}
                is_published AS "isPublished"
    `, params);
    const resourceId = await syncQuizResource(id);
    await syncQuizIntoLessonMaterials(id);
    if (lessonId) {
      await ensureLessonQuizTeacherReviewState(id);
    }
    res.status(201).json({ ...rows[0], resourceId });
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
    const resourceId = await syncQuizResource(req.params.id);
    await syncQuizIntoLessonMaterials(req.params.id);
    res.json({
      id: r.id, lessonId: r.lms_lesson_id, moduleId: r.lms_module_id, resourceId,
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
    const { rows: existingRows } = await pool.query('SELECT resource_id AS "resourceId" FROM quizzes WHERE id = $1', [req.params.id]);
    if (!existingRows.length) return res.status(404).json({ error: 'Quiz not found' });
    const resourceId = existingRows[0].resourceId;
    await removeQuizFromLessonMaterials(req.params.id);
    await pool.query('DELETE FROM quizzes WHERE id = $1', [req.params.id]);
    if (resourceId) {
      await pool.query('DELETE FROM resources WHERE id = $1', [resourceId]);
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting quiz', error);
    res.status(500).json({ error: 'Unable to delete quiz' });
  }
});

// --- GENERA QUIZ CON AI ---
app.post('/api/lms/quizzes/generate', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  
  const { lessonId, moduleId, numQuestions = 5, difficulty = 'intermediate' } = req.body;

  if (!lessonId && !moduleId) {
    return res.status(400).json({ error: 'lessonId o moduleId è obbligatorio' });
  }

  try {
    let context = '';
    let contextTitle = '';
    let generationReport = null;

    if (moduleId) {
      ({ contextTitle, context, generationReport } = await buildModuleQuizGenerationContext(moduleId));
    } else {
      ({ contextTitle, context, generationReport } = await buildLessonQuizGenerationContext(lessonId));
    }

    if (!normalizeExtractedText(context)) {
      return res.status(400).json({
        error: 'Nessun contenuto reale disponibile per generare il quiz. Carica PDF/slide/documenti leggibili o un transcript video approvato.'
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

CONTESTO DIDATTICO ESTRATTO DAI MATERIALI REALI:
${context}

ISTRUZIONI:
Genera esattamente ${numQuestions} domande a risposta multipla con difficoltà ${difficultyMap[difficulty] || 'intermedia'}.

Le domande devono basarsi prima di tutto sul contenuto reale estratto da PDF, slide, documenti e transcript video.
Usa titoli, descrizioni e note solo come supporto, non come fonte principale.
Evita domande generiche che potrebbero essere scritte senza aver letto il materiale.

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
      lessonTitle: contextTitle,
      moduleId: moduleId || null,
      lessonId: lessonId || null,
      generationReport: generationReport || null,
      numQuestions: generated.questions?.length || 0,
      questions: generated.questions || []
    });

  } catch (error) {
    console.error('Error generating quiz:', error);
    res.status(error.statusCode || 500).json({ error: 'Errore nella generazione del quiz: ' + error.message });
  }
});

// --- GENERA QUIZ PRELIMINARE DA RISORSE ---
app.post('/api/resources/generate-quiz', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  
  const { numQuestions = 10, difficulty = 'intermediate', title = 'Quiz Preliminare' } = req.body;

  try {
    // 1. Recupera le risorse pubblicate
    const { rows: resources } = await pool.query(`
      SELECT id, title, description, resource_type AS "resourceType", url,
             extracted_text AS "extractedText"
      FROM resources
      WHERE is_published = true
        AND resource_type <> 'quiz'
      ORDER BY sort_order
    `);
    
    if (!resources.length) {
      return res.status(400).json({ error: 'Nessuna risorsa pubblicata trovata. Pubblica almeno una risorsa prima di generare il quiz.' });
    }
    
    // Costruisci il contesto dalle risorse
    const sections = [];
    const tracker = { total: 0 };
    appendContextSection(sections, 'Raccolta risorse Master Carbon Farming', 'Usa le fonti seguenti per costruire il quiz preliminare.', {
      tracker,
      perSectionLimit: 1000,
      totalLimit: 35000
    });
    for (const resource of resources) {
      const text = await getResourceQuizSourceText(resource);
      appendContextSection(
        sections,
        `Risorsa: ${resource.title} (${resource.resourceType})`,
        text || [resource.description, resource.url].filter(Boolean).join('\n'),
        { tracker, perSectionLimit: 5000, totalLimit: 35000 }
      );
    }
    let context = sections.join('\n\n');

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

RISORSE DEL CORSO ESTRATTE:
${context}

ISTRUZIONI:
Genera esattamente ${numQuestions} domande a risposta multipla con difficoltà ${difficultyMap[difficulty] || 'intermedia'}.

Le domande devono coprire, sulla base del contenuto reale delle risorse:
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
    res.status(error.statusCode || 500).json({ error: 'Errore nella generazione del quiz: ' + error.message });
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
    await syncQuizResource(quizId);
    await syncQuizIntoLessonMaterials(quizId);
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
    await syncQuizResource(r.quiz_id);
    await syncQuizIntoLessonMaterials(r.quiz_id);
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
    const { rows } = await pool.query('DELETE FROM quiz_questions WHERE id = $1 RETURNING quiz_id AS "quizId"', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Question not found' });
    await syncQuizResource(rows[0].quizId);
    await syncQuizIntoLessonMaterials(rows[0].quizId);
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting quiz question', error);
    res.status(500).json({ error: 'Unable to delete question' });
  }
});

// --- QUIZ SUBMIT & ATTEMPTS ---

// Studente invia risposte quiz
app.post('/api/lms/quizzes/:id/submit', requireStudent, requireNonGuest, async (req, res) => {
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
app.post('/api/lms/lessons/:id/complete', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  const lessonId = req.params.id;
  const userId = req.user.userId;

  try {
    // 1. Carica lezione
    const { rows: lessonRows } = await pool.query(
      'SELECT id, lms_module_id AS "moduleId", duration_seconds AS "durationSeconds", calendar_lesson_id AS "calendarLessonId" FROM lms_lessons WHERE id = $1',
      [lessonId]
    );
    if (!lessonRows.length) return res.status(404).json({ error: 'Lesson not found' });
    const lesson = lessonRows[0];

    // 2. Controlla se lo studente ha una presenza (in_person o remote_live)
    const { rows: attendanceRows } = await pool.query(`
      SELECT a.id FROM attendance a
      JOIN lms_lessons ll ON ll.id = $1
      WHERE a.user_id = $2
      AND a.lesson_id = ll.calendar_lesson_id
      AND a.attendance_type IN ('in_person', 'remote_live')
      LIMIT 1
    `, [lessonId, userId]);

    if (attendanceRows.length > 0) {
      // Presenza trovata — completa automaticamente
      await pool.query(`
        INSERT INTO lesson_progress (id, user_id, lms_lesson_id, progress_percent, completed_at)
        VALUES ($1, $2, $3, 100, NOW())
        ON CONFLICT (user_id, lms_lesson_id) DO UPDATE SET completed_at = NOW(), progress_percent = 100, updated_at = NOW()
      `, [uuidv4(), userId, lessonId]);
      return res.json({ completed: true, message: 'Lezione completata (presenza registrata)', criteria: { attendance: true } });
    }

    // 3. Nessuna presenza — controlla i criteri asincroni
    const { rows: progressRows } = await pool.query(
      'SELECT progress_percent, time_spent_seconds, completed_at FROM lesson_progress WHERE user_id = $1 AND lms_lesson_id = $2',
      [userId, lessonId]
    );

    if (!progressRows.length) {
      return res.status(400).json({
        error: 'Nessun progresso registrato',
        criteria: { video: false, materials: false, quiz: false }
      });
    }

    const progress = progressRows[0];
    if (progress.completed_at) {
      return res.json({ completed: true, message: 'Lezione già completata', completedAt: progress.completed_at });
    }

    const completion = await getLessonCompletionStatus(lessonId, userId, {
      lesson,
      progress
    });

    if (!completion.allMet) {
      return res.status(400).json({
        error: 'Criteri di completamento non soddisfatti',
        criteria: completion.criteria,
        details: completion.details
      });
    }

    // Criteri soddisfatti — segna completata
    await pool.query(
      'UPDATE lesson_progress SET completed_at = NOW(), updated_at = NOW() WHERE user_id = $1 AND lms_lesson_id = $2 AND completed_at IS NULL',
      [userId, lessonId]
    );

    // Crea automaticamente presenza asincrona
    await pool.query(`
      INSERT INTO attendance (id, user_id, lms_lesson_id, attendance_type, method)
      VALUES ($1, $2, $3, 'async', 'auto_tracking')
      ON CONFLICT (user_id, lms_lesson_id) DO NOTHING
    `, [uuidv4(), userId, lessonId]);

    res.json({
      completed: true,
      message: 'Lezione completata!',
      criteria: completion.criteria,
      details: completion.details
    });
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

// Admin: lista lezioni per filtro report presenze
app.get('/api/attendance/lessons/:courseEditionId', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { courseEditionId } = req.params;
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT l.id, l.title, l.start_datetime AS "startDatetime"
      FROM lessons l
      JOIN modules m ON m.id = l.module_id
      JOIN course_editions ce ON ce.course_id = m.course_id
      WHERE ce.id = $1 AND COALESCE(l.status, 'scheduled') != 'cancelled'
      ORDER BY l.start_datetime ASC
    `, [courseEditionId]);
    res.json({ lessons: rows });
  } catch (error) {
    console.error('Error fetching lessons for attendance:', error);
    res.status(500).json({ error: 'Errore' });
  }
});

// Pubblico: ottieni codice check-in attivo (per display)
app.get('/api/attendance/active-code', async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT ac.code, ac.expires_at, l.title as lesson_title
      FROM attendance_codes ac
      LEFT JOIN lessons l ON l.id = ac.lesson_id
      WHERE ac.expires_at > NOW()
      ORDER BY ac.created_at DESC
      LIMIT 1
    `);
    
    if (rows.length === 0) {
      return res.json({ code: null });
    }
    
    res.json({
      code: rows[0].code,
      expiresAt: rows[0].expires_at,
      lessonTitle: rows[0].lesson_title
    });
  } catch (error) {
    console.error('Error fetching active code:', error);
    res.status(500).json({ error: 'Errore' });
  }
});

// Studente: check-in con PIN
app.post('/api/attendance/checkin', requireStudent, requireNonGuest, async (req, res) => {
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
      INSERT INTO attendance (id, user_id, lesson_id, attendance_type, method, check_in_at)
      VALUES ($1, $2, $3, 'in_person', 'pin', NOW())
      ON CONFLICT (user_id, lesson_id) DO UPDATE SET
        attendance_type = 'in_person',
        method = 'pin',
        check_in_at = NOW()
      RETURNING id, (xmax = 0) AS is_new
    `, [uuidv4(), req.user.userId, lessonId]);

    const lessonTitle = lessonRows.length ? lessonRows[0].title : '';

    const isNew = rows[0]?.is_new;
    res.json({
      success: true,
      message: isNew ? 'Presenza registrata' : 'Presenza aggiornata',
      lessonTitle,
      updated: !isNew
    });
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

    const { rows } = await pool.query(`
      INSERT INTO attendance (id, lesson_id, user_id, check_in_at, attendance_type, method)
      VALUES ($1, $2, $3, NOW(), $4, 'manual')
      ON CONFLICT (user_id, lesson_id) DO UPDATE SET
        attendance_type = EXCLUDED.attendance_type,
        method = EXCLUDED.method,
        check_in_at = NOW()
      RETURNING id, (xmax = 0) AS is_new
    `, [attendanceId, lessonId, userId, attendanceType]);

    const isNew = rows[0]?.is_new;
    res.status(isNew ? 201 : 200).json({ success: true, id: rows[0].id, updated: !isNew });
  } catch (error) {
    console.error('Error manual check-in', error);
    res.status(500).json({ error: 'Unable to register attendance' });
  }
});

// Admin: update attendance type
app.put('/api/attendance/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { id } = req.params;
  const { attendanceType } = req.body;
  if (!attendanceType) return res.status(400).json({ error: 'attendanceType required' });
  try {
    const { rows } = await pool.query(
      'UPDATE attendance SET attendance_type = $1 WHERE id = $2 RETURNING *',
      [attendanceType, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Attendance not found' });
    res.json(rows[0]);
  } catch (error) {
    console.error('Error updating attendance', error);
    res.status(500).json({ error: 'Unable to update attendance' });
  }
});

// Admin: import CSV report partecipanti Zoom/Teams
app.post('/api/attendance/import-csv', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { lessonId, participants } = req.body;
  if (!lessonId || !Array.isArray(participants)) {
    return res.status(400).json({ error: 'lessonId and participants array are required' });
  }

  // Parse Zoom date format DD/MM/YYYY HH:MM:SS AM/PM → ISO
  function parseZoomDate(dateStr) {
    if (!dateStr) return null;
    const match = dateStr.match(/(\d{2})\/(\d{2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
    if (!match) return dateStr; // fallback
    let [, day, month, year, hours, mins, secsRaw, ampm] = match;
    let yearNum = parseInt(year);
    if (yearNum < 100) yearNum += 2000;
    year = String(yearNum);
    const secs = secsRaw || '00';
    hours = parseInt(hours);
    if (ampm && ampm.toUpperCase() === 'PM' && hours < 12) hours += 12;
    if (ampm && ampm.toUpperCase() === 'AM' && hours === 12) hours = 0;
    return `${year}-${month}-${day}T${String(hours).padStart(2,'0')}:${mins}:${secs}`;
  }

  try {
    // Load all active enrolled students (simple and robust)
    const { rows: enrolledStudents } = await pool.query(`
      SELECT DISTINCT u.id, u.email,
             LOWER(COALESCE(u.first_name, '')) AS first_name,
             LOWER(COALESCE(u.last_name, '')) AS last_name,
             LOWER(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS full_name,
             LOWER(COALESCE(u.last_name, '') || ' ' || COALESCE(u.first_name, '')) AS full_name_rev
      FROM enrollments e
      JOIN users u ON u.id = e.user_id
      WHERE e.status = 'active'
    `, []);

    // Get lesson duration for partial attendance calculation
    const { rows: lessonRows } = await pool.query('SELECT duration_minutes FROM lessons WHERE id = $1', [lessonId]);
    const lessonDuration = lessonRows[0]?.duration_minutes || 180;

    let imported = 0;
    let updated = 0;
    let partial = 0;
    const unmatched = [];
    const matched = [];

    for (const p of participants) {
      const email = (p.email || '').trim().toLowerCase();
      const name = (p.name || '').trim();
      let userId = null;

      // 1. Match by email if available
      if (email) {
        const { rows: userRows } = await pool.query(
          'SELECT id FROM users WHERE LOWER(email) = $1', [email]
        );
        if (userRows.length) userId = userRows[0].id;
      }

      // 2. Match by name if no email match
      if (!userId && name) {
        const normName = name.toLowerCase().trim();
        const found = enrolledStudents.find(s => {
          if (s.full_name === normName || s.full_name_rev === normName) return true;
          if (s.first_name && s.last_name && normName.includes(s.first_name) && normName.includes(s.last_name)) return true;
          return false;
        });
        if (found) userId = found.id;
      }

      if (!userId) { unmatched.push(name || email || '?'); continue; }

      // Calculate attendance type based on duration
      const participantMinutes = p.durationMinutes || 0;
      const attendancePercent = lessonDuration > 0 ? (participantMinutes / lessonDuration) * 100 : 100;
      const attendanceType = attendancePercent >= 80 ? 'remote_live' : 'remote_partial';

      const joinISO = parseZoomDate(p.joinTime) || new Date().toISOString();
      const leaveISO = parseZoomDate(p.leaveTime) || null;

      const { rows: insertRows } = await pool.query(`
        INSERT INTO attendance (id, user_id, lesson_id, attendance_type, method, check_in_at, check_out_at)
        VALUES ($1, $2, $3, $4, 'csv_import', $5, $6)
        ON CONFLICT (user_id, lesson_id) DO UPDATE SET
          attendance_type = EXCLUDED.attendance_type,
          check_in_at = EXCLUDED.check_in_at,
          check_out_at = EXCLUDED.check_out_at
        RETURNING (xmax = 0) AS is_new
      `, [uuidv4(), userId, lessonId, attendanceType, joinISO, leaveISO]);

      const isNew = insertRows[0]?.is_new;
      if (isNew) { imported++; } else { updated++; }
      if (attendanceType === 'remote_partial') partial++;
      matched.push(name + (attendanceType === 'remote_partial' ? ' (parziale)' : ''));
    }

    res.json({ imported, updated, partial, notFound: unmatched.length, matched, unmatched });
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
      SELECT DISTINCT l.id, l.title, l.start_datetime AS "startDatetime"
      FROM lessons l
      JOIN modules m ON m.id = l.module_id
      JOIN course_editions ce ON ce.course_id = m.course_id
      WHERE ce.id = $1 AND COALESCE(l.status, 'scheduled') != 'cancelled'
      ORDER BY l.start_datetime ASC
    `, [courseEditionId]);

    // LMS lessons del corso (per presenze async)
    const { rows: lmsLessons } = await pool.query(`
      SELECT ll.id, ll.title
      FROM lms_lessons ll
      JOIN modules lm ON lm.id = ll.lms_module_id
      JOIN course_editions ce ON ce.course_id = lm.course_id
      WHERE ce.id = $1 AND ll.is_published = true
      ORDER BY lm.sort_order ASC, ll.sort_order ASC
    `, [courseEditionId]);

    const totalLessons = calendarLessons.length + lmsLessons.length;
    const { rows: editionRows } = await pool.query(
      'SELECT COALESCE(total_planned_hours, 432) AS total_planned_hours FROM course_editions WHERE id = $1',
      [courseEditionId]
    );
    const totalPlannedHours = Number(editionRows[0]?.total_planned_hours || 432);
    const studentIds = students.map(s => s.id);

    // Build filters for attendance query
    let attendanceQuery = `
      SELECT a.id, a.user_id, a.lesson_id, a.lms_lesson_id, a.attendance_type, a.method,
             a.check_in_at, a.check_out_at, COALESCE(les.duration_minutes, 0) AS duration_minutes
      FROM attendance a
      LEFT JOIN lessons les ON les.id = a.lesson_id
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
      const remotePartial = filteredAttendances.filter(a => a.attendance_type === 'remote_partial').length;
      const asyncCount = filteredAttendances.filter(a => a.attendance_type === 'async').length;
      const total = inPerson + remoteLive + remotePartial + asyncCount;
      const attendedMinutes = filteredAttendances
        .filter(a => ['in_person', 'remote_live', 'remote_partial'].includes(a.attendance_type))
        .reduce((sum, a) => sum + Number(a.duration_minutes || 0), 0);
      const attendedHours = attendedMinutes / 60.0;
      const percentage = totalPlannedHours > 0 ? Math.round((attendedHours / totalPlannedHours) * 100) : 0;

      // Per singola lezione, includi dettagli presenza
      const singleLessonAttendance = lessonId && filteredAttendances.length > 0 ? filteredAttendances[0] : null;
      
      return {
        id: s.id,
        email: s.email,
        firstName: s.firstName,
        lastName: s.lastName,
        inPerson,
        remoteLive,
        remotePartial,
        async: asyncCount,
        total,
        totalLessons,
        attendedHours,
        totalPlannedHours,
        percentage,
        // Campi per vista singola lezione
        attendanceId: singleLessonAttendance?.id,
        attendanceType: singleLessonAttendance?.attendance_type,
        method: singleLessonAttendance?.method,
        checkInAt: singleLessonAttendance?.check_in_at,
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
      totalLessons,
      totalPlannedHours
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
      `SELECT a.user_id, a.attendance_type, COALESCE(les.duration_minutes, 0) AS duration_minutes
       FROM attendance a
       LEFT JOIN lessons les ON les.id = a.lesson_id
       WHERE a.user_id = ANY($1)`,
      [studentIds]
    );

    const { rows: editionRows } = await pool.query(
      'SELECT COALESCE(total_planned_hours, 432) AS total_planned_hours FROM course_editions WHERE id = $1',
      [courseEditionId]
    );
    const totalPlannedHours = Number(editionRows[0]?.total_planned_hours || 432);

    let csv = 'cognome,nome,email,in_persona,da_remoto,parziale,asincrona,totale_presenze,ore_frequentate,ore_pianificate,percentuale\n';
    students.forEach(s => {
      const sa = attendances.filter(a => a.user_id === s.id);
      const inPerson = sa.filter(a => a.attendance_type === 'in_person').length;
      const remoteLive = sa.filter(a => a.attendance_type === 'remote_live').length;
      const remotePartial = sa.filter(a => a.attendance_type === 'remote_partial').length;
      const asyncCount = sa.filter(a => a.attendance_type === 'async').length;
      const total = inPerson + remoteLive + remotePartial + asyncCount;
      const attendedMinutes = sa
        .filter(a => ['in_person', 'remote_live', 'remote_partial'].includes(a.attendance_type))
        .reduce((sum, a) => sum + Number(a.duration_minutes || 0), 0);
      const attendedHours = (attendedMinutes / 60.0).toFixed(2);
      const pct = totalPlannedHours > 0 ? Math.round((Number(attendedHours) / totalPlannedHours) * 100) : 0;
      csv += `"${s.last_name}","${s.first_name}","${s.email}",${inPerson},${remoteLive},${remotePartial},${asyncCount},${total},${attendedHours},${totalPlannedHours},${pct}%\n`;
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
      SELECT cw.*, ll.title AS lesson_title, lm.name AS module_title
      FROM content_workflow cw
      JOIN lms_lessons ll ON ll.id = cw.lms_lesson_id
      JOIN modules lm ON lm.id = ll.lms_module_id
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
      SELECT cw.*, ll.title AS lesson_title, lm.name AS module_title
      FROM content_workflow cw
      JOIN lms_lessons ll ON ll.id = cw.lms_lesson_id
      JOIN modules lm ON lm.id = ll.lms_module_id
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
app.post('/api/quiz-attempts/start', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;

  try {
    const userId = req.user.userId;

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
app.post('/api/quiz-attempts/:id/submit', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;

  try {
    const userId = req.user.userId;
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
app.get('/api/quiz-attempts/my', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;

  try {
    const userId = req.user.userId;

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

// ============================================
// API DOCUMENTI E FIRME
// ============================================

// Documenti già firmati dallo studente
app.get('/api/documents/my-signed', requireStudent, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const userId = req.user.userId;
    
    const { rows } = await pool.query(`
      SELECT ds.document_id, d.title, ds.consent_given, ds.signed_at
      FROM document_signatures ds
      JOIN documents d ON d.id = ds.document_id
      WHERE ds.user_id = $1
      ORDER BY ds.signed_at DESC
    `, [userId]);
    
    res.json(rows);
  } catch (error) {
    console.error('Error fetching signed documents:', error);
    res.status(500).json({ error: 'Errore nel caricamento documenti firmati' });
  }
});

// PDF documento firmato per lo studente
app.get('/api/documents/:id/my-pdf', requireStudent, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const userId = req.user.userId;
    const documentId = req.params.id;
    
    const { rows } = await pool.query(`
      SELECT d.title, d.content, ds.consent_given, ds.signature_image, ds.signed_at, ds.signer_name, ds.signer_surname, ds.ip_address
      FROM document_signatures ds
      JOIN documents d ON d.id = ds.document_id
      WHERE ds.document_id = $1 AND ds.user_id = $2
    `, [documentId, userId]);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Firma non trovata' });
    }
    
    const data = rows[0];
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="liberatoria_${data.signer_surname || 'firmata'}.pdf"`);
    doc.pipe(res);
    
    // Header
    doc.fillColor('#166534').fontSize(20).text('Master Carbon Farming', { align: 'center' });
    doc.fillColor('#666').fontSize(10).text('Università degli Studi della Tuscia', { align: 'center' });
    doc.moveDown(2);
    
    // Titolo documento
    doc.fillColor('#000').fontSize(16).text(data.title, { align: 'center' });
    doc.moveDown();
    
    // Contenuto (rimuovi HTML tags)
    const plainContent = data.content
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    doc.fontSize(11).fillColor('#333').text(plainContent, { align: 'justify', lineGap: 4 });
    doc.moveDown(2);
    
    // Linea separatrice
    doc.strokeColor('#ccc').lineWidth(1).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown();
    
    // Dichiarazione
    doc.fillColor('#166534').fontSize(14).text('DICHIARAZIONE', { align: 'center' });
    doc.moveDown();
    
    // Nome e cognome
    doc.fillColor('#000').fontSize(11);
    doc.text(`Nome: ${data.signer_name || 'N/D'}`, 50);
    doc.text(`Cognome: ${data.signer_surname || 'N/D'}`, 300, doc.y - 14);
    doc.moveDown();
    
    // Scelta consenso
    const consensoText = data.consent_given 
      ? '✓ PRESTO IL CONSENSO - Autorizzo l\'utilizzo di immagini e video'
      : '✗ NEGO IL CONSENSO - Non desidero essere ripreso/a';
    doc.fillColor(data.consent_given ? '#166534' : '#dc2626').fontSize(12).text(consensoText);
    doc.moveDown(2);
    
    // Firma
    doc.fillColor('#000').fontSize(11).text('Firma:');
    if (data.signature_image && data.signature_image.startsWith('data:image')) {
      try {
        const base64Data = data.signature_image.split(',')[1];
        const imgBuffer = Buffer.from(base64Data, 'base64');
        doc.image(imgBuffer, { width: 200, height: 80 });
      } catch (e) {
        doc.text('[Firma non disponibile]');
      }
    }
    doc.moveDown(2);
    
    // Footer con metadati
    doc.fontSize(9).fillColor('#666');
    doc.text(`Data firma: ${new Date(data.signed_at).toLocaleString('it-IT')}`, 50);
    doc.text(`IP: ${data.ip_address || 'N/D'}`);
    doc.moveDown();
    doc.text('Documento generato automaticamente dalla piattaforma Master Carbon Farming', { align: 'center' });
    
    doc.end();
  } catch (error) {
    console.error('Error generating PDF:', error);
    res.status(500).json({ error: 'Errore nella generazione del PDF' });
  }
});

// Dettaglio firma studente per un documento
app.get('/api/documents/:id/my-signature', requireStudent, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const userId = req.user.userId;
    const documentId = req.params.id;
    
    const { rows } = await pool.query(`
      SELECT d.title, d.content, ds.consent_given, ds.signature_image, ds.signature_method, ds.signed_at, ds.signer_name, ds.signer_surname
      FROM document_signatures ds
      JOIN documents d ON d.id = ds.document_id
      WHERE ds.document_id = $1 AND ds.user_id = $2
    `, [documentId, userId]);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Firma non trovata' });
    }
    
    res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching signature:', error);
    res.status(500).json({ error: 'Errore nel caricamento firma' });
  }
});

// Documenti da firmare per lo studente (pending)
app.get('/api/documents/pending', requireStudent, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const userId = req.user.userId;
    
    // Trova documenti attivi per il corso dello studente, non ancora firmati
    const { rows } = await pool.query(`
      SELECT d.id, d.title, d.content, d.document_type
      FROM documents d
      JOIN enrollments e ON e.course_edition_id = d.course_edition_id
      WHERE e.user_id = $1 
        AND e.status = 'active'
        AND d.is_active = true
        AND NOT EXISTS (
          SELECT 1 FROM document_signatures ds 
          WHERE ds.document_id = d.id AND ds.user_id = $1
        )
      ORDER BY d.created_at
    `, [userId]);
    
    res.json(rows);
  } catch (error) {
    console.error('Error fetching pending documents:', error);
    res.status(500).json({ error: 'Errore nel caricamento documenti' });
  }
});

// Firma un documento
app.post('/api/documents/:id/sign', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const userId = req.user.userId;
    const documentId = req.params.id;
    const { consentGiven, signatureImage, signatureMethod, signerName, signerSurname } = req.body;
    
    if (consentGiven === undefined || !signatureImage || !signerName || !signerSurname) {
      return res.status(400).json({ error: 'Nome, cognome, consenso e firma sono obbligatori' });
    }
    
    // Verifica che il documento esista e sia per questo studente
    const { rows: docs } = await pool.query(`
      SELECT d.id FROM documents d
      JOIN enrollments e ON e.course_edition_id = d.course_edition_id
      WHERE d.id = $1 AND e.user_id = $2 AND e.status = 'active' AND d.is_active = true
    `, [documentId, userId]);
    
    if (docs.length === 0) {
      return res.status(404).json({ error: 'Documento non trovato' });
    }
    
    // Salva la firma
    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];
    
    await pool.query(`
      INSERT INTO document_signatures (document_id, user_id, consent_given, signature_image, signature_method, ip_address, user_agent, signer_name, signer_surname)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (document_id, user_id) DO UPDATE SET
        consent_given = $3, signer_name = $8, signer_surname = $9,
        signature_image = $4,
        signature_method = $5,
        ip_address = $6,
        user_agent = $7,
        signed_at = NOW()
    `, [documentId, userId, consentGiven, signatureImage, signatureMethod || 'draw', ipAddress, userAgent, signerName, signerSurname]);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error signing document:', error);
    res.status(500).json({ error: 'Errore nella firma del documento' });
  }
});

// Admin: PDF singola firma
app.get('/api/signatures/:id/pdf', (req, res, next) => {
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = 'Bearer ' + req.query.token;
  }
  requireAdmin(req, res, next);
}, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT ds.*, u.email, u.first_name, u.last_name, d.title, d.content
      FROM document_signatures ds
      JOIN users u ON u.id = ds.user_id
      JOIN documents d ON d.id = ds.document_id
      WHERE ds.id = $1
    `, [req.params.id]);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Firma non trovata' });
    }
    
    const data = rows[0];
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    
    const surname = data.signer_surname || data.last_name || 'studente';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="liberatoria_${surname}.pdf"`);
    doc.pipe(res);
    
    // Header
    doc.fillColor('#166534').fontSize(20).text('Master Carbon Farming', { align: 'center' });
    doc.fillColor('#666').fontSize(10).text('Università degli Studi della Tuscia', { align: 'center' });
    doc.moveDown(2);
    
    // Titolo documento
    doc.fillColor('#000').fontSize(16).text(data.title, { align: 'center' });
    doc.moveDown();
    
    // Contenuto
    const plainContent = (data.content || '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    doc.fontSize(11).fillColor('#333').text(plainContent, { align: 'justify', lineGap: 4 });
    doc.moveDown(2);
    
    // Linea separatrice
    doc.strokeColor('#ccc').lineWidth(1).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown();
    
    // Dichiarazione
    doc.fillColor('#166534').fontSize(14).text('DICHIARAZIONE', { align: 'center' });
    doc.moveDown();
    
    // Nome e cognome
    doc.fillColor('#000').fontSize(11);
    doc.text(`Nome: ${data.signer_name || data.first_name || 'N/D'}`, 50);
    doc.text(`Cognome: ${data.signer_surname || data.last_name || 'N/D'}`, 300, doc.y - 14);
    doc.text(`Email: ${data.email}`, 50);
    doc.moveDown();
    
    // Scelta consenso
    const consensoText = data.consent_given 
      ? '✓ PRESTO IL CONSENSO - Autorizzo l\'utilizzo di immagini e video'
      : '✗ NEGO IL CONSENSO - Non desidero essere ripreso/a';
    doc.fillColor(data.consent_given ? '#166534' : '#dc2626').fontSize(12).text(consensoText);
    doc.moveDown(2);
    
    // Firma
    doc.fillColor('#000').fontSize(11).text('Firma:');
    if (data.signature_image && data.signature_image.startsWith('data:image')) {
      try {
        const base64Data = data.signature_image.split(',')[1];
        const imgBuffer = Buffer.from(base64Data, 'base64');
        doc.image(imgBuffer, { width: 200, height: 80 });
      } catch (e) {
        doc.text('[Firma non disponibile]');
      }
    }
    doc.moveDown(2);
    
    // Footer
    doc.fontSize(9).fillColor('#666');
    doc.text(`Data firma: ${new Date(data.signed_at).toLocaleString('it-IT')}`, 50);
    doc.text(`IP: ${data.ip_address || 'N/D'}`);
    doc.moveDown();
    doc.text('Documento generato automaticamente dalla piattaforma Master Carbon Farming', { align: 'center' });
    
    doc.end();
  } catch (error) {
    console.error('Error generating PDF:', error);
    res.status(500).json({ error: 'Errore nella generazione del PDF' });
  }
});

// Admin: dettaglio singola firma
app.get('/api/signatures/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT ds.*, u.email, u.first_name, u.last_name, d.title, d.content
      FROM document_signatures ds
      JOIN users u ON u.id = ds.user_id
      JOIN documents d ON d.id = ds.document_id
      WHERE ds.id = $1
    `, [req.params.id]);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Firma non trovata' });
    }
    
    res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching signature:', error);
    res.status(500).json({ error: 'Errore nel caricamento firma' });
  }
});

// Admin: lista firme per un documento
app.get('/api/documents/:id/signatures', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT ds.*, u.email, u.first_name, u.last_name
      FROM document_signatures ds
      JOIN users u ON u.id = ds.user_id
      WHERE ds.document_id = $1
      ORDER BY ds.signed_at DESC
    `, [req.params.id]);
    
    res.json(rows);
  } catch (error) {
    console.error('Error fetching signatures:', error);
    res.status(500).json({ error: 'Errore nel caricamento firme' });
  }
});

// Admin: crea documento
app.post('/api/documents', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { title, content, courseEditionId } = req.body;
    
    if (!title || !content) {
      return res.status(400).json({ error: 'Titolo e contenuto sono obbligatori' });
    }
    
    const { rows } = await pool.query(`
      INSERT INTO documents (title, content, course_edition_id)
      VALUES ($1, $2, $3)
      RETURNING id, title
    `, [title, content, courseEditionId || '563e9876-8a08-4ee7-954a-79a16c39ab53']);
    
    res.json(rows[0]);
  } catch (error) {
    console.error('Error creating document:', error);
    res.status(500).json({ error: 'Errore nella creazione del documento' });
  }
});

// Admin: lista documenti
app.get('/api/documents', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT d.*, 
        (SELECT COUNT(*) FROM document_signatures ds WHERE ds.document_id = d.id) as signature_count,
        (SELECT COUNT(*) FROM document_signatures ds WHERE ds.document_id = d.id AND ds.consent_given = true) as consent_count
      FROM documents d
      ORDER BY d.created_at DESC
    `);
    
    res.json(rows);
  } catch (error) {
    console.error('Error fetching documents:', error);
    res.status(500).json({ error: 'Errore nel caricamento documenti' });
  }
});

// Admin: export firme CSV
app.get('/api/documents/:id/export', (req, res, next) => {
  // Permetti token anche come query param per download diretto
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = 'Bearer ' + req.query.token;
  }
  requireAdmin(req, res, next);
}, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT u.email, u.first_name, u.last_name, 
             ds.consent_given, ds.signature_method, ds.signed_at, ds.ip_address
      FROM document_signatures ds
      JOIN users u ON u.id = ds.user_id
      WHERE ds.document_id = $1
      ORDER BY u.last_name, u.first_name
    `, [req.params.id]);
    
    let csv = 'Email,Nome,Cognome,Consenso,Metodo Firma,Data Firma,IP\n';
    rows.forEach(r => {
      csv += `"${r.email}","${r.first_name || ''}","${r.last_name || ''}","${r.consent_given ? 'SI' : 'NO'}","${r.signature_method}","${r.signed_at}","${r.ip_address}"\n`;
    });
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="firme_${req.params.id}.csv"`);
    res.send(csv);
  } catch (error) {
    console.error('Error exporting signatures:', error);
    res.status(500).json({ error: 'Errore nell\'export' });
  }
});

// Catch-all per file statici (DEVE essere DOPO tutte le API routes!)
app.get('*', (req, res) => {
  const filePath = path.join(staticRoot, req.path);
  res.sendFile(filePath, (err) => {
    if (err) {
      res.status(404).send('Not found');
    }
  });
});

// Handler per Vercel serverless
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


app.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File troppo grande.' });
    return res.status(400).json({ error: 'Errore upload: ' + err.message });
  }
  if (err) return res.status(500).json({ error: err.message || 'Errore interno' });
  next();
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
module.exports.__setPool = (nextPool) => {
  pool = nextPool;
};
module.exports.__getPool = () => pool;
module.exports.__generateToken = generateToken;
module.exports.__importBlogPostsFromDocxBufferIntoDatabase = importBlogPostsFromDocxBufferIntoDatabase;
module.exports.__generateCoverForBlogPost = generateCoverForBlogPost;
