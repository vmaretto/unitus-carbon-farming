require('dotenv').config();
const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const { put, del } = require('@vercel/blob');
const { generateClientTokenFromReadWriteToken } = require('@vercel/blob/client');
const cheerio = require('cheerio');
const JSZip = require('jszip');
const { OpenAI } = require('openai');
const { PDFDocument, rgb, degrees, StandardFonts } = require('pdf-lib');
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
const ALLOWED_UPLOAD_EXTENSIONS = ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.txt', '.md', '.srt', '.vtt', '.mp3', '.mp4', '.m4a', '.jpg', '.jpeg', '.png', '.gif'];
const ALLOWED_UPLOAD_EXTENSIONS_LABEL = ALLOWED_UPLOAD_EXTENSIONS.join(', ');
const RESOURCE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
const MATERIALS_UPLOAD_FINAL_MAX_BYTES = 20 * 1024 * 1024;
const MATERIALS_UPLOAD_INGEST_MAX_BYTES = 50 * 1024 * 1024;
const BLOB_CLIENT_TOKEN_MAX_BYTES = 250 * 1024 * 1024;
const PDF_COMPRESSION_THRESHOLD_BYTES = RESOURCE_UPLOAD_MAX_BYTES;
async function createBlobClientToken({ pathname, maximumSizeInBytes, contentType }) {
  const clientToken = await generateClientTokenFromReadWriteToken({
    token: process.env.BLOB_READ_WRITE_TOKEN,
    access: 'public',
    pathname,
    maximumSizeInBytes,
    allowedContentTypes: contentType ? [contentType] : undefined,
    validUntil: Date.now() + 30 * 60 * 1000,
    addRandomSuffix: false,
    allowOverwrite: false
  });

  return {
    clientToken,
    uploadUrl: 'https://blob.vercel-storage.com',
    pathname,
    maximumSizeInBytes
  };
}

async function compressPdfWithPdfLib(buffer) {
  const sourceDoc = await PDFDocument.load(buffer, {
    updateMetadata: false,
    ignoreEncryption: false
  });

  const compressedDoc = await PDFDocument.create();
  const pageIndices = sourceDoc.getPageIndices();
  const copiedPages = await compressedDoc.copyPages(sourceDoc, pageIndices);
  copiedPages.forEach((page) => compressedDoc.addPage(page));

  const outputBuffer = await compressedDoc.save({
    useObjectStreams: true,
    addDefaultPage: false,
    updateFieldAppearances: false
  });

  return {
    buffer: Buffer.from(outputBuffer),
    compressed: outputBuffer.length < buffer.length,
    preset: 'pdf-lib'
  };
}

// Clausola legale stampata su ogni download (anche dentro il PDF).
const DOWNLOAD_LICENSE_CLAUSE =
  'Documento riservato del Master in Carbon Farming (UNITUS). Ogni riproduzione, ' +
  'diffusione o condivisione, totale o parziale, è vietata.';

// Stampa una filigrana diagonale ripetuta (identità utente) su ogni pagina del PDF
// + una riga di clausola legale a piè pagina. Restituisce un Buffer del nuovo PDF.
function toWinAnsi(value) {
  return String(value || '')
    .replace(/[‐-―]/g, '-')   // trattini tipografici
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/…/g, '...')           // ellissi
    .replace(/ /g, ' ')             // no-break space
    .replace(/[^\x00-\xFF]/g, '?');      // qualsiasi residuo fuori Latin-1 (WinAnsi)
}

async function stampPdfWatermark(inputBuffer, { name, email, dateStr }) {
  const pdfDoc = await PDFDocument.load(inputBuffer, { ignoreEncryption: true });
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const tag = toWinAnsi([name, email, dateStr].filter(Boolean).join('  -  '));
  const footer = toWinAnsi(`${DOWNLOAD_LICENSE_CLAUSE}  -  Scaricato da ${tag}`);

  for (const page of pdfDoc.getPages()) {
    const { width, height } = page.getSize();

    // Filigrana diagonale ripetuta, molto tenue
    const wmSize = Math.max(12, Math.min(20, Math.round(width / 38)));
    const step = 230;
    for (let y = 40; y < height + step; y += step) {
      for (let x = -40; x < width + step; x += step * 1.3) {
        page.drawText(tag || 'Master Carbon Farming', {
          x, y, size: wmSize, font,
          color: rgb(0.6, 0.6, 0.6), opacity: 0.12,
          rotate: degrees(35)
        });
      }
    }

    // Banda chiara + clausola a piè pagina
    page.drawRectangle({ x: 0, y: 0, width, height: 24, color: rgb(0.96, 0.97, 0.96), opacity: 0.9 });
    let line = footer;
    const fSize = 7;
    const maxW = width - 24;
    while (font.widthOfTextAtSize(line, fSize) > maxW && line.length > 4) {
      line = line.slice(0, -2);
    }
    if (line !== footer) line = line.replace(/\s+\S*$/, '') + '...';
    page.drawText(line, { x: 12, y: 9, size: fSize, font, color: rgb(0.2, 0.3, 0.2), opacity: 0.95 });
  }

  const out = await pdfDoc.save({ useObjectStreams: true });
  return Buffer.from(out);
}

async function prepareCompressibleMaterialUpload(file, finalLimitBytes, uploadLabel) {
  let fileBuffer = file.buffer;
  let compressed = false;

  if (file.mimetype === 'application/pdf' && file.size > finalLimitBytes) {
    console.log(`📦 Comprimendo PDF ${uploadLabel} con pdf-lib...`);
    try {
      const result = await compressPdfWithPdfLib(file.buffer);
      if (result.buffer.length <= finalLimitBytes) {
        fileBuffer = result.buffer;
        compressed = result.buffer.length < file.buffer.length;
        console.log(`✅ PDF compresso per ${uploadLabel}: ${file.size} -> ${fileBuffer.length} bytes`);
      } else {
        return {
          tooLarge: true,
          error: `Il PDF supera ancora i ${Math.round(finalLimitBytes / (1024 * 1024))}MB anche dopo la compressione automatica. Formati ammessi: ${ALLOWED_UPLOAD_EXTENSIONS_LABEL}.`
        };
      }
    } catch (compressionError) {
      console.error(`Compressione PDF fallita per ${uploadLabel}:`, compressionError);
      return {
        tooLarge: true,
        error: `Impossibile comprimere automaticamente il PDF. Formati ammessi: ${ALLOWED_UPLOAD_EXTENSIONS_LABEL}.`
      };
    }
  } else if (file.size > finalLimitBytes) {
    return {
      tooLarge: true,
      error: `File troppo grande (max ${Math.round(finalLimitBytes / (1024 * 1024))}MB). Formati ammessi: ${ALLOWED_UPLOAD_EXTENSIONS_LABEL}.`
    };
  }

  return { buffer: fileBuffer, compressed };
}

app.post('/api/blob/client-token', requireAdminOrTeacher, async (req, res) => {
  try {
    const pathname = String(req.body?.pathname || '').trim().replace(/^\/+/, '');
    if (!pathname) {
      return res.status(400).json({ error: 'pathname mancante' });
    }

    const requestedMaxSize = Number(req.body?.maximumSizeInBytes || 0);
    const maximumSizeInBytes = Number.isFinite(requestedMaxSize) && requestedMaxSize > 0
      ? Math.min(requestedMaxSize, BLOB_CLIENT_TOKEN_MAX_BYTES)
      : MATERIALS_UPLOAD_FINAL_MAX_BYTES;

    const contentType = String(req.body?.contentType || '').trim() || null;
    res.json(await createBlobClientToken({ pathname, maximumSizeInBytes, contentType }));
  } catch (error) {
    console.error('Error generating blob client token:', error);
    res.status(500).json({ error: error.message || 'Impossibile generare il token upload' });
  }
});

// Configurazione multer per upload in memoria (per Vercel Blob)
// Upload per risorse generali (limite 4MB)
const uploadSmall = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: RESOURCE_UPLOAD_MAX_BYTES }, // 4MB max per Vercel Functions
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_UPLOAD_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Tipo file non supportato. Formati ammessi: ${ALLOWED_UPLOAD_EXTENSIONS_LABEL}`));
    }
  }
});

// Upload per materiali lezioni e docenti: accetta file più grandi per permettere la compressione PDF
const uploadMaterials = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: MATERIALS_UPLOAD_INGEST_MAX_BYTES }, // ingest fino a 50MB per consentire la compressione PDF
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_UPLOAD_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Tipo file non supportato. Formati ammessi: ${ALLOWED_UPLOAD_EXTENSIONS_LABEL}`));
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

const uploadConferenceExcel = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ext === '.xlsx') {
      cb(null, true);
      return;
    }
    cb(new Error('Carica un file .xlsx valido'));
  }
});

const uploadAttendanceFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ext === '.csv' || ext === '.xlsx') {
      cb(null, true);
      return;
    }
    cb(new Error('Carica un file .csv o .xlsx valido'));
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
async function sendEmail({ to, subject, html, cc, bcc, from }) {
  const fromEmail = from || process.env.RESEND_FROM || 'Master Carbon Farming <noreply@carbonfarmingmaster.it>';
  
  // Prova prima con Resend
  if (RESEND_API_KEY) {
    try {
      const { Resend } = require('resend');
      const resend = new Resend(RESEND_API_KEY);
      const emailData = { from: fromEmail, to, subject, html };
      if (cc) emailData.cc = cc;
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
          cc: cc ? [{ email: cc }] : undefined,
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

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"]/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;'
  }[ch]));
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Formatta una data evento in italiano (es. "venerdì 17 luglio 2026 alle 08:00")
function formatEventDateIt(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString('it-IT', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome'
    });
  } catch (e) {
    return '';
  }
}

// HTML dell'email di conferma iscrizione a un evento
function buildEventRegistrationEmail({ student, event }) {
  const name = escapeHtml(student.firstName || 'Studente');
  const dateStr = formatEventDateIt(event.startsAt);
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #166534 0%, #22c55e 100%); padding: 20px; border-radius: 12px 12px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 1.5rem;">🌱 Master Carbon Farming</h1>
        <p style="color: rgba(255,255,255,0.9); margin: 8px 0 0; font-size: 14px;">Università della Tuscia</p>
      </div>
      <div style="background: #f9fafb; padding: 24px; border-radius: 0 0 12px 12px;">
        <h2 style="color: #166534; margin: 0 0 16px;">Iscrizione confermata ✅</h2>
        <p style="margin: 16px 0; line-height: 1.6;">
          Ciao <strong>${name}</strong>,<br><br>
          la tua iscrizione al seguente evento è stata registrata con successo:
        </p>
        <div style="background: white; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; margin: 16px 0;">
          <div style="font-size: 1.05rem; font-weight: 700; color: #14532d;">${escapeHtml(event.title)}</div>
          ${dateStr ? `<div style="color:#374151; margin-top:8px;">📅 ${escapeHtml(dateStr)}</div>` : ''}
          ${event.location ? `<div style="color:#374151; margin-top:4px;">📍 ${escapeHtml(event.location)}</div>` : ''}
        </div>
        <p style="margin: 16px 0; line-height: 1.6; color: #b45309; background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:12px;">
          ⚠️ <strong>L'iscrizione è definitiva</strong> e non può essere annullata dall'area studente.
          Per eventuali necessità contatta la segreteria del Master.
        </p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
        <p style="font-size: 13px; color: #6b7280; margin: 0;">
          Questa è una conferma automatica. A presto!<br>Master in Carbon Farming — UNITUS Academy
        </p>
      </div>
    </div>
  `;
}

function resolveAbsoluteUrl(value, baseUrl) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw, baseUrl).toString();
  } catch (_error) {
    return '';
  }
}

function truncateText(value, limit = 220) {
  const text = stripHtml(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

// Resolve the canonical public base URL for the current request.
// Priority: explicit env > x-forwarded-proto from the edge proxy > req.protocol.
// Behind Vercel/Cloudflare the inner Express sees req.protocol === 'http' because
// TLS is terminated at the edge; relying on the x-forwarded-proto header restores
// the correct scheme so absolute URLs in sitemap, canonical and og:url are https.
function getPublicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  }
  const forwardedProto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim();
  const proto = forwardedProto || req.protocol || 'https';
  const host = req.get('host');
  return `${proto}://${host}`;
}

function normalizeConferenceRegistrationError(error) {
  const message = String(error?.message || 'Errore sconosciuto').trim();
  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}

function normalizeConferenceExcelHeader(text = '') {
  return normalizeExtractedText(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function excelColumnIndexFromRef(cellRef = '') {
  const match = String(cellRef).match(/^[A-Z]+/i);
  if (!match) return -1;
  let index = 0;
  for (const char of match[0].toUpperCase()) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

function normalizeAttendanceImportHeader(text = '') {
  return normalizeExtractedText(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parseDelimitedLine(line, separator = ',') {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === separator && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function parseAttendanceDurationMinutes(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  const timeMatch = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (timeMatch) {
    const hours = Number(timeMatch[1] || 0);
    const minutes = Number(timeMatch[2] || 0);
    const seconds = Number(timeMatch[3] || 0);
    return Math.round(hours * 60 + minutes + seconds / 60);
  }
  const numberMatch = text.replace(',', '.').match(/(\d+(?:\.\d+)?)/);
  return numberMatch ? Math.round(Number(numberMatch[1])) : 0;
}

function excelSerialDateToIso(value) {
  const serial = Number(value);
  if (!Number.isFinite(serial) || serial < 20000 || serial > 80000) return null;
  const epoch = Date.UTC(1899, 11, 30);
  return new Date(epoch + serial * 86400000).toISOString();
}

function getTimeZoneOffsetMs(date, timeZone = 'Europe/Rome') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = Number(part.value);
    return acc;
  }, {});
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

function europeRomeDateTimeToIso(year, month, day, hour, minute, second = 0) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstOffset = getTimeZoneOffsetMs(new Date(utcGuess), 'Europe/Rome');
  const firstUtc = utcGuess - firstOffset;
  const secondOffset = getTimeZoneOffsetMs(new Date(firstUtc), 'Europe/Rome');
  return new Date(utcGuess - secondOffset).toISOString();
}

function parseAttendanceDate(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const serialIso = excelSerialDateToIso(text);
  if (serialIso) return serialIso;

  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(text)) {
    const parsedWithZone = new Date(text);
    if (!Number.isNaN(parsedWithZone.getTime())) return parsedWithZone.toISOString();
  }

  const dmy = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (dmy) {
    let [, day, month, year, hours, mins, secsRaw, ampm] = dmy;
    let yearNum = Number(year);
    if (yearNum < 100) yearNum += 2000;
    let hourNum = Number(hours);
    if (ampm && ampm.toUpperCase() === 'PM' && hourNum < 12) hourNum += 12;
    if (ampm && ampm.toUpperCase() === 'AM' && hourNum === 12) hourNum = 0;
    return europeRomeDateTimeToIso(yearNum, Number(month), Number(day), hourNum, Number(mins), Number(secsRaw || 0));
  }

  const ymd = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (ymd) {
    const [, year, month, day, hours, mins, secsRaw] = ymd;
    return europeRomeDateTimeToIso(Number(year), Number(month), Number(day), Number(hours), Number(mins), Number(secsRaw || 0));
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function getImportedAttendanceMinutes(attendance = {}) {
  const notesMatch = String(attendance.notes || '').match(/zoom_duration_minutes=(\d+)/);
  if (notesMatch) return Number(notesMatch[1]) || 0;
  if (attendance.check_in_at && attendance.check_out_at) {
    const start = new Date(attendance.check_in_at).getTime();
    const end = new Date(attendance.check_out_at).getTime();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      return Math.round((end - start) / 60000);
    }
  }
  return 0;
}

function getAttendanceCreditMinutes(attendance = {}) {
  const lessonMinutes = Number(attendance.duration_minutes || 0);
  if (attendance.attendance_type === 'remote_partial') {
    const importedMinutes = getImportedAttendanceMinutes(attendance);
    return importedMinutes > 0 && lessonMinutes > 0 ? Math.min(importedMinutes, lessonMinutes) : importedMinutes;
  }
  return lessonMinutes;
}

function calculateOverlapMinutes(startA, endA, startB, endB) {
  const start = Math.max(startA.getTime(), startB.getTime());
  const end = Math.min(endA.getTime(), endB.getTime());
  return end > start ? Math.round((end - start) / 60000) : 0;
}

function findAttendanceHeaderIndex(headers, predicates) {
  return headers.findIndex((header) => predicates.some((predicate) => predicate(header)));
}

function rowsToAttendanceParticipants(rawRows) {
  const headerRowIndex = rawRows.findIndex((row) => {
    const headers = row.map(normalizeAttendanceImportHeader);
    return headers.some((h) => h.includes('name') || h.includes('nome')) &&
      headers.some((h) => h.includes('duration') || h.includes('durata') || h.includes('minutes') || h.includes('minuti'));
  });
  if (headerRowIndex < 0) {
    throw new Error('Header non riconosciuto: servono almeno nome e durata/minuti.');
  }

  const headers = rawRows[headerRowIndex].map(normalizeAttendanceImportHeader);
  const colName = findAttendanceHeaderIndex(headers, [
    (h) => h === 'nome' || h === 'name' || h.includes('nome') || h.includes('participant name') || h.includes('original name') || h.includes('display name') || h.includes('nome visualizzato')
  ]);
  const colEmail = findAttendanceHeaderIndex(headers, [
    (h) => h.includes('email') || h.includes('e mail') || h.includes('mail')
  ]);
  const colJoin = findAttendanceHeaderIndex(headers, [
    (h) => h.includes('join time') || h.includes('joined') || h.includes('ingresso') || h.includes('entrata') || h.includes('ora di accesso')
  ]);
  const colLeave = findAttendanceHeaderIndex(headers, [
    (h) => h.includes('leave time') || h.includes('left') || h.includes('uscita') || h.includes('ora di uscita')
  ]);
  const colDuration = findAttendanceHeaderIndex(headers, [
    (h) => h.includes('duration') || h.includes('durata') || h.includes('minutes') || h.includes('minuti')
  ]);

  if (colName < 0 || colDuration < 0) {
    throw new Error('Colonne obbligatorie non trovate: nome e durata/minuti.');
  }

  const byKey = new Map();
  for (const row of rawRows.slice(headerRowIndex + 1)) {
    const rawName = String(row[colName] || '')
      .replace(/\s*[\|–—-]\s*[A-Z].*$/i, '')
      .trim();
    const email = colEmail >= 0 ? String(row[colEmail] || '').trim().toLowerCase() : '';
    if (!rawName && !email) continue;

    const durationMinutes = parseAttendanceDurationMinutes(row[colDuration]);
    if (!durationMinutes) continue;

    const joinTime = colJoin >= 0 ? parseAttendanceDate(row[colJoin]) : null;
    const leaveTime = colLeave >= 0 ? parseAttendanceDate(row[colLeave]) : null;
    const key = email || rawName.toLowerCase();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { name: rawName, email, joinTime, leaveTime, durationMinutes });
    } else {
      existing.durationMinutes += durationMinutes;
      if (email && !existing.email) existing.email = email;
      if (joinTime && (!existing.joinTime || joinTime < existing.joinTime)) existing.joinTime = joinTime;
      if (leaveTime && (!existing.leaveTime || leaveTime > existing.leaveTime)) existing.leaveTime = leaveTime;
    }
  }

  const participants = Array.from(byKey.values());
  if (!participants.length) {
    throw new Error('Nessun partecipante con durata valida trovato nel file.');
  }
  return participants;
}

function parseAttendanceCsvBuffer(buffer) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r\n|\n|\r/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('CSV vuoto o incompleto.');
  const sample = lines.slice(0, 10).join('\n');
  const separator = ((sample.match(/;/g) || []).length > (sample.match(/,/g) || []).length) ? ';' : ',';
  return rowsToAttendanceParticipants(lines.map((line) => parseDelimitedLine(line, separator)));
}

async function parseAttendanceXlsxBuffer(buffer) {
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

  const sheetName = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort()[0];
  if (!sheetName) throw new Error('Il file Excel non contiene fogli leggibili.');

  const xml = await zip.file(sheetName).async('string');
  const rawRows = [];
  const rowRegex = /<row\b[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(xml)) !== null) {
    const cells = [];
    const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowMatch[2])) !== null) {
      const attrs = cellMatch[1];
      const body = cellMatch[2];
      const ref = attrs.match(/r="([A-Z]+[0-9]+)"/i)?.[1];
      if (!ref) continue;
      const cellType = attrs.match(/t="([^"]+)"/i)?.[1] || '';
      let value = '';
      if (cellType === 'inlineStr') {
        const inlineTexts = [];
        const inlineRegex = /<t[^>]*>([\s\S]*?)<\/t>/g;
        let inlineMatch;
        while ((inlineMatch = inlineRegex.exec(body)) !== null) {
          inlineTexts.push(decodeXmlEntities(inlineMatch[1]));
        }
        value = inlineTexts.join('');
      } else {
        const vMatch = body.match(/<v>([\s\S]*?)<\/v>/);
        if (vMatch) {
          value = decodeXmlEntities(vMatch[1]);
          if (cellType === 's') {
            const idx = Number(value);
            value = Number.isInteger(idx) && sharedStrings[idx] ? sharedStrings[idx] : '';
          }
        }
      }
      const index = excelColumnIndexFromRef(ref);
      if (index >= 0) cells[index] = normalizeExtractedText(value || '');
    }
    if (cells.some((cell) => String(cell || '').trim())) rawRows.push(cells);
  }
  return rowsToAttendanceParticipants(rawRows);
}

async function parseAttendanceImportFile(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (ext === '.xlsx') return parseAttendanceXlsxBuffer(file.buffer);
  return parseAttendanceCsvBuffer(file.buffer);
}

function normalizeConferenceEmail(value = '') {
  return normalizeExtractedText(value).toLowerCase();
}

function getConferenceImportField(row, candidates) {
  for (const candidate of candidates) {
    const value = row[candidate];
    if (value && String(value).trim()) {
      return String(value).trim();
    }
  }
  return '';
}

function buildConferenceImportRow(row, rowNumber, sourceFileName) {
  const fullName = getConferenceImportField(row, [
    'nome completo',
    'full name',
    'nominativo',
    'nome e cognome',
    'participant name',
    'registrant name'
  ]);
  const firstName = getConferenceImportField(row, [
    'nome',
    'first name',
    'given name'
  ]);
  const lastName = getConferenceImportField(row, [
    'cognome',
    'last name',
    'surname'
  ]);
  const email = normalizeConferenceEmail(getConferenceImportField(row, [
    'email',
    'e mail',
    'e-mail',
    'mail'
  ]));
  const phone = getConferenceImportField(row, [
    'telefono',
    'cellulare',
    'mobile',
    'phone'
  ]);
  const organization = getConferenceImportField(row, [
    'ente',
    'organizzazione',
    'azienda',
    'company',
    'organization',
    'istituzione',
    'affiliation'
  ]);
  const role = getConferenceImportField(row, [
    'ruolo',
    'position',
    'job title',
    'incarico'
  ]);
  const note = getConferenceImportField(row, [
    'note',
    'messaggio',
    'commenti',
    'comments',
    'osservazioni'
  ]);

  const mergedName = fullName || [firstName, lastName].filter(Boolean).join(' ').trim() || firstName || lastName;
  if (!email || !mergedName) return null;

  return {
    fullName: mergedName,
    email,
    phone: phone || null,
    organization: organization || null,
    role: role || null,
    note: note || null,
    sourceFileName,
    sourceRowNumber: rowNumber
  };
}

async function parseConferenceRegistrationsFromXlsx(buffer, sourceFileName = 'import.xlsx') {
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
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => {
      const left = Number(a.match(/sheet(\d+)\.xml$/)?.[1] || 0);
      const right = Number(b.match(/sheet(\d+)\.xml$/)?.[1] || 0);
      return left - right;
    });

  if (!sheetFiles.length) {
    return { rows: [], warnings: ['Il file Excel non contiene fogli leggibili.'] };
  }

  const xml = await zip.file(sheetFiles[0]).async('string');
  const parsedRows = [];
  const rowRegex = /<row\b[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(xml)) !== null) {
    const rowNumber = Number(rowMatch[1]);
    const rowXml = rowMatch[2];
    const cells = [];
    const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let cellMatch;

    while ((cellMatch = cellRegex.exec(rowXml)) !== null) {
      const attrs = cellMatch[1];
      const body = cellMatch[2];
      const ref = attrs.match(/r="([A-Z]+[0-9]+)"/i)?.[1];
      if (!ref) continue;

      const cellType = attrs.match(/t="([^"]+)"/i)?.[1] || '';
      let value = '';

      if (cellType === 'inlineStr') {
        const inlineTexts = [];
        const inlineRegex = /<t[^>]*>([\s\S]*?)<\/t>/g;
        let inlineMatch;
        while ((inlineMatch = inlineRegex.exec(body)) !== null) {
          inlineTexts.push(decodeXmlEntities(inlineMatch[1]));
        }
        value = inlineTexts.join('');
      } else {
        const vMatch = body.match(/<v>([\s\S]*?)<\/v>/);
        if (vMatch) {
          value = decodeXmlEntities(vMatch[1]);
          if (cellType === 's') {
            const idx = Number(value);
            value = Number.isInteger(idx) && sharedStrings[idx] ? sharedStrings[idx] : '';
          } else if (cellType === 'b') {
            value = value === '1' ? 'TRUE' : 'FALSE';
          }
        }
      }

      const index = excelColumnIndexFromRef(ref);
      if (index >= 0) {
        cells[index] = normalizeExtractedText(value || '');
      }
    }

    if (cells.some((cell) => String(cell || '').trim())) {
      parsedRows.push({ rowNumber, cells });
    }
  }

  const headerRow = parsedRows[0];
  if (!headerRow) {
    return { rows: [], warnings: ['Il file Excel non contiene righe importabili.'] };
  }

  const headers = headerRow.cells.map((header, index) => normalizeConferenceExcelHeader(header || `col_${index + 1}`));
  const importRows = [];
  const warnings = [];

  parsedRows.slice(1).forEach((row) => {
    const rowValues = {};
    headers.forEach((header, index) => {
      if (!header) return;
      rowValues[header] = normalizeExtractedText(row.cells[index] || '');
    });
    const parsedRow = buildConferenceImportRow(rowValues, row.rowNumber, sourceFileName);
    if (parsedRow) {
      importRows.push(parsedRow);
    } else if (Object.values(rowValues).some((value) => String(value || '').trim())) {
      warnings.push(`Riga ${row.rowNumber} saltata: manca nome o email.`);
    }
  });

  return { rows: importRows, warnings };
}

async function createConferenceRegistrationTracking(data) {
  if (!pool) return null;

  const id = uuidv4();
  const now = new Date();
  const { rows } = await pool.query(
    `INSERT INTO conference_registrations (
       id, full_name, email, phone, organization, role, note,
       organizer_email_status, confirmation_email_status, overall_status,
       created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 'pending', 'pending', $8, $9)
     RETURNING *`,
    [
      id,
      `${data.nome} ${data.cognome}`.trim(),
      data.email,
      data.telefono || null,
      data.ente || null,
      data.ruolo || null,
      data.note || null,
      now,
      now
    ]
  );
  return rows[0] || null;
}

async function updateConferenceRegistrationTracking(id, updates = {}) {
  if (!pool || !id) return null;
  const entries = Object.entries(updates).filter(([, value]) => value !== undefined);
  if (!entries.length) return null;

  const values = [];
  const assignments = entries.map(([column, value], index) => {
    values.push(value);
    return `${column} = $${index + 1}`;
  });
  values.push(id);

  const { rows } = await pool.query(
    `UPDATE conference_registrations
     SET ${assignments.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING *`,
    values
  );
  return rows[0] || null;
}

let conferenceRegistrationEmailSender = sendEmail;
let questionAssignmentEmailSender = sendEmail;

function isConferenceRegistrationOpen() {
  return String(process.env.CONFERENCE_REGISTRATION_OPEN || '').toLowerCase() === 'true';
}

function validateConferenceRegistrationAntiSpam(body = {}) {
  const honeypot = String(body.website || body.companyWebsite || '').trim();
  if (honeypot) {
    return { ok: false, status: 400, message: 'Richiesta non valida.' };
  }

  const startedAt = Number(body.formStartedAt || body._formStartedAt || 0);
  if (!startedAt || !Number.isFinite(startedAt)) {
    return { ok: false, status: 400, message: 'Sessione form non valida. Ricarica la pagina e riprova.' };
  }

  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs < 3000) {
    return { ok: false, status: 429, message: 'Invio troppo rapido. Ricarica la pagina e riprova.' };
  }

  if (elapsedMs > 1000 * 60 * 60 * 6) {
    return { ok: false, status: 400, message: 'Sessione form scaduta. Ricarica la pagina e riprova.' };
  }

  return { ok: true };
}

