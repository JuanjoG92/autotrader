// src/services/rag.js
// RAG Engine para AutoTrader — adaptado de CentralChat
// Almacena documentos del usuario + embeddings en SQLite
// Búsqueda semántica (OpenAI) con fallback a keywords

const { getDB }          = require('../models/db');
const { getOpenAIToken } = require('./ai-token');
const path               = require('path');
const fs                 = require('fs');

const EMBEDDING_MODEL  = 'text-embedding-3-small';
const MAX_CHUNK_SIZE   = 500;
const CHUNK_OVERLAP    = 50;
const UPLOAD_DIR       = path.join(__dirname, '../../data/rag-uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── Embeddings ────────────────────────────────────────────────────────────────

async function getEmbedding(text) {
  const apiKey = await getOpenAIToken();
  if (!apiKey) return null;
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text.substring(0, 8000) }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.data?.[0]?.embedding || null;
  } catch { return null; }
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// ── Chunking ──────────────────────────────────────────────────────────────────

function chunkText(text, docId) {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const paragraphs = clean.split(/\n\n+/);
  const chunks = [];
  let current = '';
  let idx = 0;

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    if ((current + '\n' + trimmed).length <= MAX_CHUNK_SIZE) {
      current = current ? current + '\n' + trimmed : trimmed;
    } else {
      if (current.trim()) {
        chunks.push({ doc_id: docId, chunk_index: idx++, text: current.trim(), keywords: extractKeywords(current) });
        const overlap = current.split(' ').slice(-CHUNK_OVERLAP).join(' ');
        current = overlap + ' ' + trimmed;
      } else {
        current = trimmed;
      }
    }
  }
  if (current.trim()) {
    chunks.push({ doc_id: docId, chunk_index: idx++, text: current.trim(), keywords: extractKeywords(current) });
  }
  return chunks;
}

function extractKeywords(text) {
  const stopwords = new Set(['de', 'la', 'el', 'en', 'y', 'a', 'los', 'las', 'del', 'que', 'se', 'con', 'por', 'para', 'un', 'una', 'es', 'su', 'the', 'and', 'of', 'to', 'in', 'is', 'it']);
  const words = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/\b\w{3,}\b/g) || [];
  const freq = {};
  for (const w of words) { if (!stopwords.has(w)) freq[w] = (freq[w] || 0) + 1; }
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([w]) => w).join(',');
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function getDocuments() {
  return getDB().prepare('SELECT * FROM rag_documents ORDER BY created_at DESC').all();
}

function getDocument(id) {
  return getDB().prepare('SELECT * FROM rag_documents WHERE id = ?').get(id);
}

function deleteDocument(id) {
  const db = getDB();
  db.prepare('DELETE FROM rag_chunks WHERE doc_id = ?').run(id);
  db.prepare('DELETE FROM rag_documents WHERE id = ?').run(id);
}

function getChunks(docId) {
  return getDB().prepare('SELECT * FROM rag_chunks WHERE doc_id = ? ORDER BY chunk_index').all(docId);
}

function getAllChunks() {
  return getDB().prepare('SELECT * FROM rag_chunks ORDER BY doc_id, chunk_index').all();
}

// ── Ingestión ─────────────────────────────────────────────────────────────────

async function ingestDocument(name, type, content) {
  const db = getDB();

  // Crear documento
  const result = db.prepare(
    'INSERT INTO rag_documents (name, type, size) VALUES (?, ?, ?)'
  ).run(name, type, content.length);
  const docId = result.lastInsertRowid;

  // Chunking
  const chunks = chunkText(content, docId);

  // Guardar chunks
  const stmt = db.prepare(
    'INSERT INTO rag_chunks (doc_id, chunk_index, text, keywords) VALUES (?, ?, ?, ?)'
  );
  for (const c of chunks) {
    stmt.run(c.doc_id, c.chunk_index, c.text, c.keywords);
  }

  // Actualizar count
  db.prepare('UPDATE rag_documents SET chunks_count = ? WHERE id = ?').run(chunks.length, docId);

  // Generar embeddings en background
  generateEmbeddings(docId).catch(e => console.error('[RAG] Error embeddings:', e.message));

  console.log(`[RAG] Documento "${name}" ingestado: ${chunks.length} chunks`);
  return { docId, chunksCount: chunks.length };
}

