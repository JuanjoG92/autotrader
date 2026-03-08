// sell-all-to-usdt.js — Vender TODAS las criptos a USDT usando proxy
require('dotenv').config();
const { initDB, getDB } = require('./src/models/db');
const { getBalances, getExchangeForUser } = require('./src/services/binance');
initDB();
const db = getDB();

async function sellAll() {
  const key = db.prepare("SELECT * FROM api_keys WHERE exchange = 'binance' LIMIT 1").get();
  if (!key) { console.log('No API key'); process.exit(1); }

  // 1. Leer balance real
  console.log('Leyendo balance de Binance...');
  const bal = await getBalances(key.user_id, key.id);
  console.log('\nBalance actual:');
  for (const [coin, info] of Object.entries(bal)) {
    if (info.total > 0) console.log(`  ${coin}: ${info.free} libre / ${info.total} total`);
  }

  // 2. Vender todo a USDT
  const exchange = getExchangeForUser(key.user_id, key.id);
  const SKIP = ['USDT', 'ARS', 'BUSD', 'USDC'];

  for (const [coin, info] of Object.entries(bal)) {
    if (SKIP.includes(coin) || info.free <= 0) continue;
    const symbol = coin + '/USDT';

    try {
      const ticker = await exchange.fetchTicker(symbol);
      const price = ticker?.last || 0;
      const value = info.free * price;
      console.log(`\n${coin}: ${info.free} × $${price.toFixed(4)} = $${value.toFixed(2)}`);

      if (value < 5) {
        console.log(`  Skip — vale $${value.toFixed(2)}, Binance mínimo ~$5`);
        continue;
      }

      // Ajustar cantidad según precio
      let qty = info.free;
      if (price >= 10000) qty = parseFloat(qty.toFixed(5));
      else if (price >= 100) qty = parseFloat(qty.toFixed(4));
      else if (price >= 1) qty = parseFloat(qty.toFixed(2));
      else qty = Math.floor(qty);

      const order = await exchange.createMarketSellOrder(symbol, qty);
      const fillPrice = order?.average || order?.price || price;
      console.log(`  ✅ VENDIDO: ${qty} ${coin} @ $${fillPrice} = $${(qty * fillPrice).toFixed(2)}`);
    } catch (e) {
      console.log(`  ❌ Error ${coin}: ${(e.message || '').substring(0, 80)}`);
    }
  }

  // 3. Esperar y leer nuevo balance
  await new Promise(r => setTimeout(r, 3000));
  const newBal = await getBalances(key.user_id, key.id);
  const usdt = newBal.USDT?.free || 0;
  console.log(`\n${'='.repeat(50)}`);
  console.log(`💰 USDT DISPONIBLE AHORA: $${usdt.toFixed(2)}`);
  console.log(`${'='.repeat(50)}`);
  process.exit(0);
}

sellAll();
