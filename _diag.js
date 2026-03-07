require('dotenv').config();
const { initDB, getDB } = require('./src/models/db');
initDB();
const p = getDB().prepare('SELECT id,symbol,side,status,quantity,entry_price,order_id,created_at FROM crypto_positions ORDER BY id').all();
p.forEach(r => {
  const live = r.order_id && !r.order_id.startsWith('PAPER') ? 'LIVE' : 'PAPER';
  console.log(`#${r.id} ${r.symbol} ${r.side} ${r.status} qty=${r.quantity} $${r.entry_price} ${live} ${r.created_at}`);
});
console.log('---');
console.log('OPEN:', p.filter(r => r.status === 'OPEN').length);
console.log('LIVE:', p.filter(r => r.order_id && !r.order_id.startsWith('PAPER')).length);
