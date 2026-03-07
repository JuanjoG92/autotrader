require('dotenv').config();
const { initDB, getDB } = require('./src/models/db');
initDB();
const c = getDB().prepare('SELECT * FROM crypto_config WHERE id=1').get();
console.log(JSON.stringify(c, null, 2));
const pos = getDB().prepare('SELECT id, symbol, status, order_id, quantity, entry_price FROM crypto_positions ORDER BY id').all();
pos.forEach(p => console.log('#' + p.id, p.symbol, p.status, 'qty=' + p.quantity, 'oid=' + (p.order_id || '').substring(0, 20)));
