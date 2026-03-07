// check-rag.js — Verificar estado del RAG en la DB
// Ejecutar: node check-rag.js

const { getDB, initDB } = require('./src/models/db');
initDB();
const db = getDB();

console.log('\n=== RAG STATUS ===\n');

const docs = db.prepare('SELECT id, name, type, chunks_count, created_at FROM rag_documents ORDER BY id DESC LIMIT 10').all();
console.log(`Documentos RAG: ${docs.length}`);
docs.forEach(d => console.log(`  [${d.id}] ${d.name} (${d.type}) — ${d.chunks_count} chunks — ${d.created_at}`));

const totalChunks = db.prepare('SELECT COUNT(*) as c FROM rag_chunks').get().c;
const withEmb = db.prepare("SELECT COUNT(*) as c FROM rag_chunks WHERE embedding IS NOT NULL AND embedding != ''").get().c;
console.log(`\nChunks totales: ${totalChunks}`);
console.log(`Chunks con embedding: ${withEmb}`);
console.log(`Chunks solo keywords: ${totalChunks - withEmb}`);

// Test de búsqueda por keywords (gratis, sin OpenAI)
const testQuery = 'bitcoin trading risk strategy';
const qWords = testQuery.toLowerCase().match(/\b\w{3,}\b/g) || [];
const allChunks = db.prepare('SELECT id, doc_id, text, keywords FROM rag_chunks').all();
const results = allChunks.map(c => {
  const text = (c.text + ' ' + c.keywords).toLowerCase();
  let score = 0;
  for (const w of qWords) if (text.includes(w)) score++;
  return { ...c, score };
}).filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);

console.log(`\nBúsqueda keywords "${testQuery}": ${results.length} resultados`);
results.forEach(r => console.log(`  Score:${r.score} — "${r.text.substring(0, 100)}..."`));

if (!totalChunks) {
  console.log('\n⚠️  NO HAY DATOS RAG. El RAG no aporta nada sin documentos.');
  console.log('   Para que funcione, subí documentos de estrategia desde el dashboard.');
}

console.log('\n=== CONFIG CRYPTO ===\n');
const cfg = db.prepare('SELECT * FROM crypto_config WHERE id = 1').get();
if (cfg) {
  console.log(`Enabled: ${cfg.enabled}`);
  console.log(`Intervalo: ${cfg.analysis_interval_min} min`);
  console.log(`Max trade: $${cfg.max_per_trade_usd}`);
  console.log(`Risk: ${cfg.risk_level} | SL: ${cfg.stop_loss_pct}% | TP: ${cfg.take_profit_pct}%`);
}

console.log('\n=== POSICIONES ===\n');
const open = db.prepare("SELECT * FROM crypto_positions WHERE status = 'OPEN'").all();
const closed = db.prepare("SELECT COUNT(*) as c FROM crypto_positions WHERE status = 'CLOSED'").get().c;
console.log(`Abiertas: ${open.length}`);
open.forEach(p => console.log(`  ${p.symbol}: ${p.quantity} @ $${p.entry_price} (SL:$${p.stop_loss} TP:$${p.take_profit})`));
console.log(`Cerradas: ${closed}`);

process.exit(0);
