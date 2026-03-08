const { initDB, getDB } = require('./src/models/db');
initDB();
const db = getDB();
const rows = db.prepare("SELECT id, symbol, status, quantity, entry_price, current_price, pnl, order_id, reason FROM crypto_positions ORDER BY id DESC LIMIT 15").all();
rows.forEach(r => {
  const mode = (r.order_id||'').startsWith('PAPER') ? 'PAPER' : 'LIVE';
  console.log(`#${r.id} ${r.status} ${mode} ${r.symbol} qty=${r.quantity} entry=$${r.entry_price} pnl=$${r.pnl||0}`);
});
const open = rows.filter(r => r.status === 'OPEN');
console.log(`\nAbiertas: ${open.length}`);
open.forEach(r => console.log(`  ${r.symbol}: ${r.quantity} @ $${r.entry_price} | ${r.order_id}`));
process.exit(0);