function buildConferenceRegistrationHtml(data, { isConfirmation = false } = {}) {
  const title = isConfirmation
    ? 'Conferma registrazione conferenza 26 maggio 2026'
    : 'Nuova registrazione conferenza 26 maggio 2026';
  const intro = isConfirmation
    ? 'Abbiamo ricevuto la tua registrazione per la conferenza Carbon Farming e Soft Power del Food.'
    : 'Hai ricevuto una nuova registrazione per la conferenza Carbon Farming e Soft Power del Food.';

  const fields = [
    ['Nome', data.nome],
    ['Cognome', data.cognome],
    ['Email', data.email],
    ['Telefono', data.telefono],
    ['Ente / Azienda / Universita', data.ente],
    ['Ruolo', data.ruolo],
    ['Note', data.note]
  ].filter(([, value]) => Boolean(String(value || '').trim()));

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px; color: #1f2937;">
      <div style="background: linear-gradient(135deg, #2f6b3f 0%, #6a9f4f 100%); color: white; padding: 20px 24px; border-radius: 16px 16px 0 0;">
        <h1 style="margin: 0; font-size: 24px;">${escapeHtml(title)}</h1>
      </div>
      <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-top: 0; border-radius: 0 0 16px 16px; padding: 24px;">
        <p style="margin: 0 0 20px; font-size: 16px; line-height: 1.6;">${escapeHtml(intro)}</p>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <tbody>
            ${fields.map(([label, value]) => `
              <tr>
                <th style="text-align: left; vertical-align: top; padding: 10px 12px 10px 0; width: 220px; color: #374151;">${escapeHtml(label)}</th>
                <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb;">${escapeHtml(value)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function buildQuestionAssignmentEmailHtml(question, teacher, teacherUrl) {
  const teacherName = teacher.displayName || teacher.email || 'Docente';
  const contextRows = [
    ['Studente', question.studentName || question.studentEmail || 'Studente'],
    ['Modulo', question.moduleTitle],
    ['Lezione', question.lessonTitle],
    ['Data domanda', question.createdAt ? new Date(question.createdAt).toLocaleString('it-IT') : null]
  ].filter(([, value]) => Boolean(String(value || '').trim()));

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 680px; margin: 0 auto; padding: 24px; color: #1f2937;">
      <div style="background: #245a3d; color: white; padding: 20px 24px; border-radius: 16px 16px 0 0;">
        <h1 style="margin: 0; font-size: 22px;">Nuova domanda assegnata</h1>
      </div>
      <div style="background: #f9fafb; border: 1px solid #e5e7eb; border-top: 0; border-radius: 0 0 16px 16px; padding: 24px;">
        <p style="margin: 0 0 18px; font-size: 16px; line-height: 1.6;">Gentile ${escapeHtml(teacherName)}, ti e stata assegnata una domanda nel pannello docenti del Master in Carbon Farming.</p>
        <div style="background: white; border: 1px solid #d1d5db; border-radius: 12px; padding: 18px; margin-bottom: 18px;">
          <div style="font-weight: 700; margin-bottom: 8px; color: #245a3d;">Domanda</div>
          <div style="font-size: 16px; line-height: 1.6;">${escapeHtml(question.questionText)}</div>
        </div>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 20px;">
          <tbody>
            ${contextRows.map(([label, value]) => `
              <tr>
                <th style="text-align: left; vertical-align: top; padding: 9px 12px 9px 0; width: 140px; color: #374151;">${escapeHtml(label)}</th>
                <td style="padding: 9px 0; border-bottom: 1px solid #e5e7eb;">${escapeHtml(value)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        <a href="${escapeHtml(teacherUrl)}" style="display: inline-block; background: #245a3d; color: white; text-decoration: none; font-weight: 700; padding: 12px 18px; border-radius: 999px;">Apri pannello docenti</a>
      </div>
    </div>
  `;
}

app.post('/api/conference-registration', async (req, res) => {
  if (!isConferenceRegistrationOpen()) {
    return res.status(410).send('Registrazioni chiuse.');
  }

  const antiSpam = validateConferenceRegistrationAntiSpam(req.body || {});
  if (!antiSpam.ok) {
    return res.status(antiSpam.status).send(antiSpam.message);
  }

  const data = {
    nome: String(req.body.nome || '').trim(),
    cognome: String(req.body.cognome || '').trim(),
    email: String(req.body.email || '').trim(),
    telefono: String(req.body.telefono || '').trim(),
    ente: String(req.body.ente || '').trim(),
    ruolo: String(req.body.ruolo || '').trim(),
    note: String(req.body.note || '').trim()
  };

  if (!data.nome || !data.cognome || !data.email) {
    return res.status(400).send('Campi obbligatori mancanti.');
  }

  const organizerEmail = process.env.CONFERENCE_REGISTRATION_EMAIL || 'maretto@carbonfarmingmaster.it';
  const organizerSubject = 'Registrazione conferenza 26 maggio 2026 - Carbon Farming e Soft Power del Food';
  const confirmationSubject = 'Conferma registrazione conferenza 26 maggio 2026';
  let tracking = null;

  try {
    tracking = await createConferenceRegistrationTracking(data);
  } catch (trackingError) {
    console.error('Conference registration tracking insert failed:', trackingError);
  }

  try {
    const organizerResult = await conferenceRegistrationEmailSender({
      to: organizerEmail,
      subject: organizerSubject,
      html: buildConferenceRegistrationHtml(data)
    });
    if (tracking?.id) {
      await updateConferenceRegistrationTracking(tracking.id, {
        organizer_email_status: 'sent',
        organizer_email_provider: organizerResult?.provider || null,
        organizer_email_sent_at: new Date()
      });
    }

    const confirmationResult = await conferenceRegistrationEmailSender({
      to: data.email,
      subject: confirmationSubject,
      html: buildConferenceRegistrationHtml(data, { isConfirmation: true })
    });
    if (tracking?.id) {
      await updateConferenceRegistrationTracking(tracking.id, {
        confirmation_email_status: 'sent',
        confirmation_email_provider: confirmationResult?.provider || null,
        confirmation_email_sent_at: new Date(),
        overall_status: 'sent'
      });
    }

    return res.redirect(303, '/conferenza-26-maggio-2026.html?sent=1#grazie');
  } catch (error) {
    if (tracking?.id) {
      const failureUpdates = {
        overall_status: 'failed',
        final_error: normalizeConferenceRegistrationError(error)
      };
      if (!tracking.organizer_email_sent_at) {
        failureUpdates.organizer_email_status = 'failed';
        failureUpdates.organizer_email_error = normalizeConferenceRegistrationError(error);
      } else if (!tracking.confirmation_email_sent_at) {
        failureUpdates.confirmation_email_status = 'failed';
        failureUpdates.confirmation_email_error = normalizeConferenceRegistrationError(error);
        failureUpdates.overall_status = 'partial';
      }
      try {
        await updateConferenceRegistrationTracking(tracking.id, failureUpdates);
      } catch (trackingUpdateError) {
        console.error('Conference registration tracking update failed:', trackingUpdateError);
      }
    }
    console.error('Conference registration failed:', error);
    return res.status(500).send('Errore durante l\'invio della registrazione.');
  }
});

app.get('/api/admin/conference-registrations', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;

  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const [trackedResult, importedResult] = await Promise.all([
      pool.query(
        `
        SELECT id, full_name AS "fullName", email, phone, organization, role, note,
               organizer_email_status AS "organizerEmailStatus",
               organizer_email_provider AS "organizerEmailProvider",
               organizer_email_error AS "organizerEmailError",
               organizer_email_sent_at AS "organizerEmailSentAt",
               confirmation_email_status AS "confirmationEmailStatus",
               confirmation_email_provider AS "confirmationEmailProvider",
               confirmation_email_error AS "confirmationEmailError",
               confirmation_email_sent_at AS "confirmationEmailSentAt",
               overall_status AS "overallStatus",
               final_error AS "finalError",
               created_at AS "createdAt",
               updated_at AS "updatedAt",
               'tracked'::text AS "recordType",
               'Registrazione da form'::text AS "sourceLabel"
        FROM conference_registrations
        ORDER BY created_at DESC
        LIMIT $1
        `,
        [limit]
      ),
      pool.query(
        `
        SELECT id, full_name AS "fullName", email, phone, organization, role, note,
               NULL::text AS "organizerEmailStatus",
               NULL::text AS "organizerEmailProvider",
               NULL::text AS "organizerEmailError",
               NULL::timestamptz AS "organizerEmailSentAt",
               NULL::text AS "confirmationEmailStatus",
               NULL::text AS "confirmationEmailProvider",
               NULL::text AS "confirmationEmailError",
               NULL::timestamptz AS "confirmationEmailSentAt",
               'imported'::text AS "overallStatus",
               NULL::text AS "finalError",
               created_at AS "createdAt",
               updated_at AS "updatedAt",
               'imported'::text AS "recordType",
               source_file_name AS "sourceLabel"
        FROM conference_registration_imports
        ORDER BY created_at DESC
        LIMIT $1
        `,
        [limit]
      )
    ]);
    const rows = [...trackedResult.rows, ...importedResult.rows]
      .sort((a, b) => {
        const left = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const right = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return right - left;
      })
      .slice(0, limit);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching conference registrations', error);
    res.status(500).json({ error: 'Unable to retrieve conference registrations' });
  }
});

app.delete('/api/admin/conference-registrations/:recordType/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;

  const { recordType, id } = req.params;
  const table = recordType === 'tracked'
    ? 'conference_registrations'
    : recordType === 'imported'
      ? 'conference_registration_imports'
      : null;

  if (!table) {
    return res.status(400).json({ error: 'Tipo registrazione non valido' });
  }

  try {
    const { rowCount } = await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    if (!rowCount) {
      return res.status(404).json({ error: 'Registrazione non trovata' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting conference registration', error);
    res.status(500).json({ error: 'Unable to delete conference registration' });
  }
});

app.post('/api/admin/conference-registrations/import-xlsx', requireAdmin, uploadConferenceExcel.single('file'), async (req, res) => {
  if (!ensurePool(res)) return;

  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'Carica un file .xlsx valido' });
    }

    const sourceFileName = req.file.originalname || 'import.xlsx';
    const parsed = await parseConferenceRegistrationsFromXlsx(req.file.buffer, sourceFileName);
    const warnings = [...(parsed.warnings || [])];
    if (!parsed.rows.length) {
      return res.status(400).json({ error: 'Il file Excel non contiene righe importabili', warnings });
    }

    const [trackedEmailsResult, importedEmailsResult] = await Promise.all([
      pool.query('SELECT LOWER(email) AS email FROM conference_registrations WHERE email IS NOT NULL'),
      pool.query('SELECT LOWER(email) AS email FROM conference_registration_imports WHERE email IS NOT NULL')
    ]);
    const knownEmails = new Set([
      ...trackedEmailsResult.rows.map((row) => normalizeConferenceEmail(row.email)).filter(Boolean),
      ...importedEmailsResult.rows.map((row) => normalizeConferenceEmail(row.email)).filter(Boolean)
    ]);

    let importedCount = 0;
    const skippedRows = [];

    for (const row of parsed.rows) {
      if (!row.email) {
        skippedRows.push({ rowNumber: row.sourceRowNumber, reason: 'missing_email' });
        continue;
      }
      if (knownEmails.has(row.email)) {
        skippedRows.push({ rowNumber: row.sourceRowNumber, email: row.email, reason: 'duplicate_email' });
        continue;
      }

      const id = uuidv4();
      await pool.query(
        `
        INSERT INTO conference_registration_imports
          (id, full_name, email, phone, organization, role, note, source_file_name, source_row_number, created_at, updated_at)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
        `,
        [
          id,
          row.fullName,
          row.email,
          row.phone,
          row.organization,
          row.role,
          row.note,
          row.sourceFileName,
          row.sourceRowNumber
        ]
      );
      knownEmails.add(row.email);
      importedCount += 1;
    }

    res.json({
      imported: importedCount,
      skipped: skippedRows.length,
      warnings,
      skippedRows
    });
  } catch (error) {
    console.error('Error importing conference registrations from xlsx', error);
    res.status(500).json({ error: 'Unable to import conference registrations', detail: error.message });
  }
});

// =============================================================================
// EVENTI — iscrizioni studenti (es. visite aziendali)
// =============================================================================

async function setEventResponse({ eventId, userId, responseStatus }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: eventRows } = await client.query(`
      SELECT id, title, location, starts_at AS "startsAt", capacity,
             registration_open AS "registrationOpen",
             registration_deadline AS "registrationDeadline"
      FROM events
      WHERE id = $1
      FOR UPDATE
    `, [eventId]);
    const event = eventRows[0];
    if (!event) {
      await client.query('ROLLBACK');
      return { error: { status: 404, message: 'Evento non trovato' } };
    }

    const { rows: existingRows } = await client.query(
      'SELECT id, response_status AS "responseStatus" FROM event_registrations WHERE event_id = $1 AND user_id = $2 FOR UPDATE',
      [eventId, userId]
    );
    const existing = existingRows[0] || null;
    if (existing && existing.responseStatus === responseStatus) {
      await client.query('COMMIT');
      return { ok: true, alreadyResponded: true, responseStatus };
    }

    if (responseStatus === 'registered') {
      if (!event.registrationOpen) {
        await client.query('ROLLBACK');
        return { error: { status: 409, message: 'Le iscrizioni per questo evento sono chiuse' } };
      }
      if (event.registrationDeadline && new Date(event.registrationDeadline).getTime() < Date.now()) {
        await client.query('ROLLBACK');
        return { error: { status: 409, message: 'Il termine per iscriversi a questo evento è scaduto' } };
      }
      if (event.capacity && (!existing || existing.responseStatus !== 'registered')) {
        const { rows: countRows } = await client.query(
          "SELECT COUNT(*)::int AS n FROM event_registrations WHERE event_id = $1 AND response_status = 'registered'",
          [eventId]
        );
        if (countRows[0].n >= event.capacity) {
          await client.query('ROLLBACK');
          return { error: { status: 409, message: 'Posti esauriti per questo evento' } };
        }
      }
    }

    const { rows: savedRows } = await client.query(`
      INSERT INTO event_registrations (event_id, user_id, response_status)
      VALUES ($1, $2, $3)
      ON CONFLICT (event_id, user_id) DO UPDATE SET
        response_status = EXCLUDED.response_status,
        updated_at = NOW()
      RETURNING id, response_status AS "responseStatus", (xmax = 0) AS "inserted"
    `, [eventId, userId, responseStatus]);

    await client.query('COMMIT');
    return {
      ok: true,
      inserted: savedRows[0]?.inserted === true,
      responseStatus: savedRows[0]?.responseStatus || responseStatus,
      changed: !existing || existing.responseStatus !== responseStatus
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Error rolling back event response transaction', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

// Studente: elenco eventi aperti con stato iscrizione personale
app.get('/api/lms/events', requireStudent, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const userId = req.user.userId || null;
    const { rows } = await pool.query(`
      SELECT e.id, e.title, e.description, e.location, e.starts_at AS "startsAt",
             e.capacity, e.registration_open AS "registrationOpen",
             e.registration_deadline AS "registrationDeadline",
             COUNT(*) FILTER (WHERE r.response_status = 'registered')::int AS "registeredCount",
             COUNT(*) FILTER (WHERE r.response_status = 'declined')::int AS "declinedCount",
             MAX(CASE WHEN r.user_id = $1 THEN r.response_status END) AS "responseStatus"
      FROM events e
      LEFT JOIN event_registrations r ON r.event_id = e.id
      GROUP BY e.id
      HAVING e.registration_open = true OR MAX(CASE WHEN r.user_id = $1 THEN r.response_status END) IS NOT NULL
      ORDER BY e.starts_at NULLS LAST, e.created_at DESC
    `, [userId]);
    res.json(rows.map(row => ({
      ...row,
      responseStatus: row.responseStatus || null,
      isRegistered: row.responseStatus === 'registered',
      isDeclined: row.responseStatus === 'declined'
    })));
  } catch (error) {
    console.error('Error fetching events', error);
    res.status(500).json({ error: 'Unable to retrieve events' });
  }
});

async function handleEventResponseRequest(req, res, responseStatus) {
  if (!ensurePool(res)) return;
  const userId = req.user.userId;
  if (!userId) return res.status(400).json({ error: 'Utente non valido' });
  if (!['registered', 'declined'].includes(responseStatus)) {
    return res.status(400).json({ error: 'responseStatus must be registered or declined' });
  }
  try {
    const result = await setEventResponse({ eventId: req.params.id, userId, responseStatus });
    if (result.error) {
      return res.status(result.error.status || 500).json({ error: result.error.message });
    }

    if (responseStatus === 'registered' && result.changed) {
      try {
        const { rows: userRows } = await pool.query(
          'SELECT email, first_name AS "firstName", last_name AS "lastName" FROM users WHERE id = $1',
          [userId]
        );
        const { rows: eventRows } = await pool.query(
          'SELECT title, location, starts_at AS "startsAt" FROM events WHERE id = $1',
          [req.params.id]
        );
        const student = userRows[0];
        const event = eventRows[0];
        if (student && student.email && event) {
          await sendEmail({
            to: student.email,
            subject: `Conferma iscrizione: ${event.title}`,
            html: buildEventRegistrationEmail({ student, event })
          });
        }
      } catch (mailErr) {
        console.error('Event confirmation email failed', mailErr.message);
      }
    }

    res.json({ ok: true, responseStatus });
  } catch (error) {
    console.error('Error saving event response', error);
    res.status(500).json({ error: 'Risposta non riuscita' });
  }
}

// Studente: risponde a un evento (parteciperà / non parteciperà)
app.post('/api/lms/events/:id/response', requireStudent, requireNonGuest, async (req, res) => {
  const responseStatus = String(req.body?.responseStatus || req.body?.response || '').trim();
  return handleEventResponseRequest(req, res, responseStatus);
});

// Compatibilità: vecchia route iscrizione => RSVP "parteciperò"
app.post('/api/lms/events/:id/register', requireStudent, requireNonGuest, async (req, res) => {
  return handleEventResponseRequest(req, res, 'registered');
});

// Compatibilità: declinazione esplicita
app.post('/api/lms/events/:id/decline', requireStudent, requireNonGuest, async (req, res) => {
  return handleEventResponseRequest(req, res, 'declined');
});

// Studente: l'iscrizione a un evento è definitiva e NON può essere annullata
// dallo studente. Solo l'admin può rimuovere un iscritto (route admin sotto).
app.delete('/api/lms/events/:id/register', requireStudent, requireNonGuest, async (req, res) => {
  return res.status(403).json({
    error: 'L\'iscrizione è definitiva e non può essere annullata. Per necessità contatta la segreteria.'
  });
});

// Admin: elenco eventi con conteggio iscritti
app.get('/api/admin/events', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT e.id, e.title, e.description, e.location, e.starts_at AS "startsAt",
             e.capacity, e.registration_open AS "registrationOpen",
             e.registration_deadline AS "registrationDeadline",
             e.calendar_lesson_id AS "calendarLessonId",
             COUNT(*) FILTER (WHERE r.response_status = 'registered')::int AS "registeredCount",
             COUNT(*) FILTER (WHERE r.response_status = 'declined')::int AS "declinedCount",
             e.created_at AS "createdAt"
      FROM events e
      LEFT JOIN event_registrations r ON r.event_id = e.id
      GROUP BY e.id
      ORDER BY e.starts_at NULLS LAST, e.created_at DESC
    `);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching admin events', error);
    res.status(500).json({ error: 'Unable to retrieve events' });
  }
});

// Admin: crea evento
app.post('/api/admin/events', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { title, description, location, startsAt, capacity, registrationOpen, calendarLessonId, registrationDeadline } = req.body || {};
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'Il titolo è obbligatorio' });
  }
  try {
    const { rows } = await pool.query(`
      INSERT INTO events (title, description, location, starts_at, capacity, registration_open, calendar_lesson_id, registration_deadline)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
    `, [
      String(title).trim(),
      description ? String(description).trim() : null,
      location ? String(location).trim() : null,
      startsAt || null,
      Number.isFinite(Number(capacity)) && Number(capacity) > 0 ? Number(capacity) : null,
      registrationOpen === false ? false : true,
      calendarLessonId || null,
      registrationDeadline || null
    ]);
    res.status(201).json({ id: rows[0].id });
  } catch (error) {
    console.error('Error creating event', error);
    res.status(500).json({ error: 'Creazione evento non riuscita' });
  }
});

// Admin: aggiorna evento
app.put('/api/admin/events/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { title, description, location, startsAt, capacity, registrationOpen, calendarLessonId, registrationDeadline } = req.body || {};
  try {
    const { rows } = await pool.query(`
      UPDATE events SET
        title = COALESCE($2, title),
        description = $3,
        location = $4,
        starts_at = $5,
        capacity = $6,
        registration_open = COALESCE($7, registration_open),
        calendar_lesson_id = $8,
        registration_deadline = $9,
        updated_at = NOW()
      WHERE id = $1
      RETURNING id
    `, [
      req.params.id,
      title ? String(title).trim() : null,
      description ? String(description).trim() : null,
      location ? String(location).trim() : null,
      startsAt || null,
      Number.isFinite(Number(capacity)) && Number(capacity) > 0 ? Number(capacity) : null,
      typeof registrationOpen === 'boolean' ? registrationOpen : null,
      calendarLessonId || null,
      registrationDeadline || null
    ]);
    if (!rows.length) return res.status(404).json({ error: 'Evento non trovato' });
    res.json({ id: rows[0].id });
  } catch (error) {
    console.error('Error updating event', error);
    res.status(500).json({ error: 'Aggiornamento evento non riuscito' });
  }
});

// Admin: elimina evento
app.delete('/api/admin/events/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rowCount } = await pool.query('DELETE FROM events WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Evento non trovato' });
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting event', error);
    res.status(500).json({ error: 'Eliminazione evento non riuscita' });
  }
});