async function generateEmbeddings(docId) {
  const db = getDB();
  const chunks = db.prepare('SELECT * FROM rag_chunks WHERE doc_id = ? AND embedding IS NULL').all(docId);
  if (!chunks.length) return;

  console.log(`[RAG] Generando embeddings para ${chunks.length} chunks...`);
  for (const chunk of chunks) {
    const emb = await getEmbedding(chunk.text);
    if (emb) {
      db.prepare('UPDATE rag_chunks SET embedding = ? WHERE id = ?').run(JSON.stringify(emb), chunk.id);
    }
    await new Promise(r => setTimeout(r, 200)); // rate limit
  }
  console.log(`[RAG] Embeddings generados para doc ${docId}`);
}

// ── Búsqueda semántica ────────────────────────────────────────────────────────

async function search(query, maxResults) {
  const lim    = maxResults || 5;
  const chunks = getAllChunks();
  if (!chunks.length) return [];

  // Intentar búsqueda semántica
  const withEmb = chunks.filter(c => c.embedding);
  if (withEmb.length > 0) {
    const queryEmb = await getEmbedding(query);
    if (queryEmb) {
      const scored = withEmb
        .map(c => ({ ...c, score: cosineSimilarity(queryEmb, JSON.parse(c.embedding)) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, lim);
      if (scored[0]?.score > 0.25) {
        return scored.map(({ embedding, ...c }) => c);
      }
    }
  }

  // Fallback: keywords
  const qWords = query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/\b\w{3,}\b/g) || [];
  const scored = chunks.map(c => {
    const text = (c.text + ' ' + c.keywords).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    let score = 0;
    for (const w of qWords) if (text.includes(w)) score++;
    return { ...c, score };
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, lim);

  return scored.map(({ embedding, ...c }) => c);
}

async function buildRAGContext(query) {
  const results = await search(query, 5);
  if (!results.length) return '';
  return results.map(c => c.text).join('\n\n---\n\n');
}

// ── Auto-ingest de noticias diarias ──────────────────────────────────────────

async function ingestDailyNews() {
  const db = getDB();

  // Verificar si ya se ingirió hoy
  const today = new Date().toISOString().split('T')[0];
  const existing = db.prepare(
    "SELECT id FROM rag_documents WHERE name LIKE ? LIMIT 1"
  ).get(`news-digest-${today}%`);
  if (existing) return null;

  // Obtener noticias de las últimas 24h
  const newsRows = db.prepare(
    "SELECT title, summary, keywords, source FROM news_items WHERE published_at > datetime('now', '-24 hours') ORDER BY published_at DESC LIMIT 100"
  ).all();
  if (newsRows.length < 5) return null;

  // Construir documento resumen
  const lines = newsRows.map(n => {
    const kw = n.keywords ? ` [${n.keywords}]` : '';
    return `[${n.source}] ${n.title}${n.summary ? ': ' + n.summary.substring(0, 150) : ''}${kw}`;
  });
  const content = `RESUMEN DE NOTICIAS FINANCIERAS — ${today}\n${newsRows.length} noticias de las últimas 24h.\n\n` + lines.join('\n\n');

  // Ingerir como documento RAG
  const result = await ingestDocument(`news-digest-${today}`, 'auto-news', content);
  console.log(`[RAG] Auto-ingest noticias: ${result.chunksCount} chunks del ${today}`);

  // Limpiar digests viejos (mantener últimos 7 días)
  const oldDocs = db.prepare(
    "SELECT id FROM rag_documents WHERE type = 'auto-news' ORDER BY created_at DESC"
  ).all();
  if (oldDocs.length > 7) {
    for (const old of oldDocs.slice(7)) {
      deleteDocument(old.id);
    }
    console.log(`[RAG] Limpieza: eliminados ${oldDocs.length - 7} digests antiguos`);
  }

  return result;
}

module.exports = {
  ingestDocument,
  ingestDailyNews,
  getDocuments,
  getDocument,
  deleteDocument,
  getChunks,
  search,
  buildRAGContext,
  generateEmbeddings,
  UPLOAD_DIR,
};
