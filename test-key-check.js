require('dotenv').config();
const { initDB, getDB } = require('./src/models/db');
const { decrypt } = require('./src/services/encryption');
initDB();
const db = getDB();
const row = db.prepare("SELECT * FROM api_keys WHERE exchange = 'binance' LIMIT 1").get();
if (!row) { console.log('No key'); process.exit(); }
const k = decrypt(row.api_key_enc);
console.log('Key starts:', k.substring(0, 10) + '...', 'length:', k.length);
console.log('Expected start: XvcLbTYUk1');
console.log('Match:', k.startsWith('XvcLbTYUk1'));