// Admin: elenco iscritti a un evento
app.get('/api/admin/events/:id/registrations', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT r.id,
             COALESCE(NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), u.email, 'Studente') AS "studentName",
             u.email AS "studentEmail",
             r.response_status AS "responseStatus",
             r.created_at AS "registeredAt",
             r.updated_at AS "updatedAt"
      FROM event_registrations r
      LEFT JOIN users u ON u.id = r.user_id
      WHERE r.event_id = $1
      ORDER BY r.response_status DESC, r.created_at ASC
    `, [req.params.id]);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching event registrations', error);
    res.status(500).json({ error: 'Unable to retrieve registrations' });
  }
});

// Admin: rimuovi un iscritto
app.delete('/api/admin/events/:id/registrations/:regId', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM event_registrations WHERE id = $1 AND event_id = $2',
      [req.params.regId, req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Iscrizione non trovata' });
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting event registration', error);
    res.status(500).json({ error: 'Rimozione iscrizione non riuscita' });
  }
});

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

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email || null;
}

function isFacultyEmailUniqueViolation(error) {
  return error?.code === '23505' && (
    error.constraint === 'idx_faculty_email' ||
    error.constraint === 'idx_faculty_email_lower'
  );
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

function getOptionalAdmin(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice(7);
  if (PIPELINE_API_KEY && token === PIPELINE_API_KEY) {
    return { role: 'admin', source: 'pipeline_api_key' };
  }

  const payload = verifyToken(token);
  return payload && payload.role === 'admin' ? payload : null;
}

function getOptionalTeacher(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice(7);
  const payload = verifyToken(token);
  return payload && payload.role === 'teacher' ? payload : null;
}

function requireAdminOrTeacher(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ error: 'Authentication not configured.' });
  }

  const admin = getOptionalAdmin(req);
  if (admin) {
    req.admin = admin;
    return next();
  }

  const teacher = getOptionalTeacher(req);
  if (teacher) {
    req.teacher = teacher;
    return next();
  }

  return res.status(401).json({ error: 'Authentication required' });
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

// =============================================================================
// Admin "preview studente"
// -----------------------------------------------------------------------------
// L'admin del pannello puo' aprire /admin/prof-carbonio-preview.html per
// vedere il widget Prof. Carbonio esattamente come lo vede uno studente.
// Quel widget chiama /api/tutor/* e ha bisogno di un req.user.userId valido.
//
// Il JWT admin pero' contiene solo {role:'admin'} senza userId, quindi
// requireStudent (che accetta gia' role='admin') non basta: tutte le query
// scope per user_id si romperebbero.
//
// requireStudentOrAdminPreview rileva il caso "token admin senza userId" e
// inietta un userId reale (ADMIN_PREVIEW_USER_ID, seedato da migration 052)
// in req.user. Effetto:
//   - le sessioni create dall'admin in anteprima usano questo user_id
//   - sono isolate dalle sessioni degli studenti reali
//   - la FK tutor_sessions.user_id -> users.id continua a essere rispettata.
// =============================================================================
const ADMIN_PREVIEW_USER_ID = '00000000-0000-0000-0000-000000000001';

function requireStudentOrAdminPreview(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = authHeader.slice(7);
  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Token admin "puro" (no userId): sintetizziamo lo pseudo-utente preview.
  if (payload.role === 'admin' && !payload.userId) {
    req.user = {
      role: 'admin',
      userId: ADMIN_PREVIEW_USER_ID,
      firstName: 'Admin',
      lastName: 'Preview',
      email: 'admin-preview@carbonfarmingmaster.local',
      isAdminPreview: true
    };
    return next();
  }

  // Altrimenti comportamento identico a requireStudent.
  if (!['student', 'teacher', 'admin', 'guest'].includes(payload.role)) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  req.user = payload;
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
app.use(express.urlencoded({ extended: true }));

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

// =============================================================================
// Prof. Carbonio — AI Tutor del Master in Carbon Farming
// Modulo separato in api/prof-carbonio-*.js, registriamo qui le route.
// =============================================================================
try {
  const Anthropic = require('@anthropic-ai/sdk').default;
  const { registerProfCarbonioRoutes } = require('./prof-carbonio-routes');

  const profCarbonioAnthropic = process.env.ANTHROPIC_API_KEY
    ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    : null;

  const profCarbonioOpenAI = process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

  registerProfCarbonioRoutes(app, {
    pool,
    anthropic: profCarbonioAnthropic,
    openai: profCarbonioOpenAI,
    // requireStudentOrAdminPreview accetta anche il token admin (no userId)
    // e inietta lo pseudo-utente "Admin Preview" per consentire la pagina
    // /admin/prof-carbonio-preview.html senza rompere le query scope-by-user.
    requireStudent: requireStudentOrAdminPreview,
    requireNonGuest
  });

  const { registerProfCarbonioAdminRoutes } = require('./prof-carbonio-admin');
  registerProfCarbonioAdminRoutes(app, {
    pool,
    openai: profCarbonioOpenAI,
    requireAdmin,
    // Anche /api/tutor/config deve essere raggiungibile dall'admin preview.
    requireStudent: requireStudentOrAdminPreview
  });
  console.log('[prof-carbonio] Routes registered (student + admin)');
} catch (err) {
  console.error('[prof-carbonio] Failed to register routes:', err.message);
}

// ---------------------------------------------------------------------------
// AI Study Companion (Sprint 2: agente Claude con tool use sulla KB)
// Docs: docs/study-companion/ARCHITETTURA.md
// ---------------------------------------------------------------------------
try {
  const { registerStudyCompanionRoutes } = require('./study-companion-routes');

  const studyCompanionAnthropic = process.env.ANTHROPIC_API_KEY
    ? (() => {
        const Anthropic = require('@anthropic-ai/sdk').default;
        return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      })()
    : null;

  // Ricreiamo l'istanza OpenAI qui (lo scope del try di Prof. Carbonio è
  // separato). Servono gli embeddings per il tool search_kb dell'agente.
  const studyCompanionOpenAI = process.env.OPENAI_API_KEY
    ? (() => {
        const { OpenAI } = require('openai');
        return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      })()
    : null;

  registerStudyCompanionRoutes(app, {
    pool,
    anthropic: studyCompanionAnthropic,
    openai: studyCompanionOpenAI,
    requireStudent,
    requireNonGuest
  });
} catch (err) {
  console.error('[study-companion] Failed to register routes:', err.message);
}

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
  res.status(410).json({
    error: 'Accesso con password disabilitato. Richiedi un link di accesso via email.'
  });
});

// Self-service magic link request (public, no auth required)
app.post('/api/teachers/request-magic-link', async (req, res) => {
  if (!ensurePool(res)) return;
  const safeMsg = 'Se la tua email è registrata, riceverai un link di accesso.';

  const email = normalizeEmail(req.body?.email);
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

app.post('/api/teachers/student-view-token', requireTeacher, async (req, res) => {
  if (!ensurePool(res)) return;

  try {
    const { rows } = await pool.query(
      'SELECT id, email, first_name, last_name FROM faculty WHERE id = $1 LIMIT 1',
      [req.teacher.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Docente non trovato' });
    }

    const teacher = rows[0];
    const token = generateToken({
      role: 'guest',
      purpose: 'teacher_student_view',
      teacherId: teacher.id,
      firstName: teacher.first_name,
      lastName: teacher.last_name,
      email: teacher.email
    });

    res.json({
      token,
      user: {
        role: 'guest',
        teacherId: teacher.id,
        firstName: teacher.first_name,
        lastName: teacher.last_name,
        email: teacher.email,
        accessMode: 'student_view'
      }
    });
  } catch (error) {
    console.error('Error generating teacher student-view token', error);
    res.status(500).json({ error: 'Unable to generate student view token' });
  }
});

// Get teacher statistics
app.get('/api/teachers/stats', requireTeacher, async (req, res) => {
  if (!ensurePool(res)) return;

  try {
    const facultyId = req.teacher.id;
    
    // Teacher lessons in scope: all non-cancelled lessons.
    // Teachers often need to upload materials after a lesson date, before the
    // admin has marked that lesson as completed.
    const { rows: lessonStats } = await pool.query(
      `SELECT
         COUNT(*)::int AS total_lessons,
         COUNT(*) FILTER (WHERE l.status = 'completed')::int AS completed_lessons,
         COUNT(*) FILTER (WHERE COALESCE(l.status, 'scheduled') != 'completed')::int AS planned_lessons,
         COALESCE(SUM(COALESCE(l.duration_minutes, 0)) FILTER (WHERE COALESCE(l.status, 'scheduled') != 'completed'), 0)::int AS planned_minutes,
         COALESCE(SUM(COALESCE(l.duration_minutes, 0)) FILTER (WHERE l.status = 'completed'), 0)::int AS completed_minutes
       FROM lessons l
       WHERE l.teacher_id = $1
         AND COALESCE(l.status, 'scheduled') != 'cancelled'`,
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
  
  const { lesson_id, title, description, url } = req.body;
  const file = req.file;
  
  if ((!file && !url) || !lesson_id || !title) {
    return res.status(400).json({ error: 'File o URL, lesson_id e title sono obbligatori' });
  }
  
  try {
    console.log('Upload attempt:', { teacherFacultyId: req.teacher.id, lessonId: lesson_id });
    const schema = await getMaterialsPendingSchemaConfig();

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

    let storedUrl = String(url || '').trim();
    let originalName = file ? file.originalname : storedUrl;
    let mimeType = file ? file.mimetype : 'text/uri-list';

    if (file) {
      const materialUpload = await prepareCompressibleMaterialUpload(file, MATERIALS_UPLOAD_FINAL_MAX_BYTES, 'materiali docente');
      if (materialUpload.tooLarge) {
        return res.status(413).json({ error: materialUpload.error });
      }

      // Upload to Vercel Blob — con retry: il put fallisce a volte in modo
      // transitorio su cold start / rete, ed era la causa di 500 intermittenti.
      let blobUrl, pathname;
      {
        let lastErr;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            ({ url: blobUrl, pathname } = await put(file.originalname, materialUpload.buffer, {
              access: 'public',
              addRandomSuffix: true,
              contentType: file.mimetype,
              token: process.env.BLOB_READ_WRITE_TOKEN
            }));
            lastErr = null;
            break;
          } catch (putErr) {
            lastErr = putErr;
            console.warn(`Blob put attempt ${attempt}/3 failed:`, putErr && putErr.message);
            await new Promise(r => setTimeout(r, 400 * attempt));
          }
        }
        if (lastErr) throw lastErr;
      }
      storedUrl = blobUrl;
    }

    // Save to materials_pending
    let materials;
    if (schema.hasTitle && schema.hasDescription) {
      const insertPayload = buildMaterialsPendingInsertPayload({
        teacherFacultyId: req.teacher.id,
        lessonId: lesson_id,
        url: storedUrl,
        fileOriginalName: originalName,
        fileMimeType: mimeType,
        title,
        description
      });
      ({ rows: materials } = await pool.query(insertPayload.text, insertPayload.values));
    } else {
      ({ rows: materials } = await pool.query(
        `INSERT INTO materials_pending
         (faculty_id, lesson_id, file_url, file_name, file_type, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')
         RETURNING id`,
        [req.teacher.id, lesson_id, storedUrl, originalName, mimeType]
      ));
    }
    
    res.json({
      id: materials[0].id,
      message: 'Materiale caricato con successo. In attesa di approvazione.',
      file_url: storedUrl,
      filename: originalName
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
    const pendingSchema = await getMaterialsPendingSchemaConfig();
    const resourcesSchema = await getResourcesSchemaConfig();

    // Materials uploaded by teacher (pending approval)
    let pending = [];
    if (pendingSchema.hasTable) {
      const pendingFragments = buildMaterialsPendingSelectFragments(pendingSchema);
      try {
        const result = await pool.query(
          `SELECT id, ${pendingFragments.title}, ${pendingFragments.description}, file_url, file_name, file_type, status, ${pendingFragments.notes}, created_at, 'upload' AS source
           FROM materials_pending mp
           WHERE mp.faculty_id = $1
             AND status != 'approved'
           ORDER BY mp.created_at DESC`,
          [facultyId]
        );
        pending = result.rows;
      } catch (error) {
        console.warn('Skipping teacher pending materials query:', error.message);
      }
    }

    // Resources assigned to this teacher by admin
    let resources = [];
    if (resourcesSchema.hasTable && resourcesSchema.hasTeacherId) {
      const resourceFragments = buildTeacherResourcesSelectFragments(resourcesSchema);
      const resourceTypeFilter = resourcesSchema.hasResourceType ? `AND r.resource_type <> 'quiz'` : '';
      const lessonJoin = resourcesSchema.hasLessonId ? 'LEFT JOIN lessons l ON l.id = r.lesson_id' : '';
      const accessClause = resourcesSchema.hasLessonId
        ? 'WHERE (r.teacher_id = $1 OR l.teacher_id = $1)'
        : 'WHERE r.teacher_id = $1';
      try {
        const result = await pool.query(
          `SELECT r.id, r.title, ${resourceFragments.description}, r.url AS file_url, NULL AS file_name, ${resourceFragments.fileSize},
                  ${resourceFragments.fileType}, ${resourceFragments.status},
                  ${resourceFragments.reviewStatus}, ${resourceFragments.reviewNotes}, ${resourceFragments.reviewedAt},
                  r.created_at, 'admin' AS source
           FROM resources r
           ${lessonJoin}
           ${accessClause}
           ${resourceTypeFilter}
           ORDER BY r.created_at DESC`,
          [facultyId]
        );
        resources = result.rows;
      } catch (error) {
        console.warn('Skipping teacher resources query:', error.message);
      }
    }

    // Merge and sort by date
    const all = [...pending, ...resources].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json(all);
  } catch (error) {
    console.error('Get teacher materials error:', error);
    res.status(500).json({ error: 'Errore nel recupero materiali' });
  }
});

app.put('/api/teachers/materials/:id/review', requireTeacher, async (req, res) => {
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
    const resourceColumns = await getTableColumns('resources');
    if (!resourceColumns.has('teacher_id')) {
      return res.status(500).json({ error: 'Resources schema missing teacher_id column' });
    }

    const hasReviewStatus = resourceColumns.has('review_status');
    const hasReviewNotes = resourceColumns.has('teacher_review_notes');
    const hasReviewedAt = resourceColumns.has('teacher_reviewed_at');
    const hasLessonId = resourceColumns.has('lesson_id');
    const reviewStatus = action === 'approve' ? 'teacher_approved' : 'teacher_rejected';
    const isPublished = action === 'approve';
    const reviewNotes = action === 'reject' ? String(notes).trim() : null;
    const setClauses = ['is_published = $2', 'updated_at = NOW()'];
    if (hasReviewStatus) setClauses.push('review_status = $3');
    if (hasReviewNotes) setClauses.push('teacher_review_notes = $4');
    if (hasReviewedAt) setClauses.push('teacher_reviewed_at = NOW()');

    const returningClauses = [
      'id',
      'title',
      'resource_type AS "resourceType"',
      'teacher_id AS "teacherId"',
      'is_published AS "isPublished"',
      hasReviewStatus ? 'review_status AS "reviewStatus"' : `$3 AS "reviewStatus"`,
      hasReviewNotes ? 'teacher_review_notes AS "reviewNotes"' : '$4::text AS "reviewNotes"',
      hasReviewedAt ? 'teacher_reviewed_at AS "reviewedAt"' : 'NOW() AS "reviewedAt"'
    ];

    const { rows } = await pool.query(
      `UPDATE resources
       SET ${setClauses.join(', ')}
       WHERE id = $1
         AND (${hasLessonId ? '(teacher_id = $5 OR lesson_id IN (SELECT id FROM lessons WHERE teacher_id = $5))' : 'teacher_id = $5'})
         AND resource_type <> 'quiz'
       RETURNING ${returningClauses.join(', ')}`,
      [id, isPublished, reviewStatus, reviewNotes, req.teacher.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Material not found for this teacher' });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error('Error reviewing teacher material', error);
    res.status(500).json({ error: 'Unable to review material' });
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
    const schema = await getMaterialsPendingSchemaConfig();
    if (!schema.hasTable) {
      return res.json([]);
    }
    const fragments = buildMaterialsPendingSelectFragments(schema);
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
              ${fragments.title}, ${fragments.description}, mp.status, ${fragments.notes}, mp.created_at AS "createdAt", ${fragments.updatedAt},
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
    const schema = await getMaterialsPendingSchemaConfig();
    if (!schema.hasTable) {
      return res.status(500).json({ error: 'Materials pending schema missing' });
    }
    const resourcesSchema = await getResourcesSchemaConfig();
    if (!resourcesSchema.hasTable) {
      return res.status(500).json({ error: 'Resources schema missing' });
    }
    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    const reviewNotes = action === 'reject' ? String(notes).trim() : null;
    await pool.query('BEGIN');
    try {
      // In UPDATE ... RETURNING non c'è alias FROM, quindi i frammenti devono
      // essere senza prefisso `mp.` (default usato dalle SELECT con JOIN).
      const returningFragments = buildMaterialsPendingSelectFragments(schema, '');
      const pendingSetClauses = ['status = $1::varchar'];
      if (schema.hasNotes) {
        pendingSetClauses.push(`notes = CASE WHEN $1::varchar = 'rejected' THEN $2::text ELSE NULL END`);
      }
      if (schema.hasUpdatedAt) {
        pendingSetClauses.push('updated_at = NOW()');
      }
      const { rows } = await pool.query(
        `UPDATE materials_pending
         SET ${pendingSetClauses.join(', ')}
         WHERE id = $3
         RETURNING id, faculty_id AS "facultyId", lesson_id AS "lessonId",
                   file_url AS "fileUrl", file_name AS "fileName", file_type AS "fileType",
                   ${returningFragments.title}, ${returningFragments.description}, status, ${returningFragments.notes}, ${returningFragments.updatedAt}`,
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
        const resourceFacultyId = normalizedFacultyId || null;

        if (normalizedFacultyId && normalizedFacultyId !== item.facultyId) {
          const facultyUpdateSet = ['faculty_id = $1'];
          if (schema.hasUpdatedAt) facultyUpdateSet.push('updated_at = NOW()');
          await pool.query(
            `UPDATE materials_pending
             SET ${facultyUpdateSet.join(', ')}
             WHERE id = $2`,
            [normalizedFacultyId, item.id]
          );
          item.facultyId = normalizedFacultyId;
        }

        const existingWhere = ['url = $1'];
        const existingValues = [item.fileUrl];
        if (resourcesSchema.hasLessonId) {
          existingValues.push(item.lessonId || null);
          existingWhere.push(`COALESCE(lesson_id::text, '') = COALESCE($${existingValues.length}::text, '')`);
        }
        if (resourcesSchema.hasTeacherId) {
          existingValues.push(resourceFacultyId);
          existingWhere.push(`COALESCE(teacher_id::text, '') = COALESCE($${existingValues.length}::text, '')`);
        }
        const { rows: existing } = await pool.query(
          `SELECT id FROM resources
           WHERE ${existingWhere.join(' AND ')}
           LIMIT 1`,
          existingValues
        );

        let approvedResourceId = null;
        if (existing.length) {
          const updateValues = [existing[0].id, resourceTitle];
          const updateSet = ['title = $2'];
          if (resourcesSchema.hasDescription) {
            updateValues.push(item.description || null);
            updateSet.push(`description = $${updateValues.length}`);
          }
          if (resourcesSchema.hasResourceType) {
            updateValues.push(resourceType);
            updateSet.push(`resource_type = $${updateValues.length}`);
          }
          if (resourcesSchema.hasTeacherId) {
            updateValues.push(resourceFacultyId);
            updateSet.push(`teacher_id = $${updateValues.length}`);
          }
          if (resourcesSchema.hasLessonId) {
            updateValues.push(item.lessonId || null);
            updateSet.push(`lesson_id = $${updateValues.length}`);
          }
          if (resourcesSchema.hasIsPublished) {
            updateSet.push('is_published = true');
          }
          updateSet.push('updated_at = NOW()');
          await pool.query(
            `UPDATE resources
             SET ${updateSet.join(', ')}
             WHERE id = $1`,
            updateValues
          );
          approvedResourceId = existing[0].id;
        } else {
          approvedResourceId = uuidv4();
          const insertColumns = ['id', 'title', 'url'];
          const insertValues = [approvedResourceId, resourceTitle, item.fileUrl];
          if (resourcesSchema.hasDescription) {
            insertColumns.push('description');
            insertValues.push(item.description || null);
          }
          if (resourcesSchema.hasResourceType) {
            insertColumns.push('resource_type');
            insertValues.push(resourceType);
          }
          if (resourcesSchema.hasIsPublished) {
            insertColumns.push('is_published');
            insertValues.push(true);
          }
          if (resourcesSchema.hasTeacherId) {
            insertColumns.push('teacher_id');
            insertValues.push(resourceFacultyId);
          }
          if (resourcesSchema.hasLessonId) {
            insertColumns.push('lesson_id');
            insertValues.push(item.lessonId || null);
          }
          insertColumns.push('created_at', 'updated_at');
          const placeholders = insertValues.map((_, index) => `$${index + 1}`);
          placeholders.push('NOW()', 'NOW()');
          await pool.query(
            `INSERT INTO resources
               (${insertColumns.join(', ')})
             VALUES
               (${placeholders.join(', ')})`,
            insertValues
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

  // Academic band (fascia) and pro-bono flag
  await pool.query(`
    ALTER TABLE faculty
    ADD COLUMN IF NOT EXISTS band TEXT;
  `);
  await pool.query(`
    ALTER TABLE faculty
    ADD COLUMN IF NOT EXISTS is_pro_bono BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS faculty_overview_overrides (
      faculty_id UUID PRIMARY KEY REFERENCES faculty(id) ON DELETE CASCADE,
      appointment_received_manual BOOLEAN,
      received_hours NUMERIC(6, 1),
      notes TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conference_registrations (
      id UUID PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      organization TEXT,
      role TEXT,
      note TEXT,
      organizer_email_status TEXT NOT NULL DEFAULT 'pending',
      organizer_email_provider TEXT,
      organizer_email_error TEXT,
      organizer_email_sent_at TIMESTAMPTZ,
      confirmation_email_status TEXT NOT NULL DEFAULT 'pending',
      confirmation_email_provider TEXT,
      confirmation_email_error TEXT,
      confirmation_email_sent_at TIMESTAMPTZ,
      overall_status TEXT NOT NULL DEFAULT 'pending',
      final_error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE conference_registrations
    ADD COLUMN IF NOT EXISTS full_name TEXT;
  `);
  await pool.query(`
    ALTER TABLE conference_registrations
    ADD COLUMN IF NOT EXISTS email TEXT;
  `);
  await pool.query(`
    ALTER TABLE conference_registrations
    ADD COLUMN IF NOT EXISTS phone TEXT;
  `);
  await pool.query(`
    ALTER TABLE conference_registrations
    ADD COLUMN IF NOT EXISTS organization TEXT;
  `);
  await pool.query(`
    ALTER TABLE conference_registrations
    ADD COLUMN IF NOT EXISTS role TEXT;
  `);
  await pool.query(`
    ALTER TABLE conference_registrations
    ADD COLUMN IF NOT EXISTS note TEXT;
  `);
  await pool.query(`
    ALTER TABLE conference_registrations
    ADD COLUMN IF NOT EXISTS organizer_email_status TEXT NOT NULL DEFAULT 'pending';
  `);
  await pool.query(`
    ALTER TABLE conference_registrations
    ADD COLUMN IF NOT EXISTS organizer_email_provider TEXT;
  `);
  await pool.query(`
    ALTER TABLE conference_registrations
    ADD COLUMN IF NOT EXISTS organizer_email_error TEXT;
  `);
  await pool.query(`
    ALTER TABLE conference_registrations
    ADD COLUMN IF NOT EXISTS organizer_email_sent_at TIMESTAMPTZ;
  `);
  await pool.query(`
    ALTER TABLE conference_registrations
    ADD COLUMN IF NOT EXISTS confirmation_email_status TEXT NOT NULL DEFAULT 'pending';
  `);
  await pool.query(`
    ALTER TABLE conference_registrations
    ADD COLUMN IF NOT EXISTS confirmation_email_provider TEXT;
  `);
  await pool.query(`
    ALTER TABLE conference_registrations
    ADD COLUMN IF NOT EXISTS confirmation_email_error TEXT;
  `);
  await pool.query(`
    ALTER TABLE conference_registrations
    ADD COLUMN IF NOT EXISTS confirmation_email_sent_at TIMESTAMPTZ;
  `);
  await pool.query(`
    ALTER TABLE conference_registrations
    ADD COLUMN IF NOT EXISTS overall_status TEXT NOT NULL DEFAULT 'pending';
  `);
  await pool.query(`
    ALTER TABLE conference_registrations
    ADD COLUMN IF NOT EXISTS final_error TEXT;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conference_registration_imports (
      id UUID PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      organization TEXT,
      role TEXT,
      note TEXT,
      source_file_name TEXT,
      source_row_number INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
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
    ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS seo_title VARCHAR(80),
    ADD COLUMN IF NOT EXISTS meta_description VARCHAR(200),
    ADD COLUMN IF NOT EXISTS focus_keyword VARCHAR(120),
    ADD COLUMN IF NOT EXISTS pillar_slug VARCHAR(120),
    ADD COLUMN IF NOT EXISTS cover_alt VARCHAR(200),
    ADD COLUMN IF NOT EXISTS internal_links JSONB,
    ADD COLUMN IF NOT EXISTS last_reviewed_at TIMESTAMPTZ;
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
  } else {
    // Se questo log appare in produzione, le migrazioni SQL non sono state incluse
    // nel bundle serverless: controlla "includeFiles" in vercel.json (deve essere
    // "db/migrations/**", relativo alla root del progetto, NON "../db/migrations/**").
    console.warn(`Migrations directory not found at ${migrationsDir} — SQL migrations were skipped. Check vercel.json "includeFiles".`);
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
    hasTable: columns.size > 0,
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

async function getMaterialsPendingSchemaConfig() {
  const columns = await getTableColumns('materials_pending');
  return {
    hasTable: columns.size > 0,
    hasTitle: columns.has('title'),
    hasDescription: columns.has('description'),
    hasNotes: columns.has('notes'),
    hasUpdatedAt: columns.has('updated_at')
  };
}

function buildMaterialsPendingSelectFragments(config, alias = 'mp') {
  const prefix = alias ? `${alias}.` : '';
  return {
    title: config.hasTitle ? `${prefix}title AS title` : `NULL::text AS title`,
    description: config.hasDescription ? `${prefix}description AS description` : `NULL::text AS description`,
    notes: config.hasNotes ? `${prefix}notes AS notes` : `NULL::text AS notes`,
    updatedAt: config.hasUpdatedAt ? `${prefix}updated_at AS "updatedAt"` : `${prefix}created_at AS "updatedAt"`
  };
}

async function getResourcesSchemaConfig() {
  const columns = await getTableColumns('resources');
  return {
    hasTable: columns.size > 0,
    hasDescription: columns.has('description'),
    hasFileSizeBytes: columns.has('file_size_bytes'),
    hasResourceType: columns.has('resource_type'),
    hasIsPublished: columns.has('is_published'),
    hasTeacherId: columns.has('teacher_id'),
    hasLessonId: columns.has('lesson_id'),
    hasReviewStatus: columns.has('review_status'),
    hasReviewNotes: columns.has('teacher_review_notes'),
    hasReviewedAt: columns.has('teacher_reviewed_at')
  };
}

function buildTeacherResourcesSelectFragments(config, alias = 'r') {
  const prefix = alias ? `${alias}.` : '';
  return {
    description: config.hasDescription ? `${prefix}description AS description` : `NULL::text AS description`,
    fileSize: config.hasFileSizeBytes ? `${prefix}file_size_bytes AS file_size` : `NULL::bigint AS file_size`,
    fileType: config.hasResourceType ? `${prefix}resource_type AS file_type` : `NULL::text AS file_type`,
    status: config.hasIsPublished
      ? `CASE WHEN ${prefix}is_published THEN 'approved' ELSE 'pending' END AS status`
      : `'approved'::text AS status`,
    reviewStatus: config.hasReviewStatus
      ? `${prefix}review_status AS "reviewStatus"`
      : `NULL::text AS "reviewStatus"`,
    reviewNotes: config.hasReviewNotes
      ? `${prefix}teacher_review_notes AS "reviewNotes"`
      : `NULL::text AS "reviewNotes"`,
    reviewedAt: config.hasReviewedAt
      ? `${prefix}teacher_reviewed_at AS "reviewedAt"`
      : `NULL::timestamptz AS "reviewedAt"`
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
    ...(has('tags') ? { tags: Array.isArray(row.tags) ? row.tags : [] } : {}),
    ...(has('seo_title') ? { seoTitle: row.seo_title } : {}),
    ...(has('meta_description') ? { metaDescription: row.meta_description } : {}),
    ...(has('focus_keyword') ? { focusKeyword: row.focus_keyword } : {}),
    ...(has('pillar_slug') ? { pillarSlug: row.pillar_slug } : {}),
    ...(has('cover_alt') ? { coverAlt: row.cover_alt } : {})
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
  if (columns.has('seo_title')) mappings.push(['seo_title', post.seoTitle || null]);
  if (columns.has('meta_description')) mappings.push(['meta_description', post.metaDescription || null]);
  if (columns.has('focus_keyword')) mappings.push(['focus_keyword', post.focusKeyword || null]);
  if (columns.has('pillar_slug')) mappings.push(['pillar_slug', post.pillarSlug || null]);
  if (columns.has('cover_alt')) mappings.push(['cover_alt', post.coverAlt || null]);

  const insertColumns = mappings.map(([column]) => column);
  const placeholders = mappings.map((_, index) => `$${index + 1}`);
  const values = mappings.map(([, value]) => value);
  return { insertColumns, placeholders, values };
}

function createPublicUploadsPath(...parts) {
  return path.join(__dirname, ...parts);
}

async function saveBlogCoverToStorage(buffer, postId) {
  return saveImageToStorage(buffer, {
    folder: 'blog-covers',
    fileName: `${postId}-${Date.now()}.png`,
    contentType: 'image/png'
  });
}

async function saveImageToStorage(buffer, { folder, fileName, contentType = 'image/png' }) {
  if (process.env.CLOUDINARY_URL) {
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder,
          public_id: fileName.replace(/\.[^.]+$/, ''),
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
    const blob = await put(`${folder}/${fileName}`, buffer, {
      access: 'public',
      token: process.env.BLOB_READ_WRITE_TOKEN,
      addRandomSuffix: false,
      contentType
    });
    return blob.url;
  }

  if (process.env.VERCEL) {
    throw new Error('Storage immagini non configurato su Vercel. Imposta CLOUDINARY_URL oppure BLOB_READ_WRITE_TOKEN.');
  }

  const uploadDir = createPublicUploadsPath('uploads', folder);
  await fs.promises.mkdir(uploadDir, { recursive: true });
  const filePath = path.join(uploadDir, fileName);
  await fs.promises.writeFile(filePath, buffer);
  return `/uploads/${folder}/${fileName}`;
}

async function generateBlogCoverImage(prompt) {
  if (process.env.MOCK_OPENAI_IMAGE_BASE64) {
    return Buffer.from(process.env.MOCK_OPENAI_IMAGE_BASE64, 'base64');
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY non configurata');
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  // Quality and size are env-tunable so we can change cost/quality from Vercel
  // without a redeploy. Defaults chosen for cost-efficiency: medium quality at
  // landscape ~1.5:1 is plenty for blog covers and costs ~3x less than high.
  // gpt-image-1 listino approssimativo (output):
  //   low    1536x1024 ~$0.016 / img
  //   medium 1536x1024 ~$0.063 / img   <- default
  //   high   1536x1024 ~$0.250 / img   (old default)
  const quality = process.env.OPENAI_IMAGE_QUALITY || 'medium';
  const size = process.env.OPENAI_IMAGE_SIZE || '1536x1024';
  const response = await client.images.generate({
    model: 'gpt-image-1',
    prompt,
    size,
    quality
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

  const hasAttendance = typeof preloaded.hasAttendance === 'boolean'
    ? preloaded.hasAttendance
    : lesson.calendarLessonId
      ? ((await pool.query(`
        SELECT a.id
        FROM attendance a
        WHERE a.user_id = $2
          AND a.lesson_id = $1
          AND a.attendance_type IN ('in_person', 'remote_live')
        LIMIT 1
      `, [lesson.calendarLessonId, userId])).rows.length > 0)
      : false;

  const videoPercent = Number(progress?.progress_percent || 0);
  const videoOk = hasAttendance ? true : videoPercent >= 80;

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

  // Solo i quiz collegati a QUESTA lezione contano per il completamento della lezione.
  // Il quiz di modulo è tracciato separatamente (vista corso) e non deve soddisfare il criterio delle singole lezioni.
  const { rows: quizRows } = await pool.query(`
    SELECT id
    FROM quizzes
    WHERE is_published = true
      AND lms_lesson_id = $1
    ORDER BY created_at ASC
  `, [lessonId]);
  const quizIds = quizRows.map(row => row.id);

  let quizBestScore = null;
  let quizOk = true;
  if (quizIds.length) {
    const { rows: attemptRows } = await pool.query(
      'SELECT MAX(COALESCE(percentage, score))::int AS "bestScore" FROM quiz_attempts WHERE user_id = $1 AND quiz_id = ANY($2) AND completed_at IS NOT NULL',
      [userId, quizIds]
    );
    quizBestScore = attemptRows[0]?.bestScore === null || attemptRows[0]?.bestScore === undefined
      ? null
      : Number(attemptRows[0].bestScore);
    quizOk = (quizBestScore ?? -1) >= 70;
  }

  const criteria = { attendance: hasAttendance, video: videoOk, materials: materialsOk, quiz: quizOk };
  const details = {
    hasAttendance,
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
  faculty: ['name', 'first_name', 'last_name', 'role', 'email', 'bio', 'photo_url', 'profile_link', 'sort_order', 'is_published', 'is_active', 'can_view_all_materials', 'band', 'is_pro_bono'],
  blog_posts: ['title', 'slug', 'content', 'excerpt', 'cover_image_url', 'author', 'source_module', 'cover_image_prompt', 'reviewer_teacher_id', 'sources', 'tags', 'is_published', 'published_at', 'seo_title', 'meta_description', 'focus_keyword', 'pillar_slug', 'cover_alt'],
  partners: ['name', 'logo_url', 'partner_type', 'description', 'website_url', 'sort_order', 'is_published'],
  modules: ['name', 'ssd', 'cfu', 'hours', 'description', 'sort_order', 'course_id', 'is_published'],
  lessons: ['title', 'module_id', 'teacher_id', 'external_teacher_name', 'start_datetime', 'duration_minutes', 'location_physical', 'location_remote', 'status', 'notes', 'materials'],
  courses: ['title', 'slug', 'description', 'cover_image_url', 'is_published'],
  course_editions: ['edition_name', 'course_id', 'start_date', 'end_date', 'max_students', 'is_active'],
  lms_lessons: ['lms_module_id', 'title', 'description', 'video_url', 'video_provider', 'duration_seconds', 'sort_order', 'is_free', 'is_published', 'materials', 'calendar_lesson_id'],
  quizzes: ['title', 'description', 'passing_score', 'max_attempts', 'time_limit_minutes', 'is_published'],
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
      SELECT id, name, role, email, bio, photo_url AS "photoUrl", profile_link AS "profileLink", sort_order AS "sortOrder", is_published AS "isPublished", can_view_all_materials AS "canViewAllMaterials", band, is_pro_bono AS "isProBono"
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

  const { name, role, email, bio, photoUrl, profileLink, sortOrder, isPublished, canViewAllMaterials, band, isProBono } = req.body;
  const normalizedEmail = normalizeEmail(email);

  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }

  // Normalizza URL della foto (converte GitHub blob in raw)
  const normalizedPhotoUrl = normalizeImageUrl(photoUrl);
  const normalizedBand = typeof band === 'string' ? band.trim() : '';

  try {
    if (normalizedEmail) {
      const { rows: existingFaculty } = await pool.query(
        'SELECT id, name FROM faculty WHERE LOWER(email) = LOWER($1) LIMIT 1',
        [normalizedEmail]
      );

      if (existingFaculty.length) {
        return res.status(409).json({
          error: 'Email gia associata a un altro docente',
          facultyId: existingFaculty[0].id,
          facultyName: existingFaculty[0].name
        });
      }
    }

    const id = uuidv4();
    const insert = `
      INSERT INTO faculty (id, name, role, email, bio, photo_url, profile_link, sort_order, is_published, can_view_all_materials, band, is_pro_bono)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id, name, role, email, bio, photo_url AS "photoUrl", profile_link AS "profileLink", sort_order AS "sortOrder", is_published AS "isPublished", can_view_all_materials AS "canViewAllMaterials", band, is_pro_bono AS "isProBono"
    `;
    const values = [
      id,
      name,
      role || null,
      normalizedEmail,
      bio || null,
      normalizedPhotoUrl || null,
      profileLink || null,
      typeof sortOrder === 'number' ? sortOrder : null,
      Boolean(isPublished),
      Boolean(canViewAllMaterials),
      normalizedBand || null,
      Boolean(isProBono)
    ];

    const { rows } = await pool.query(insert, values);
    res.status(201).json(rows[0]);
  } catch (error) {
    if (isFacultyEmailUniqueViolation(error)) {
      return res.status(409).json({ error: 'Email gia associata a un altro docente' });
    }

    console.error('Error creating faculty', error);
    res.status(500).json({ error: 'Unable to create faculty member' });
  }
});

app.put('/api/faculty/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) {
    return;
  }

  const { id } = req.params;
  const { name, role, email, bio, photoUrl, profileLink, sortOrder, isPublished, canViewAllMaterials, can_view_all_materials, band, isProBono } = req.body;
  const normalizedEmail = email === undefined ? undefined : normalizeEmail(email);

  // Normalizza URL della foto (converte GitHub blob in raw)
  const normalizedPhotoUrl = photoUrl !== undefined ? normalizeImageUrl(photoUrl) : undefined;
  const normalizedBand = band === undefined
    ? undefined
    : (typeof band === 'string' && band.trim() ? band.trim() : null);

  try {
    if (normalizedEmail) {
      const { rows: existingFaculty } = await pool.query(
        'SELECT id, name FROM faculty WHERE LOWER(email) = LOWER($1) AND id <> $2 LIMIT 1',
        [normalizedEmail, id]
      );

      if (existingFaculty.length) {
        return res.status(409).json({
          error: 'Email gia associata a un altro docente',
          facultyId: existingFaculty[0].id,
          facultyName: existingFaculty[0].name
        });
      }
    }

    const updateFields = {
      name,
      role,
      email: normalizedEmail,
      bio,
      photo_url: normalizedPhotoUrl,
      profile_link: profileLink,
      sort_order: sortOrder,
      is_published: typeof isPublished === 'boolean' ? isPublished : undefined,
      can_view_all_materials: typeof canViewAllMaterials === 'boolean'
        ? canViewAllMaterials
        : (typeof can_view_all_materials === 'boolean' ? can_view_all_materials : undefined),
      band: normalizedBand,
      is_pro_bono: typeof isProBono === 'boolean' ? isProBono : undefined
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
      email: row.email,
      bio: row.bio,
      photoUrl: row.photo_url,
      profileLink: row.profile_link,
      sortOrder: row.sort_order,
      isPublished: row.is_published,
      canViewAllMaterials: row.can_view_all_materials,
      band: row.band,
      isProBono: row.is_pro_bono
    });
  } catch (error) {
    if (isFacultyEmailUniqueViolation(error)) {
      return res.status(409).json({ error: 'Email gia associata a un altro docente' });
    }

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

function buildFacultyOverviewRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    email: row.email,
    bio: row.bio,
    photoUrl: row.photoUrl,
    profileLink: row.profileLink,
    sortOrder: row.sortOrder,
    isPublished: Boolean(row.isPublished),
    isActive: Boolean(row.isActive),
    canViewAllMaterials: Boolean(row.canViewAllMaterials),
    band: row.band || null,
    isProBono: Boolean(row.isProBono),
    appointmentReceived: Boolean(row.appointmentReceived),
    releaseSigned: Boolean(row.releaseSigned),
    lessonHours: Number(row.lessonHours || 0),
    completedLessonHours: Number(row.completedLessonHours || 0),
    totalLessons: Number(row.totalLessons || 0),
    completedLessons: Number(row.completedLessons || 0),
    totalModules: Number(row.totalModules || 0),
    isFinished: Boolean(row.isFinished),
    appointmentReceivedManual: row.appointmentReceivedManual === null ? null : Boolean(row.appointmentReceivedManual),
    receivedHours: row.receivedHours === null || row.receivedHours === undefined ? null : Number(row.receivedHours),
    notes: row.notes || '',
    documents: Array.isArray(row.documents) ? row.documents : [],
    modules: Array.isArray(row.modules) ? row.modules : [],
    lessons: Array.isArray(row.lessons) ? row.lessons : []
  };
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

app.patch('/api/admin/faculty-overview/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) {
    return;
  }

  try {
    const facultyId = req.params.id;
    const appointmentReceivedManual = req.body?.appointmentReceivedManual;
    const receivedHours = req.body?.receivedHours;
    const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : '';
    const bandProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'band');
    const proBonoProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'isProBono');

    if (bandProvided || proBonoProvided) {
      const facultyFields = {};
      if (bandProvided) {
        const raw = req.body.band;
        facultyFields.band = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
      }
      if (proBonoProvided) {
        facultyFields.is_pro_bono = Boolean(req.body.isProBono);
      }
      const { query, values } = buildUpdateQuery('faculty', facultyFields, facultyId);
      const facultyUpdate = await pool.query(query, values);
      if (!facultyUpdate.rows.length) {
        return res.status(404).json({ error: 'Faculty member not found' });
      }
    }

    const { rows } = await pool.query(`
      INSERT INTO faculty_overview_overrides (faculty_id, appointment_received_manual, received_hours, notes, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (faculty_id)
      DO UPDATE SET
        appointment_received_manual = EXCLUDED.appointment_received_manual,
        received_hours = EXCLUDED.received_hours,
        notes = EXCLUDED.notes,
        updated_at = NOW()
      RETURNING faculty_id, appointment_received_manual AS "appointmentReceivedManual", received_hours AS "receivedHours", notes
    `, [
      facultyId,
      appointmentReceivedManual === null || appointmentReceivedManual === undefined ? null : Boolean(appointmentReceivedManual),
      receivedHours === '' || receivedHours === null || receivedHours === undefined ? null : Number(receivedHours),
      notes || null
    ]);

    const { rows: facultyRows } = await pool.query(
      'SELECT band, is_pro_bono AS "isProBono" FROM faculty WHERE id = $1',
      [facultyId]
    );
    const merged = {
      ...(rows[0] || { faculty_id: facultyId }),
      band: facultyRows[0]?.band || null,
      isProBono: Boolean(facultyRows[0]?.isProBono)
    };
    res.json(merged);
  } catch (error) {
    console.error('Update faculty overview override error', error);
    res.status(500).json({ error: 'Unable to update faculty overview' });
  }
});

app.get('/api/admin/faculty-overview', requireAdmin, async (_req, res) => {
  if (!ensurePool(res)) {
    return;
  }

  try {
    const { rows } = await pool.query(`
      WITH lesson_stats AS (
        SELECT
          l.teacher_id AS faculty_id,
          COUNT(*)::int AS total_lessons,
          COUNT(*) FILTER (WHERE COALESCE(l.status, 'draft') = 'completed')::int AS completed_lessons,
          ROUND(COALESCE(SUM(COALESCE(l.duration_minutes, 0)), 0)::numeric / 60.0, 1) AS lesson_hours,
          ROUND(COALESCE(SUM(COALESCE(l.duration_minutes, 0)) FILTER (WHERE COALESCE(l.status, 'draft') = 'completed'), 0)::numeric / 60.0, 1) AS completed_lesson_hours,
          COUNT(DISTINCT m.id)::int AS total_modules,
          COALESCE(
            (
              SELECT JSONB_AGG(module_item ORDER BY module_name)
              FROM (
                SELECT DISTINCT m2.id, m2.name AS module_name, JSONB_BUILD_OBJECT('id', m2.id, 'name', m2.name) AS module_item
                FROM lessons l2
                LEFT JOIN modules m2 ON m2.id = l2.module_id
                WHERE l2.teacher_id = l.teacher_id AND m2.id IS NOT NULL
              ) module_rows
            ),
            '[]'::jsonb
          ) AS modules,
          COALESCE(
            (
              SELECT JSONB_AGG(lesson_item ORDER BY start_datetime DESC)
              FROM (
                SELECT
                  l2.start_datetime,
                  JSONB_BUILD_OBJECT(
                    'id', l2.id,
                    'title', l2.title,
                    'moduleId', m2.id,
                    'moduleName', m2.name,
                    'startDatetime', l2.start_datetime,
                    'status', l2.status,
                    'durationMinutes', l2.duration_minutes
                  ) AS lesson_item
                FROM lessons l2
                LEFT JOIN modules m2 ON m2.id = l2.module_id
                WHERE l2.teacher_id = l.teacher_id
              ) lesson_rows
            ),
            '[]'::jsonb
          ) AS lessons
        FROM lessons l
        LEFT JOIN modules m ON m.id = l.module_id
        WHERE l.teacher_id IS NOT NULL
        GROUP BY l.teacher_id
      ),
      document_signatures AS (
        SELECT
          document_id,
          COUNT(*)::int AS signature_count,
          COUNT(*) FILTER (WHERE consent_given)::int AS consent_count
        FROM teacher_document_signatures
        GROUP BY document_id
      ),
      document_stats AS (
        SELECT
          td.faculty_id,
          BOOL_OR(
            (
              LOWER(COALESCE(td.type, '')) LIKE '%incarico%'
              OR LOWER(COALESCE(td.title, '')) LIKE '%incarico%'
            )
            AND COALESCE(ds.signature_count, 0) > 0
          ) AS appointment_received,
          BOOL_OR(
            (
              LOWER(COALESCE(td.type, '')) LIKE '%liberatoria%'
              OR LOWER(COALESCE(td.type, '')) LIKE '%release%'
              OR LOWER(COALESCE(td.title, '')) LIKE '%liberatoria%'
              OR LOWER(COALESCE(td.title, '')) LIKE '%release%'
            )
            AND COALESCE(ds.signature_count, 0) > 0
          ) AS release_signed,
          COALESCE(
            JSONB_AGG(
              JSONB_BUILD_OBJECT(
                'id', td.id,
                'title', td.title,
                'type', td.type,
                'signatureCount', COALESCE(ds.signature_count, 0),
                'consentCount', COALESCE(ds.consent_count, 0)
              )
              ORDER BY td.created_at DESC
            ) FILTER (WHERE td.id IS NOT NULL),
            '[]'::jsonb
          ) AS documents
        FROM teacher_documents td
        LEFT JOIN document_signatures ds ON ds.document_id = td.id
        WHERE td.faculty_id IS NOT NULL
        GROUP BY td.faculty_id
      ),
      override_stats AS (
        SELECT
          faculty_id,
          appointment_received_manual AS "appointmentReceivedManual",
          received_hours AS "receivedHours",
          notes
        FROM faculty_overview_overrides
      )
      SELECT
        f.id,
        f.name,
        f.role,
        f.email,
        f.bio,
        f.photo_url AS "photoUrl",
        f.profile_link AS "profileLink",
        f.sort_order AS "sortOrder",
        f.is_published AS "isPublished",
        f.is_active AS "isActive",
        f.can_view_all_materials AS "canViewAllMaterials",
        f.band,
        f.is_pro_bono AS "isProBono",
        COALESCE(ls.total_lessons, 0) AS "totalLessons",
        COALESCE(ls.completed_lessons, 0) AS "completedLessons",
        COALESCE(ls.lesson_hours, 0) AS "lessonHours",
        COALESCE(ls.completed_lesson_hours, 0) AS "completedLessonHours",
        COALESCE(ls.total_modules, 0) AS "totalModules",
        COALESCE(ls.modules, '[]'::jsonb) AS modules,
        COALESCE(ls.lessons, '[]'::jsonb) AS lessons,
        os."appointmentReceivedManual",
        os."receivedHours",
        os.notes,
        COALESCE(ds.appointment_received, false) AS "appointmentReceived",
        COALESCE(ds.release_signed, false) AS "releaseSigned",
        COALESCE(ds.documents, '[]'::jsonb) AS documents,
        (COALESCE(ls.total_lessons, 0) > 0 AND COALESCE(ls.completed_lessons, 0) = COALESCE(ls.total_lessons, 0)) AS "isFinished"
      FROM faculty f
      LEFT JOIN lesson_stats ls ON ls.faculty_id = f.id
      LEFT JOIN document_stats ds ON ds.faculty_id = f.id
      LEFT JOIN override_stats os ON os.faculty_id = f.id
      ORDER BY f.sort_order NULLS LAST, f.created_at ASC
    `);

    res.json(rows.map(buildFacultyOverviewRow));
  } catch (error) {
    console.error('Error fetching faculty overview', error);
    res.status(500).json({ error: 'Unable to retrieve faculty overview' });
  }
});

app.get('/api/admin/faculty-overview.csv', requireAdmin, async (_req, res) => {
  if (!ensurePool(res)) {
    return;
  }

  try {
    const { rows } = await pool.query(`
      WITH lesson_stats AS (
        SELECT
          l.teacher_id AS faculty_id,
          COUNT(*)::int AS total_lessons,
          COUNT(*) FILTER (WHERE COALESCE(l.status, 'draft') = 'completed')::int AS completed_lessons,
          ROUND(COALESCE(SUM(COALESCE(l.duration_minutes, 0)), 0)::numeric / 60.0, 1) AS lesson_hours,
          ROUND(COALESCE(SUM(COALESCE(l.duration_minutes, 0)) FILTER (WHERE COALESCE(l.status, 'draft') = 'completed'), 0)::numeric / 60.0, 1) AS completed_lesson_hours,
          COUNT(DISTINCT m.id)::int AS total_modules,
          COALESCE(
            (
              SELECT JSONB_AGG(module_item ORDER BY module_name)
              FROM (
                SELECT DISTINCT m2.id, m2.name AS module_name, JSONB_BUILD_OBJECT('id', m2.id, 'name', m2.name) AS module_item
                FROM lessons l2
                LEFT JOIN modules m2 ON m2.id = l2.module_id
                WHERE l2.teacher_id = l.teacher_id AND m2.id IS NOT NULL
              ) module_rows
            ),
            '[]'::jsonb
          ) AS modules,
          COALESCE(
            (
              SELECT JSONB_AGG(lesson_item ORDER BY start_datetime DESC)
              FROM (
                SELECT
                  l2.start_datetime,
                  JSONB_BUILD_OBJECT(
                    'id', l2.id,
                    'title', l2.title,
                    'moduleId', m2.id,
                    'moduleName', m2.name,
                    'startDatetime', l2.start_datetime,
                    'status', l2.status,
                    'durationMinutes', l2.duration_minutes
                  ) AS lesson_item
                FROM lessons l2
                LEFT JOIN modules m2 ON m2.id = l2.module_id
                WHERE l2.teacher_id = l.teacher_id
              ) lesson_rows
            ),
            '[]'::jsonb
          ) AS lessons
        FROM lessons l
        LEFT JOIN modules m ON m.id = l.module_id
        WHERE l.teacher_id IS NOT NULL
        GROUP BY l.teacher_id
      ),
      document_signatures AS (
        SELECT
          document_id,
          COUNT(*)::int AS signature_count,
          COUNT(*) FILTER (WHERE consent_given)::int AS consent_count
        FROM teacher_document_signatures
        GROUP BY document_id
      ),
      document_stats AS (
        SELECT
          td.faculty_id,
          BOOL_OR(
            (
              LOWER(COALESCE(td.type, '')) LIKE '%incarico%'
              OR LOWER(COALESCE(td.title, '')) LIKE '%incarico%'
            )
            AND COALESCE(ds.signature_count, 0) > 0
          ) AS appointment_received,
          BOOL_OR(
            (
              LOWER(COALESCE(td.type, '')) LIKE '%liberatoria%'
              OR LOWER(COALESCE(td.type, '')) LIKE '%release%'
              OR LOWER(COALESCE(td.title, '')) LIKE '%liberatoria%'
              OR LOWER(COALESCE(td.title, '')) LIKE '%release%'
            )
            AND COALESCE(ds.signature_count, 0) > 0
          ) AS release_signed,
          COALESCE(
            JSONB_AGG(
              JSONB_BUILD_OBJECT(
                'id', td.id,
                'title', td.title,
                'type', td.type,
                'signatureCount', COALESCE(ds.signature_count, 0),
                'consentCount', COALESCE(ds.consent_count, 0)
              )
              ORDER BY td.created_at DESC
            ) FILTER (WHERE td.id IS NOT NULL),
            '[]'::jsonb
          ) AS documents
        FROM teacher_documents td
        LEFT JOIN document_signatures ds ON ds.document_id = td.id
        WHERE td.faculty_id IS NOT NULL
        GROUP BY td.faculty_id
      ),
      override_stats AS (
        SELECT
          faculty_id,
          appointment_received_manual AS "appointmentReceivedManual",
          received_hours AS "receivedHours",
          notes
        FROM faculty_overview_overrides
      )
      SELECT
        f.id,
        f.name,
        f.role,
        f.email,
        f.bio,
        f.photo_url AS "photoUrl",
        f.profile_link AS "profileLink",
        f.sort_order AS "sortOrder",
        f.is_published AS "isPublished",
        f.is_active AS "isActive",
        f.can_view_all_materials AS "canViewAllMaterials",
        f.band,
        f.is_pro_bono AS "isProBono",
        COALESCE(ls.total_lessons, 0) AS "totalLessons",
        COALESCE(ls.completed_lessons, 0) AS "completedLessons",
        COALESCE(ls.lesson_hours, 0) AS "lessonHours",
        COALESCE(ls.completed_lesson_hours, 0) AS "completedLessonHours",
        COALESCE(ls.total_modules, 0) AS "totalModules",
        COALESCE(ls.modules, '[]'::jsonb) AS modules,
        COALESCE(ls.lessons, '[]'::jsonb) AS lessons,
        os."appointmentReceivedManual",
        os."receivedHours",
        os.notes,
        COALESCE(ds.appointment_received, false) AS "appointmentReceived",
        COALESCE(ds.release_signed, false) AS "releaseSigned",
        COALESCE(ds.documents, '[]'::jsonb) AS documents
      FROM faculty f
      LEFT JOIN lesson_stats ls ON ls.faculty_id = f.id
      LEFT JOIN document_stats ds ON ds.faculty_id = f.id
      LEFT JOIN override_stats os ON os.faculty_id = f.id
      ORDER BY f.sort_order NULLS LAST, f.created_at ASC
    `);

    let csv = 'nome,ruolo,fascia,titolo_gratuito,email,visibile,attivo,accesso_materiali,incarico_manual,ore_ricevute,ore_totali,ore_completate,lezioni_totali,lezioni_completate,moduli_totali,liberatoria_firmata,documenti_count,moduli,lezioni,note\n';
    rows.map(buildFacultyOverviewRow).forEach((row) => {
      csv += [
        csvEscape(row.name),
        csvEscape(row.role),
        csvEscape(row.band || ''),
        csvEscape(row.isProBono ? 'SI' : 'NO'),
        csvEscape(row.email),
        csvEscape(row.isPublished ? 'SI' : 'NO'),
        csvEscape(row.isActive ? 'SI' : 'NO'),
        csvEscape(row.canViewAllMaterials ? 'SI' : 'NO'),
        csvEscape(row.appointmentReceivedManual === null ? '' : (row.appointmentReceivedManual ? 'SI' : 'NO')),
        csvEscape(row.receivedHours ?? ''),
        csvEscape(row.lessonHours),
        csvEscape(row.completedLessonHours),
        csvEscape(row.totalLessons),
        csvEscape(row.completedLessons),
        csvEscape(row.totalModules),
        csvEscape(row.releaseSigned ? 'SI' : 'NO'),
        csvEscape(Array.isArray(row.documents) ? row.documents.length : 0),
        csvEscape(JSON.stringify(row.modules || [])),
        csvEscape(JSON.stringify(row.lessons || [])),
        csvEscape(row.notes || '')
      ].join(',') + '\n';
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="faculty_overview.csv"');
    res.send('\uFEFF' + csv);
  } catch (error) {
    console.error('Export faculty overview csv error', error);
    res.status(500).json({ error: 'Unable to export faculty overview' });
  }
});

app.get('/api/admin/lessons.csv', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) {
    return;
  }

  try {
    const { module_id, teacher_id, status, month, year } = req.query;
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
      filters.push(`EXTRACT(MONTH FROM l.start_datetime AT TIME ZONE 'Europe/Rome') = $${filters.length + 1}`);
      values.push(parseInt(month, 10));
      filters.push(`EXTRACT(YEAR FROM l.start_datetime AT TIME ZONE 'Europe/Rome') = $${filters.length + 1}`);
      values.push(parseInt(year, 10));
    } else if (year) {
      filters.push(`EXTRACT(YEAR FROM l.start_datetime AT TIME ZONE 'Europe/Rome') = $${filters.length + 1}`);
      values.push(parseInt(year, 10));
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const { rows } = await pool.query(`
      SELECT
        l.id,
        TO_CHAR(l.start_datetime AT TIME ZONE 'Europe/Rome', 'YYYY-MM-DD') AS start_date,
        TO_CHAR(l.start_datetime AT TIME ZONE 'Europe/Rome', 'HH24:MI') AS start_time,
        TO_CHAR(
          COALESCE(l.end_datetime, l.start_datetime + (COALESCE(l.duration_minutes, 0) || ' minutes')::interval)
            AT TIME ZONE 'Europe/Rome',
          'HH24:MI'
        ) AS end_time,
        COALESCE(l.duration_minutes, 0) AS duration_minutes,
        l.title,
        COALESCE(l.description, '') AS description,
        COALESCE(l.status, 'draft') AS status,
        COALESCE(l.location_physical, '') AS location_physical,
        COALESCE(l.location_remote, '') AS location_remote,
        COALESCE(l.notes, '') AS notes,
        m.id AS module_id,
        COALESCE(m.name, '') AS module_name,
        COALESCE(m.ssd, '') AS module_ssd,
        COALESCE(m.cfu, 0) AS module_cfu,
        f.id AS teacher_id,
        COALESCE(f.name, '') AS teacher_name,
        COALESCE(f.email, '') AS teacher_email,
        COALESCE(f.role, '') AS teacher_role,
        COALESCE(f.band, '') AS teacher_band,
        COALESCE(f.is_pro_bono, FALSE) AS teacher_pro_bono,
        COALESCE(l.external_teacher_name, '') AS external_teacher_name,
        COALESCE(JSONB_ARRAY_LENGTH(l.materials), 0) AS materials_count,
        TO_CHAR(l.created_at AT TIME ZONE 'Europe/Rome', 'YYYY-MM-DD HH24:MI') AS created_at,
        TO_CHAR(l.updated_at AT TIME ZONE 'Europe/Rome', 'YYYY-MM-DD HH24:MI') AS updated_at
      FROM lessons l
      LEFT JOIN modules m ON m.id = l.module_id
      LEFT JOIN faculty f ON f.id = l.teacher_id
      ${where}
      ORDER BY l.start_datetime ASC
    `, values);

    const header = [
      'id',
      'data',
      'ora_inizio',
      'ora_fine',
      'durata_min',
      'titolo',
      'descrizione',
      'stato',
      'aula_fisica',
      'link_streaming',
      'note',
      'modulo_id',
      'modulo_nome',
      'modulo_ssd',
      'modulo_cfu',
      'docente_id',
      'docente_nome',
      'docente_email',
      'docente_ruolo',
      'docente_fascia',
      'docente_titolo_gratuito',
      'docente_esterno',
      'materiali_count',
      'creata_il',
      'aggiornata_il'
    ].join(',') + '\n';

    const body = rows.map((row) => [
      csvEscape(row.id),
      csvEscape(row.start_date),
      csvEscape(row.start_time),
      csvEscape(row.end_time),
      csvEscape(row.duration_minutes),
      csvEscape(row.title),
      csvEscape(row.description),
      csvEscape(row.status),
      csvEscape(row.location_physical),
      csvEscape(row.location_remote),
      csvEscape(row.notes),
      csvEscape(row.module_id || ''),
      csvEscape(row.module_name),
      csvEscape(row.module_ssd),
      csvEscape(row.module_cfu),
      csvEscape(row.teacher_id || ''),
      csvEscape(row.teacher_name),
      csvEscape(row.teacher_email),
      csvEscape(row.teacher_role),
      csvEscape(row.teacher_band),
      csvEscape(row.teacher_pro_bono ? 'SI' : 'NO'),
      csvEscape(row.external_teacher_name),
      csvEscape(row.materials_count),
      csvEscape(row.created_at || ''),
      csvEscape(row.updated_at || '')
    ].join(',')).join('\n') + (rows.length ? '\n' : '');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="lezioni_calendario.csv"');
    res.send('\uFEFF' + header + body);
  } catch (error) {
    console.error('Export lessons csv error', error);
    res.status(500).json({ error: 'Unable to export lessons' });
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

  const { title, slug, excerpt, content, coverImageUrl, publishedAt, isPublished, author, sourceModule, coverImagePrompt, reviewerTeacherId, sources, tags, seoTitle, metaDescription, focusKeyword, pillarSlug, coverAlt } = req.body;

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
      tags,
      seoTitle,
      metaDescription,
      focusKeyword,
      pillarSlug,
      coverAlt
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
  const { title, slug, excerpt, content, coverImageUrl, publishedAt, isPublished, author, sourceModule, coverImagePrompt, reviewerTeacherId, sources, tags, seoTitle, metaDescription, focusKeyword, pillarSlug, coverAlt } = req.body;

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
      is_published: typeof isPublished === 'boolean' ? isPublished : undefined,
      seo_title: seoTitle,
      meta_description: metaDescription,
      focus_keyword: focusKeyword,
      pillar_slug: pillarSlug,
      cover_alt: coverAlt
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

// Static-ish list of high-priority public pages of the marketing site. Keep in
// sync with the actual files served at the root of the project.
const SITEMAP_STATIC_PAGES = [
  { path: '/', priority: '1.0', changefreq: 'weekly' },
  { path: '/blog.html', priority: '0.9', changefreq: 'daily' },
  { path: '/calendario.html', priority: '0.7', changefreq: 'weekly' },
  { path: '/iscrizioni.html', priority: '0.8', changefreq: 'weekly' },
  { path: '/sponsorship.html', priority: '0.5', changefreq: 'monthly' },
  { path: '/faq.html', priority: '0.5', changefreq: 'monthly' },
  { path: '/richiedi-informazioni.html', priority: '0.5', changefreq: 'monthly' }
];

function buildSitemapXml(entries) {
  const items = entries.map((e) => `  <url>
    <loc>${escapeHtml(e.loc)}</loc>${e.lastmod ? `\n    <lastmod>${escapeHtml(e.lastmod)}</lastmod>` : ''}${e.changefreq ? `\n    <changefreq>${escapeHtml(e.changefreq)}</changefreq>` : ''}${e.priority ? `\n    <priority>${escapeHtml(e.priority)}</priority>` : ''}
  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${items}
</urlset>
`;
}

async function buildSitemapEntries(baseUrl) {
  const entries = [];
  const now = new Date().toISOString();

  for (const page of SITEMAP_STATIC_PAGES) {
    entries.push({
      loc: new URL(page.path, baseUrl).toString(),
      lastmod: now.slice(0, 10),
      changefreq: page.changefreq,
      priority: page.priority
    });
  }

  if (pool) {
    try {
      const { rows } = await pool.query(
        'SELECT slug, updated_at, published_at FROM blog_posts WHERE is_published = true AND slug IS NOT NULL ORDER BY published_at DESC NULLS LAST LIMIT 5000'
      );
      for (const row of rows) {
        const lastmodSource = row.updated_at || row.published_at;
        entries.push({
          loc: new URL(`/share/blog/${encodeURIComponent(row.slug)}`, baseUrl).toString(),
          lastmod: lastmodSource ? new Date(lastmodSource).toISOString().slice(0, 10) : now.slice(0, 10),
          changefreq: 'monthly',
          priority: '0.7'
        });
      }
    } catch (error) {
      console.error('Sitemap: unable to read blog_posts', error);
    }
  }

  return entries;
}

app.get(['/sitemap.xml', '/sitemap'], async (req, res) => {
  try {
    const baseUrl = getPublicBaseUrl(req);
    const entries = await buildSitemapEntries(baseUrl);
    const xml = buildSitemapXml(entries);
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=600, s-maxage=600');
    res.send(xml);
  } catch (error) {
    console.error('Error generating sitemap', error);
    res.status(500).send('Sitemap generation failed');
  }
});

// IndexNow proof-of-ownership: Bing/Yandex fetch /{KEY}.txt and expect the body
// to contain exactly the key. We serve dynamically from the env var so no key
// is committed to git. Set INDEXNOW_KEY on Vercel to any 8-128 hex chars
// (e.g. `openssl rand -hex 16`).
app.get(/^\/[a-f0-9]{8,128}\.txt$/, (req, res, next) => {
  const indexNowKey = process.env.INDEXNOW_KEY || '';
  if (!indexNowKey) return next();
  const requestedKey = req.path.replace(/^\//, '').replace(/\.txt$/, '');
  if (requestedKey !== indexNowKey) return next();
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(indexNowKey);
});

app.get('/robots.txt', (req, res) => {
  const baseUrl = getPublicBaseUrl(req);
  const sitemapUrl = new URL('/sitemap.xml', baseUrl).toString();
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');
  res.send(`User-agent: *
Allow: /
Disallow: /admin/
Disallow: /api/
Disallow: /learn/
Disallow: /teachers/

Sitemap: ${sitemapUrl}
`);
});

// SEO pings: rebuild sitemap (no-op cache buster) + IndexNow notification for
// fast URL discovery by Bing, Yandex and the IndexNow consortium (Google does
// not consume IndexNow; for Google we rely on the sitemap + organic crawl).
app.post('/api/seo/sitemap-rebuild', requireAdmin, async (req, res) => {
  try {
    const baseUrl = getPublicBaseUrl(req);
    const entries = await buildSitemapEntries(baseUrl);
    res.json({
      ok: true,
      urls: entries.length,
      sitemap: new URL('/sitemap.xml', baseUrl).toString(),
      note: 'Sitemap is regenerated on every request from the DB; this endpoint just verifies the build succeeds.'
    });
  } catch (error) {
    console.error('Sitemap rebuild failed', error);
    res.status(500).json({ error: 'Sitemap rebuild failed' });
  }
});

app.post('/api/seo/indexnow', requireAdmin, async (req, res) => {
  try {
    const baseUrl = getPublicBaseUrl(req);
    const indexNowKey = process.env.INDEXNOW_KEY || '';
    const urls = Array.isArray(req.body && req.body.urls) && req.body.urls.length
      ? req.body.urls
      : null;

    if (!urls) {
      return res.status(400).json({ error: 'Missing "urls" array in body' });
    }

    if (!indexNowKey) {
      return res.json({
        ok: false,
        skipped: true,
        urls: urls.length,
        note: 'INDEXNOW_KEY env var not set. Configure it on Vercel and expose /<key>.txt with the key content to enable Bing/Yandex IndexNow pings.'
      });
    }

    const host = new URL(baseUrl).host;
    const payload = {
      host,
      key: indexNowKey,
      keyLocation: `${baseUrl.replace(/\/$/, '')}/${indexNowKey}.txt`,
      urlList: urls
    };

    const upstream = await fetch('https://api.indexnow.org/IndexNow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    res.json({
      ok: upstream.ok,
      status: upstream.status,
      urls: urls.length,
      indexNowHost: host
    });
  } catch (error) {
    console.error('IndexNow ping failed', error);
    res.status(500).json({ error: 'IndexNow ping failed' });
  }
});

app.get('/share/blog/:slug', async (req, res) => {
  if (!ensurePool(res)) {
    return;
  }

  try {
    const blogColumns = await getTableColumns('blog_posts');
    const { rows } = await pool.query(
      'SELECT * FROM blog_posts WHERE slug = $1 AND is_published = true LIMIT 1',
      [req.params.slug]
    );

    if (!rows.length) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html lang="it">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Articolo non trovato - Master in Carbon Farming</title>
          <style>
            body { font-family: Inter, system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: linear-gradient(135deg, #f3f7ef, #eef6ea); color: #1f2937; }
            .card { max-width: 520px; padding: 36px; border-radius: 24px; background: white; box-shadow: 0 22px 60px rgba(31,41,55,0.12); text-align: center; }
            h1 { margin: 0 0 12px; font-size: 1.8rem; color: #2d5016; }
            p { margin: 0 0 20px; color: #4b5563; line-height: 1.6; }
            a { display: inline-flex; align-items: center; justify-content: center; padding: 12px 20px; border-radius: 999px; background: #7AB928; color: white; text-decoration: none; font-weight: 700; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Articolo non trovato</h1>
            <p>Il contenuto richiesto non è disponibile oppure non è ancora pubblicato.</p>
            <a href="/blog.html">Vai al blog</a>
          </div>
        </body>
        </html>
      `);
    }

    const post = buildBlogPostPayload(rows[0], blogColumns);
    const baseUrl = getPublicBaseUrl(req);
    const sharePageUrl = new URL(`/share/blog/${encodeURIComponent(post.slug)}`, baseUrl).toString();
    const articleUrl = new URL(`/blog.html#${encodeURIComponent(post.slug)}`, baseUrl).toString();
    const coverImageUrl = resolveAbsoluteUrl(post.coverImageUrl, baseUrl);
    const excerpt = truncateText(post.excerpt || post.content || 'Leggi l\'articolo pubblicato dal Master in Carbon Farming.');
    const title = post.title || 'Articolo blog';

    // SEO-optimized meta tags: prefer dedicated SEO fields when present, fall
    // back to editorial title / excerpt / title-as-alt for legacy posts.
    const seoTitleRaw = (post.seoTitle && post.seoTitle.trim()) || title;
    // If the editor already appended a brand suffix, don't double-append it.
    const seoTitleHasBrand = /master.*carbon.*farming/i.test(seoTitleRaw);
    const seoTitleFull = seoTitleHasBrand ? seoTitleRaw : `${seoTitleRaw} - Master in Carbon Farming`;
    const metaDescriptionRaw = (post.metaDescription && post.metaDescription.trim()) || excerpt;
    const coverAltRaw = (post.coverAlt && post.coverAlt.trim()) || title;
    const focusKeywordRaw = (post.focusKeyword && post.focusKeyword.trim()) || '';
    const articlePublishedTime = post.publishedAt ? new Date(post.publishedAt).toISOString() : '';
    const authorName = (post.author && post.author.trim()) || 'Redazione Master Carbon Farming';

    // gpt-image-1 covers are generated at 1536x1024 (env-tunable). Hard-code
    // those dimensions in og:image tags so social scrapers (Facebook/LinkedIn)
    // don't have to fetch the image just to learn its size. Stops the FB
    // Debugger warning "Le proprietà og:image fornite non sono ancora
    // disponibili perché le nuove immagini vengono elaborate in modo asincrono".
    const coverWidth = process.env.OPENAI_IMAGE_WIDTH || '1536';
    const coverHeight = process.env.OPENAI_IMAGE_HEIGHT || '1024';
    const ogImageTags = coverImageUrl ? `
      <meta property="og:image" content="${escapeHtml(coverImageUrl)}">
      <meta property="og:image:secure_url" content="${escapeHtml(coverImageUrl)}">
      <meta property="og:image:type" content="image/png">
      <meta property="og:image:width" content="${escapeHtml(coverWidth)}">
      <meta property="og:image:height" content="${escapeHtml(coverHeight)}">
      <meta property="og:image:alt" content="${escapeHtml(coverAltRaw)}">
      <meta name="twitter:image" content="${escapeHtml(coverImageUrl)}">
      <meta name="twitter:image:alt" content="${escapeHtml(coverAltRaw)}">
    ` : '';

    // Schema.org Article JSON-LD: unlocks Google rich snippets (article badge,
    // publish date, author and large thumbnail in search results).
    const articleModifiedTime = post.publishedAt
      ? new Date(post.publishedAt).toISOString()
      : articlePublishedTime;
    const logoUrl = new URL('/assets/img/logo-tuscia.png', baseUrl).toString();
    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'NewsArticle',
      mainEntityOfPage: { '@type': 'WebPage', '@id': sharePageUrl },
      headline: (seoTitleRaw || title).slice(0, 110),
      description: metaDescriptionRaw,
      ...(coverImageUrl ? {
        image: [{
          '@type': 'ImageObject',
          url: coverImageUrl,
          width: Number(coverWidth),
          height: Number(coverHeight)
        }]
      } : {}),
      ...(articlePublishedTime ? { datePublished: articlePublishedTime } : {}),
      ...(articleModifiedTime ? { dateModified: articleModifiedTime } : {}),
      author: { '@type': 'Organization', name: authorName },
      publisher: {
        '@type': 'Organization',
        name: 'Master in Carbon Farming - Università della Tuscia',
        logo: { '@type': 'ImageObject', url: logoUrl }
      },
      ...(focusKeywordRaw ? { keywords: focusKeywordRaw } : {}),
      inLanguage: 'it-IT'
    };
    // Use a JSON serializer that closes </script> safely.
    const jsonLdText = JSON.stringify(jsonLd).replace(/</g, '\\u003c');
    const jsonLdTag = `<script type="application/ld+json">${jsonLdText}</script>`;
    const keywordsTag = focusKeywordRaw ? `<meta name="keywords" content="${escapeHtml(focusKeywordRaw)}">` : '';
    const publishedTimeTag = articlePublishedTime ? `<meta property="article:published_time" content="${escapeHtml(articlePublishedTime)}">` : '';
    const authorTag = `<meta name="author" content="${escapeHtml(authorName)}">
        <meta property="article:author" content="${escapeHtml(authorName)}">`;

    res.send(`
      <!DOCTYPE html>
      <html lang="it">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${escapeHtml(seoTitleFull)}</title>
        <meta name="description" content="${escapeHtml(metaDescriptionRaw)}">
        <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
        ${authorTag}
        ${keywordsTag}
        ${publishedTimeTag}
        <meta property="og:type" content="article">
        <meta property="og:site_name" content="Master in Carbon Farming">
        <meta property="og:title" content="${escapeHtml(seoTitleRaw)}">
        <meta property="og:description" content="${escapeHtml(metaDescriptionRaw)}">
        <meta property="og:url" content="${escapeHtml(sharePageUrl)}">
        <meta property="og:locale" content="it_IT">
        ${ogImageTags}
        <meta name="twitter:card" content="summary_large_image">
        <meta name="twitter:title" content="${escapeHtml(seoTitleRaw)}">
        <meta name="twitter:description" content="${escapeHtml(metaDescriptionRaw)}">
        <link rel="canonical" href="${escapeHtml(sharePageUrl)}">
        ${jsonLdTag}
        <style>
          body {
            margin: 0;
            min-height: 100vh;
            font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
            background: linear-gradient(135deg, #f4f8ef 0%, #eef5ea 100%);
            color: #1f2937;
          }
          .shell {
            max-width: 920px;
            margin: 0 auto;
            padding: 36px 20px 56px;
          }
          .card {
            background: rgba(255,255,255,0.94);
            border-radius: 28px;
            box-shadow: 0 28px 80px rgba(31,41,55,0.12);
            overflow: hidden;
            border: 1px solid rgba(122, 185, 40, 0.14);
          }
          .hero {
            padding: 28px;
            display: grid;
            gap: 22px;
          }
          .eyebrow {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            color: #7AB928;
            font-size: 0.82rem;
            font-weight: 800;
            text-transform: uppercase;
            letter-spacing: 0.14em;
          }
          h1 {
            margin: 8px 0 0;
            font-size: clamp(2rem, 4vw, 3.4rem);
            line-height: 1.05;
            color: #17311c;
          }
          .meta {
            margin-top: 14px;
            color: #6b7280;
            font-size: 0.96rem;
          }
          .cover {
            width: 100%;
            aspect-ratio: 16 / 9;
            object-fit: cover;
            display: block;
            background: #eef4eb;
          }
          .cover-fallback {
            width: 100%;
            aspect-ratio: 16 / 9;
            display: grid;
            place-items: center;
            background: linear-gradient(135deg, rgba(122,185,40,0.14), rgba(255,122,26,0.12));
            color: #2d5016;
            font-weight: 700;
            text-align: center;
            padding: 24px;
          }
          .excerpt {
            font-size: 1.06rem;
            line-height: 1.7;
            color: #374151;
            margin: 0;
          }
          .actions {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            margin-top: 26px;
          }
          .button {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            padding: 14px 20px;
            border-radius: 999px;
            text-decoration: none;
            font-weight: 700;
            transition: transform 0.2s ease, box-shadow 0.2s ease;
          }
          .button:hover { transform: translateY(-1px); }
          .button.primary {
            background: linear-gradient(45deg, #ff6b35, #f7931e);
            color: white;
            box-shadow: 0 14px 30px rgba(255, 122, 26, 0.24);
          }
          .button.linkedin {
            background: #0a66c2;
            color: white;
            box-shadow: 0 14px 30px rgba(10, 102, 194, 0.22);
          }
          .button.ghost {
            background: #eef3ea;
            color: #33513d;
          }
          .body {
            padding: 0 28px 28px;
            color: #374151;
          }
          .body h2 {
            color: #2d5016;
            margin: 0 0 12px;
            font-size: 1.2rem;
          }
        </style>
      </head>
      <body>
        <main class="shell">
          <section class="card">
            ${coverImageUrl ? `<img class="cover" src="${escapeHtml(coverImageUrl)}" alt="${escapeHtml(coverAltRaw)}" loading="eager">` : `<div class="cover-fallback">Copertina articolo non disponibile</div>`}
            <div class="hero">
              <div>
                <div class="eyebrow">Master in Carbon Farming</div>
                <h1>${escapeHtml(title)}</h1>
                <div class="meta">Articolo del blog · ${escapeHtml(post.publishedAt ? new Date(post.publishedAt).toLocaleDateString('it-IT', { year: 'numeric', month: 'long', day: 'numeric' }) : '')}</div>
              </div>
              <p class="excerpt">${escapeHtml(excerpt)}</p>
              <div class="actions">
                <a class="button primary" href="${escapeHtml(articleUrl)}">Leggi l'articolo</a>
                <a class="button linkedin" href="https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(sharePageUrl)}" target="_blank" rel="noopener">Apri LinkedIn</a>
                <a class="button ghost" href="/blog.html">Torna al blog</a>
              </div>
            </div>
          </section>
          <section class="body">
            <h2>Per la condivisione</h2>
            <p>Questa pagina contiene i meta Open Graph usati da LinkedIn per mostrare titolo, descrizione e immagine di copertina quando condividi l'articolo.</p>
          </section>
        </main>
      </body>
      </html>
    `);
  } catch (error) {
    console.error('Error rendering blog share page', error);
    res.status(500).send('Impossibile generare la pagina di condivisione');
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
    const isAdmin = Boolean(getOptionalAdmin(req));
    const filters = [];
    const values = [];

    if (!isAdmin) {
      filters.push('r.is_published = true');
    } else if (published !== undefined) {
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
             r.teacher_id AS "teacherId",
             r.lesson_id AS "lessonId",
             r.source, r.tags,
             r.extraction_status AS "extractionStatus", r.extracted_at AS "extractedAt",
             f.name AS "teacherName",
             l.title AS "lessonTitle",
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
    const normalizedUrl = String(url || '').trim();
    const isQuizPayload = resourceType === 'quiz' && normalizedUrl.startsWith('data:application/json,');

    if (isQuizPayload) {
      const { rows: existingRows } = await pool.query(
        `SELECT id
         FROM resources
         WHERE title = $1
           AND resource_type = 'quiz'
           AND url = $2
           AND COALESCE(teacher_id::text, '') = COALESCE($3::text, '')
           AND COALESCE(lesson_id::text, '') = COALESCE($4::text, '')
         ORDER BY updated_at DESC
         LIMIT 1`,
        [title, normalizedUrl, teacherId || null, lessonId || null]
      );

      if (existingRows.length) {
        const existingId = existingRows[0].id;
        const { rows } = await pool.query(
          `UPDATE resources
           SET description = $2,
               thumbnail_url = $3,
               file_size_bytes = $4,
               sort_order = $5,
               is_published = $6,
               source = $7,
               tags = $8,
               updated_at = NOW()
           WHERE id = $1
          RETURNING id, title, description, resource_type AS "resourceType",
                     url, thumbnail_url AS "thumbnailUrl", file_size_bytes AS "fileSizeBytes",
                     sort_order AS "sortOrder", is_published AS "isPublished",
                     teacher_id AS "teacherId", lesson_id AS "lessonId",
                     source, tags,
                     extraction_status AS "extractionStatus", extracted_at AS "extractedAt",
                     created_at AS "createdAt", updated_at AS "updatedAt"`
          ,
          [
            existingId,
            description || null,
            thumbnailUrl || null,
            fileSizeBytes || null,
            typeof sortOrder === 'number' ? sortOrder : null,
            Boolean(isPublished),
            source || 'admin',
            Array.isArray(tags) ? tags : []
          ]
        );
        try {
          await extractAndPersistResourceContent(existingId, { force: true });
        } catch (extractionError) {
          console.error('Resource extraction failed on duplicate quiz update', extractionError);
        }
        return res.status(200).json(rows[0]);
      }
    }

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

// Admin: send resource to teacher review
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

    const setClauses = ['teacher_id = $1', 'is_published = false', 'updated_at = NOW()'];
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
       WHERE id = $2
       RETURNING ${returningClauses.join(', ')}`,
      [teacherId, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Resource not found' });
    res.json(rows[0]);
  } catch (error) {
    console.error('Error requesting teacher review', error);
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
      `SELECT DISTINCT ON (
          LOWER(r.title),
          COALESCE(r.teacher_id::text, ''),
          COALESCE(r.lesson_id::text, ''),
          COALESCE(r.url, '')
        ) ${selectClauses.join(', ')}
       FROM resources r
       ${joinLessonClause}
       ${where}
       ORDER BY
         LOWER(r.title),
         COALESCE(r.teacher_id::text, ''),
         COALESCE(r.lesson_id::text, ''),
         COALESCE(r.url, ''),
         r.updated_at DESC`,
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

  try {
    const materialUpload = await prepareCompressibleMaterialUpload(req.file, MATERIALS_UPLOAD_FINAL_MAX_BYTES, 'materiali lezione');
    if (materialUpload.tooLarge) {
      return res.status(413).json({ error: materialUpload.error });
    }

    // Sanitizza il nome file
    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    
    // Upload su Vercel Blob
    const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    if (!blobToken) {
      console.error('BLOB_READ_WRITE_TOKEN non configurato!');
      return res.status(500).json({ error: 'Storage non configurato (BLOB_READ_WRITE_TOKEN mancante).' });
    }

    const blob = await put(safeName, materialUpload.buffer, {
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

  try {
    // Sanitizza il nome file
    let fileBuffer = req.file.buffer;
    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');

    // Se il PDF supera i 4MB proviamo a comprimerlo con pdf-lib prima di rifiutarlo.
    if (req.file.mimetype === 'application/pdf' && req.file.size > RESOURCE_UPLOAD_MAX_BYTES) {
      console.log('📦 Comprimendo PDF risorsa con pdf-lib...');
      try {
        const result = await compressPdfWithPdfLib(req.file.buffer);
        if (result.buffer.length <= RESOURCE_UPLOAD_MAX_BYTES) {
          fileBuffer = result.buffer;
          console.log(`✅ PDF compresso con preset ${result.preset || 'unknown'}: ${req.file.size} -> ${fileBuffer.length} bytes`);
        } else {
          return res.status(413).json({
            error: `Il PDF supera ancora i 4MB anche dopo la compressione automatica. Formati ammessi: ${ALLOWED_UPLOAD_EXTENSIONS_LABEL}.`
          });
        }
      } catch (compressionError) {
        console.error('Compressione PDF fallita:', compressionError);
        return res.status(500).json({
          error: `Impossibile comprimere automaticamente il PDF. Formati ammessi: ${ALLOWED_UPLOAD_EXTENSIONS_LABEL}.`
        });
      }
    } else if (req.file.size > RESOURCE_UPLOAD_MAX_BYTES) {
      return res.status(413).json({
        error: `File troppo grande (max 4MB). Formati ammessi: ${ALLOWED_UPLOAD_EXTENSIONS_LABEL}.`
      });
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
    brevoConfigured: Boolean(BREVO_API_KEY),
    pdfCompressionWorkerUrl: process.env.PDF_COMPRESSION_WORKER_URL || null
  });
});

function servePdfLibBundle(_req, res) {
  try {
    const pdfLibPath = require.resolve('pdf-lib/dist/pdf-lib.min.js');
    const pdfLibCode = fs.readFileSync(pdfLibPath, 'utf8');
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(pdfLibCode);
  } catch (error) {
    console.error('Error serving pdf-lib bundle:', error);
    return res.status(500).json({ error: 'Impossibile caricare la libreria PDF' });
  }
}

app.get('/api/vendor/pdf-lib.min.js', servePdfLibBundle);

app.get('/vendor/pdf-lib.min.js', servePdfLibBundle);

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
    const isAdmin = Boolean(getOptionalAdmin(req));
    const selectFields = isAdmin
      ? `id, title, description, resource_type AS "resourceType",
             url, thumbnail_url AS "thumbnailUrl", is_published AS "isPublished",
             extracted_text AS "extractedText", extraction_status AS "extractionStatus",
             extraction_metadata AS "extractionMetadata", extracted_at AS "extractedAt"`
      : `id, title, description, resource_type AS "resourceType",
             url, thumbnail_url AS "thumbnailUrl", is_published AS "isPublished"`;
    const where = isAdmin ? 'id = $1' : 'id = $1 AND is_published = true';
    const { rows } = await pool.query(`
      SELECT ${selectFields}
      FROM resources WHERE ${where}
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Resource not found' });
    res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching resource', error);
    res.status(500).json({ error: 'Unable to retrieve resource' });
  }
});

// Download di un documento della lezione con filigrana personalizzata + clausola.
// Solo studenti autenticati (no guest). Il PDF viene marchiato al volo con i dati
// dello studente; chiamare questo endpoint implica l'accettazione della clausola
// (mostrata e confermata nel frontend prima del download).
app.get('/api/resources/:id/download', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const isAdmin = Boolean(getOptionalAdmin(req));
    const where = isAdmin ? 'id = $1' : 'id = $1 AND is_published = true';
    const { rows } = await pool.query(
      `SELECT id, title, resource_type AS "resourceType", url FROM resources WHERE ${where}`,
      [req.params.id]
    );
    const resource = rows[0];
    if (!resource || !resource.url) return res.status(404).json({ error: 'Documento non trovato' });

    // Identità studente per la filigrana
    let name = '';
    let email = '';
    if (req.user && req.user.userId) {
      const { rows: u } = await pool.query(
        'SELECT email, first_name AS "firstName", last_name AS "lastName" FROM users WHERE id = $1',
        [req.user.userId]
      );
      if (u[0]) {
        name = [u[0].firstName, u[0].lastName].filter(Boolean).join(' ').trim();
        email = u[0].email || '';
      }
    }

    function resolveDownloadTarget(rawUrl) {
      const url = String(rawUrl || '').trim();
      if (!url) return { kind: 'missing' };

      if (url.startsWith('/upload/')) {
        return { kind: 'local', path: path.join(__dirname, '..', url) };
      }

      let parsed;
      try {
        parsed = new URL(url);
      } catch (e) {
        return { kind: 'invalid' };
      }

      const host = parsed.hostname.toLowerCase();
      if (host.endsWith('.public.blob.vercel-storage.com') || host === 'public.blob.vercel-storage.com') {
        return { kind: 'remote', url };
      }

      if (host === 'docs.google.com') {
        const match = parsed.pathname.match(/\/(document|spreadsheets|presentation)\/d\/([^/]+)/i);
        if (!match) return { kind: 'unsupported', reason: 'Documento Google non riconosciuto' };
        const [, type, id] = match;
        const exportFormat = type.toLowerCase() === 'document' ? 'pdf'
          : type.toLowerCase() === 'spreadsheets' ? 'xlsx'
          : 'pdf';
        return { kind: 'remote', url: `https://docs.google.com/${type}/d/${id}/export?format=${exportFormat}` };
      }

      if (host === 'drive.google.com') {
        const fileMatch = url.match(/\/file\/d\/([^/]+)/i) || url.match(/[?&]id=([^&]+)/i);
        if (fileMatch && fileMatch[1]) {
          return { kind: 'remote', url: `https://drive.google.com/uc?export=download&id=${fileMatch[1]}` };
        }
        return { kind: 'unsupported', reason: 'Il link Google Drive sembra puntare a una cartella, non a un file' };
      }

      return { kind: 'remote', url };
    }

    // Scarica i byte del file dal blob (domini consentiti) o da /upload locale
    let fileBuffer;
    const target = resolveDownloadTarget(resource.url);
    if (target.kind === 'missing') {
      return res.status(404).json({ error: 'Documento non trovato' });
    }
    if (target.kind === 'invalid') {
      return res.status(400).json({ error: 'URL non valido' });
    }
    if (target.kind === 'unsupported') {
      return res.status(400).json({ error: target.reason || 'Il documento non è scaricabile da questo link' });
    }
    if (target.kind === 'local') {
      if (!fs.existsSync(target.path)) return res.status(404).json({ error: 'File non trovato' });
      fileBuffer = fs.readFileSync(target.path);
    } else {
      const resp = await fetch(target.url);
      if (!resp.ok) return res.status(502).json({ error: 'Impossibile recuperare il documento' });
      fileBuffer = Buffer.from(await resp.arrayBuffer());
    }

    const urlExt = (String(resource.url || '').split('?')[0].match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
    const isPdf = urlExt === '.pdf' || resource.resourceType === 'pdf';
    const safeTitle = String(resource.title || 'documento').replace(/[^\p{L}\p{N} ._-]/gu, '').trim() || 'documento';
    const dateStr = new Date().toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });

    if (isPdf) {
      let stamped;
      try {
        stamped = await stampPdfWatermark(fileBuffer, { name, email, dateStr });
      } catch (wmErr) {
        console.error('Watermark stamping failed, serving original PDF', wmErr.message);
        stamped = fileBuffer;
      }
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${safeTitle}.pdf"`,
        'Content-Length': stamped.length
      });
      return res.send(stamped);
    }

    // Non-PDF: non è possibile imprimere la filigrana; serviamo l'originale come allegato.
    const ext = (resource.url.split('?')[0].match(/\.[a-z0-9]+$/i) || [''])[0];
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${safeTitle}${ext}"`,
      'Content-Length': fileBuffer.length
    });
    return res.send(fileBuffer);
  } catch (error) {
    console.error('Resource download error', error);
    res.status(500).json({ error: 'Download non riuscito' });
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

// Export CSV delle lezioni del calendario (solo admin). Accetta gli stessi
// filtri opzionali di /api/lessons (module_id, teacher_id, status, month, year)
// così l'export può rispecchiare la vista corrente; senza filtri esporta tutto.
const LESSON_STATUS_LABELS = {
  draft: 'Bozza',
  confirmed: 'Confermata',
  completed: 'Completata',
  cancelled: 'Annullata'
};

app.get('/api/admin/lessons.csv', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;

  try {
    const { module_id, teacher_id, status, month, year } = req.query;
    const filters = [];
    const values = [];

    if (module_id) {
      values.push(module_id);
      filters.push(`l.module_id = $${values.length}`);
    }
    if (teacher_id) {
      values.push(teacher_id);
      filters.push(`l.teacher_id = $${values.length}`);
    }
    if (status) {
      values.push(status);
      filters.push(`l.status = $${values.length}`);
    }
    if (month && year) {
      values.push(parseInt(month, 10));
      filters.push(`EXTRACT(MONTH FROM l.start_datetime) = $${values.length}`);
      values.push(parseInt(year, 10));
      filters.push(`EXTRACT(YEAR FROM l.start_datetime) = $${values.length}`);
    } else if (year) {
      values.push(parseInt(year, 10));
      filters.push(`EXTRACT(YEAR FROM l.start_datetime) = $${values.length}`);
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const { rows } = await pool.query(`
      SELECT l.start_datetime AS "startDatetime",
             l.end_datetime AS "endDatetime",
             l.duration_minutes AS "durationMinutes",
             l.title,
             m.name AS "moduleName",
             COALESCE(f.name, l.external_teacher_name) AS "teacherName",
             CASE WHEN f.id IS NULL AND l.external_teacher_name IS NOT NULL THEN 'esterno' ELSE 'interno' END AS "teacherType",
             l.status,
             l.location_physical AS "locationPhysical",
             l.location_remote AS "locationRemote",
             l.notes,
             (SELECT COUNT(*)::int FROM attendance a WHERE a.lesson_id = l.id) AS "attendanceCount"
      FROM lessons l
      LEFT JOIN modules m ON l.module_id = m.id
      LEFT JOIN faculty f ON l.teacher_id = f.id
      ${where}
      ORDER BY l.start_datetime ASC
    `, values);

    const fmtDate = (value) => {
      if (!value) return '';
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return '';
      return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Rome' });
    };
    const fmtTime = (value) => {
      if (!value) return '';
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return '';
      return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
    };

    let csv = 'data,ora_inizio,ora_fine,titolo,modulo,docente,tipo_docente,ore,stato,completata,luogo_fisico,luogo_remoto,presenze,note\n';
    rows.forEach((row) => {
      const statusKey = row.status || 'draft';
      const hours = row.durationMinutes ? (Number(row.durationMinutes) / 60).toFixed(1).replace('.', ',') : '';
      csv += [
        csvEscape(fmtDate(row.startDatetime)),
        csvEscape(fmtTime(row.startDatetime)),
        csvEscape(fmtTime(row.endDatetime)),
        csvEscape(row.title),
        csvEscape(row.moduleName || ''),
        csvEscape(row.teacherName || ''),
        csvEscape(row.teacherType || ''),
        csvEscape(hours),
        csvEscape(LESSON_STATUS_LABELS[statusKey] || statusKey),
        csvEscape(statusKey === 'completed' ? 'SI' : 'NO'),
        csvEscape(row.locationPhysical || ''),
        csvEscape(row.locationRemote || ''),
        csvEscape(row.attendanceCount ?? 0),
        csvEscape(row.notes || '')
      ].join(',') + '\n';
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="calendario_lezioni.csv"');
    res.send('﻿' + csv);
  } catch (error) {
    console.error('Export lessons csv error', error);
    res.status(500).json({ error: 'Unable to export lessons' });
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
      WHERE COALESCE(l.status, 'scheduled') <> 'cancelled'
        AND l.start_datetime IS NOT NULL
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
             cal.teacher_id AS "teacherId", f.name AS "teacherName",
             cal.external_teacher_name AS "externalTeacherName",
             ll.created_at AS "createdAt", ll.updated_at AS "updatedAt"
      FROM lms_lessons ll
      LEFT JOIN lessons cal ON cal.id = ll.calendar_lesson_id
      LEFT JOIN faculty f ON f.id = cal.teacher_id
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
      SELECT ll.id, ll.lms_module_id AS "moduleId", ll.title, ll.description,
             video_url AS "videoUrl", video_provider AS "videoProvider",
             duration_seconds AS "durationSeconds", sort_order AS "sortOrder",
             is_free AS "isFree", is_published AS "isPublished",
             ll.materials, calendar_lesson_id AS "calendarLessonId",
             cal.title AS "calendarLessonTitle",
             ll.created_at AS "createdAt", ll.updated_at AS "updatedAt"
      FROM lms_lessons ll
      LEFT JOIN lessons cal ON cal.id = ll.calendar_lesson_id
      WHERE ll.id = $1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Lesson not found' });

    const lesson = rows[0];
    const normalizeMaterialUrl = (value) => String(value || '').trim();

    // Load linked resources from calendar lesson and keep only published materials for students
    if (lesson.calendarLessonId) {
      const { rows: resRows } = await pool.query(`
        SELECT r.id, r.title, r.url, r.resource_type AS "resourceType",
               r.description, f.name AS "teacherName",
               r.is_published AS "isPublished",
               r.review_status AS "reviewStatus"
        FROM resources r
        LEFT JOIN faculty f ON f.id = r.teacher_id
        WHERE r.lesson_id = $1
        ORDER BY r.sort_order NULLS LAST, r.created_at
      `, [lesson.calendarLessonId]);
      const publishedResources = resRows.filter((resource) => resource && resource.isPublished && resource.resourceType !== 'quiz');
      const publishedResourceIds = new Set(publishedResources.map((resource) => String(resource.id)));
      const publishedResourceUrls = new Set(publishedResources.map((resource) => normalizeMaterialUrl(resource.url)));

      lesson.linkedResources = publishedResources;

      const rawMaterials = Array.isArray(lesson.materials) ? lesson.materials : [];
      const publicMaterials = rawMaterials.filter((material) => {
        if (!material) return false;
        const materialType = String(material.type || material.assetType || '').toLowerCase();
        if (materialType === 'quiz' || material.quizId) return false;

        if (material.isPublished === true || material.status === 'approved' || material.reviewStatus === 'teacher_approved' || material.reviewStatus === 'approved') {
          return true;
        }

        const materialResourceId = material.resourceId || material.id || null;
        if (materialResourceId && publishedResourceIds.has(String(materialResourceId))) return true;

        const materialUrl = normalizeMaterialUrl(material.url);
        if (materialUrl && publishedResourceUrls.has(materialUrl)) return true;

        return false;
      });

      const mergedPublicMaterials = [
        ...publicMaterials,
        ...publishedResources.map((resource) => ({
          id: resource.id,
          title: resource.title,
          url: resource.url,
          resourceType: resource.resourceType,
          description: resource.description,
          teacherName: resource.teacherName,
          isPublished: resource.isPublished,
          reviewStatus: resource.reviewStatus,
          source: 'calendar_lesson'
        }))
      ];

      lesson.publicMaterials = mergedPublicMaterials;
      lesson.materials = mergedPublicMaterials;

      if (!lesson.linkedResources.length) {
        const fallbackTitles = [lesson.calendarLessonTitle, lesson.title].filter(Boolean);
        if (fallbackTitles.length) {
          const { rows: fallbackRows } = await pool.query(`
            SELECT r.id, r.title, r.url, r.resource_type AS "resourceType",
                   r.description, f.name AS "teacherName",
                   r.is_published AS "isPublished",
                   r.review_status AS "reviewStatus"
            FROM resources r
            LEFT JOIN faculty f ON f.id = r.teacher_id
            WHERE r.is_published = true
              AND r.resource_type <> 'quiz'
              AND COALESCE(r.source, 'admin') = 'calendar_lesson'
              AND (
                LOWER(TRIM(r.title)) = LOWER(TRIM($1))
                OR LOWER(TRIM(r.title)) = LOWER(TRIM($2))
              )
            ORDER BY r.sort_order NULLS LAST, r.created_at
          `, [fallbackTitles[0], fallbackTitles[1] || fallbackTitles[0]]);
          lesson.linkedResources = fallbackRows;
        }
      }
    } else {
      lesson.linkedResources = [];
      lesson.publicMaterials = Array.isArray(lesson.materials) ? lesson.materials.filter((material) => {
        if (!material) return false;
        const materialType = String(material.type || material.assetType || '').toLowerCase();
        if (materialType === 'quiz' || material.quizId) return false;
        return material.isPublished === true || material.status === 'approved' || material.reviewStatus === 'teacher_approved' || material.reviewStatus === 'approved';
      }) : [];
      lesson.materials = lesson.publicMaterials;
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
  if (!calendarLessonId) return res.status(400).json({ error: 'calendarLessonId is required' });
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
  if (!calendarLessonId) return res.status(400).json({ error: 'calendarLessonId is required' });
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
      calendarLessonId: r.calendar_lesson_id,
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

    const baseUrl = getPublicBaseUrl(req);
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
  if (req.user.role === 'guest') {
    return res.json({
      id: req.user.teacherId || req.user.userId || null,
      email: req.user.email || null,
      firstName: req.user.firstName || null,
      lastName: req.user.lastName || null,
      role: 'guest',
      updatedAt: null,
      accessMode: 'student_view'
    });
  }
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

function normalizeNetworkText(value, maxLength = 500) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

function normalizeNetworkList(value) {
  const input = Array.isArray(value)
    ? value
    : String(value || '')
      .split(',')
      .map((item) => item.trim());

  const seen = new Set();
  return input
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .map((item) => item.slice(0, 60))
    .filter((item) => {
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);
}

function normalizeNetworkUrl(value) {
  const text = normalizeNetworkText(value, 300);
  if (!text) return null;
  if (!/^https?:\/\//i.test(text)) return null;
  return text;
}

const NETWORK_SETTING_DEFAULTS = {
  network_enabled: 'true',
  profiles_enabled: 'true',
  posts_enabled: 'true',
  intro_requests_enabled: 'true',
  profile_photos_enabled: 'true',
  link_previews_enabled: 'true'
};

async function loadNetworkSettings(client = pool) {
  const settings = { ...NETWORK_SETTING_DEFAULTS };
  if (!client) return settings;
  const { rows } = await client.query('SELECT key, value FROM network_settings');
  rows.forEach((row) => {
    if (row && row.key) {
      settings[row.key] = String(row.value ?? '');
    }
  });
  return settings;
}

function isNetworkFlagEnabled(settings, key) {
  return String(settings?.[key] ?? NETWORK_SETTING_DEFAULTS[key] ?? 'false').toLowerCase() === 'true';
}

function normalizeNetworkEntries(value, allowedKeys, maxItems = 5) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const normalized = {};
      allowedKeys.forEach((key) => {
        const text = normalizeNetworkText(entry[key], key === 'url' ? 300 : 180);
        if (text) normalized[key] = key === 'url' ? normalizeNetworkUrl(text) : text;
      });
      Object.keys(normalized).forEach((key) => {
        if (normalized[key] === null) delete normalized[key];
      });
      return Object.keys(normalized).length ? normalized : null;
    })
    .filter(Boolean)
    .slice(0, maxItems);
}

// Versione corrente del testo di consenso del network. Va incrementata quando il
// testo dell'informativa cambia, così da poter richiedere un nuovo consenso esplicito.
const NETWORK_CONSENT_VERSION = '1.0';

function buildNetworkProfile(row, options = {}) {
  if (!row) return null;
  const exposePrivate = Boolean(options.exposePrivate);
  const email = exposePrivate || row.showEmail ? (row.contactEmail || row.userEmail || null) : null;
  return {
    userId: row.userId,
    firstName: row.firstName,
    lastName: row.lastName,
    fullName: [row.firstName, row.lastName].filter(Boolean).join(' ').trim(),
    role: row.role,
    headline: row.headline,
    organization: row.organization,
    roleTitle: row.roleTitle,
    city: row.city,
    country: row.country,
    bio: row.bio,
    collaborationGoals: row.collaborationGoals,
    profilePhotoUrl: row.profilePhotoUrl || row.userAvatarUrl || null,
    coverImageUrl: row.coverImageUrl,
    experience: Array.isArray(row.experience) ? row.experience : [],
    featuredLinks: Array.isArray(row.featuredLinks) ? row.featuredLinks : [],
    skills: row.skills || [],
    interests: row.interests || [],
    linkedinUrl: exposePrivate || row.showLinkedin ? row.linkedinUrl : null,
    contactEmail: email,
    isVisible: Boolean(row.isVisible),
    showEmail: Boolean(row.showEmail),
    showLinkedin: Boolean(row.showLinkedin),
    availableForContact: Boolean(row.availableForContact),
    // I dati di consenso sono privati: si espongono solo al titolare del profilo,
    // mai nella directory verso gli altri partecipanti.
    ...(exposePrivate ? {
      externalVisible: Boolean(row.externalVisible),
      consentVersion: NETWORK_CONSENT_VERSION,
      internalConsentAt: row.internalConsentAt || null,
      internalConsentVersion: row.internalConsentVersion || null,
      externalConsentAt: row.externalConsentAt || null,
      externalConsentVersion: row.externalConsentVersion || null
    } : {}),
    followersCount: Number(row.followersCount ?? 0),
    followingCount: Number(row.followingCount ?? 0),
    postsCount: Number(row.postsCount ?? 0),
    isFollowing: Boolean(row.isFollowing),
    isFollowedBy: Boolean(row.isFollowedBy),
    isConnected: Boolean(row.isConnected),
    updatedAt: row.updatedAt
  };
}

function buildNetworkFaculty(row) {
  if (!row) return null;
  const modules = Array.isArray(row.modules) ? row.modules.filter((m) => m && m.id) : [];
  return {
    id: row.id,
    name: row.name,
    role: row.role || null,
    bio: row.bio || null,
    photoUrl: row.photoUrl || null,
    profileLink: row.profileLink || null,
    contactEmail: row.email || null,
    modules,
    moduleNames: modules.map((m) => m.name).filter(Boolean),
    lessonsCount: Number(row.lessonsCount ?? 0)
  };
}

const NETWORK_OPPORTUNITY_TYPES = ['stage', 'tesi', 'lavoro', 'altro'];

function normalizeOpportunityType(value) {
  const v = String(value || '').trim().toLowerCase();
  return NETWORK_OPPORTUNITY_TYPES.includes(v) ? v : 'lavoro';
}

function buildNetworkOpportunity(row, options = {}) {
  if (!row) return null;
  const base = {
    id: row.id,
    title: row.title,
    type: row.type,
    organization: row.organization || null,
    location: row.location || null,
    description: row.description || null,
    applyUrl: row.applyUrl || null,
    contactEmail: row.contactEmail || null,
    deadline: row.deadline || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null
  };
  if (options.includeAdminFields) {
    base.isPublished = Boolean(row.isPublished);
    base.applicationsCount = Number(row.applicationsCount ?? 0);
  } else {
    base.hasApplied = Boolean(row.hasApplied);
    base.applicationStatus = row.applicationStatus || null;
  }
  return base;
}

function buildNetworkIntroRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    direction: row.direction,
    status: row.status,
    message: row.message,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    participant: {
      userId: row.participantUserId,
      fullName: [row.participantFirstName, row.participantLastName].filter(Boolean).join(' ').trim(),
      headline: row.participantHeadline,
      organization: row.participantOrganization,
      roleTitle: row.participantRoleTitle,
      profilePhotoUrl: row.participantProfilePhotoUrl || row.participantAvatarUrl || null,
      linkedinUrl: row.participantShowLinkedin ? row.participantLinkedinUrl : null,
      contactEmail: row.participantShowEmail ? (row.participantContactEmail || row.participantEmail || null) : null
    }
  };
}

function buildNetworkPost(row) {
  if (!row) return null;
  return {
    id: row.id,
    body: row.body,
    linkUrl: row.linkUrl,
    linkTitle: row.linkTitle,
    mediaUrl: row.mediaUrl || null,
    mediaAlt: row.mediaAlt || null,
    linkPreview: row.linkPreviewTitle || row.linkPreviewDescription || row.linkPreviewImageUrl || row.linkPreviewSiteName
      ? {
          title: row.linkPreviewTitle || null,
          description: row.linkPreviewDescription || null,
          imageUrl: row.linkPreviewImageUrl || null,
          siteName: row.linkPreviewSiteName || null
        }
      : null,
    tags: row.tags || [],
    visibility: row.visibility,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    likeCount: Number(row.likeCount ?? 0),
    commentCount: Number(row.commentCount ?? 0),
    isLiked: Boolean(row.isLiked),
    author: {
      userId: row.authorUserId,
      fullName: [row.authorFirstName, row.authorLastName].filter(Boolean).join(' ').trim(),
      headline: row.authorHeadline,
      organization: row.authorOrganization,
      roleTitle: row.authorRoleTitle,
      profilePhotoUrl: row.authorProfilePhotoUrl || row.authorAvatarUrl || null
    },
    canDelete: Boolean(row.canDelete)
  };
}

function buildNetworkComment(row) {
  if (!row) return null;
  return {
    id: row.id,
    postId: row.postId,
    body: row.body,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    canDelete: Boolean(row.canDelete),
    author: {
      userId: row.authorUserId,
      fullName: [row.authorFirstName, row.authorLastName].filter(Boolean).join(' ').trim(),
      headline: row.authorHeadline,
      organization: row.authorOrganization,
      roleTitle: row.authorRoleTitle,
      profilePhotoUrl: row.authorProfilePhotoUrl || row.authorAvatarUrl || null
    }
  };
}

function buildNetworkNotification(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    entityType: row.entityType,
    entityId: row.entityId,
    payload: row.payload || {},
    isRead: Boolean(row.isRead),
    createdAt: row.createdAt,
    readAt: row.readAt
  };
}

function buildNetworkAdminProfile(row) {
  const profile = buildNetworkProfile(row, { exposePrivate: true });
  if (!profile) return null;
  return {
    ...profile,
    email: row.userEmail || null,
    userAvatarUrl: row.userAvatarUrl || null,
    createdAt: row.createdAt || null
  };
}

async function fetchNetworkLinkPreview(linkUrl) {
  if (!linkUrl) return null;
  if (process.env.NODE_ENV === 'test') return null;
  try {
    const response = await fetch(linkUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CarbonFarmingMasterBot/1.0)'
      }
    });
    if (!response.ok) return null;
    const html = await response.text();
    const $ = cheerio.load(html);
    const pick = (...selectors) => {
      for (const selector of selectors) {
        const value = $(selector).attr('content') || $(selector).attr('value') || $(selector).text();
        if (value && String(value).trim()) return String(value).trim();
      }
      return '';
    };
    const resolveUrl = (value) => {
      if (!value) return null;
      try {
        return new URL(value, linkUrl).toString();
      } catch (_) {
        return null;
      }
    };
    const title = pick('meta[property="og:title"]', 'meta[name="twitter:title"]', 'title') || null;
    const description = pick('meta[property="og:description"]', 'meta[name="description"]', 'meta[name="twitter:description"]') || null;
    const imageUrl = resolveUrl(pick('meta[property="og:image"]', 'meta[name="twitter:image"]'));
    const siteName = pick('meta[property="og:site_name"]') || null;
    if (!title && !description && !imageUrl && !siteName) return null;
    return {
      title,
      description,
      imageUrl,
      siteName
    };
  } catch (error) {
    console.warn('Network link preview failed:', error.message);
    return null;
  }
}

async function insertNetworkNotification({ userId, type, entityType, entityId = null, payload = {} }) {
  if (!pool) return null;
  const { rows } = await pool.query(`
    INSERT INTO network_notifications (user_id, type, entity_type, entity_id, payload, is_read, created_at)
    VALUES ($1, $2, $3, $4, $5::jsonb, false, NOW())
    RETURNING id
  `, [userId, type, entityType, entityId, JSON.stringify(payload || {})]);
  return rows[0]?.id || null;
}

app.get('/api/lms/network/config', requireStudent, async (_req, res) => {
  if (!ensurePool(res)) return;
  try {
    const settings = await loadNetworkSettings();
    res.json({
      networkEnabled: isNetworkFlagEnabled(settings, 'network_enabled'),
      profilesEnabled: isNetworkFlagEnabled(settings, 'profiles_enabled'),
      postsEnabled: isNetworkFlagEnabled(settings, 'posts_enabled'),
      introRequestsEnabled: isNetworkFlagEnabled(settings, 'intro_requests_enabled'),
      profilePhotosEnabled: isNetworkFlagEnabled(settings, 'profile_photos_enabled'),
      linkPreviewsEnabled: isNetworkFlagEnabled(settings, 'link_previews_enabled'),
      consentVersion: NETWORK_CONSENT_VERSION
    });
  } catch (error) {
    console.error('Get network config error:', error);
    res.status(500).json({ error: 'Errore nel recupero configurazione network' });
  }
});

app.post('/api/lms/network/blob-token', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const pathname = String(req.body?.pathname || '').trim().replace(/^\/+/, '');
    if (!pathname.startsWith('network/')) {
      return res.status(400).json({ error: 'Percorso upload non valido' });
    }

    const requestedMaxSize = Number(req.body?.maximumSizeInBytes || 0);
    const maximumSizeInBytes = Number.isFinite(requestedMaxSize) && requestedMaxSize > 0
      ? Math.min(requestedMaxSize, BLOB_CLIENT_TOKEN_MAX_BYTES)
      : Math.min(12 * 1024 * 1024, BLOB_CLIENT_TOKEN_MAX_BYTES);
    const contentType = String(req.body?.contentType || '').trim() || null;
    res.json(await createBlobClientToken({ pathname, maximumSizeInBytes, contentType }));
  } catch (error) {
    console.error('Error generating network blob token:', error);
    res.status(500).json({ error: error.message || 'Impossibile generare il token upload' });
  }
});

app.get('/api/lms/network/profile', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const networkSettings = await loadNetworkSettings();
    if (!isNetworkFlagEnabled(networkSettings, 'network_enabled') || !isNetworkFlagEnabled(networkSettings, 'profiles_enabled')) {
      return res.status(503).json({ error: 'Network non disponibile al momento' });
    }
    const { rows } = await pool.query(`
      SELECT u.id AS "userId", u.email AS "userEmail",
             u.first_name AS "firstName", u.last_name AS "lastName", u.role,
             u.avatar_url AS "userAvatarUrl",
             p.headline, p.organization, p.role_title AS "roleTitle",
             p.city, p.country, p.bio, COALESCE(p.skills, '{}') AS skills,
             COALESCE(p.interests, '{}') AS interests,
             p.profile_photo_url AS "profilePhotoUrl",
             p.cover_image_url AS "coverImageUrl",
             p.collaboration_goals AS "collaborationGoals",
             COALESCE(p.experience, '[]'::jsonb) AS "experience",
             COALESCE(p.featured_links, '[]'::jsonb) AS "featuredLinks",
             p.linkedin_url AS "linkedinUrl", p.contact_email AS "contactEmail",
             COALESCE(p.is_visible, false) AS "isVisible",
             COALESCE(p.show_email, false) AS "showEmail",
             COALESCE(p.show_linkedin, true) AS "showLinkedin",
             COALESCE(p.available_for_contact, true) AS "availableForContact",
             COALESCE(p.external_visible, false) AS "externalVisible",
             p.internal_consent_at AS "internalConsentAt",
             p.internal_consent_version AS "internalConsentVersion",
             p.external_consent_at AS "externalConsentAt",
             p.external_consent_version AS "externalConsentVersion",
             (SELECT COUNT(*)::int FROM network_follows f WHERE f.following_user_id = u.id) AS "followersCount",
             (SELECT COUNT(*)::int FROM network_follows f WHERE f.follower_user_id = u.id) AS "followingCount",
             (SELECT COUNT(*)::int FROM network_posts post WHERE post.author_user_id = u.id AND post.is_deleted = false) AS "postsCount",
             EXISTS (
               SELECT 1 FROM network_follows f
               WHERE f.follower_user_id = $1 AND f.following_user_id = u.id
             ) AS "isFollowing",
             EXISTS (
               SELECT 1 FROM network_follows f
               WHERE f.follower_user_id = u.id AND f.following_user_id = $1
             ) AS "isFollowedBy",
             EXISTS (
               SELECT 1
               FROM network_follows f1
               JOIN network_follows f2
                 ON f1.follower_user_id = f2.following_user_id
                AND f1.following_user_id = f2.follower_user_id
               WHERE f1.follower_user_id = $1 AND f1.following_user_id = u.id
             ) AS "isConnected",
             p.updated_at AS "updatedAt"
      FROM users u
      LEFT JOIN network_profiles p ON p.user_id = u.id
      WHERE u.id = $1
    `, [req.user.userId]);

    if (!rows.length) return res.status(404).json({ error: 'Studente non trovato' });
    res.json(buildNetworkProfile(rows[0], { exposePrivate: true }));
  } catch (error) {
    console.error('Get network profile error:', error);
    res.status(500).json({ error: 'Errore nel recupero profilo network' });
  }
});

app.put('/api/lms/network/profile', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const networkSettings = await loadNetworkSettings();
    if (!isNetworkFlagEnabled(networkSettings, 'network_enabled') || !isNetworkFlagEnabled(networkSettings, 'profiles_enabled')) {
      return res.status(403).json({ error: 'La modifica del profilo network è temporaneamente disabilitata' });
    }
    if (!isNetworkFlagEnabled(networkSettings, 'profile_photos_enabled')) {
      req.body.profilePhotoUrl = null;
      req.body.coverImageUrl = null;
    }
    const payload = {
      headline: normalizeNetworkText(req.body.headline, 160),
      organization: normalizeNetworkText(req.body.organization, 160),
      roleTitle: normalizeNetworkText(req.body.roleTitle, 160),
      city: normalizeNetworkText(req.body.city, 120),
      country: normalizeNetworkText(req.body.country, 120),
      bio: normalizeNetworkText(req.body.bio, 900),
      collaborationGoals: normalizeNetworkText(req.body.collaborationGoals, 500),
      profilePhotoUrl: normalizeNetworkUrl(req.body.profilePhotoUrl),
      coverImageUrl: normalizeNetworkUrl(req.body.coverImageUrl),
      experience: normalizeNetworkEntries(req.body.experience, ['title', 'organization', 'period', 'description'], 8),
      featuredLinks: normalizeNetworkEntries(req.body.featuredLinks, ['label', 'url'], 6),
      skills: normalizeNetworkList(req.body.skills),
      interests: normalizeNetworkList(req.body.interests),
      linkedinUrl: normalizeNetworkUrl(req.body.linkedinUrl),
      contactEmail: normalizeNetworkText(req.body.contactEmail, 180),
      isVisible: normalizeBoolean(req.body.isVisible, false),
      showEmail: normalizeBoolean(req.body.showEmail, false),
      showLinkedin: normalizeBoolean(req.body.showLinkedin, true),
      availableForContact: normalizeBoolean(req.body.availableForContact, true),
      externalVisible: normalizeBoolean(req.body.externalVisible, false)
    };

    // Consenso GDPR: il timestamp/versione viene registrato solo quando il consenso
    // viene concesso per la prima volta (o sotto una nuova versione del testo). Alla
    // revoca si abbassa il flag ma si conserva lo storico del consenso prestato.
    const { rows } = await pool.query(`
      INSERT INTO network_profiles (
        user_id, headline, organization, role_title, city, country, bio,
        collaboration_goals, profile_photo_url, cover_image_url, experience, featured_links,
        skills, interests, linkedin_url, contact_email, is_visible,
        show_email, show_linkedin, available_for_contact, external_visible,
        internal_consent_at, internal_consent_version,
        external_consent_at, external_consent_version, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::text[], $14::text[], $15, $16, $17, $18, $19, $20, $21,
        CASE WHEN $17 THEN NOW() ELSE NULL END,
        CASE WHEN $17 THEN $22::text ELSE NULL END,
        CASE WHEN $21 THEN NOW() ELSE NULL END,
        CASE WHEN $21 THEN $22::text ELSE NULL END,
        NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        headline = EXCLUDED.headline,
        organization = EXCLUDED.organization,
        role_title = EXCLUDED.role_title,
        city = EXCLUDED.city,
        country = EXCLUDED.country,
        bio = EXCLUDED.bio,
        collaboration_goals = EXCLUDED.collaboration_goals,
        profile_photo_url = EXCLUDED.profile_photo_url,
        cover_image_url = EXCLUDED.cover_image_url,
        experience = EXCLUDED.experience,
        featured_links = EXCLUDED.featured_links,
        skills = EXCLUDED.skills,
        interests = EXCLUDED.interests,
        linkedin_url = EXCLUDED.linkedin_url,
        contact_email = EXCLUDED.contact_email,
        is_visible = EXCLUDED.is_visible,
        show_email = EXCLUDED.show_email,
        show_linkedin = EXCLUDED.show_linkedin,
        available_for_contact = EXCLUDED.available_for_contact,
        external_visible = EXCLUDED.external_visible,
        internal_consent_at = CASE
          WHEN EXCLUDED.is_visible AND (network_profiles.internal_consent_at IS NULL OR network_profiles.internal_consent_version IS DISTINCT FROM $22::text)
            THEN NOW()
          ELSE network_profiles.internal_consent_at
        END,
        internal_consent_version = CASE
          WHEN EXCLUDED.is_visible AND (network_profiles.internal_consent_at IS NULL OR network_profiles.internal_consent_version IS DISTINCT FROM $22::text)
            THEN $22::text
          ELSE network_profiles.internal_consent_version
        END,
        external_consent_at = CASE
          WHEN EXCLUDED.external_visible AND (network_profiles.external_consent_at IS NULL OR network_profiles.external_consent_version IS DISTINCT FROM $22::text)
            THEN NOW()
          ELSE network_profiles.external_consent_at
        END,
        external_consent_version = CASE
          WHEN EXCLUDED.external_visible AND (network_profiles.external_consent_at IS NULL OR network_profiles.external_consent_version IS DISTINCT FROM $22::text)
            THEN $22::text
          ELSE network_profiles.external_consent_version
        END,
        updated_at = NOW()
      RETURNING user_id AS "userId", headline, organization, role_title AS "roleTitle",
                city, country, bio, collaboration_goals AS "collaborationGoals",
                profile_photo_url AS "profilePhotoUrl", cover_image_url AS "coverImageUrl",
                experience, featured_links AS "featuredLinks",
                skills, interests, linkedin_url AS "linkedinUrl",
                contact_email AS "contactEmail", is_visible AS "isVisible",
                show_email AS "showEmail", show_linkedin AS "showLinkedin",
                available_for_contact AS "availableForContact",
                external_visible AS "externalVisible",
                internal_consent_at AS "internalConsentAt",
                internal_consent_version AS "internalConsentVersion",
                external_consent_at AS "externalConsentAt",
                external_consent_version AS "externalConsentVersion",
                updated_at AS "updatedAt"
    `, [
      req.user.userId,
      payload.headline,
      payload.organization,
      payload.roleTitle,
      payload.city,
      payload.country,
      payload.bio,
      payload.collaborationGoals,
      payload.profilePhotoUrl,
      payload.coverImageUrl,
      JSON.stringify(payload.experience),
      JSON.stringify(payload.featuredLinks),
      payload.skills,
      payload.interests,
      payload.linkedinUrl,
      payload.contactEmail,
      payload.isVisible,
      payload.showEmail,
      payload.showLinkedin,
      payload.availableForContact,
      payload.externalVisible,
      NETWORK_CONSENT_VERSION
    ]);

    const userRes = await pool.query(
      'SELECT email AS "userEmail", first_name AS "firstName", last_name AS "lastName", role, avatar_url AS "userAvatarUrl" FROM users WHERE id = $1',
      [req.user.userId]
    );
    res.json(buildNetworkProfile({ ...rows[0], ...userRes.rows[0] }, { exposePrivate: true }));
  } catch (error) {
    console.error('Update network profile error:', error);
    res.status(500).json({ error: 'Errore nel salvataggio profilo network' });
  }
});

