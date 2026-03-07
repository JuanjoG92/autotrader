// Fix: re-encrypt Binance API key with current ENCRYPTION_KEY
require('dotenv').config();
const { initDB, getDB } = require('./src/models/db');
const { encrypt, decrypt } = require('./src/services/encryption');

initDB();
const db = getDB();

const API_KEY = 'XvcLbTYUk1AZwalknb7DVCwWIpUDeKQPit6cQjCEeksgce64neMn2rg8PODqyoSs';
const API_SECRET = '6fRmyguWO8XnEcTA0ao63EpjqxiSZOAwIWwIP4KhBEaYSbZkKJNw2j7BKIOGABwC';

// Encrypt with current key
const encKey = encrypt(API_KEY);
const encSecret = encrypt(API_SECRET);

// Verify decryption works
const testKey = decrypt(encKey);
const testSecret = decrypt(encSecret);
console.log('Decrypt test key match:', testKey === API_KEY);
console.log('Decrypt test secret match:', testSecret === API_SECRET);

if (testKey !== API_KEY || testSecret !== API_SECRET) {
  console.log('ERROR: Encrypt/decrypt mismatch!');
  process.exit(1);
}

// Update in DB
const row = db.prepare("SELECT id FROM api_keys WHERE exchange = 'binance' LIMIT 1").get();
if (row) {
  db.prepare('UPDATE api_keys SET api_key_enc = ?, api_secret_enc = ? WHERE id = ?')
    .run(encKey, encSecret, row.id);
  console.log('Updated API key id:', row.id);
} else {
  // Insert new
  db.prepare('INSERT INTO api_keys (user_id, exchange, label, api_key_enc, api_secret_enc, permissions) VALUES (?,?,?,?,?,?)')
    .run(1, 'binance', 'autotrader', encKey, encSecret, 'spot');
  console.log('Inserted new API key');
}

// Final verify
const check = db.prepare("SELECT * FROM api_keys WHERE exchange = 'binance' LIMIT 1").get();
const finalKey = decrypt(check.api_key_enc);
console.log('Final verify - key starts:', finalKey.substring(0, 10) + '...', 'OK:', finalKey === API_KEY);
console.log('DONE - API key re-encrypted successfully');
