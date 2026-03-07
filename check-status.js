// check-status.js — Diagnóstico completo del sistema
const { getDB, initDB } = require('./src/models/db');
initDB();
const db = getDB();

console.log('\n=== ESTADO DEL BOT ===\n');

// Config
const cfg = db.prepare('SELECT * FROM crypto_config WHERE id = 1').get();
console.log(`Enabled: ${cfg.enabled} | Intervalo: ${cfg.analysis_interval_min} min`);

// Todas las posiciones (abiertas y cerradas)
const all = db.prepare('SELECT * FROM crypto_positions ORDER BY id DESC').all();
console.log(`\nTotal posiciones en DB: ${all.length}`);
console.log('\n--- TODAS LAS OPERACIONES ---');
all.forEach(p => {
  const created = p.created_at;
  const status = p.status;
  const pnl = p.pnl ? `PnL: $${p.pnl.toFixed(4)}` : '';
  console.log(`[${p.id}] ${created} | ${p.symbol} | ${p.side} | qty:${p.quantity} @ $${p.entry_price} | SL:$${p.stop_loss} TP:$${p.take_profit} | ${status} ${pnl} | order:${p.order_id} | ${p.reason?.substring(0, 60)}`);
});

// Verificar XRP específicamente
console.log('\n--- BUSCAR XRP ---');
const xrp = db.prepare("SELECT * FROM crypto_positions WHERE symbol LIKE '%XRP%'").all();
if (xrp.length) {
  xrp.forEach(p => console.log(`  [${p.id}] ${p.created_at} | ${p.symbol} | ${p.side} | ${p.status} | order:${p.order_id}`));
} else {
  console.log('  NO HAY OPERACIONES XRP EN LA DB');
}

// Timezone check
console.log('\n--- TIMEZONE ---');
console.log(`Server UTC now: ${new Date().toISOString()}`);
console.log(`Server local: ${new Date().toString()}`);
const artNow = new Date(new Date().getTime() - 3 * 3600000);
console.log(`Argentina (UTC-3): ${artNow.toISOString().replace('T', ' ').substring(0, 19)}`);

// Ejemplo: primera y última operación
if (all.length) {
  const first = all[all.length - 1];
  const last = all[0];
  console.log(`\nPrimera op DB: ${first.created_at} (UTC) → Argentina: ${toART(first.created_at)}`);
  console.log(`Última op DB:  ${last.created_at} (UTC) → Argentina: ${toART(last.created_at)}`);
}

function toART(utcStr) {
  const d = new Date(utcStr + 'Z');
  return d.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
}

// Operaciones PAPER vs LIVE
const paper = all.filter(p => p.order_id && p.order_id.startsWith('PAPER'));
const live = all.filter(p => p.order_id && !p.order_id.startsWith('PAPER') && p.order_id !== '');
console.log(`\nOperaciones PAPER: ${paper.length}`);
paper.forEach(p => console.log(`  [${p.id}] ${p.symbol} | ${p.order_id}`));
console.log(`Operaciones LIVE: ${live.length}`);
live.forEach(p => console.log(`  [${p.id}] ${p.symbol} | ${p.order_id}`));

process.exit(0);