app.get('/api/lms/network/profiles', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const networkSettings = await loadNetworkSettings();
    if (!isNetworkFlagEnabled(networkSettings, 'network_enabled') || !isNetworkFlagEnabled(networkSettings, 'profiles_enabled')) {
      return res.json([]);
    }
    const { rows } = await pool.query(`
      SELECT u.id AS "userId", u.email AS "userEmail",
             u.first_name AS "firstName", u.last_name AS "lastName", u.role,
             u.avatar_url AS "userAvatarUrl",
             p.headline, p.organization, p.role_title AS "roleTitle",
             p.city, p.country, p.bio, p.skills, p.interests,
             p.profile_photo_url AS "profilePhotoUrl",
             p.cover_image_url AS "coverImageUrl",
             p.collaboration_goals AS "collaborationGoals",
             p.experience, p.featured_links AS "featuredLinks",
             p.linkedin_url AS "linkedinUrl", p.contact_email AS "contactEmail",
             p.is_visible AS "isVisible", p.show_email AS "showEmail",
             p.show_linkedin AS "showLinkedin",
             p.available_for_contact AS "availableForContact",
             (SELECT COUNT(*)::int FROM network_follows f WHERE f.following_user_id = u.id) AS "followersCount",
             (SELECT COUNT(*)::int FROM network_follows f WHERE f.follower_user_id = u.id) AS "followingCount",
             (SELECT COUNT(*)::int FROM network_posts post WHERE post.author_user_id = u.id AND post.is_deleted = false) AS "postsCount",
             EXISTS (
               SELECT 1 FROM network_follows f
               WHERE f.follower_user_id = $1 AND f.following_user_id = u.id
             ) AS "isFollowing",
             EXISTS (
               SELECT 1 FROM network_follows f
               WHERE f.follower_user_id = u.id AND f.following_user_id = $1
             ) AS "isFollowedBy",
             EXISTS (
               SELECT 1
               FROM network_follows f1
               JOIN network_follows f2
                 ON f1.follower_user_id = f2.following_user_id
                AND f1.following_user_id = f2.follower_user_id
               WHERE f1.follower_user_id = $1 AND f1.following_user_id = u.id
             ) AS "isConnected",
             p.updated_at AS "updatedAt"
      FROM network_profiles p
      JOIN users u ON u.id = p.user_id
      WHERE p.is_visible = true
        AND u.is_active = true
      ORDER BY u.last_name ASC, u.first_name ASC
      LIMIT 300
    `, [req.user.userId]);

    res.json(rows.map(buildNetworkProfile));
  } catch (error) {
    console.error('List network profiles error:', error);
    res.status(500).json({ error: 'Errore nel recupero network' });
  }
});

