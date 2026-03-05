// Test Binance: NO proxy, direct connection
require('dotenv').config();
const { getDB, initDB } = require('./src/models/db');
const { decrypt } = require('./src/services/encryption');
const ccxt = require('ccxt');

initDB();
const db = getDB();
const k = db.prepare('SELECT * FROM api_keys WHERE id = 3').get();

const apiKey = decrypt(k.api_key_enc);
const secret = decrypt(k.api_secret_enc);
console.log('Key:', apiKey.substring(0, 10) + '...');

// Test 1: NO proxy at all
console.log('\n--- TEST 1: Direct (no proxy) ---');
const ex1 = new ccxt.binance({ apiKey, secret, enableRateLimit: true, options: { defaultType: 'spot' } });
ex1.fetchBalance().then(b => {
  console.log('DIRECT: SUCCESS!');
}).catch(e => {
  console.log('DIRECT ERROR:', e.message.substring(0, 150));
});

// Test 2: With WARP proxy (port 40000)
console.log('\n--- TEST 2: WARP proxy (127.0.0.1:40000) ---');
const ex2 = new ccxt.binance({ apiKey, secret, enableRateLimit: true, socksProxy: 'socks5://127.0.0.1:40000', options: { defaultType: 'spot' } });
ex2.fetchBalance().then(b => {
  console.log('WARP: SUCCESS!');
}).catch(e => {
  console.log('WARP ERROR:', e.message.substring(0, 150));
});

// Test 3: With Privoxy HTTP proxy (port 8118)
console.log('\n--- TEST 3: Privoxy HTTP proxy (127.0.0.1:8118) ---');
const ex3 = new ccxt.binance({ apiKey, secret, enableRateLimit: true, httpsProxy: 'http://127.0.0.1:8118', options: { defaultType: 'spot' } });
ex3.fetchBalance().then(b => {
  console.log('PRIVOXY: SUCCESS!');
}).catch(e => {
  console.log('PRIVOXY ERROR:', e.message.substring(0, 150));
});

setTimeout(() => process.exit(0), 20000);
