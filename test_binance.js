// Test: minimal Binance connection - skip heavy loadMarkets
require('dotenv').config();
const { getDB, initDB } = require('./src/models/db');
const { decrypt } = require('./src/services/encryption');
const ccxt = require('ccxt');

initDB();
const db = getDB();
const k = db.prepare('SELECT * FROM api_keys WHERE id = 3').get();
const apiKey = decrypt(k.api_key_enc);
const secret = decrypt(k.api_secret_enc);

const proxy = process.env.BINANCE_PROXY;
console.log('Proxy:', proxy || 'NONE');

// Test 1: Direct (no proxy)
async function testDirect() {
  console.log('\n=== TEST: Direct (no proxy) ===');
  const ex = new ccxt.binance({ apiKey, secret, enableRateLimit: true });
  try {
    const bal = await ex.fetchBalance({ type: 'spot' });
    const assets = Object.keys(bal.total).filter(c => bal.total[c] > 0);
    console.log('DIRECT SUCCESS! Assets:', assets);
  } catch(e) {
    console.log('DIRECT:', e.constructor.name, e.message.substring(0, 120));
  }
}

// Test 2: With SOCKS proxy
async function testProxy() {
  if (!proxy) return console.log('\n=== SKIP proxy test (not set) ===');
  console.log('\n=== TEST: SOCKS proxy ===');
  const ex = new ccxt.binance({ apiKey, secret, enableRateLimit: true, socksProxy: proxy });
  try {
    const bal = await ex.fetchBalance({ type: 'spot' });
    const assets = Object.keys(bal.total).filter(c => bal.total[c] > 0);
    console.log('PROXY SUCCESS! Assets:', assets);
  } catch(e) {
    console.log('PROXY:', e.constructor.name, e.message.substring(0, 120));
  }
}

// Test 3: Direct but only call /api/v3/account (no sapi)
async function testMinimal() {
  console.log('\n=== TEST: Minimal /api/v3/account ===');
  const ex = new ccxt.binance({ apiKey, secret, enableRateLimit: true });
  ex.options['fetchBalance'] = 'spot';
  ex.options['defaultType'] = 'spot';
  // Manually call the spot account endpoint
  try {
    const resp = await ex.privateGetAccount();
    console.log('MINIMAL SUCCESS! Balances count:', resp.balances ? resp.balances.filter(b => parseFloat(b.free) > 0).length : 0);
  } catch(e) {
    console.log('MINIMAL:', e.constructor.name, e.message.substring(0, 120));
  }
}

// Test 4: Minimal with proxy
async function testMinimalProxy() {
  if (!proxy) return;
  console.log('\n=== TEST: Minimal /api/v3/account + proxy ===');
  const ex = new ccxt.binance({ apiKey, secret, enableRateLimit: true, socksProxy: proxy });
  try {
    const resp = await ex.privateGetAccount();
    console.log('MINIMAL+PROXY SUCCESS! Balances:', resp.balances ? resp.balances.filter(b => parseFloat(b.free) > 0).length : 0);
  } catch(e) {
    console.log('MINIMAL+PROXY:', e.constructor.name, e.message.substring(0, 120));
  }
}

(async () => {
  await testDirect();
  await testProxy();
  await testMinimal();
  await testMinimalProxy();
  process.exit(0);
})();