// Fase 2 — profili docente navigabili dall'area studente. Riusa la tabella faculty
// esistente (dati già pubblici sul sito) e mostra "chi ha insegnato cosa" aggregando
// i moduli/lezioni assegnati al docente, con un contatto per tesi/mentorship.
app.get('/api/lms/network/faculty', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const networkSettings = await loadNetworkSettings();
    if (!isNetworkFlagEnabled(networkSettings, 'network_enabled')) {
      return res.json([]);
    }
    const { rows } = await pool.query(`
      SELECT f.id, f.name, f.role, f.email, f.bio,
             f.photo_url AS "photoUrl", f.profile_link AS "profileLink",
             COALESCE(
               JSON_AGG(DISTINCT JSONB_BUILD_OBJECT('id', m.id, 'name', m.name))
                 FILTER (WHERE m.id IS NOT NULL),
               '[]'::json
             ) AS modules,
             COUNT(DISTINCT l.id)::int AS "lessonsCount"
      FROM faculty f
      LEFT JOIN lessons l ON l.teacher_id = f.id
      LEFT JOIN modules m ON m.id = l.module_id
      WHERE f.is_published = true
      GROUP BY f.id, f.name, f.role, f.email, f.bio, f.photo_url, f.profile_link, f.sort_order, f.created_at
      ORDER BY f.sort_order NULLS LAST, f.created_at ASC
    `);
    res.json(rows.map(buildNetworkFaculty));
  } catch (error) {
    console.error('List network faculty error:', error);
    res.status(500).json({ error: 'Errore nel recupero docenti' });
  }
});

// Fase 3a — bacheca opportunità (lato studente): solo opportunità pubblicate,
// con lo stato della candidatura dello studente corrente.
app.get('/api/lms/network/opportunities', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const networkSettings = await loadNetworkSettings();
    if (!isNetworkFlagEnabled(networkSettings, 'network_enabled')) {
      return res.json([]);
    }
    const { rows } = await pool.query(`
      SELECT o.id, o.title, o.type, o.organization, o.location, o.description,
             o.apply_url AS "applyUrl", o.contact_email AS "contactEmail",
             o.deadline, o.created_at AS "createdAt", o.updated_at AS "updatedAt",
             (a.id IS NOT NULL) AS "hasApplied",
             a.status AS "applicationStatus"
      FROM network_opportunities o
      LEFT JOIN network_opportunity_applications a
        ON a.opportunity_id = o.id AND a.user_id = $1
      WHERE o.is_published = true
      ORDER BY o.deadline ASC NULLS LAST, o.created_at DESC
    `, [req.user.userId]);
    res.json(rows.map((row) => buildNetworkOpportunity(row)));
  } catch (error) {
    console.error('List network opportunities error:', error);
    res.status(500).json({ error: 'Errore nel recupero opportunità' });
  }
});

app.post('/api/lms/network/opportunities/:id/apply', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const networkSettings = await loadNetworkSettings();
    if (!isNetworkFlagEnabled(networkSettings, 'network_enabled')) {
      return res.status(403).json({ error: 'Bacheca opportunità non disponibile al momento' });
    }
    const { rows: opp } = await pool.query(
      'SELECT id FROM network_opportunities WHERE id = $1 AND is_published = true LIMIT 1',
      [req.params.id]
    );
    if (!opp.length) return res.status(404).json({ error: 'Opportunità non trovata' });

    const message = normalizeNetworkText(req.body?.message, 1000);
    const { rows } = await pool.query(`
      INSERT INTO network_opportunity_applications (opportunity_id, user_id, message, status)
      VALUES ($1, $2, $3, 'submitted')
      ON CONFLICT (opportunity_id, user_id) DO UPDATE SET
        message = EXCLUDED.message,
        status = 'submitted',
        updated_at = NOW()
      RETURNING id, status, message, created_at AS "createdAt", updated_at AS "updatedAt"
    `, [req.params.id, req.user.userId, message]);

    res.status(201).json({ ...rows[0], hasApplied: true });
  } catch (error) {
    console.error('Apply to opportunity error:', error);
    res.status(500).json({ error: 'Errore durante la candidatura' });
  }
});

app.get('/api/lms/network/intro-requests', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const networkSettings = await loadNetworkSettings();
    if (!isNetworkFlagEnabled(networkSettings, 'network_enabled') || !isNetworkFlagEnabled(networkSettings, 'intro_requests_enabled')) {
      return res.json([]);
    }
    const { rows } = await pool.query(`
      SELECT r.id, r.status, r.message,
             r.created_at AS "createdAt", r.updated_at AS "updatedAt",
             CASE WHEN r.sender_user_id = $1 THEN 'sent' ELSE 'received' END AS direction,
             u.id AS "participantUserId", u.email AS "participantEmail",
             u.first_name AS "participantFirstName", u.last_name AS "participantLastName",
             u.avatar_url AS "participantAvatarUrl",
             p.headline AS "participantHeadline",
             p.organization AS "participantOrganization",
             p.role_title AS "participantRoleTitle",
             p.profile_photo_url AS "participantProfilePhotoUrl",
             p.linkedin_url AS "participantLinkedinUrl",
             p.contact_email AS "participantContactEmail",
             p.show_email AS "participantShowEmail",
             p.show_linkedin AS "participantShowLinkedin"
      FROM network_intro_requests r
      JOIN users u ON u.id = CASE WHEN r.sender_user_id = $1 THEN r.recipient_user_id ELSE r.sender_user_id END
      LEFT JOIN network_profiles p ON p.user_id = u.id
      WHERE r.sender_user_id = $1 OR r.recipient_user_id = $1
      ORDER BY r.created_at DESC
      LIMIT 100
    `, [req.user.userId]);

    res.json(rows.map(buildNetworkIntroRequest));
  } catch (error) {
    console.error('List network intro requests error:', error);
    res.status(500).json({ error: 'Errore nel recupero richieste network' });
  }
});

app.post('/api/lms/network/intro-requests', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const networkSettings = await loadNetworkSettings();
    if (!isNetworkFlagEnabled(networkSettings, 'network_enabled') || !isNetworkFlagEnabled(networkSettings, 'intro_requests_enabled')) {
      return res.status(403).json({ error: 'Le richieste di contatto sono temporaneamente disabilitate' });
    }
    const recipientUserId = normalizeNetworkText(req.body.recipientUserId, 80);
    const message = normalizeNetworkText(req.body.message, 700);

    if (!recipientUserId) {
      return res.status(400).json({ error: 'Destinatario richiesto' });
    }
    if (recipientUserId === req.user.userId) {
      return res.status(400).json({ error: 'Non puoi inviare una richiesta a te stesso' });
    }

    const recipientRes = await pool.query(`
      SELECT p.user_id
      FROM network_profiles p
      JOIN users u ON u.id = p.user_id
      WHERE p.user_id = $1
        AND p.is_visible = true
        AND p.available_for_contact = true
        AND u.is_active = true
    `, [recipientUserId]);

    if (!recipientRes.rows.length) {
      return res.status(404).json({ error: 'Profilo non disponibile per il contatto' });
    }

    const { rows } = await pool.query(`
      INSERT INTO network_intro_requests (
        sender_user_id, recipient_user_id, message, status, created_at, updated_at
      )
      VALUES ($1, $2, $3, 'pending', NOW(), NOW())
      ON CONFLICT (sender_user_id, recipient_user_id) WHERE status = 'pending'
      DO UPDATE SET message = EXCLUDED.message, updated_at = NOW()
      RETURNING id, status, message, created_at AS "createdAt", updated_at AS "updatedAt"
    `, [req.user.userId, recipientUserId, message]);

    await insertNetworkNotification({
      userId: recipientUserId,
      type: 'intro_request',
      entityType: 'network_intro_request',
      entityId: rows[0].id,
      payload: { senderUserId: req.user.userId, message }
    });

    res.status(201).json(rows[0]);
  } catch (error) {
    console.error('Create network intro request error:', error);
    res.status(500).json({ error: 'Errore nell invio richiesta network' });
  }
});

