const express = require('express');
const multer = require('multer');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const app = express();
const port = process.env.PORT || 8080;
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 250 * 1024 * 1024);
const PDF_COMPRESSION_PRESETS = ['/screen', '/ebook'];
const ALLOWED_ORIGIN = process.env.CORS_ORIGIN || '*';

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-version, x-api-blob-request-id, x-content-length, x-content-type, x-vercel-blob-access');
  if (req.method === 'OPTIONS') {
    return res.status(204).send();
  }
  next();
});

const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      try {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-worker-upload-'));
        cb(null, tempDir);
      } catch (error) {
        cb(error);
      }
    },
    filename: (_req, file, cb) => {
      const safeName = (file.originalname || 'file.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, safeName);
    }
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ext === '.pdf' || file.mimetype === 'application/pdf') {
      cb(null, true);
      return;
    }
    cb(new Error('Carica un file PDF valido'));
  }
});

async function compressPdfWithGhostscript(inputPath) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-worker-'));
  const outputPath = path.join(tempDir, 'output.pdf');

  try {
    const inputBuffer = await fs.readFile(inputPath);
    let bestBuffer = inputBuffer;
    let bestPreset = null;

    for (const preset of PDF_COMPRESSION_PRESETS) {
      await execFileAsync('gs', [
        '-sDEVICE=pdfwrite',
        '-dCompatibilityLevel=1.4',
        `-dPDFSETTINGS=${preset}`,
        '-dNOPAUSE',
        '-dBATCH',
        '-dQUIET',
        `-sOutputFile=${outputPath}`,
        inputPath
      ], { maxBuffer: 10 * 1024 * 1024 });

      const candidate = await fs.readFile(outputPath);
      if (candidate.length < bestBuffer.length) {
        bestBuffer = candidate;
        bestPreset = preset;
      }

      if (bestBuffer.length <= inputBuffer.length * 0.9) {
        break;
      }
    }

    return {
      buffer: bestBuffer,
      compressed: bestBuffer.length < inputBuffer.length,
      preset: bestPreset || 'ghostscript'
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'unitus-pdf-worker',
    timestamp: new Date().toISOString()
  });
});

app.post('/compress-pdf', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nessun file caricato' });
  }

  try {
    const result = await compressPdfWithGhostscript(req.file.path);
    const safeName = (req.file.originalname || 'file.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
    const compressedName = safeName.replace(/\.pdf$/i, '') + '-compressed.pdf';
    const originalSize = req.file.size;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${compressedName}"`);
    res.setHeader('X-Original-Size', String(originalSize));
    res.setHeader('X-Compressed-Size', String(result.buffer.length));
    res.setHeader('X-Compressed-Filename', compressedName);
    res.setHeader('X-Compression-Applied', result.buffer.length < originalSize ? '1' : '0');
    res.setHeader('X-Compression-Preset', result.preset || 'ghostscript');
    return res.send(result.buffer);
  } catch (error) {
    console.error('Error compressing PDF:', error);
    return res.status(500).json({ error: `Impossibile comprimere il PDF: ${error.message || 'errore sconosciuto'}` });
  } finally {
    if (req.file?.path) {
      await fs.rm(req.file.path, { force: true }).catch(() => {});
    }
    if (req.file?.destination) {
      await fs.rm(req.file.destination, { recursive: true, force: true }).catch(() => {});
    }
  }
});

app.use((error, _req, res, _next) => {
  if (!error) return res.status(500).json({ error: 'Errore sconosciuto' });
  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `File troppo grande. Limite massimo ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.` });
  }
  return res.status(400).json({ error: error.message || 'Richiesta non valida' });
});

app.listen(port, () => {
  console.log(`PDF worker listening on ${port}`);
});
