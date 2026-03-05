// src/routes/rag.js
// Rutas del módulo RAG — subida de documentos + búsqueda + config IA avanzada

const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const auth    = require('../middleware/auth');
const rag     = require('../services/rag');
const aiTrader= require('../services/ai-trader');

const OWNER_ID = parseInt(process.env.COCOS_OWNER_USER_ID || '1');
function ownerOnly(req, res, next) {
  if (req.userId !== OWNER_ID) return res.status(403).json({ error: 'Solo el propietario' });
  next();
}

// ── Multer config ─────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: rag.UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')),
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.txt', '.md', '.csv', '.json', '.pdf'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

// ── Documentos ────────────────────────────────────────────────────────────────

// GET /api/rag/documents
router.get('/documents', auth, ownerOnly, (req, res) => {
  res.json(rag.getDocuments());
});

// POST /api/rag/documents  — subir archivo
router.post('/documents', auth, ownerOnly, upload.single('file'), async (req, res) => {
  try {
    if (!req.file && !req.body.text) return res.status(400).json({ error: 'Archivo o texto requerido' });

    let content = '';
    let name    = '';
    let type    = 'txt';

    if (req.file) {
      name = req.file.originalname;
      type = path.extname(name).replace('.', '');
      const fs = require('fs');
      if (type === 'pdf') {
        // PDF simple: extraer texto plano con regex básico
        const buf = fs.readFileSync(req.file.path);
        content = buf.toString('latin1').replace(/[^\x20-\x7E\n]/g, ' ').replace(/\s+/g, ' ').substring(0, 50000);
      } else {
        content = fs.readFileSync(req.file.path, 'utf8');
      }
    } else {
      content = req.body.text;
      name    = req.body.name || 'Manual ' + new Date().toLocaleDateString('es-AR');
      type    = 'txt';
    }

    if (!content.trim()) return res.status(400).json({ error: 'El archivo está vacío' });

    const result = await rag.ingestDocument(name, type, content);
    res.json({ ok: true, ...result, name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/rag/documents/:id
router.delete('/documents/:id', auth, ownerOnly, (req, res) => {
  rag.deleteDocument(parseInt(req.params.id));
  res.json({ ok: true });
});

// POST /api/rag/search
router.post('/search', auth, ownerOnly, async (req, res) => {
  const { query, limit } = req.body;
  if (!query) return res.status(400).json({ error: 'query requerido' });
  const results = await rag.search(query, limit || 5);
  res.json(results);
});

// ── Config avanzada IA ────────────────────────────────────────────────────────

// GET /api/rag/ai-config
router.get('/ai-config', auth, ownerOnly, (req, res) => {
  res.json(aiTrader.getConfig());
});

// PUT /api/rag/ai-config
router.put('/ai-config', auth, ownerOnly, (req, res) => {
  const allowed = [
    'enabled', 'auto_execute', 'max_per_trade_ars', 'min_confidence', 'risk_level',
    'sectors', 'asset_types', 'news_driven', 'news_weight', 'use_rag',
    'max_positions', 'stop_loss_pct', 'take_profit_pct',
  ];
  const changes = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) changes[k] = req.body[k];
  }
  if (!Object.keys(changes).length) return res.status(400).json({ error: 'Nada que actualizar' });
  res.json(aiTrader.updateConfig(changes));
});

module.exports = router;