app.patch('/api/lms/network/intro-requests/:id', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const networkSettings = await loadNetworkSettings();
    if (!isNetworkFlagEnabled(networkSettings, 'network_enabled') || !isNetworkFlagEnabled(networkSettings, 'intro_requests_enabled')) {
      return res.status(403).json({ error: 'Le richieste di contatto sono temporaneamente disabilitate' });
    }
    const status = normalizeNetworkText(req.body.status, 20);
    if (!['accepted', 'declined', 'archived'].includes(status)) {
      return res.status(400).json({ error: 'Stato richiesta non valido' });
    }

    const ownerRes = await pool.query(`
      SELECT sender_user_id AS "senderUserId", recipient_user_id AS "recipientUserId"
      FROM network_intro_requests
      WHERE id = $1
    `, [req.params.id]);
    if (!ownerRes.rows.length) {
      return res.status(404).json({ error: 'Richiesta non trovata' });
    }

    const { rows } = await pool.query(`
      UPDATE network_intro_requests
      SET status = $1, updated_at = NOW()
      WHERE id = $2
        AND recipient_user_id = $3
        AND status = 'pending'
      RETURNING id, status, message, created_at AS "createdAt", updated_at AS "updatedAt"
    `, [status, req.params.id, req.user.userId]);

    if (!rows.length) {
      return res.status(404).json({ error: 'Richiesta non trovata' });
    }

    const targetUserId = ownerRes.rows[0].senderUserId;
    if (targetUserId && targetUserId !== req.user.userId) {
      await insertNetworkNotification({
        userId: targetUserId,
        type: `intro_request_${status}`,
        entityType: 'network_intro_request',
        entityId: req.params.id,
        payload: { status }
      });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error('Update network intro request error:', error);
    res.status(500).json({ error: 'Errore nell aggiornamento richiesta network' });
  }
});

app.get('/api/lms/network/posts', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const networkSettings = await loadNetworkSettings();
    if (!isNetworkFlagEnabled(networkSettings, 'network_enabled') || !isNetworkFlagEnabled(networkSettings, 'posts_enabled')) {
      return res.json([]);
    }
    const { rows } = await pool.query(`
      SELECT post.id, post.body, post.link_url AS "linkUrl",
             post.link_title AS "linkTitle", post.media_url AS "mediaUrl",
             post.media_alt AS "mediaAlt",
             post.link_preview_title AS "linkPreviewTitle",
             post.link_preview_description AS "linkPreviewDescription",
             post.link_preview_image_url AS "linkPreviewImageUrl",
             post.link_preview_site_name AS "linkPreviewSiteName",
             post.tags, post.visibility,
             post.created_at AS "createdAt", post.updated_at AS "updatedAt",
             post.author_user_id AS "authorUserId",
             u.first_name AS "authorFirstName", u.last_name AS "authorLastName",
             u.avatar_url AS "authorAvatarUrl",
             p.headline AS "authorHeadline",
             p.organization AS "authorOrganization",
             p.role_title AS "authorRoleTitle",
             p.profile_photo_url AS "authorProfilePhotoUrl",
             (SELECT COUNT(*)::int FROM network_post_likes l WHERE l.post_id = post.id) AS "likeCount",
             (SELECT COUNT(*)::int FROM network_post_comments c WHERE c.post_id = post.id AND c.is_deleted = false) AS "commentCount",
             EXISTS (
               SELECT 1 FROM network_post_likes l
               WHERE l.post_id = post.id AND l.user_id = $1
             ) AS "isLiked",
             (post.author_user_id = $1) AS "canDelete"
      FROM network_posts post
      JOIN users u ON u.id = post.author_user_id
      LEFT JOIN network_profiles p ON p.user_id = u.id
      WHERE post.is_deleted = false
        AND u.is_active = true
      ORDER BY post.created_at DESC
      LIMIT 100
    `, [req.user.userId]);

    res.json(rows.map(buildNetworkPost));
  } catch (error) {
    console.error('List network posts error:', error);
    res.status(500).json({ error: 'Errore nel recupero post network' });
  }
});

app.post('/api/lms/network/posts', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const networkSettings = await loadNetworkSettings();
    if (!isNetworkFlagEnabled(networkSettings, 'network_enabled') || !isNetworkFlagEnabled(networkSettings, 'posts_enabled')) {
      return res.status(403).json({ error: 'La pubblicazione dei post è temporaneamente disabilitata' });
    }
    const body = normalizeNetworkText(req.body.body, 1600);
    const linkUrl = normalizeNetworkUrl(req.body.linkUrl);
    const linkTitle = normalizeNetworkText(req.body.linkTitle, 160);
    const mediaUrl = normalizeNetworkUrl(req.body.mediaUrl);
    const mediaAlt = normalizeNetworkText(req.body.mediaAlt, 180);
    const tags = normalizeNetworkList(req.body.tags).slice(0, 8);

    if (!body || body.length < 3) {
      return res.status(400).json({ error: 'Scrivi un contenuto per pubblicare il post' });
    }

    const allowLinkPreviews = isNetworkFlagEnabled(networkSettings, 'link_previews_enabled');
    const linkPreview = allowLinkPreviews && linkUrl ? await fetchNetworkLinkPreview(linkUrl) : null;

    const { rows } = await pool.query(`
      INSERT INTO network_posts (
        author_user_id, body, link_url, link_title, media_url, media_alt,
        link_preview_title, link_preview_description, link_preview_image_url, link_preview_site_name,
        tags, visibility, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
              $11::text[], 'network', NOW(), NOW())
      RETURNING id, body, link_url AS "linkUrl", link_title AS "linkTitle",
                media_url AS "mediaUrl", media_alt AS "mediaAlt",
                link_preview_title AS "linkPreviewTitle",
                link_preview_description AS "linkPreviewDescription",
                link_preview_image_url AS "linkPreviewImageUrl",
                link_preview_site_name AS "linkPreviewSiteName",
                tags, visibility, created_at AS "createdAt", updated_at AS "updatedAt",
                author_user_id AS "authorUserId", true AS "canDelete"
    `, [
      req.user.userId,
      body,
      linkUrl,
      linkTitle,
      mediaUrl,
      mediaAlt,
      linkPreview?.title || null,
      linkPreview?.description || null,
      linkPreview?.imageUrl || null,
      linkPreview?.siteName || null,
      tags
    ]);

    const authorRes = await pool.query(`
      SELECT u.first_name AS "authorFirstName", u.last_name AS "authorLastName",
             u.avatar_url AS "authorAvatarUrl",
             p.headline AS "authorHeadline",
             p.organization AS "authorOrganization",
             p.role_title AS "authorRoleTitle",
             p.profile_photo_url AS "authorProfilePhotoUrl"
      FROM users u
      LEFT JOIN network_profiles p ON p.user_id = u.id
      WHERE u.id = $1
    `, [req.user.userId]);

    res.status(201).json(buildNetworkPost({
      ...rows[0],
      ...authorRes.rows[0],
      likeCount: 0,
      commentCount: 0,
      isLiked: false
    }));
  } catch (error) {
    console.error('Create network post error:', error);
    res.status(500).json({ error: 'Errore nella pubblicazione del post' });
  }
});

app.delete('/api/lms/network/posts/:id', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const networkSettings = await loadNetworkSettings();
    if (!isNetworkFlagEnabled(networkSettings, 'network_enabled') || !isNetworkFlagEnabled(networkSettings, 'posts_enabled')) {
      return res.status(403).json({ error: 'La gestione dei post è temporaneamente disabilitata' });
    }
    const { rows } = await pool.query(`
      UPDATE network_posts
      SET is_deleted = true, updated_at = NOW()
      WHERE id = $1
        AND author_user_id = $2
        AND is_deleted = false
      RETURNING id
    `, [req.params.id, req.user.userId]);

    if (!rows.length) {
      return res.status(404).json({ error: 'Post non trovato' });
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('Delete network post error:', error);
    res.status(500).json({ error: 'Errore nella cancellazione del post' });
  }
});

app.get('/api/lms/network/posts/:id/comments', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const networkSettings = await loadNetworkSettings();
    if (!isNetworkFlagEnabled(networkSettings, 'network_enabled')) {
      return res.json([]);
    }
    const { rows } = await pool.query(`
      SELECT c.id, c.post_id AS "postId", c.body, c.created_at AS "createdAt",
             c.updated_at AS "updatedAt",
             c.user_id AS "authorUserId",
             u.first_name AS "authorFirstName", u.last_name AS "authorLastName",
             u.avatar_url AS "authorAvatarUrl",
             p.headline AS "authorHeadline",
             p.organization AS "authorOrganization",
             p.role_title AS "authorRoleTitle",
             p.profile_photo_url AS "authorProfilePhotoUrl",
             (c.user_id = $2) AS "canDelete"
      FROM network_post_comments c
      JOIN users u ON u.id = c.user_id
      LEFT JOIN network_profiles p ON p.user_id = u.id
      WHERE c.post_id = $1 AND c.is_deleted = false
      ORDER BY c.created_at ASC
      LIMIT 200
    `, [req.params.id, req.user.userId]);
    res.json(rows.map(buildNetworkComment));
  } catch (error) {
    console.error('List network comments error:', error);
    res.status(500).json({ error: 'Errore nel recupero commenti' });
  }
});

app.post('/api/lms/network/posts/:id/comments', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const networkSettings = await loadNetworkSettings();
    if (!isNetworkFlagEnabled(networkSettings, 'network_enabled')) {
      return res.status(403).json({ error: 'Commenti non disponibili' });
    }
    const body = normalizeNetworkText(req.body.body, 1200);
    if (!body || body.length < 2) {
      return res.status(400).json({ error: 'Scrivi un commento valido' });
    }
    const postRes = await pool.query('SELECT author_user_id AS "authorUserId" FROM network_posts WHERE id = $1 AND is_deleted = false', [req.params.id]);
    if (!postRes.rows.length) {
      return res.status(404).json({ error: 'Post non trovato' });
    }
    const { rows } = await pool.query(`
      INSERT INTO network_post_comments (post_id, user_id, body, created_at, updated_at)
      VALUES ($1, $2, $3, NOW(), NOW())
      RETURNING id, post_id AS "postId", body, created_at AS "createdAt", updated_at AS "updatedAt",
                user_id AS "authorUserId", true AS "canDelete"
    `, [req.params.id, req.user.userId, body]);
    const authorRes = await pool.query(`
      SELECT u.first_name AS "authorFirstName", u.last_name AS "authorLastName",
             u.avatar_url AS "authorAvatarUrl",
             p.headline AS "authorHeadline",
             p.organization AS "authorOrganization",
             p.role_title AS "authorRoleTitle",
             p.profile_photo_url AS "authorProfilePhotoUrl"
      FROM users u
      LEFT JOIN network_profiles p ON p.user_id = u.id
      WHERE u.id = $1
    `, [req.user.userId]);
    await insertNetworkNotification({
      userId: postRes.rows[0].authorUserId,
      type: 'post_comment',
      entityType: 'network_post',
      entityId: req.params.id,
      payload: { postId: req.params.id, commentId: rows[0].id, commentBody: body }
    });
    res.status(201).json(buildNetworkComment({ ...rows[0], ...authorRes.rows[0] }));
  } catch (error) {
    console.error('Create network comment error:', error);
    res.status(500).json({ error: 'Errore nella creazione commento' });
  }
});

app.delete('/api/lms/network/comments/:id', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      UPDATE network_post_comments
      SET is_deleted = true, updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND is_deleted = false
      RETURNING id
    `, [req.params.id, req.user.userId]);
    if (!rows.length) {
      return res.status(404).json({ error: 'Commento non trovato' });
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Delete network comment error:', error);
    res.status(500).json({ error: 'Errore nella cancellazione commento' });
  }
});

app.post('/api/lms/network/posts/:id/likes', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const networkSettings = await loadNetworkSettings();
    if (!isNetworkFlagEnabled(networkSettings, 'network_enabled')) {
      return res.status(403).json({ error: 'Like non disponibili' });
    }
    const postRes = await pool.query('SELECT author_user_id AS "authorUserId" FROM network_posts WHERE id = $1 AND is_deleted = false', [req.params.id]);
    if (!postRes.rows.length) {
      return res.status(404).json({ error: 'Post non trovato' });
    }
    await pool.query(`
      INSERT INTO network_post_likes (post_id, user_id, created_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (post_id, user_id) DO NOTHING
    `, [req.params.id, req.user.userId]);
    if (postRes.rows[0].authorUserId !== req.user.userId) {
      await insertNetworkNotification({
        userId: postRes.rows[0].authorUserId,
        type: 'post_like',
        entityType: 'network_post',
        entityId: req.params.id,
        payload: { postId: req.params.id }
      });
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Like network post error:', error);
    res.status(500).json({ error: 'Errore nel mettere like al post' });
  }
});

app.delete('/api/lms/network/posts/:id/likes', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    await pool.query(`
      DELETE FROM network_post_likes
      WHERE post_id = $1 AND user_id = $2
    `, [req.params.id, req.user.userId]);
    res.json({ ok: true });
  } catch (error) {
    console.error('Unlike network post error:', error);
    res.status(500).json({ error: 'Errore nel rimuovere il like' });
  }
});

app.post('/api/lms/network/follows', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const targetUserId = normalizeNetworkText(req.body.targetUserId, 80);
    if (!targetUserId || targetUserId === req.user.userId) {
      return res.status(400).json({ error: 'Utente non valido' });
    }
    const networkSettings = await loadNetworkSettings();
    if (!isNetworkFlagEnabled(networkSettings, 'network_enabled')) {
      return res.status(403).json({ error: 'Follow non disponibili' });
    }
    const targetRes = await pool.query(`
      SELECT p.user_id
      FROM network_profiles p
      JOIN users u ON u.id = p.user_id
      WHERE p.user_id = $1 AND p.is_visible = true AND u.is_active = true
    `, [targetUserId]);
    if (!targetRes.rows.length) {
      return res.status(404).json({ error: 'Profilo non trovato' });
    }
    await pool.query(`
      INSERT INTO network_follows (follower_user_id, following_user_id, created_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (follower_user_id, following_user_id) DO NOTHING
    `, [req.user.userId, targetUserId]);
    await insertNetworkNotification({
      userId: targetUserId,
      type: 'follow',
      entityType: 'network_profile',
      entityId: targetUserId,
      payload: { followerUserId: req.user.userId }
    });
    res.json({ ok: true });
  } catch (error) {
    console.error('Create follow error:', error);
    res.status(500).json({ error: 'Errore nel follow' });
  }
});

app.delete('/api/lms/network/follows/:userId', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    await pool.query(`
      DELETE FROM network_follows
      WHERE follower_user_id = $1 AND following_user_id = $2
    `, [req.user.userId, req.params.userId]);
    res.json({ ok: true });
  } catch (error) {
    console.error('Delete follow error:', error);
    res.status(500).json({ error: 'Errore nella rimozione follow' });
  }
});

app.get('/api/lms/network/notifications', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT id, type, entity_type AS "entityType", entity_id AS "entityId",
             payload, is_read AS "isRead", created_at AS "createdAt", read_at AS "readAt"
      FROM network_notifications
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 100
    `, [req.user.userId]);
    res.json(rows.map(buildNetworkNotification));
  } catch (error) {
    console.error('Get network notifications error:', error);
    res.status(500).json({ error: 'Errore nel recupero notifiche' });
  }
});

app.patch('/api/lms/network/notifications/:id/read', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      UPDATE network_notifications
      SET is_read = true, read_at = NOW()
      WHERE id = $1 AND user_id = $2
      RETURNING id
    `, [req.params.id, req.user.userId]);
    if (!rows.length) {
      return res.status(404).json({ error: 'Notifica non trovata' });
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Mark notification read error:', error);
    res.status(500).json({ error: 'Errore nell aggiornamento notifica' });
  }
});

app.get('/api/admin/network/settings', requireAdmin, async (_req, res) => {
  if (!ensurePool(res)) return;
  try {
    const settings = await loadNetworkSettings();
    res.json({
      networkEnabled: isNetworkFlagEnabled(settings, 'network_enabled'),
      profilesEnabled: isNetworkFlagEnabled(settings, 'profiles_enabled'),
      postsEnabled: isNetworkFlagEnabled(settings, 'posts_enabled'),
      introRequestsEnabled: isNetworkFlagEnabled(settings, 'intro_requests_enabled'),
      profilePhotosEnabled: isNetworkFlagEnabled(settings, 'profile_photos_enabled'),
      linkPreviewsEnabled: isNetworkFlagEnabled(settings, 'link_previews_enabled')
    });
  } catch (error) {
    console.error('Get admin network settings error:', error);
    res.status(500).json({ error: 'Errore nel recupero configurazione network' });
  }
});

app.put('/api/admin/network/settings', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const payload = {
      network_enabled: normalizeBoolean(req.body.networkEnabled, true),
      profiles_enabled: normalizeBoolean(req.body.profilesEnabled, true),
      posts_enabled: normalizeBoolean(req.body.postsEnabled, true),
      intro_requests_enabled: normalizeBoolean(req.body.introRequestsEnabled, true),
      profile_photos_enabled: normalizeBoolean(req.body.profilePhotosEnabled, true),
      link_previews_enabled: normalizeBoolean(req.body.linkPreviewsEnabled, true)
    };

    const entries = Object.entries(payload);
    for (const [key, value] of entries) {
      await pool.query(`
        INSERT INTO network_settings (key, value, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `, [key, String(value)]);
    }

    res.json({
      networkEnabled: normalizeBoolean(payload.network_enabled, true),
      profilesEnabled: normalizeBoolean(payload.profiles_enabled, true),
      postsEnabled: normalizeBoolean(payload.posts_enabled, true),
      introRequestsEnabled: normalizeBoolean(payload.intro_requests_enabled, true),
      profilePhotosEnabled: normalizeBoolean(payload.profile_photos_enabled, true),
      linkPreviewsEnabled: normalizeBoolean(payload.link_previews_enabled, true)
    });
  } catch (error) {
    console.error('Update admin network settings error:', error);
    res.status(500).json({ error: 'Errore nel salvataggio configurazione network' });
  }
});

app.get('/api/admin/network/profiles', requireAdmin, async (_req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT u.id AS "userId", u.email AS "userEmail",
             u.first_name AS "firstName", u.last_name AS "lastName", u.role,
             u.avatar_url AS "userAvatarUrl",
             p.headline, p.organization, p.role_title AS "roleTitle",
             p.city, p.country, p.bio, p.skills, p.interests,
             p.profile_photo_url AS "profilePhotoUrl",
             p.cover_image_url AS "coverImageUrl",
             p.collaboration_goals AS "collaborationGoals",
             p.experience, p.featured_links AS "featuredLinks",
             p.linkedin_url AS "linkedinUrl", p.contact_email AS "contactEmail",
             p.is_visible AS "isVisible", p.show_email AS "showEmail",
             p.show_linkedin AS "showLinkedin",
             p.available_for_contact AS "availableForContact",
             COALESCE(p.external_visible, false) AS "externalVisible",
             p.internal_consent_at AS "internalConsentAt",
             p.internal_consent_version AS "internalConsentVersion",
             p.external_consent_at AS "externalConsentAt",
             p.external_consent_version AS "externalConsentVersion",
             (SELECT COUNT(*)::int FROM network_follows f WHERE f.following_user_id = u.id) AS "followersCount",
             (SELECT COUNT(*)::int FROM network_follows f WHERE f.follower_user_id = u.id) AS "followingCount",
             (SELECT COUNT(*)::int FROM network_posts post WHERE post.author_user_id = u.id AND post.is_deleted = false) AS "postsCount",
             u.created_at AS "createdAt",
             p.updated_at AS "updatedAt"
      FROM users u
      LEFT JOIN network_profiles p ON p.user_id = u.id
      WHERE u.role <> 'admin'
      ORDER BY COALESCE(p.updated_at, u.created_at) DESC NULLS LAST, u.last_name ASC, u.first_name ASC
      LIMIT 250
    `);
    res.json(rows.map(buildNetworkAdminProfile));
  } catch (error) {
    console.error('List admin network profiles error:', error);
    res.status(500).json({ error: 'Errore nel recupero profili network' });
  }
});

app.get('/api/admin/network/posts', requireAdmin, async (_req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT post.id, post.body, post.link_url AS "linkUrl",
             post.link_title AS "linkTitle", post.media_url AS "mediaUrl",
             post.media_alt AS "mediaAlt",
             post.link_preview_title AS "linkPreviewTitle",
             post.link_preview_description AS "linkPreviewDescription",
             post.link_preview_image_url AS "linkPreviewImageUrl",
             post.link_preview_site_name AS "linkPreviewSiteName",
             post.tags, post.visibility,
             post.created_at AS "createdAt", post.updated_at AS "updatedAt",
             post.author_user_id AS "authorUserId",
             u.first_name AS "authorFirstName", u.last_name AS "authorLastName",
             u.avatar_url AS "authorAvatarUrl",
             p.headline AS "authorHeadline",
             p.organization AS "authorOrganization",
             p.role_title AS "authorRoleTitle",
             p.profile_photo_url AS "authorProfilePhotoUrl",
             (SELECT COUNT(*)::int FROM network_post_likes l WHERE l.post_id = post.id) AS "likeCount",
             (SELECT COUNT(*)::int FROM network_post_comments c WHERE c.post_id = post.id AND c.is_deleted = false) AS "commentCount",
             (post.is_deleted = false) AS "isVisible"
      FROM network_posts post
      JOIN users u ON u.id = post.author_user_id
      LEFT JOIN network_profiles p ON p.user_id = u.id
      ORDER BY post.created_at DESC
      LIMIT 200
    `);
    res.json(rows.map(buildNetworkPost));
  } catch (error) {
    console.error('List admin network posts error:', error);
    res.status(500).json({ error: 'Errore nel recupero post network' });
  }
});

app.get('/api/admin/network/intro-requests', requireAdmin, async (_req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT r.id, r.status, r.message,
             r.created_at AS "createdAt", r.updated_at AS "updatedAt",
             sender.id AS "senderUserId",
             sender.first_name AS "senderFirstName", sender.last_name AS "senderLastName",
             recipient.id AS "recipientUserId",
             recipient.first_name AS "recipientFirstName", recipient.last_name AS "recipientLastName"
      FROM network_intro_requests r
      JOIN users sender ON sender.id = r.sender_user_id
      JOIN users recipient ON recipient.id = r.recipient_user_id
      ORDER BY r.created_at DESC
      LIMIT 200
    `);
    res.json(rows);
  } catch (error) {
    console.error('List admin network intro requests error:', error);
    res.status(500).json({ error: 'Errore nel recupero richieste network' });
  }
});

app.get('/api/admin/network/notifications', requireAdmin, async (_req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT COUNT(*)::int AS unreadCount,
             COUNT(*) FILTER (WHERE type = 'follow')::int AS followCount,
             COUNT(*) FILTER (WHERE type = 'post_like')::int AS likeCount,
             COUNT(*) FILTER (WHERE type = 'post_comment')::int AS commentCount,
             COUNT(*) FILTER (WHERE type = 'intro_request')::int AS introRequestCount
      FROM network_notifications
    `);
    res.json(rows[0] || {
      unreadCount: 0,
      followCount: 0,
      likeCount: 0,
      commentCount: 0,
      introRequestCount: 0
    });
  } catch (error) {
    console.error('Get admin network notifications summary error:', error);
    res.status(500).json({ error: 'Errore nel recupero statistiche network' });
  }
});

// Fase 3a — gestione admin della bacheca opportunità.
app.get('/api/admin/network/opportunities', requireAdmin, async (_req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT o.id, o.title, o.type, o.organization, o.location, o.description,
             o.apply_url AS "applyUrl", o.contact_email AS "contactEmail",
             o.deadline, o.is_published AS "isPublished",
             o.created_at AS "createdAt", o.updated_at AS "updatedAt",
             (SELECT COUNT(*)::int FROM network_opportunity_applications a WHERE a.opportunity_id = o.id) AS "applicationsCount"
      FROM network_opportunities o
      ORDER BY o.created_at DESC
      LIMIT 250
    `);
    res.json(rows.map((row) => buildNetworkOpportunity(row, { includeAdminFields: true })));
  } catch (error) {
    console.error('List admin opportunities error:', error);
    res.status(500).json({ error: 'Errore nel recupero opportunità' });
  }
});

app.post('/api/admin/network/opportunities', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const title = normalizeNetworkText(req.body?.title, 200);
    const description = normalizeNetworkText(req.body?.description, 4000);
    if (!title || !description) {
      return res.status(400).json({ error: 'Titolo e descrizione sono obbligatori' });
    }
    const { rows } = await pool.query(`
      INSERT INTO network_opportunities
        (title, type, organization, location, description, apply_url, contact_email, deadline, is_published)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, title, type, organization, location, description,
                apply_url AS "applyUrl", contact_email AS "contactEmail",
                deadline, is_published AS "isPublished",
                created_at AS "createdAt", updated_at AS "updatedAt"
    `, [
      title,
      normalizeOpportunityType(req.body?.type),
      normalizeNetworkText(req.body?.organization, 200),
      normalizeNetworkText(req.body?.location, 200),
      description,
      normalizeNetworkUrl(req.body?.applyUrl),
      normalizeNetworkText(req.body?.contactEmail, 200),
      req.body?.deadline || null,
      normalizeBoolean(req.body?.isPublished, false)
    ]);
    res.status(201).json(buildNetworkOpportunity(rows[0], { includeAdminFields: true }));
  } catch (error) {
    console.error('Create opportunity error:', error);
    res.status(500).json({ error: 'Errore nella creazione opportunità' });
  }
});

app.put('/api/admin/network/opportunities/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const title = normalizeNetworkText(req.body?.title, 200);
    const description = normalizeNetworkText(req.body?.description, 4000);
    if (!title || !description) {
      return res.status(400).json({ error: 'Titolo e descrizione sono obbligatori' });
    }
    const { rows } = await pool.query(`
      UPDATE network_opportunities SET
        title = $2, type = $3, organization = $4, location = $5, description = $6,
        apply_url = $7, contact_email = $8, deadline = $9, is_published = $10,
        updated_at = NOW()
      WHERE id = $1
      RETURNING id, title, type, organization, location, description,
                apply_url AS "applyUrl", contact_email AS "contactEmail",
                deadline, is_published AS "isPublished",
                created_at AS "createdAt", updated_at AS "updatedAt"
    `, [
      req.params.id,
      title,
      normalizeOpportunityType(req.body?.type),
      normalizeNetworkText(req.body?.organization, 200),
      normalizeNetworkText(req.body?.location, 200),
      description,
      normalizeNetworkUrl(req.body?.applyUrl),
      normalizeNetworkText(req.body?.contactEmail, 200),
      req.body?.deadline || null,
      normalizeBoolean(req.body?.isPublished, false)
    ]);
    if (!rows.length) return res.status(404).json({ error: 'Opportunità non trovata' });
    res.json(buildNetworkOpportunity(rows[0], { includeAdminFields: true }));
  } catch (error) {
    console.error('Update opportunity error:', error);
    res.status(500).json({ error: 'Errore nell\'aggiornamento opportunità' });
  }
});

app.delete('/api/admin/network/opportunities/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rowCount } = await pool.query('DELETE FROM network_opportunities WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Opportunità non trovata' });
    res.json({ success: true });
  } catch (error) {
    console.error('Delete opportunity error:', error);
    res.status(500).json({ error: 'Errore nell\'eliminazione opportunità' });
  }
});

app.get('/api/admin/network/opportunities/:id/applications', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT a.id, a.status, a.message,
             a.created_at AS "createdAt", a.updated_at AS "updatedAt",
             u.id AS "userId", u.first_name AS "firstName", u.last_name AS "lastName",
             u.email AS "userEmail"
      FROM network_opportunity_applications a
      JOIN users u ON u.id = a.user_id
      WHERE a.opportunity_id = $1
      ORDER BY a.created_at DESC
    `, [req.params.id]);
    res.json(rows.map((row) => ({
      id: row.id,
      status: row.status,
      message: row.message || null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      applicant: {
        userId: row.userId,
        fullName: [row.firstName, row.lastName].filter(Boolean).join(' ').trim(),
        email: row.userEmail || null
      }
    })));
  } catch (error) {
    console.error('List opportunity applications error:', error);
    res.status(500).json({ error: 'Errore nel recupero candidature' });
  }
});

// Corsi dello studente loggato
app.get('/api/lms/my-courses', requireStudent, async (req, res) => {
  if (!ensurePool(res)) return;
  if (req.user.role === 'guest') {
    try {
      if (!req.user.teacherId) {
        return res.json([]);
      }

      const schema = await getCourseEditionSchemaConfig();
      const fragments = buildCourseEditionSelectFragments(schema, 'ce');
      const teacherCourseQuery = `
        SELECT DISTINCT ON (c.id) c.id, c.title, c.slug, c.description, c.cover_image_url AS "coverImageUrl",
               ce.id AS "editionId", ce.edition_name AS "editionName",
               ${fragments.totalPlannedHours},
               ${fragments.minimumInPersonAttendanceRatio},
               NULL::text AS "enrollmentStatus", NULL::timestamptz AS "enrolledAt",
               (SELECT COUNT(*)::int FROM modules m WHERE m.course_id = c.id) AS "totalModules",
               (SELECT COUNT(*)::int FROM lms_lessons ll
                JOIN modules m2 ON m2.id = ll.lms_module_id
                WHERE m2.course_id = c.id AND ll.is_published = true) AS "totalLessons",
               0::numeric AS "attendedHours",
               0::numeric AS "inPersonHours",
               0::int AS "completedLessons"
        FROM lessons l
        JOIN modules m ON m.id = l.module_id
        JOIN courses c ON c.id = m.course_id
        LEFT JOIN course_editions ce ON ce.course_id = c.id
        WHERE l.teacher_id = $1
        ORDER BY c.id, ce.start_date DESC NULLS LAST, ce.created_at DESC NULLS LAST, c.title
      `;
      const { rows: teacherRows } = await pool.query(teacherCourseQuery, [req.user.teacherId]);
      if (teacherRows.length) {
        return res.json(teacherRows);
      }

      const { rows } = await pool.query(`
        SELECT DISTINCT ON (c.id) c.id, c.title, c.slug, c.description, c.cover_image_url AS "coverImageUrl",
               ce.id AS "editionId", ce.edition_name AS "editionName",
               ${fragments.totalPlannedHours},
               ${fragments.minimumInPersonAttendanceRatio},
               NULL::text AS "enrollmentStatus", NULL::timestamptz AS "enrolledAt",
               (SELECT COUNT(*)::int FROM modules m WHERE m.course_id = c.id) AS "totalModules",
               (SELECT COUNT(*)::int FROM lms_lessons ll
                JOIN modules m2 ON m2.id = ll.lms_module_id
                WHERE m2.course_id = c.id AND ll.is_published = true) AS "totalLessons",
               0::numeric AS "attendedHours",
               0::numeric AS "inPersonHours",
               0::int AS "completedLessons"
        FROM course_editions ce
        JOIN courses c ON c.id = ce.course_id
        WHERE ce.is_active = true
        ORDER BY c.id, ce.start_date DESC NULLS LAST, ce.created_at DESC NULLS LAST, c.title
      `);

      return res.json(rows);
    } catch (error) {
      console.error('Error fetching teacher guest courses', error);
      return res.status(500).json({ error: 'Unable to retrieve courses' });
    }
  }
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
    const { rows: teachers } = await pool.query(`
      SELECT id,
             email,
             COALESCE(name, NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), ''), email) AS "displayName"
      FROM faculty
      WHERE id = $1
    `, [teacherId]);
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

    const { rows: detailRows } = await pool.query(`
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
      WHERE sq.id = $1
      LIMIT 1
    `, [req.params.id]);

    const question = detailRows[0] || rows[0];
    const teacher = teachers[0];
    const responsePayload = { ...question, notification: { attempted: false, sent: false } };

    if (teacher.email) {
      responsePayload.notification.attempted = true;
      try {
        const teacherUrl = `${getPublicBaseUrl(req)}/teachers/`;
        const emailResult = await questionAssignmentEmailSender({
          to: teacher.email,
          cc: process.env.QUESTION_ASSIGNMENT_CC || 'maretto@carbonfarmingmaster.it',
          subject: 'Nuova domanda assegnata - Master Carbon Farming',
          html: buildQuestionAssignmentEmailHtml(question, teacher, teacherUrl)
        });
        responsePayload.notification.sent = true;
        responsePayload.notification.provider = emailResult.provider || null;
      } catch (emailError) {
        console.error('Error sending question assignment notification', emailError);
        responsePayload.notification.error = emailError.message || 'Unable to send notification';
      }
    } else {
      responsePayload.notification.skippedReason = 'teacher_email_missing';
    }

    res.json(responsePayload);
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
      SELECT id, COALESCE(percentage, score)::int AS score, percentage, passed,
             started_at AS "startedAt", completed_at AS "completedAt"
      FROM quiz_attempts
      WHERE user_id = $1 AND quiz_id = $2 AND completed_at IS NOT NULL
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

    const { rows: attendanceRows } = lesson.calendarLessonId
      ? await pool.query(`
        SELECT a.id
        FROM attendance a
        WHERE a.user_id = $2
          AND a.lesson_id = $1
          AND a.attendance_type IN ('in_person', 'remote_live')
        LIMIT 1
      `, [lesson.calendarLessonId, userId])
      : { rows: [] };
    const hasAttendance = attendanceRows.length > 0;

    // 2. Carica progresso: può mancare se la presenza sostituisce il video
    const { rows: progressRows } = await pool.query(
      'SELECT progress_percent, time_spent_seconds, completed_at FROM lesson_progress WHERE user_id = $1 AND lms_lesson_id = $2',
      [userId, lessonId]
    );

    const progress = progressRows[0];
    if (progress.completed_at) {
      return res.json({ completed: true, message: 'Lezione già completata', completedAt: progress.completed_at });
    }

    const completion = await getLessonCompletionStatus(lessonId, userId, {
      lesson,
      progress,
      hasAttendance
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

    // Crea automaticamente presenza asincrona solo per completamenti senza presenza live
    if (!hasAttendance) {
      await pool.query(`
        INSERT INTO attendance (id, user_id, lms_lesson_id, attendance_type, method)
        VALUES ($1, $2, $3, 'async', 'auto_tracking')
        ON CONFLICT (user_id, lms_lesson_id) DO NOTHING
      `, [uuidv4(), userId, lessonId]);
    }

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

// Admin: delete attendance record
app.delete('/api/attendance/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { id } = req.params;
  try {
    const { rows } = await pool.query('DELETE FROM attendance WHERE id = $1 RETURNING id', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Attendance not found' });
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting attendance', error);
    res.status(500).json({ error: 'Unable to delete attendance' });
  }
});

async function importAttendanceParticipants(lessonId, participants) {
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
    let skippedExisting = 0;
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
      if (!participantMinutes) { unmatched.push(`${name || email || '?'} (durata mancante)`); continue; }
      const attendancePercent = lessonDuration > 0 ? (participantMinutes / lessonDuration) * 100 : 100;
      const attendanceType = attendancePercent >= 80 ? 'remote_live' : 'remote_partial';

      const joinISO = parseAttendanceDate(p.joinTime);
      const leaveISO = parseAttendanceDate(p.leaveTime);

      const importNotes = `zoom_duration_minutes=${participantMinutes}`;
      const { rows: insertRows } = await pool.query(`
        INSERT INTO attendance (id, user_id, lesson_id, attendance_type, method, check_in_at, check_out_at, notes)
        VALUES ($1, $2, $3, $4, 'csv_import', $5, $6, $7)
        ON CONFLICT (user_id, lesson_id) DO UPDATE SET
          attendance_type = EXCLUDED.attendance_type,
          check_in_at = EXCLUDED.check_in_at,
          check_out_at = EXCLUDED.check_out_at,
          notes = EXCLUDED.notes
        WHERE attendance.method = 'csv_import'
        RETURNING (xmax = 0) AS is_new
      `, [uuidv4(), userId, lessonId, attendanceType, joinISO, leaveISO, importNotes]);

      if (!insertRows.length) {
        skippedExisting++;
        continue;
      }
      const isNew = insertRows[0]?.is_new;
      if (isNew) { imported++; } else { updated++; }
      if (attendanceType === 'remote_partial') partial++;
      matched.push(name + (attendanceType === 'remote_partial' ? ' (parziale)' : ''));
    }

    return { imported, updated, skippedExisting, partial, notFound: unmatched.length, matched, unmatched };
  } catch (error) {
    console.error('Error importing attendance participants', error);
    throw error;
  }
}

async function importAttendanceParticipantsAcrossLessons(lessonIds, participants) {
  const { rows: lessons } = await pool.query(
    `SELECT id, title, start_datetime, COALESCE(duration_minutes, 0) AS duration_minutes
     FROM lessons
     WHERE id = ANY($1::uuid[])
     ORDER BY start_datetime ASC`,
    [lessonIds]
  );

  if (lessons.length !== lessonIds.length) {
    throw new Error('Una o più lezioni selezionate non sono valide.');
  }

  const lessonWindows = lessons.map((lesson) => {
    const start = new Date(lesson.start_datetime);
    const durationMinutes = Number(lesson.duration_minutes || 0);
    return {
      ...lesson,
      start,
      end: new Date(start.getTime() + durationMinutes * 60000),
      durationMinutes
    };
  }).filter((lesson) => lesson.durationMinutes > 0);

  if (!lessonWindows.length) {
    throw new Error('Le lezioni selezionate non hanno una durata valida.');
  }

  const result = {
    imported: 0,
    updated: 0,
    skippedExisting: 0,
    partial: 0,
    notFound: 0,
    matched: [],
    unmatched: [],
    lessons: []
  };

  for (const lesson of lessonWindows) {
    const lessonParticipants = [];
    for (const participant of participants) {
      const joinTime = parseAttendanceDate(participant.joinTime);
      const durationMinutes = Number(participant.durationMinutes || 0);
      const leaveTime = parseAttendanceDate(participant.leaveTime) ||
        (joinTime && durationMinutes ? new Date(new Date(joinTime).getTime() + durationMinutes * 60000).toISOString() : null);

      if (!joinTime || !leaveTime) {
        if (!result.unmatched.includes(`${participant.name || participant.email || '?'} (ingresso/uscita mancanti)`)) {
          result.unmatched.push(`${participant.name || participant.email || '?'} (ingresso/uscita mancanti)`);
        }
        continue;
      }

      const overlapMinutes = calculateOverlapMinutes(new Date(joinTime), new Date(leaveTime), lesson.start, lesson.end);
      if (overlapMinutes <= 0) continue;

      lessonParticipants.push({
        ...participant,
        joinTime: new Date(Math.max(new Date(joinTime).getTime(), lesson.start.getTime())).toISOString(),
        leaveTime: new Date(Math.min(new Date(leaveTime).getTime(), lesson.end.getTime())).toISOString(),
        durationMinutes: overlapMinutes
      });
    }

    const lessonResult = await importAttendanceParticipants(lesson.id, lessonParticipants);
    result.imported += lessonResult.imported;
    result.updated += lessonResult.updated;
    result.skippedExisting += lessonResult.skippedExisting || 0;
    result.partial += lessonResult.partial;
    result.notFound += lessonResult.notFound;
    result.matched.push(...lessonResult.matched.map((name) => `${lesson.title}: ${name}`));
    result.unmatched.push(...lessonResult.unmatched.map((name) => `${lesson.title}: ${name}`));
    result.lessons.push({
      lessonId: lesson.id,
      title: lesson.title,
      parsed: lessonParticipants.length,
      imported: lessonResult.imported,
      updated: lessonResult.updated,
      skippedExisting: lessonResult.skippedExisting || 0,
      partial: lessonResult.partial
    });
  }

  return result;
}

// Admin: import file report partecipanti Zoom/Teams
app.post('/api/attendance/import-file', requireAdmin, uploadAttendanceFile.single('file'), async (req, res) => {
  if (!ensurePool(res)) return;
  let lessonIds = [];
  try {
    lessonIds = req.body.lessonIds ? JSON.parse(req.body.lessonIds) : [];
  } catch (_error) {
    lessonIds = [];
  }
  if (!lessonIds.length && req.body.lessonId) lessonIds = [req.body.lessonId];
  lessonIds = [...new Set(lessonIds.map((id) => String(id || '').trim()).filter(Boolean))];

  if (!lessonIds.length || !req.file) {
    return res.status(400).json({ error: 'lessonIds and file are required' });
  }

  try {
    const participants = await parseAttendanceImportFile(req.file);
    const result = lessonIds.length > 1
      ? await importAttendanceParticipantsAcrossLessons(lessonIds, participants)
      : await importAttendanceParticipants(lessonIds[0], participants);
    res.json({ ...result, parsed: participants.length });
  } catch (error) {
    console.error('Error importing attendance file', error);
    res.status(400).json({ error: error.message || 'Unable to import attendance file' });
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
    const result = await importAttendanceParticipants(lessonId, participants);
    res.json(result);
  } catch (error) {
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
      SELECT a.id, a.user_id, a.lesson_id, a.lms_lesson_id, a.attendance_type, a.method, a.notes,
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
        .reduce((sum, a) => sum + getAttendanceCreditMinutes(a), 0);
      const attendedHours = attendedMinutes / 60.0;
      const percentage = totalPlannedHours > 0 ? Math.round((attendedHours / totalPlannedHours) * 100) : 0;

      // Per singola lezione, includi dettagli presenza
      const singleLessonAttendance = lessonId && filteredAttendances.length > 0 ? filteredAttendances[0] : null;
      const singleAttendanceImportedMinutes = singleLessonAttendance ? getImportedAttendanceMinutes(singleLessonAttendance) : 0;
      const singleAttendanceCreditMinutes = singleLessonAttendance ? getAttendanceCreditMinutes(singleLessonAttendance) : 0;
      const singleAttendanceMinutes = singleAttendanceImportedMinutes || singleAttendanceCreditMinutes || null;
      
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
        attendanceMinutes: singleAttendanceMinutes,
        attendances: filteredAttendances.map(a => ({
          lessonId: a.lesson_id,
          lmsLessonId: a.lms_lesson_id,
          type: a.attendance_type,
          method: a.method,
          checkInAt: a.check_in_at,
          attendanceMinutes: getImportedAttendanceMinutes(a) || getAttendanceCreditMinutes(a) || null
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
      `SELECT a.user_id, a.attendance_type, a.notes, a.check_in_at, a.check_out_at, COALESCE(les.duration_minutes, 0) AS duration_minutes
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
        .reduce((sum, a) => sum + getAttendanceCreditMinutes(a), 0);
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

