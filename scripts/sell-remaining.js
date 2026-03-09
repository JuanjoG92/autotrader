// scripts/sell-remaining.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { initDB } = require('../src/models/db');
const { getBalances, createOrder, formatAmount, getMarketInfo } = require('../src/services/binance');

async function run() {
  initDB();
  const db = require('../src/models/db').getDB();
  const key = db.prepare("SELECT * FROM api_keys WHERE exchange = 'binance' LIMIT 1").get();

  // XRP: 3.6963 — necesitamos vender todo
  console.log('--- Vendiendo XRP ---');
  try {
    const market = await getMarketInfo('XRP/USDT');
    console.log('XRP min notional:', market?.limits?.cost?.min, 'min amount:', market?.limits?.amount?.min);
    // Intentar con la cantidad exacta
    const order = await createOrder(key.user_id, key.id, 'XRP/USDT', 'sell', 3.6);
    console.log('XRP vendido:', order?.average || order?.price);
  } catch(e) {
    console.log('XRP error:', e.message?.substring(0, 80));
    // Intentar con 3.69
    try {
      const order = await createOrder(key.user_id, key.id, 'XRP/USDT', 'sell', 3.69);
      console.log('XRP vendido (retry):', order?.average || order?.price);
    } catch(e2) { console.log('XRP retry error:', e2.message?.substring(0, 80)); }
  }

  // MBOX: 192.0479
  console.log('\n--- Vendiendo MBOX ---');
  try {
    const market = await getMarketInfo('MBOX/USDT');
    console.log('MBOX min notional:', market?.limits?.cost?.min, 'min amount:', market?.limits?.amount?.min);
    const order = await createOrder(key.user_id, key.id, 'MBOX/USDT', 'sell', 192);
    console.log('MBOX vendido:', order?.average || order?.price);
  } catch(e) {
    console.log('MBOX error:', e.message?.substring(0, 80));
    try {
      const order = await createOrder(key.user_id, key.id, 'MBOX/USDT', 'sell', 192.0);
      console.log('MBOX vendido (retry):', order?.average || order?.price);
    } catch(e2) { console.log('MBOX retry error:', e2.message?.substring(0, 80)); }
  }

  // Balance final
  const bal = await getBalances(key.user_id, key.id);
  console.log('\n💰 USDT:', bal?.USDT?.free?.toFixed(2));
  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
