// Actualizar config para trading activo
const { getDB, initDB } = require('./src/models/db');
initDB();
const db = getDB();
db.prepare('UPDATE crypto_config SET analysis_interval_min = 5, min_confidence = 0.70 WHERE id = 1').run();
const cfg = db.prepare('SELECT * FROM crypto_config WHERE id = 1').get();
console.log('Config actualizada:', JSON.stringify(cfg, null, 2));

// Ver balance en posiciones abiertas
const open = db.prepare("SELECT * FROM crypto_positions WHERE status = 'OPEN'").all();
console.log(`\nPosiciones abiertas: ${open.length}`);
open.forEach(p => console.log(`  ${p.symbol}: ${p.quantity} @ $${p.entry_price} | order: ${p.order_id}`));

// Ver cuánto USDT libre tiene
process.exit(0);