app.get('/api/admin/student-progress', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { courseEditionId } = req.query || {};
  if (!courseEditionId) {
    return res.status(400).json({ error: 'courseEditionId is required' });
  }

  try {
    const { rows: editionRows } = await pool.query(`
      SELECT ce.id, ce.edition_name AS "editionName",
             c.id AS "courseId", c.title AS "courseTitle"
      FROM course_editions ce
      JOIN courses c ON c.id = ce.course_id
      WHERE ce.id = $1
      LIMIT 1
    `, [courseEditionId]);
    if (!editionRows.length) {
      return res.status(404).json({ error: 'Edizione corso non trovata' });
    }

    const edition = editionRows[0];
    const { rows: studentRows } = await pool.query(`
      SELECT e.user_id AS "userId",
             u.first_name AS "firstName",
             u.last_name AS "lastName",
             u.email,
             COALESCE(u.role, 'student') AS role
      FROM enrollments e
      JOIN users u ON u.id = e.user_id
      WHERE e.course_edition_id = $1
        AND e.status = 'active'
      ORDER BY u.last_name, u.first_name, u.email
    `, [courseEditionId]);

    const { rows: moduleRows } = await pool.query(
      'SELECT id FROM modules WHERE course_id = $1',
      [edition.courseId]
    );
    const moduleIds = moduleRows.map((row) => row.id);

    const { rows: lessonRows } = await pool.query(`
      SELECT ll.id, ll.calendar_lesson_id AS "calendarLessonId"
      FROM lms_lessons ll
      JOIN modules m ON m.id = ll.lms_module_id
      WHERE m.course_id = $1
        AND ll.is_published = true
    `, [edition.courseId]);
    const lessonIds = lessonRows.map((row) => row.id);
    const calendarLessonIds = lessonRows.map((row) => row.calendarLessonId).filter(Boolean);
    const studentIds = studentRows.map((row) => row.userId);

    let attendanceRows = [];
    let lessonProgressRows = [];
    let quizRows = [];
    let resourceRows = [];
    let questionRows = [];
    let surveyRows = [];
    let eventRows = [];
    let totalResourceRows = [{ total: 0 }];
    let completedLessonRows = [{ total: 0 }];

    if (studentIds.length) {
      if (calendarLessonIds.length || lessonIds.length) {
        ({ rows: attendanceRows } = await pool.query(`
          SELECT a.user_id AS "userId",
                 COUNT(*) FILTER (WHERE a.attendance_type = 'in_person')::int AS "inPerson",
                 COUNT(*) FILTER (WHERE a.attendance_type = 'remote_live')::int AS "remoteLive",
                 COUNT(*) FILTER (WHERE a.attendance_type = 'remote_partial')::int AS "remotePartial",
                 COUNT(*) FILTER (WHERE a.attendance_type = 'async')::int AS "async",
                 COUNT(*)::int AS "total",
                 MAX(COALESCE(a.check_in_at, a.created_at)) AS "lastAttendanceAt"
          FROM attendance a
          WHERE a.user_id = ANY($1::uuid[])
            AND (a.lesson_id = ANY($2::uuid[]) OR a.lms_lesson_id = ANY($3::uuid[]))
          GROUP BY a.user_id
        `, [studentIds, calendarLessonIds, lessonIds]));

        ({ rows: lessonProgressRows } = await pool.query(`
          SELECT lp.user_id AS "userId",
                 COUNT(*) FILTER (WHERE lp.completed_at IS NOT NULL)::int AS "completedLessons",
                 COUNT(*)::int AS "progressedLessons",
                 COALESCE(AVG(lp.progress_percent), 0)::numeric(5,2) AS "avgProgress",
                 MAX(lp.completed_at) AS "lastProgressAt"
          FROM lesson_progress lp
          WHERE lp.user_id = ANY($1::uuid[])
            AND lp.lms_lesson_id = ANY($2::uuid[])
          GROUP BY lp.user_id
        `, [studentIds, lessonIds]));

        ({ rows: completedLessonRows } = await pool.query(`
          SELECT COUNT(DISTINCT ll.id)::int AS total
          FROM lms_lessons ll
          WHERE ll.id = ANY($1::uuid[])
            AND (
              EXISTS (
                SELECT 1
                FROM attendance a
                WHERE a.lesson_id = ll.calendar_lesson_id
                  AND a.attendance_type IN ('in_person', 'remote_live', 'remote_partial', 'async')
              )
              OR EXISTS (
                SELECT 1
                FROM lesson_progress lp
                WHERE lp.lms_lesson_id = ll.id
                  AND lp.completed_at IS NOT NULL
              )
            )
        `, [lessonIds]));

        ({ rows: totalResourceRows } = await pool.query(`
          SELECT COUNT(DISTINCT r.id)::int AS total
          FROM resources r
          WHERE r.is_published = true
            AND r.resource_type <> 'quiz'
            AND r.lesson_id = ANY($1::uuid[])
        `, [calendarLessonIds]));

        ({ rows: resourceRows } = await pool.query(`
          SELECT rv.user_id AS "userId",
                 COUNT(DISTINCT rv.resource_id)::int AS "viewedResources",
                 COUNT(*)::int AS "resourceViews",
                 MAX(rv.first_viewed_at) AS "lastResourceAt"
          FROM resource_views rv
          JOIN resources r ON r.id = rv.resource_id
          WHERE rv.user_id = ANY($1::uuid[])
            AND r.is_published = true
            AND r.resource_type <> 'quiz'
            AND r.lesson_id = ANY($2::uuid[])
          GROUP BY rv.user_id
        `, [studentIds, calendarLessonIds]));
      }

      ({ rows: quizRows } = await pool.query(`
        SELECT qa.user_id AS "userId",
               COUNT(*)::int AS "attempts",
               COUNT(*) FILTER (WHERE qa.passed)::int AS "passedAttempts",
               MAX(COALESCE(qa.percentage, qa.score))::int AS "bestScore",
               COALESCE(AVG(COALESCE(qa.percentage, qa.score)), 0)::numeric(5,2) AS "avgScore",
               COUNT(DISTINCT qa.quiz_id) FILTER (WHERE q.lms_lesson_id IS NOT NULL)::int AS "lessonQuizCompleted",
               COUNT(DISTINCT qa.quiz_id) FILTER (WHERE q.lms_module_id IS NOT NULL)::int AS "moduleQuizCompleted",
               COUNT(DISTINCT qa.quiz_id)::int AS "quizzesCompleted",
               MAX(qa.completed_at) AS "lastQuizAt"
        FROM quiz_attempts qa
        JOIN quizzes q ON q.id = qa.quiz_id
        WHERE qa.user_id = ANY($1::uuid[])
          AND qa.completed_at IS NOT NULL
          AND q.is_published = true
          AND (q.lms_lesson_id = ANY($2::uuid[]) OR q.lms_module_id = ANY($3::uuid[]))
        GROUP BY qa.user_id
      `, [studentIds, lessonIds, moduleIds]));

      ({ rows: surveyRows } = await pool.query(`
        SELECT i.user_id AS "userId",
               COUNT(*) FILTER (WHERE i.completed_at IS NOT NULL)::int AS "surveysCompleted",
               MAX(i.completed_at) AS "lastSurveyAt"
        FROM survey_invitations i
        JOIN survey_campaigns c ON c.id = i.campaign_id
        JOIN surveys s ON s.id = c.survey_id
        WHERE i.user_id = ANY($1::uuid[])
        GROUP BY i.user_id
      `, [studentIds]));

      ({ rows: eventRows } = await pool.query(`
        SELECT r.user_id AS "userId",
               COUNT(*) FILTER (WHERE r.response_status = 'registered')::int AS "eventsRegistered",
               COUNT(*) FILTER (WHERE r.response_status = 'declined')::int AS "eventsDeclined",
               COUNT(*)::int AS "eventsResponded",
               MAX(r.updated_at) AS "lastEventAt"
        FROM event_registrations r
        WHERE r.user_id = ANY($1::uuid[])
        GROUP BY r.user_id
      `, [studentIds]));

      ({ rows: questionRows } = await pool.query(`
        SELECT sq.user_id AS "userId",
               COUNT(DISTINCT sq.id)::int AS "questionsAsked",
               COUNT(DISTINCT qr.id)::int AS "repliesReceived",
               MAX(COALESCE(qr.created_at, sq.created_at)) AS "lastQuestionAt"
        FROM student_questions sq
        LEFT JOIN question_replies qr ON qr.question_id = sq.id
        WHERE sq.user_id = ANY($1::uuid[])
          AND (sq.lms_lesson_id = ANY($2::uuid[]) OR sq.module_id = ANY($3::uuid[]))
        GROUP BY sq.user_id
      `, [studentIds, lessonIds, moduleIds]));
    }

    const attendanceMap = new Map(attendanceRows.map((row) => [row.userId, row]));
    const progressMap = new Map(lessonProgressRows.map((row) => [row.userId, row]));
    const quizMap = new Map(quizRows.map((row) => [row.userId, row]));
    const resourceMap = new Map(resourceRows.map((row) => [row.userId, row]));
    const questionMap = new Map(questionRows.map((row) => [row.userId, row]));
    const surveyMap = new Map(surveyRows.map((row) => [row.userId, row]));
    const eventMap = new Map(eventRows.map((row) => [row.userId, row]));

    const totalLessons = lessonRows.length;
    const totalResources = Number(totalResourceRows[0]?.total || 0);
    const cohortCompletedLessons = Number(completedLessonRows[0]?.total || 0);

    const students = studentRows.map((student) => {
      const attendance = attendanceMap.get(student.userId) || {};
      const progress = progressMap.get(student.userId) || {};
      const quiz = quizMap.get(student.userId) || {};
      const resources = resourceMap.get(student.userId) || {};
      const questions = questionMap.get(student.userId) || {};
      const surveys = surveyMap.get(student.userId) || {};
      const events = eventMap.get(student.userId) || {};

      const attendanceTotal = Number(attendance.total || 0);
      const completedLessons = Math.min(totalLessons, Math.max(Number(progress.completedLessons || 0), attendanceTotal));
      const lessonProgressPercent = totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0;
      const attendancePercent = totalLessons > 0 ? Math.round((attendanceTotal / totalLessons) * 100) : 0;
      const quizBestScore = quiz.bestScore === null || quiz.bestScore === undefined ? null : Number(quiz.bestScore);
      const lessonQuizCompleted = Number(quiz.lessonQuizCompleted || 0);
      const moduleQuizCompleted = Number(quiz.moduleQuizCompleted || 0);
      const quizzesCompleted = Number(quiz.quizzesCompleted || (lessonQuizCompleted + moduleQuizCompleted));
      const materialsViewed = Number(resources.viewedResources || 0);
      const materialsPercent = totalResources > 0 ? Math.round((materialsViewed / totalResources) * 100) : 0;
      const askedQuestions = Number(questions.questionsAsked || 0);
      const repliesReceived = Number(questions.repliesReceived || 0);
      const surveysCompleted = Number(surveys.surveysCompleted || 0);
      const eventsRegistered = Number(events.eventsRegistered || 0);
      const eventsDeclined = Number(events.eventsDeclined || 0);
      const eventsResponded = Number(events.eventsResponded || 0);
      const overallPercent = Math.round((
        lessonProgressPercent +
        Math.min(attendancePercent, 100) +
        (quizBestScore ?? 0) +
        materialsPercent
      ) / 4);

      const lastActivityAt = [
        attendance.lastAttendanceAt,
        progress.lastProgressAt,
        quiz.lastQuizAt,
        resources.lastResourceAt,
        questions.lastQuestionAt,
        surveys.lastSurveyAt,
        events.lastEventAt
      ].filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || null;

      return {
        ...student,
        attendance: {
          inPerson: Number(attendance.inPerson || 0),
          remoteLive: Number(attendance.remoteLive || 0),
          remotePartial: Number(attendance.remotePartial || 0),
          async: Number(attendance.async || 0),
          total: attendanceTotal
        },
        lessons: {
          completed: completedLessons,
          total: totalLessons,
          percent: lessonProgressPercent,
          avgProgress: Number(progress.avgProgress || 0)
        },
        quizzes: {
          attempts: Number(quiz.attempts || 0),
          passedAttempts: Number(quiz.passedAttempts || 0),
          bestScore: quizBestScore,
          avgScore: quiz.avgScore === null || quiz.avgScore === undefined ? null : Number(quiz.avgScore),
          lessonCompleted: lessonQuizCompleted,
          moduleCompleted: moduleQuizCompleted,
          completed: quizzesCompleted
        },
        materials: {
          viewed: materialsViewed,
          total: totalResources,
          percent: materialsPercent,
          views: Number(resources.resourceViews || 0)
        },
        surveys: {
          completed: surveysCompleted
        },
        events: {
          registered: eventsRegistered,
          declined: eventsDeclined,
          responded: eventsResponded
        },
        questions: {
          asked: askedQuestions,
          repliesReceived
        },
        overallPercent,
        lastActivityAt
      };
    });

    const summary = students.reduce((acc, student) => {
      acc.studentsCount += 1;
      if (student.role === 'student') acc.studentRoleCount += 1;
      else if (student.role === 'guest') acc.guestRoleCount += 1;
      else acc.otherRoleCount += 1;
      acc.lessonsCompleted += student.lessons.completed;
      acc.lessonProgressPercentTotal += student.lessons.percent;
      acc.inPerson += student.attendance.inPerson;
      acc.remoteLive += student.attendance.remoteLive;
      acc.remotePartial += student.attendance.remotePartial;
      acc.async += student.attendance.async;
      acc.quizAttempts += student.quizzes.attempts;
      acc.quizPassed += student.quizzes.passedAttempts;
      acc.lessonQuizCompleted += student.quizzes.lessonCompleted;
      acc.moduleQuizCompleted += student.quizzes.moduleCompleted;
      acc.quizCompleted += student.quizzes.completed;
      if (student.quizzes.bestScore !== null && student.quizzes.bestScore !== undefined) {
        acc.quizBestScoreTotal += student.quizzes.bestScore;
        acc.quizBestScoreCount += 1;
      }
      acc.materialsViewed += student.materials.viewed;
      acc.surveysCompleted += student.surveys.completed;
      acc.eventsRegistered += student.events.registered;
      acc.eventsDeclined += student.events.declined;
      acc.eventsResponded += student.events.responded;
      acc.questionsAsked += student.questions.asked;
      acc.repliesReceived += student.questions.repliesReceived;
      return acc;
    }, {
      studentsCount: 0,
      studentRoleCount: 0,
      guestRoleCount: 0,
      otherRoleCount: 0,
      lessonsCompleted: 0,
      lessonProgressPercentTotal: 0,
      inPerson: 0,
      remoteLive: 0,
      remotePartial: 0,
      async: 0,
      quizAttempts: 0,
      quizPassed: 0,
      lessonQuizCompleted: 0,
      moduleQuizCompleted: 0,
      quizCompleted: 0,
      quizBestScoreTotal: 0,
      quizBestScoreCount: 0,
      materialsViewed: 0,
      surveysCompleted: 0,
      eventsRegistered: 0,
      eventsDeclined: 0,
      eventsResponded: 0,
      questionsAsked: 0,
      repliesReceived: 0
    });

    summary.totalLessons = totalLessons;
    summary.cohortCompletedLessons = cohortCompletedLessons;
    summary.totalResources = totalResources;
    summary.totalQuizzesCompleted = summary.quizCompleted;
    summary.avgLessonProgress = summary.studentsCount ? Math.round(summary.lessonProgressPercentTotal / summary.studentsCount) : 0;
    summary.avgQuizBestScore = summary.quizBestScoreCount ? Math.round(summary.quizBestScoreTotal / summary.quizBestScoreCount) : null;
    summary.quizPassRate = summary.quizAttempts ? Math.round((summary.quizPassed / summary.quizAttempts) * 100) : 0;

    res.json({
      edition,
      summary,
      students: students.sort((a, b) => (b.overallPercent - a.overallPercent) || String(a.lastName || '').localeCompare(String(b.lastName || ''))),
      attendanceBreakdown: [
        { key: 'inPerson', label: '🏫 In sito', count: summary.inPerson },
        { key: 'remoteLive', label: '💻 Online', count: summary.remoteLive },
        { key: 'remotePartial', label: '⏱️ Online parziale', count: summary.remotePartial },
        { key: 'async', label: '📹 Offline / asincrona', count: summary.async }
      ]
    });
  } catch (error) {
    console.error('Error fetching student progress admin report', error);
    res.status(500).json({ error: 'Unable to retrieve student progress report' });
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

    const normalizeQuizAnswer = (value) => {
      if (value === null || value === undefined) return value;
      if (Array.isArray(value)) {
        return value.map(normalizeQuizAnswer).sort((a, b) => String(a).localeCompare(String(b)));
      }
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return '';
        try {
          return normalizeQuizAnswer(JSON.parse(trimmed));
        } catch (_error) {
          return trimmed;
        }
      }
      return value;
    };

    const answersMatch = (studentAnswer, correctAnswer) => {
      const normalizedStudent = normalizeQuizAnswer(studentAnswer);
      const normalizedCorrect = normalizeQuizAnswer(correctAnswer);
      if (Array.isArray(normalizedStudent) || Array.isArray(normalizedCorrect)) {
        if (!Array.isArray(normalizedStudent) || !Array.isArray(normalizedCorrect)) return false;
        if (normalizedStudent.length !== normalizedCorrect.length) return false;
        return normalizedStudent.every((item, index) => JSON.stringify(item) === JSON.stringify(normalizedCorrect[index]));
      }
      return String(normalizedStudent) === String(normalizedCorrect);
    };

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
      const isCorrect = answersMatch(a.selectedAnswer, question.correct_answer);
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

// ============================================================
// SURVEYS / FEEDBACK QUESTIONNAIRES
//   - 1c: tracciato per sistema, anonimo per i risultati
//   - 2b: docente vede aggregati anonimi sui questionari "su di lui"
//   - 3a: tipi domanda = rating 1-5 e text libero
//   - 4b: scope = course | module | lesson | teacher
// ============================================================

// --- Helper: calcola la lista degli invitati per una campagna in base allo scope ---
async function computeSurveyInvitees(client, scopeType, scopeId, targetRole) {
  if (targetRole === 'student') {
    let courseIds = null; // null => tutti i corsi
    if (scopeType === 'course') {
      courseIds = scopeId ? [scopeId] : null;
    } else if (scopeType === 'module') {
      const { rows } = await client.query('SELECT course_id FROM modules WHERE id=$1', [scopeId]);
      if (!rows.length || !rows[0].course_id) return [];
      courseIds = [rows[0].course_id];
    } else if (scopeType === 'lesson') {
      const { rows } = await client.query(
        'SELECT m.course_id FROM lessons l JOIN modules m ON m.id = l.module_id WHERE l.id = $1',
        [scopeId]
      );
      if (!rows.length || !rows[0].course_id) return [];
      courseIds = [rows[0].course_id];
    } else if (scopeType === 'teacher') {
      const { rows } = await client.query(
        `SELECT DISTINCT m.course_id FROM lessons l
         JOIN modules m ON m.id = l.module_id
         WHERE l.teacher_id = $1 AND m.course_id IS NOT NULL`,
        [scopeId]
      );
      if (!rows.length) return [];
      courseIds = rows.map(r => r.course_id);
    }

    let q, params;
    if (courseIds) {
      q = `SELECT DISTINCT e.user_id FROM enrollments e
           JOIN course_editions ce ON ce.id = e.course_edition_id
           WHERE ce.course_id = ANY($1::uuid[]) AND e.status = 'active' AND e.user_id IS NOT NULL`;
      params = [courseIds];
    } else {
      q = `SELECT DISTINCT e.user_id FROM enrollments e
           WHERE e.status = 'active' AND e.user_id IS NOT NULL`;
      params = [];
    }
    const { rows: enrollees } = await client.query(q, params);
    return enrollees.map(r => ({ user_id: r.user_id, faculty_id: null }));
  }

  // target_role === 'teacher'
  if (scopeType === 'teacher') {
    return scopeId ? [{ user_id: null, faculty_id: scopeId }] : [];
  }
  if (scopeType === 'lesson') {
    const { rows } = await client.query(
      'SELECT teacher_id FROM lessons WHERE id=$1 AND teacher_id IS NOT NULL',
      [scopeId]
    );
    return rows.map(r => ({ user_id: null, faculty_id: r.teacher_id }));
  }
  if (scopeType === 'module') {
    const { rows } = await client.query(
      'SELECT DISTINCT teacher_id FROM lessons WHERE module_id = $1 AND teacher_id IS NOT NULL',
      [scopeId]
    );
    return rows.map(r => ({ user_id: null, faculty_id: r.teacher_id }));
  }
  if (scopeType === 'course') {
    const where = scopeId ? 'WHERE m.course_id = $1 AND l.teacher_id IS NOT NULL' : 'WHERE l.teacher_id IS NOT NULL';
    const params = scopeId ? [scopeId] : [];
    const { rows } = await client.query(
      `SELECT DISTINCT l.teacher_id FROM lessons l JOIN modules m ON m.id = l.module_id ${where}`,
      params
    );
    return rows.map(r => ({ user_id: null, faculty_id: r.teacher_id }));
  }
  return [];
}

async function getSingleSurveyInvitee(client, targetRole, recipientId) {
  if (!recipientId) return null;
  if (targetRole === 'student') {
    const { rows } = await client.query(
      `SELECT id FROM users
        WHERE id = $1 AND role = 'student' AND is_active = true
        LIMIT 1`,
      [recipientId]
    );
    return rows.length ? { user_id: rows[0].id, faculty_id: null } : null;
  }
  const { rows } = await client.query(
    `SELECT id FROM faculty
      WHERE id = $1 AND is_active = true
      LIMIT 1`,
    [recipientId]
  );
  return rows.length ? { user_id: null, faculty_id: rows[0].id } : null;
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function buildSurveyOdtBuffer(survey, questions) {
  const zip = new JSZip();
  const mimetype = 'application/vnd.oasis.opendocument.text';
  zip.file('mimetype', mimetype, { compression: 'STORE' });
  zip.file('META-INF/manifest.xml', `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="${mimetype}"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`);
  zip.file('styles.xml', `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2">
  <office:styles/>
</office:document-styles>`);
  zip.file('meta.xml', `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="1.2">
  <office:meta><meta:generator>UNITUS Carbon Farming</meta:generator></office:meta>
</office:document-meta>`);

  const body = [
    `<text:h text:outline-level="1">${escapeXml(survey.title)}</text:h>`,
    survey.description ? `<text:p>${escapeXml(survey.description)}</text:p>` : '',
    `<text:p>Pubblico: ${survey.targetRole === 'student' ? 'Studenti' : 'Docenti'}</text:p>`,
    `<text:p/>`,
    ...questions.map((q, index) => [
      `<text:h text:outline-level="2">Domanda ${index + 1}</text:h>`,
      `<text:p>${escapeXml(q.text)}</text:p>`,
      `<text:p>Tipo: ${q.questionType === 'rating' ? 'Rating 1-5' : 'Testo libero'}${q.isRequired ? ' — obbligatoria' : ' — facoltativa'}</text:p>`
    ].join('\n'))
  ].filter(Boolean).join('\n');

  zip.file('content.xml', `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2">
  <office:body>
    <office:text>
${body}
    </office:text>
  </office:body>
</office:document-content>`);

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// Risolve il nome leggibile dello scope (per UI)
async function resolveSurveyScopeLabel(scopeType, scopeId) {
  if (!scopeId) return scopeType === 'course' ? 'Tutti i corsi' : '—';
  try {
    if (scopeType === 'course') {
      const { rows } = await pool.query('SELECT title FROM courses WHERE id=$1', [scopeId]);
      return rows[0]?.title || '(corso eliminato)';
    }
    if (scopeType === 'module') {
      const { rows } = await pool.query('SELECT name FROM modules WHERE id=$1', [scopeId]);
      return rows[0]?.name || '(modulo eliminato)';
    }
    if (scopeType === 'lesson') {
      const { rows } = await pool.query('SELECT title FROM lessons WHERE id=$1', [scopeId]);
      return rows[0]?.title || '(lezione eliminata)';
    }
    if (scopeType === 'teacher') {
      const { rows } = await pool.query('SELECT name FROM faculty WHERE id=$1', [scopeId]);
      return rows[0]?.name || '(docente eliminato)';
    }
  } catch (_) {}
  return '—';
}

// --- ADMIN: SURVEY TEMPLATES ---

app.get('/api/admin/surveys', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT s.id, s.title, s.description, s.target_role AS "targetRole",
             s.created_at AS "createdAt", s.updated_at AS "updatedAt",
             (SELECT COUNT(*)::int FROM survey_questions q WHERE q.survey_id = s.id) AS "questionCount",
             (SELECT COUNT(*)::int FROM survey_campaigns c WHERE c.survey_id = s.id) AS "campaignCount"
      FROM surveys s ORDER BY s.created_at DESC
    `);
    res.json(rows);
  } catch (e) {
    console.error('Error listing surveys', e);
    res.status(500).json({ error: 'Errore nel recupero dei questionari' });
  }
});

app.get('/api/admin/survey-recipients', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const targetRole = req.query.targetRole;
  if (!['student', 'teacher'].includes(targetRole)) {
    return res.status(400).json({ error: 'targetRole obbligatorio (student|teacher)' });
  }
  try {
    if (targetRole === 'student') {
      const { rows } = await pool.query(`
        SELECT DISTINCT u.id,
               u.email,
               u.first_name AS "firstName",
               u.last_name AS "lastName"
          FROM users u
          JOIN enrollments e ON e.user_id = u.id
         WHERE u.role = 'student'
           AND u.is_active = true
           AND e.status = 'active'
         ORDER BY u.last_name NULLS LAST, u.first_name NULLS LAST, u.email
      `);
      return res.json(rows);
    }
    const { rows } = await pool.query(`
      SELECT id, name, email, first_name AS "firstName", last_name AS "lastName"
        FROM faculty
       WHERE is_active = true
       ORDER BY name, email
    `);
    res.json(rows);
  } catch (e) {
    console.error('Error listing survey recipients', e);
    res.status(500).json({ error: 'Errore nel recupero destinatari' });
  }
});

app.post('/api/admin/surveys', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { title, description, targetRole } = req.body || {};
  if (!title || !['student', 'teacher'].includes(targetRole)) {
    return res.status(400).json({ error: 'title e targetRole (student|teacher) sono obbligatori' });
  }
  try {
    const id = uuidv4();
    await pool.query(
      'INSERT INTO surveys (id, title, description, target_role) VALUES ($1,$2,$3,$4)',
      [id, title, description || null, targetRole]
    );
    res.status(201).json({ id, title, description: description || null, targetRole });
  } catch (e) {
    console.error('Error creating survey', e);
    res.status(500).json({ error: 'Errore nella creazione' });
  }
});

app.get('/api/admin/surveys/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows: surveys } = await pool.query(
      `SELECT id, title, description, target_role AS "targetRole",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM surveys WHERE id=$1`, [req.params.id]
    );
    if (!surveys.length) return res.status(404).json({ error: 'Questionario non trovato' });
    const { rows: questions } = await pool.query(
      `SELECT id, text, question_type AS "questionType", is_required AS "isRequired", sort_order AS "sortOrder"
       FROM survey_questions WHERE survey_id = $1 ORDER BY sort_order ASC, created_at ASC`,
      [req.params.id]
    );
    res.json({ ...surveys[0], questions });
  } catch (e) {
    console.error('Error fetching survey', e);
    res.status(500).json({ error: 'Errore nel recupero' });
  }
});

app.get('/api/admin/surveys/:id/export.odt', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows: surveys } = await pool.query(
      `SELECT id, title, description, target_role AS "targetRole"
         FROM surveys WHERE id=$1`,
      [req.params.id]
    );
    if (!surveys.length) return res.status(404).json({ error: 'Questionario non trovato' });
    const { rows: questions } = await pool.query(
      `SELECT id, text, question_type AS "questionType", is_required AS "isRequired", sort_order AS "sortOrder"
         FROM survey_questions WHERE survey_id = $1 ORDER BY sort_order ASC, created_at ASC`,
      [req.params.id]
    );
    const buffer = await buildSurveyOdtBuffer(surveys[0], questions);
    const filename = String(surveys[0].title || 'questionario')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'questionario';
    res.setHeader('Content-Type', 'application/vnd.oasis.opendocument.text');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.odt"`);
    res.send(buffer);
  } catch (e) {
    console.error('Error exporting survey ODT', e);
    res.status(500).json({ error: 'Errore export ODT' });
  }
});

app.put('/api/admin/surveys/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { title, description, targetRole } = req.body || {};
  try {
    const { query, values } = buildUpdateQuery('surveys', {
      title, description,
      target_role: ['student', 'teacher'].includes(targetRole) ? targetRole : undefined
    }, req.params.id);
    const { rows } = await pool.query(query, values);
    if (!rows.length) return res.status(404).json({ error: 'Non trovato' });
    res.json(rows[0]);
  } catch (e) {
    console.error('Error updating survey', e);
    res.status(500).json({ error: 'Errore aggiornamento' });
  }
});

app.delete('/api/admin/surveys/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rowCount } = await pool.query('DELETE FROM surveys WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Non trovato' });
    res.status(204).send();
  } catch (e) {
    console.error('Error deleting survey', e);
    res.status(500).json({ error: 'Errore eliminazione' });
  }
});

