require('dotenv').config();
const { initDB, getDB } = require('./src/models/db');
initDB();
getDB().prepare('SELECT id, symbol, order_id, status, quantity, entry_price FROM crypto_positions ORDER BY id').all().forEach(r => {
  const oid = (r.order_id || '').substring(0, 30);
  const vol = (r.entry_price * r.quantity).toFixed(2);
  console.log(`#${r.id} ${r.symbol} ${r.status} oid=${oid} vol=$${vol}`);
});
