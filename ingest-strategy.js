// ingest-strategy.js
// Carga automáticamente el documento de estrategia al RAG
// Ejecutar: node ingest-strategy.js

require('dotenv').config();
const fs       = require('fs');
const path     = require('path');
const { initDB } = require('./src/models/db');
const rag      = require('./src/services/rag');

const STRATEGY_FILE = path.join(__dirname, 'data', 'rag-strategy.md');

async function main() {
  initDB();

  if (!fs.existsSync(STRATEGY_FILE)) {
    console.error('No se encontró data/rag-strategy.md');
    process.exit(1);
  }

  const content = fs.readFileSync(STRATEGY_FILE, 'utf8');
  console.log(`Leyendo estrategia: ${content.length} caracteres`);

  const result = await rag.ingestDocument(
    'Estrategia de Inversión Inteligente',
    'md',
    content
  );

  console.log(`✅ Documento cargado al RAG: ${result.chunksCount} chunks`);
  console.log('Esperando generación de embeddings (30s)...');

  // Dar tiempo para embeddings
  await new Promise(r => setTimeout(r, 30000));
  console.log('Listo. El documento está disponible para la IA.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