// Genera un questionario con AI in base al pubblico e allo scopo descritto dall'admin
app.post('/api/admin/surveys/generate-with-ai', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'Generazione AI non disponibile (ANTHROPIC_API_KEY non configurata)' });
  }
  const { targetRole, purpose, scopeType, scopeId, numQuestions } = req.body || {};
  if (!['student', 'teacher'].includes(targetRole)) {
    return res.status(400).json({ error: 'targetRole (student|teacher) obbligatorio' });
  }
  if (!purpose || !String(purpose).trim()) {
    return res.status(400).json({ error: 'purpose: descrivi cosa vuoi misurare' });
  }
  const nq = Math.min(Math.max(parseInt(numQuestions || 8, 10) || 8, 3), 15);

  // Costruisce un contesto ricco per Claude pescando da DB:
  //  - extracted_text già pronto sui materiali (resources.extracted_text)
  //  - trascrizioni video (workflow Whisper) per le lezioni LMS
  //  - bio/ruolo docente, lezioni assegnate, materiali del docente
  // Limite totale ~6000 char per non far esplodere prompt e costo.
  const SURVEY_CONTEXT_LIMIT = 6000;
  function clip(str, max) {
    if (!str) return '';
    const s = String(str).replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) + '…[troncato]' : s;
  }
  async function gatherResourcesText(query, params, perResourceLimit = 1200, maxResources = 6) {
    const { rows } = await pool.query(query, params);
    const parts = [];
    for (const r of rows.slice(0, maxResources)) {
      const txt = clip(r.extracted_text, perResourceLimit);
      if (txt) parts.push(`Materiale "${r.title}" (${r.resource_type || 'doc'}):\n${txt}`);
    }
    return { count: rows.length, withText: parts.length, text: parts.join('\n\n') };
  }

  let scopeContext = '';
  let contextSourcesUsed = 0;
  try {
    if (scopeType === 'course' && scopeId) {
      const { rows: c } = await pool.query('SELECT title, description FROM courses WHERE id=$1', [scopeId]);
      if (c[0]) {
        scopeContext = `Corso: "${c[0].title}".\n${c[0].description || ''}`;
        const { rows: mods } = await pool.query(
          'SELECT name, description_short, contents_main, learning_objectives FROM modules WHERE course_id=$1 ORDER BY sort_order',
          [scopeId]
        );
        if (mods.length) {
          scopeContext += '\n\nMODULI DEL CORSO:';
          for (const m of mods.slice(0, 8)) {
            scopeContext += `\n• ${m.name}`;
            if (m.description_short) scopeContext += ` — ${clip(m.description_short, 200)}`;
            if (m.contents_main) scopeContext += `\n  Contenuti: ${clip(m.contents_main, 300)}`;
          }
          contextSourcesUsed = mods.length;
        }
      }
    } else if (scopeType === 'module' && scopeId) {
      const { rows: m } = await pool.query(
        'SELECT name, description, contents_main, learning_objectives FROM modules WHERE id=$1',
        [scopeId]
      );
      if (m[0]) {
        scopeContext = `Modulo: "${m[0].name}".`;
        if (m[0].description) scopeContext += `\nDescrizione: ${m[0].description}`;
        if (m[0].learning_objectives) scopeContext += `\nObiettivi: ${clip(m[0].learning_objectives, 600)}`;
        if (m[0].contents_main) scopeContext += `\nContenuti principali: ${clip(m[0].contents_main, 600)}`;
      }
      // Lezioni del modulo (calendario) con docenti
      const { rows: lessons } = await pool.query(
        `SELECT l.id, l.title, l.start_datetime, l.description, f.name AS teacher_name, l.external_teacher_name
         FROM lessons l LEFT JOIN faculty f ON f.id = l.teacher_id
         WHERE l.module_id = $1 ORDER BY l.start_datetime NULLS LAST`,
        [scopeId]
      );
      if (lessons.length) {
        scopeContext += `\n\nLEZIONI DEL MODULO (${lessons.length}):`;
        for (const l of lessons.slice(0, 10)) {
          const who = l.teacher_name || l.external_teacher_name || 'docente n/d';
          const when = l.start_datetime ? new Date(l.start_datetime).toLocaleDateString('it-IT') : '';
          scopeContext += `\n• ${l.title} — ${who}${when ? ' (' + when + ')' : ''}`;
          if (l.description) scopeContext += `\n  ${clip(l.description, 200)}`;
        }
      }
      // Materiali del modulo (via lessons)
      const lessonIds = lessons.map(l => l.id);
      if (lessonIds.length) {
        const r = await gatherResourcesText(
          `SELECT title, resource_type, extracted_text FROM resources
           WHERE lesson_id = ANY($1::uuid[]) AND extracted_text IS NOT NULL
             AND char_length(TRIM(extracted_text)) > 50 AND resource_type <> 'quiz'
           ORDER BY created_at DESC`,
          [lessonIds],
          1000, 5
        );
        if (r.text) scopeContext += `\n\nMATERIALI DEL MODULO:\n${r.text}`;
        contextSourcesUsed = r.withText;
      }
    } else if (scopeType === 'lesson' && scopeId) {
      const { rows: l } = await pool.query(
        `SELECT l.title, l.description, l.notes, l.start_datetime,
                m.name AS module_name, f.name AS teacher_name, l.external_teacher_name
         FROM lessons l LEFT JOIN modules m ON m.id=l.module_id
         LEFT JOIN faculty f ON f.id = l.teacher_id WHERE l.id=$1`,
        [scopeId]
      );
      if (l[0]) {
        const who = l[0].teacher_name || l[0].external_teacher_name || '';
        scopeContext = `Lezione: "${l[0].title}"`;
        if (l[0].module_name) scopeContext += ` (modulo "${l[0].module_name}")`;
        if (who) scopeContext += `, docente: ${who}`;
        if (l[0].start_datetime) scopeContext += ` — ${new Date(l[0].start_datetime).toLocaleDateString('it-IT')}`;
        if (l[0].description) scopeContext += `\nDescrizione: ${l[0].description}`;
        if (l[0].notes) scopeContext += `\nNote: ${clip(l[0].notes, 400)}`;
      }
      // Trascrizione dell'eventuale lezione LMS associata
      const { rows: lmsLessons } = await pool.query(
        'SELECT id FROM lms_lessons WHERE calendar_lesson_id = $1 LIMIT 1',
        [scopeId]
      );
      if (lmsLessons[0]) {
        const transcript = await getLatestWorkflowTranscriptForLesson(lmsLessons[0].id);
        if (transcript) {
          scopeContext += `\n\nESTRATTO DALLA TRASCRIZIONE VIDEO:\n${clip(transcript, 2500)}`;
          contextSourcesUsed++;
        }
      }
      // Materiali della lezione
      const r = await gatherResourcesText(
        `SELECT title, resource_type, extracted_text FROM resources
         WHERE lesson_id = $1 AND extracted_text IS NOT NULL
           AND char_length(TRIM(extracted_text)) > 50 AND resource_type <> 'quiz'
         ORDER BY sort_order NULLS LAST, created_at`,
        [scopeId], 1500, 4
      );
      if (r.text) {
        scopeContext += `\n\nMATERIALI DELLA LEZIONE:\n${r.text}`;
        contextSourcesUsed += r.withText;
      }
    } else if (scopeType === 'teacher' && scopeId) {
      const { rows: f } = await pool.query(
        'SELECT name, role, bio FROM faculty WHERE id=$1',
        [scopeId]
      );
      if (f[0]) {
        scopeContext = `Docente valutato: ${f[0].name}`;
        if (f[0].role) scopeContext += ` (${f[0].role})`;
        if (f[0].bio) scopeContext += `\nBio: ${clip(f[0].bio, 600)}`;
      }
      // Lezioni del docente
      const { rows: lessons } = await pool.query(
        `SELECT l.id, l.title, l.start_datetime, m.name AS module_name
         FROM lessons l LEFT JOIN modules m ON m.id = l.module_id
         WHERE l.teacher_id = $1 ORDER BY l.start_datetime NULLS LAST`,
        [scopeId]
      );
      if (lessons.length) {
        scopeContext += `\n\nLEZIONI TENUTE (${lessons.length}):`;
        for (const l of lessons.slice(0, 10)) {
          const when = l.start_datetime ? new Date(l.start_datetime).toLocaleDateString('it-IT') : '';
          scopeContext += `\n• "${l.title}"${l.module_name ? ' — ' + l.module_name : ''}${when ? ' (' + when + ')' : ''}`;
        }
      }
      // Materiali caricati dal docente (extracted_text)
      const r = await gatherResourcesText(
        `SELECT title, resource_type, extracted_text FROM resources
         WHERE teacher_id = $1 AND extracted_text IS NOT NULL
           AND char_length(TRIM(extracted_text)) > 50 AND resource_type <> 'quiz'
         ORDER BY created_at DESC`,
        [scopeId], 1000, 4
      );
      if (r.text) {
        scopeContext += `\n\nMATERIALI CARICATI DAL DOCENTE:\n${r.text}`;
        contextSourcesUsed += r.withText;
      }
      // Eventuali trascrizioni delle sue lezioni LMS
      const { rows: lmsLessons } = await pool.query(
        `SELECT ll.id, ll.title FROM lms_lessons ll
         JOIN lessons l ON l.id = ll.calendar_lesson_id
         WHERE l.teacher_id = $1 LIMIT 3`,
        [scopeId]
      );
      for (const lms of lmsLessons) {
        const t = await getLatestWorkflowTranscriptForLesson(lms.id);
        if (t) {
          scopeContext += `\n\nESTRATTO TRASCRIZIONE — "${lms.title}":\n${clip(t, 1500)}`;
          contextSourcesUsed++;
        }
      }
    }
  } catch (e) {
    console.error('Survey context build error:', e);
  }

  // Tronco il context complessivo per non sforare il prompt
  if (scopeContext.length > SURVEY_CONTEXT_LIMIT) {
    scopeContext = scopeContext.slice(0, SURVEY_CONTEXT_LIMIT) + '\n…[contesto troncato]';
  }

  try {
    const Anthropic = require('@anthropic-ai/sdk').default;
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const audienceLabel = targetRole === 'student'
      ? 'studenti del Master in Carbon Farming (Università della Tuscia)'
      : 'docenti del Master in Carbon Farming (Università della Tuscia)';

    const prompt = `Sei un esperto di valutazione didattica universitaria. Devi creare un questionario di feedback.

PUBBLICO: ${audienceLabel}.
SCOPO DEL FEEDBACK (descritto dall'admin): ${String(purpose).trim()}
${scopeContext ? '\nCONTESTO REALE ESTRATTO DAL SISTEMA (titoli, descrizioni, contenuti dei materiali e/o trascrizioni video):\n' + scopeContext + '\n' : ''}

ISTRUZIONI:
- Genera esattamente ${nq} domande di feedback, mix di rating e testo libero (almeno 1-2 testo libero).
- ${scopeContext ? 'USA IL CONTESTO REALE: cita argomenti specifici, materiali, lezioni o concetti che vedi sopra. Le domande devono essere ancorate a quel contenuto, non generiche.' : 'Niente contesto specifico: fai domande di feedback generali ma calibrate sul pubblico.'}
- Le domande di tipo "rating" sono su scala 1-5 (1=pessimo, 5=ottimo) e devono essere formulate in positivo (es. "Quanto è stato chiaro...", "Quanto è utile...").
- Le domande "text" sono aperte (es. "Cosa miglioreresti?", "Suggerimenti?").
- Le prime domande siano più generali, le ultime più specifiche/aperte.
- Ottimizza per ricavare insight azionabili.
- Tono professionale ma amichevole, in italiano.
- Formulazioni neutre, non leading.

Genera anche un titolo del questionario (breve, sotto i 60 caratteri) e una descrizione (1-2 frasi) che apparirà a chi compila.

FORMATO OUTPUT (JSON valido, niente altro testo):
{
  "title": "...",
  "description": "...",
  "questions": [
    { "text": "...", "questionType": "rating", "isRequired": true },
    { "text": "...", "questionType": "text",   "isRequired": false }
  ]
}`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }]
    });

    const responseText = message.content[0].text;
    let generated;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('JSON non trovato');
      generated = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error('Error parsing AI survey response:', responseText);
      return res.status(500).json({ error: 'Errore parsing risposta AI' });
    }
    if (!generated.title || !Array.isArray(generated.questions) || !generated.questions.length) {
      return res.status(500).json({ error: 'Risposta AI incompleta' });
    }

    // Salva direttamente survey + questions in DB (l'admin potrà poi modificarle)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const surveyId = uuidv4();
      await client.query(
        'INSERT INTO surveys (id, title, description, target_role) VALUES ($1, $2, $3, $4)',
        [surveyId, String(generated.title).slice(0, 200), generated.description || null, targetRole]
      );
      let order = 0;
      for (const q of generated.questions) {
        if (!q.text) continue;
        const qt = ['rating', 'text'].includes(q.questionType) ? q.questionType : 'rating';
        await client.query(
          'INSERT INTO survey_questions (id, survey_id, text, question_type, is_required, sort_order) VALUES ($1, $2, $3, $4, $5, $6)',
          [uuidv4(), surveyId, String(q.text).slice(0, 500), qt, q.isRequired !== false, order++]
        );
      }
      await client.query('COMMIT');
      res.status(201).json({
        id: surveyId,
        title: generated.title,
        description: generated.description,
        targetRole,
        questionCount: order,
        createdByAi: true,
        contextSourcesUsed,
        contextChars: scopeContext.length
      });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Error generating survey with AI:', error);
    res.status(error.statusCode || 500).json({ error: 'Errore generazione AI: ' + (error.message || 'sconosciuto') });
  }
});

// --- ADMIN: SURVEY QUESTIONS ---

app.post('/api/admin/surveys/:id/questions', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { text, questionType, isRequired, sortOrder } = req.body || {};
  if (!text || !['rating', 'text'].includes(questionType)) {
    return res.status(400).json({ error: 'text e questionType (rating|text) sono obbligatori' });
  }
  try {
    const id = uuidv4();
    await pool.query(
      `INSERT INTO survey_questions (id, survey_id, text, question_type, is_required, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, req.params.id, text, questionType, isRequired !== false, typeof sortOrder === 'number' ? sortOrder : 0]
    );
    res.status(201).json({ id });
  } catch (e) {
    console.error('Error adding survey question', e);
    res.status(500).json({ error: 'Errore creazione domanda' });
  }
});

app.put('/api/admin/survey-questions/:qid', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { text, questionType, isRequired, sortOrder } = req.body || {};
  // UPDATE diretta: la tabella survey_questions non ha la colonna updated_at,
  // quindi non possiamo usare buildUpdateQuery (che la imposta sempre).
  const sets = [];
  const values = [];
  if (typeof text === 'string' && text.trim()) { values.push(text.trim()); sets.push(`text = $${values.length}`); }
  if (['rating', 'text'].includes(questionType)) { values.push(questionType); sets.push(`question_type = $${values.length}`); }
  if (typeof isRequired === 'boolean') { values.push(isRequired); sets.push(`is_required = $${values.length}`); }
  if (typeof sortOrder === 'number') { values.push(sortOrder); sets.push(`sort_order = $${values.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'Nessun campo da aggiornare' });
  values.push(req.params.qid);
  try {
    const { rows } = await pool.query(
      `UPDATE survey_questions SET ${sets.join(', ')} WHERE id = $${values.length}
       RETURNING id, text, question_type AS "questionType", is_required AS "isRequired", sort_order AS "sortOrder"`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Non trovato' });
    res.json(rows[0]);
  } catch (e) {
    console.error('Error updating survey question', e);
    res.status(500).json({ error: 'Errore aggiornamento' });
  }
});

app.delete('/api/admin/survey-questions/:qid', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rowCount } = await pool.query('DELETE FROM survey_questions WHERE id=$1', [req.params.qid]);
    if (!rowCount) return res.status(404).json({ error: 'Non trovato' });
    res.status(204).send();
  } catch (e) {
    console.error('Error deleting survey question', e);
    res.status(500).json({ error: 'Errore eliminazione' });
  }
});

// --- ADMIN: SURVEY CAMPAIGNS (lanci) ---

app.get('/api/admin/survey-campaigns', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT c.id, c.survey_id AS "surveyId", c.title, c.scope_type AS "scopeType", c.scope_id AS "scopeId",
             c.opens_at AS "opensAt", c.closes_at AS "closesAt", c.is_active AS "isActive",
             c.created_at AS "createdAt",
             s.title AS "surveyTitle", s.target_role AS "targetRole",
             (SELECT COUNT(*)::int FROM survey_invitations i WHERE i.campaign_id = c.id) AS "invitedCount",
             (SELECT COUNT(*)::int FROM survey_invitations i WHERE i.campaign_id = c.id AND i.completed_at IS NOT NULL) AS "completedCount"
      FROM survey_campaigns c
      JOIN surveys s ON s.id = c.survey_id
      ORDER BY c.created_at DESC
    `);
    // arricchisco con lo scope label
    for (const r of rows) {
      r.scopeLabel = await resolveSurveyScopeLabel(r.scopeType, r.scopeId);
    }
    res.json(rows);
  } catch (e) {
    console.error('Error listing survey campaigns', e);
    res.status(500).json({ error: 'Errore' });
  }
});

app.post('/api/admin/survey-campaigns', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { surveyId, title, scopeType, scopeId, opensAt, closesAt, recipientMode = 'scope', recipientId } = req.body || {};
  if (!surveyId || !['course', 'module', 'lesson', 'teacher'].includes(scopeType)) {
    return res.status(400).json({ error: 'surveyId e scopeType sono obbligatori' });
  }
  if (scopeType !== 'course' && !scopeId) {
    return res.status(400).json({ error: 'scopeId è obbligatorio per scope diverso da course' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: surveys } = await client.query(
      'SELECT target_role FROM surveys WHERE id=$1', [surveyId]
    );
    if (!surveys.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Questionario non trovato' }); }
    const targetRole = surveys[0].target_role;
    const { rows: hasQ } = await client.query(
      'SELECT 1 FROM survey_questions WHERE survey_id=$1 LIMIT 1', [surveyId]
    );
    if (!hasQ.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Aggiungi almeno una domanda al questionario prima di lanciarlo' }); }

    const campaignId = uuidv4();
    await client.query(
      `INSERT INTO survey_campaigns (id, survey_id, title, scope_type, scope_id, opens_at, closes_at, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)`,
      [campaignId, surveyId, title || null, scopeType, scopeId || null,
       opensAt || new Date().toISOString(), closesAt || null]
    );

    let invitees;
    if (recipientMode === 'single') {
      const invitee = await getSingleSurveyInvitee(client, targetRole, recipientId);
      if (!invitee) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Destinatario non valido o non attivo' });
      }
      invitees = [invitee];
    } else {
      invitees = await computeSurveyInvitees(client, scopeType, scopeId || null, targetRole);
    }
    let invitedCount = 0;
    for (const inv of invitees) {
      await client.query(
        `INSERT INTO survey_invitations (id, campaign_id, user_id, faculty_id) VALUES ($1,$2,$3,$4)
         ON CONFLICT DO NOTHING`,
        [uuidv4(), campaignId, inv.user_id, inv.faculty_id]
      );
      invitedCount++;
    }

    await client.query('COMMIT');
    res.status(201).json({ id: campaignId, invitedCount, targetRole, recipientMode });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Error launching survey campaign', e);
    res.status(500).json({ error: 'Errore nel lancio della campagna: ' + e.message });
  } finally {
    client.release();
  }
});

app.get('/api/admin/survey-campaigns/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows: campaigns } = await pool.query(`
      SELECT c.id, c.survey_id AS "surveyId", c.title, c.scope_type AS "scopeType", c.scope_id AS "scopeId",
             c.opens_at AS "opensAt", c.closes_at AS "closesAt", c.is_active AS "isActive",
             s.title AS "surveyTitle", s.target_role AS "targetRole"
      FROM survey_campaigns c JOIN surveys s ON s.id=c.survey_id WHERE c.id=$1
    `, [req.params.id]);
    if (!campaigns.length) return res.status(404).json({ error: 'Non trovata' });
    const c = campaigns[0];
    c.scopeLabel = await resolveSurveyScopeLabel(c.scopeType, c.scopeId);
    res.json(c);
  } catch (e) {
    console.error('Error fetching campaign', e);
    res.status(500).json({ error: 'Errore' });
  }
});

app.put('/api/admin/survey-campaigns/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const { isActive, closesAt, title } = req.body || {};
  try {
    const { query, values } = buildUpdateQuery('survey_campaigns', {
      title,
      is_active: typeof isActive === 'boolean' ? isActive : undefined,
      closes_at: closesAt !== undefined ? (closesAt || null) : undefined
    }, req.params.id);
    const { rows } = await pool.query(query, values);
    if (!rows.length) return res.status(404).json({ error: 'Non trovata' });
    res.json(rows[0]);
  } catch (e) {
    console.error('Error updating campaign', e);
    res.status(500).json({ error: 'Errore' });
  }
});

app.delete('/api/admin/survey-campaigns/:id', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rowCount } = await pool.query('DELETE FROM survey_campaigns WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Non trovata' });
    res.status(204).send();
  } catch (e) {
    console.error('Error deleting campaign', e);
    res.status(500).json({ error: 'Errore' });
  }
});

app.post('/api/admin/survey-campaigns/:id/reset-results', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: campaign } = await client.query('SELECT id FROM survey_campaigns WHERE id=$1', [req.params.id]);
    if (!campaign.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Campagna non trovata' });
    }
    const { rowCount: deletedAnswers } = await client.query(
      `DELETE FROM survey_answers a
        USING survey_invitations i
        WHERE a.invitation_id = i.id AND i.campaign_id = $1`,
      [req.params.id]
    );
    const { rowCount: resetInvitations } = await client.query(
      'UPDATE survey_invitations SET completed_at = NULL WHERE campaign_id = $1 AND completed_at IS NOT NULL',
      [req.params.id]
    );
    await client.query('COMMIT');
    res.json({ deletedAnswers, resetInvitations });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Error resetting survey results', e);
    res.status(500).json({ error: 'Errore reset risultati' });
  } finally {
    client.release();
  }
});

app.delete('/api/admin/survey-campaigns/:campaignId/invitations/:invitationId/results', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: invitation } = await client.query(
      'SELECT id FROM survey_invitations WHERE id=$1 AND campaign_id=$2',
      [req.params.invitationId, req.params.campaignId]
    );
    if (!invitation.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Compilazione non trovata' });
    }
    const { rowCount: deletedAnswers } = await client.query(
      'DELETE FROM survey_answers WHERE invitation_id=$1',
      [req.params.invitationId]
    );
    await client.query('UPDATE survey_invitations SET completed_at = NULL WHERE id=$1', [req.params.invitationId]);
    await client.query('COMMIT');
    res.json({ deletedAnswers });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Error deleting survey invitation results', e);
    res.status(500).json({ error: 'Errore eliminazione risultato' });
  } finally {
    client.release();
  }
});

// Risultati aggregati di una campagna (admin vede aggregati + commenti senza nominativo)
app.get('/api/admin/survey-campaigns/:id/results', requireAdmin, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows: campaign } = await pool.query(`
      SELECT c.id, c.survey_id AS "surveyId", c.title, c.scope_type AS "scopeType", c.scope_id AS "scopeId",
             c.is_active AS "isActive", s.title AS "surveyTitle", s.target_role AS "targetRole"
      FROM survey_campaigns c JOIN surveys s ON s.id=c.survey_id WHERE c.id=$1
    `, [req.params.id]);
    if (!campaign.length) return res.status(404).json({ error: 'Non trovata' });

    const { rows: questions } = await pool.query(
      `SELECT id, text, question_type AS "questionType", sort_order AS "sortOrder"
       FROM survey_questions WHERE survey_id=$1 ORDER BY sort_order ASC, created_at ASC`,
      [campaign[0].surveyId]
    );

    const { rows: invStats } = await pool.query(
      `SELECT COUNT(*)::int AS invited,
              COUNT(*) FILTER (WHERE completed_at IS NOT NULL)::int AS completed
       FROM survey_invitations WHERE campaign_id=$1`, [req.params.id]
    );

    // Per ogni domanda: media+istogramma se rating, lista commenti se text
    const aggregates = [];
    for (const q of questions) {
      if (q.questionType === 'rating') {
        const { rows: agg } = await pool.query(
          `SELECT AVG(rating_value)::numeric(4,2) AS avg, COUNT(*)::int AS n,
                  COUNT(*) FILTER (WHERE rating_value=1)::int AS r1,
                  COUNT(*) FILTER (WHERE rating_value=2)::int AS r2,
                  COUNT(*) FILTER (WHERE rating_value=3)::int AS r3,
                  COUNT(*) FILTER (WHERE rating_value=4)::int AS r4,
                  COUNT(*) FILTER (WHERE rating_value=5)::int AS r5
           FROM survey_answers a
           JOIN survey_invitations i ON i.id = a.invitation_id
           WHERE i.campaign_id=$1 AND a.question_id=$2 AND a.rating_value IS NOT NULL`,
          [req.params.id, q.id]
        );
        aggregates.push({ ...q, ...agg[0] });
      } else {
        const { rows: comments } = await pool.query(
          `SELECT a.text_value AS comment FROM survey_answers a
           JOIN survey_invitations i ON i.id = a.invitation_id
           WHERE i.campaign_id=$1 AND a.question_id=$2 AND a.text_value IS NOT NULL AND TRIM(a.text_value)<>''`,
          [req.params.id, q.id]
        );
        aggregates.push({ ...q, comments: comments.map(c => c.comment), n: comments.length });
      }
    }

    // I risultati sono anonimi: non restituiamo l'elenco delle singole compilazioni
    // con nomi/email dei rispondenti, ma solo gli aggregati e i commenti anonimi.
    res.json({
      campaign: { ...campaign[0], scopeLabel: await resolveSurveyScopeLabel(campaign[0].scopeType, campaign[0].scopeId) },
      stats: invStats[0],
      questions: aggregates
    });
  } catch (e) {
    console.error('Error fetching results', e);
    res.status(500).json({ error: 'Errore nel recupero dei risultati' });
  }
});

// --- COMPILE: condiviso student/teacher (interno) ---

async function getInvitationForUser(invitationId, identity) {
  // identity = { userId } per student, { facultyId } per teacher
  const { rows } = await pool.query(`
    SELECT i.id, i.campaign_id AS "campaignId", i.user_id AS "userId", i.faculty_id AS "facultyId",
           i.completed_at AS "completedAt",
           c.opens_at AS "opensAt", c.closes_at AS "closesAt", c.is_active AS "isActive",
           c.scope_type AS "scopeType", c.scope_id AS "scopeId", c.title AS "campaignTitle",
           s.id AS "surveyId", s.title AS "surveyTitle", s.description AS "surveyDescription", s.target_role AS "targetRole"
    FROM survey_invitations i
    JOIN survey_campaigns c ON c.id = i.campaign_id
    JOIN surveys s ON s.id = c.survey_id
    WHERE i.id = $1
  `, [invitationId]);
  if (!rows.length) return { notFound: true };
  const inv = rows[0];
  if (identity.userId && inv.userId !== identity.userId) return { forbidden: true };
  if (identity.facultyId && inv.facultyId !== identity.facultyId) return { forbidden: true };
  if (!inv.isActive) return { closed: true, invitation: inv };
  if (inv.closesAt && new Date(inv.closesAt) < new Date()) return { closed: true, invitation: inv };
  return { ok: true, invitation: inv };
}

async function loadSurveyQuestionsForCompile(surveyId) {
  const { rows } = await pool.query(
    `SELECT id, text, question_type AS "questionType", is_required AS "isRequired", sort_order AS "sortOrder"
     FROM survey_questions WHERE survey_id=$1 ORDER BY sort_order ASC, created_at ASC`,
    [surveyId]
  );
  return rows;
}

async function submitSurveyAnswers(invitationId, surveyId, answers) {
  // answers: [{ questionId, ratingValue?, textValue? }]
  const questions = await loadSurveyQuestionsForCompile(surveyId);
  const qmap = new Map(questions.map(q => [q.id, q]));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const ans of answers || []) {
      const q = qmap.get(ans.questionId);
      if (!q) continue;
      let rating = null, text = null;
      if (q.questionType === 'rating') {
        rating = Number(ans.ratingValue);
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
          if (q.isRequired) throw new Error('Risposta rating mancante o invalida per "' + q.text + '"');
          continue;
        }
      } else {
        text = (ans.textValue || '').trim() || null;
        if (!text && q.isRequired) throw new Error('Risposta mancante per "' + q.text + '"');
      }
      await client.query(
        `INSERT INTO survey_answers (id, invitation_id, question_id, rating_value, text_value)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (invitation_id, question_id)
         DO UPDATE SET rating_value=EXCLUDED.rating_value, text_value=EXCLUDED.text_value, answered_at=NOW()`,
        [uuidv4(), invitationId, q.id, rating, text]
      );
    }
    // verifica required tutti coperti
    const { rows: missing } = await client.query(
      `SELECT q.id, q.text FROM survey_questions q
       WHERE q.survey_id=$1 AND q.is_required=TRUE
       AND NOT EXISTS (
         SELECT 1 FROM survey_answers a WHERE a.invitation_id=$2 AND a.question_id=q.id
         AND ((q.question_type='rating' AND a.rating_value IS NOT NULL)
           OR (q.question_type='text' AND a.text_value IS NOT NULL AND TRIM(a.text_value)<>''))
       )`,
      [surveyId, invitationId]
    );
    if (missing.length) throw new Error('Mancano risposte obbligatorie: ' + missing.map(m => m.text).join('; '));
    await client.query('UPDATE survey_invitations SET completed_at=NOW() WHERE id=$1', [invitationId]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// --- STUDENT: compile ---

app.get('/api/lms/my-surveys', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT i.id AS "invitationId", i.completed_at AS "completedAt",
             c.id AS "campaignId", c.title AS "campaignTitle", c.scope_type AS "scopeType", c.scope_id AS "scopeId",
             c.opens_at AS "opensAt", c.closes_at AS "closesAt", c.is_active AS "isActive",
             s.title AS "surveyTitle", s.description AS "surveyDescription"
      FROM survey_invitations i
      JOIN survey_campaigns c ON c.id = i.campaign_id
      JOIN surveys s ON s.id = c.survey_id
      WHERE i.user_id = $1 AND c.is_active = TRUE
        AND (c.opens_at IS NULL OR c.opens_at <= NOW())
        AND (c.closes_at IS NULL OR c.closes_at > NOW())
      ORDER BY i.completed_at NULLS FIRST, c.opens_at DESC
    `, [req.user.userId]);
    for (const r of rows) r.scopeLabel = await resolveSurveyScopeLabel(r.scopeType, r.scopeId);
    res.json(rows);
  } catch (e) {
    console.error('Error listing my-surveys (student)', e);
    res.status(500).json({ error: 'Errore' });
  }
});

app.get('/api/lms/surveys/invitations/:invitationId', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const result = await getInvitationForUser(req.params.invitationId, { userId: req.user.userId });
    if (result.notFound) return res.status(404).json({ error: 'Invito non trovato' });
    if (result.forbidden) return res.status(403).json({ error: 'Non autorizzato' });
    if (result.closed) return res.status(410).json({ error: 'Questa campagna è chiusa', invitation: result.invitation });
    const questions = await loadSurveyQuestionsForCompile(result.invitation.surveyId);
    let existingAnswers = [];
    if (result.invitation.completedAt) {
      const { rows: existing } = await pool.query(
        `SELECT question_id AS "questionId", rating_value AS "ratingValue", text_value AS "textValue"
         FROM survey_answers WHERE invitation_id = $1`, [result.invitation.id]
      );
      existingAnswers = existing;
    }
    res.json({ invitation: result.invitation, questions, existingAnswers });
  } catch (e) {
    console.error('Error get survey for compile (student)', e);
    res.status(500).json({ error: 'Errore' });
  }
});

app.post('/api/lms/surveys/invitations/:invitationId/submit', requireStudent, requireNonGuest, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const result = await getInvitationForUser(req.params.invitationId, { userId: req.user.userId });
    if (result.notFound) return res.status(404).json({ error: 'Invito non trovato' });
    if (result.forbidden) return res.status(403).json({ error: 'Non autorizzato' });
    if (result.closed) return res.status(410).json({ error: 'Campagna chiusa' });
    await submitSurveyAnswers(req.params.invitationId, result.invitation.surveyId, req.body?.answers || []);
    res.json({ ok: true });
  } catch (e) {
    console.error('Error submitting survey (student)', e);
    res.status(400).json({ error: e.message || 'Errore invio risposte' });
  }
});

// --- TEACHER: compile (questionari rivolti ai docenti) ---

app.get('/api/teachers/my-surveys', requireTeacher, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const { rows } = await pool.query(`
      SELECT i.id AS "invitationId", i.completed_at AS "completedAt",
             c.id AS "campaignId", c.title AS "campaignTitle", c.scope_type AS "scopeType", c.scope_id AS "scopeId",
             c.opens_at AS "opensAt", c.closes_at AS "closesAt",
             s.title AS "surveyTitle", s.description AS "surveyDescription"
      FROM survey_invitations i
      JOIN survey_campaigns c ON c.id = i.campaign_id
      JOIN surveys s ON s.id = c.survey_id
      WHERE i.faculty_id = $1 AND c.is_active = TRUE
        AND (c.opens_at IS NULL OR c.opens_at <= NOW())
        AND (c.closes_at IS NULL OR c.closes_at > NOW())
      ORDER BY i.completed_at NULLS FIRST, c.opens_at DESC
    `, [req.user.id]);
    for (const r of rows) r.scopeLabel = await resolveSurveyScopeLabel(r.scopeType, r.scopeId);
    res.json(rows);
  } catch (e) {
    console.error('Error listing my-surveys (teacher)', e);
    res.status(500).json({ error: 'Errore' });
  }
});

app.get('/api/teachers/surveys/invitations/:invitationId', requireTeacher, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const result = await getInvitationForUser(req.params.invitationId, { facultyId: req.user.id });
    if (result.notFound) return res.status(404).json({ error: 'Invito non trovato' });
    if (result.forbidden) return res.status(403).json({ error: 'Non autorizzato' });
    if (result.closed) return res.status(410).json({ error: 'Campagna chiusa', invitation: result.invitation });
    const questions = await loadSurveyQuestionsForCompile(result.invitation.surveyId);
    let existingAnswers = [];
    if (result.invitation.completedAt) {
      const { rows: existing } = await pool.query(
        `SELECT question_id AS "questionId", rating_value AS "ratingValue", text_value AS "textValue"
         FROM survey_answers WHERE invitation_id = $1`, [result.invitation.id]
      );
      existingAnswers = existing;
    }
    res.json({ invitation: result.invitation, questions, existingAnswers });
  } catch (e) {
    console.error('Error get survey for compile (teacher)', e);
    res.status(500).json({ error: 'Errore' });
  }
});

app.post('/api/teachers/surveys/invitations/:invitationId/submit', requireTeacher, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const result = await getInvitationForUser(req.params.invitationId, { facultyId: req.user.id });
    if (result.notFound) return res.status(404).json({ error: 'Invito non trovato' });
    if (result.forbidden) return res.status(403).json({ error: 'Non autorizzato' });
    if (result.closed) return res.status(410).json({ error: 'Campagna chiusa' });
    await submitSurveyAnswers(req.params.invitationId, result.invitation.surveyId, req.body?.answers || []);
    res.json({ ok: true });
  } catch (e) {
    console.error('Error submitting survey (teacher)', e);
    res.status(400).json({ error: e.message || 'Errore invio risposte' });
  }
});

// --- TEACHER: feedback ricevuti (aggregati anonimi sui questionari "su di lui") ---
//   2b: il docente vede aggregati senza nominativi delle proprie campagne (scope='teacher', scope_id = la sua faculty_id)
app.get('/api/teachers/feedback-on-me', requireTeacher, async (req, res) => {
  if (!ensurePool(res)) return;
  try {
    const facultyId = req.user.id;
    const { rows: campaigns } = await pool.query(`
      SELECT c.id, c.title, c.scope_type AS "scopeType", c.scope_id AS "scopeId",
             c.opens_at AS "opensAt", c.closes_at AS "closesAt", c.is_active AS "isActive",
             s.id AS "surveyId", s.title AS "surveyTitle", s.target_role AS "targetRole",
             (SELECT COUNT(*)::int FROM survey_invitations i WHERE i.campaign_id=c.id) AS "invitedCount",
             (SELECT COUNT(*)::int FROM survey_invitations i WHERE i.campaign_id=c.id AND i.completed_at IS NOT NULL) AS "completedCount"
      FROM survey_campaigns c JOIN surveys s ON s.id=c.survey_id
      WHERE c.scope_type='teacher' AND c.scope_id=$1
      ORDER BY c.created_at DESC
    `, [facultyId]);

    const out = [];
    for (const camp of campaigns) {
      const { rows: questions } = await pool.query(
        `SELECT id, text, question_type AS "questionType", sort_order AS "sortOrder"
         FROM survey_questions WHERE survey_id=$1 ORDER BY sort_order ASC, created_at ASC`,
        [camp.surveyId]
      );
      const aggregates = [];
      for (const q of questions) {
        if (q.questionType === 'rating') {
          const { rows: agg } = await pool.query(
            `SELECT AVG(rating_value)::numeric(4,2) AS avg, COUNT(*)::int AS n
             FROM survey_answers a JOIN survey_invitations i ON i.id=a.invitation_id
             WHERE i.campaign_id=$1 AND a.question_id=$2 AND a.rating_value IS NOT NULL`,
            [camp.id, q.id]
          );
          aggregates.push({ ...q, ...agg[0] });
        } else {
          const { rows: comments } = await pool.query(
            `SELECT a.text_value AS comment FROM survey_answers a
             JOIN survey_invitations i ON i.id=a.invitation_id
             WHERE i.campaign_id=$1 AND a.question_id=$2 AND a.text_value IS NOT NULL AND TRIM(a.text_value)<>''`,
            [camp.id, q.id]
          );
          aggregates.push({ ...q, comments: comments.map(c => c.comment), n: comments.length });
        }
      }
      out.push({ campaign: camp, questions: aggregates });
    }
    res.json(out);
  } catch (e) {
    console.error('Error fetching feedback-on-me', e);
    res.status(500).json({ error: 'Errore' });
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
    if (err.code === 'LIMIT_FILE_SIZE') {
      if (req && req.path === '/api/resources/upload') {
        return res.status(413).json({
          error: `File troppo grande. Limite effettivo 4MB dopo compressione automatica dei PDF. Formati ammessi: ${ALLOWED_UPLOAD_EXTENSIONS_LABEL}.`
        });
      }
      if (req && (req.path === '/api/materials/upload' || req.path === '/api/teachers/upload')) {
        return res.status(413).json({
          error: `File troppo grande. Limite tecnico di caricamento 50MB; il limite finale resta 20MB dopo eventuale compressione PDF. Formati ammessi: ${ALLOWED_UPLOAD_EXTENSIONS_LABEL}.`
        });
      }
      return res.status(413).json({ error: `File troppo grande. Formati ammessi: ${ALLOWED_UPLOAD_EXTENSIONS_LABEL}.` });
    }
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
module.exports.__setConferenceRegistrationEmailSender = (nextSender) => {
  conferenceRegistrationEmailSender = typeof nextSender === 'function' ? nextSender : sendEmail;
};
module.exports.__setQuestionAssignmentEmailSender = (nextSender) => {
  questionAssignmentEmailSender = typeof nextSender === 'function' ? nextSender : sendEmail;
};
