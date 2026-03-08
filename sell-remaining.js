// sell-remaining.js — Vender BTC y XRP con cantidades exactas
require('dotenv').config();
const { initDB, getDB } = require('./src/models/db');
const { getExchangeForUser } = require('./src/services/binance');
initDB();
const db = getDB();

async function sell() {
  const key = db.prepare("SELECT * FROM api_keys WHERE exchange = 'binance' LIMIT 1").get();
  const exchange = getExchangeForUser(key.user_id, key.id);

  // BTC: 0.00013986 — Binance requiere step de 0.00001
  try {
    const qty = 0.00013;
    const order = await exchange.createMarketSellOrder('BTC/USDT', qty);
    console.log(`BTC vendido: ${qty} @ $${order?.average || '?'}`);
  } catch (e) {
    console.log('BTC error:', e.message?.substring(0, 100));
  }

  // XRP: 3.6963 — step de 0.1
  try {
    const qty = 3.6;
    const order = await exchange.createMarketSellOrder('XRP/USDT', qty);
    console.log(`XRP vendido: ${qty} @ $${order?.average || '?'}`);
  } catch (e) {
    console.log('XRP error:', e.message?.substring(0, 100));
  }

  await new Promise(r => setTimeout(r, 2000));

  // Balance final
  const { getBalances } = require('./src/services/binance');
  const bal = await getBalances(key.user_id, key.id);
  console.log(`\n💰 USDT LIBRE: $${(bal.USDT?.free || 0).toFixed(2)}`);
  process.exit(0);
}
sell();
