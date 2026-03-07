require('dotenv').config();
const { initDB, getDB } = require('./src/models/db');
initDB();

// Check encryption key
const ek = process.env.ENCRYPTION_KEY || 'NONE';
console.log('ENCRYPTION_KEY length:', ek.length, 'starts:', ek.substring(0, 10));

// Check what's in the DB
const db = getDB();
const row = db.prepare("SELECT id, exchange, label, api_key_enc FROM api_keys WHERE exchange = 'binance' LIMIT 1").get();
if (!row) { console.log('No binance key in DB'); process.exit(); }
console.log('DB row id:', row.id, 'label:', row.label);
console.log('Encrypted key starts:', (row.api_key_enc || '').substring(0, 40));
console.log('Encrypted key parts:', (row.api_key_enc || '').split(':').length);

// Try decrypt
try {
  const { decrypt } = require('./src/services/encryption');
  const k = decrypt(row.api_key_enc);
  console.log('DECRYPT OK! Key starts:', k.substring(0, 10) + '...', 'length:', k.length);
} catch (e) {
  console.log('DECRYPT FAILED:', e.message);
  console.log('The API key needs to be re-saved with the current ENCRYPTION_KEY');
}
