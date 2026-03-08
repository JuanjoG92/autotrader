// sell-all-to-usdt.js — Vender TODAS las criptos a USDT para liberar capital
const { initDB, getDB } = require('./src/models/db');
const { createOrder, getTicker } = require('./src/services/binance');
initDB();
const db = getDB();

const COINS_TO_SELL = [
  { symbol: 'SOL/USDT', coin: 'SOL', qty: 0.531917 },
  { symbol: 'BTC/USDT', coin: 'BTC', qty: 0.00013986 },
  { symbol: 'XRP/USDT', coin: 'XRP', qty: 3.6963 },
  { symbol: 'ADA/USDT', coin: 'ADA', qty: 0.0802 },
];

async function sellAll() {
  const key = db.prepare("SELECT * FROM api_keys WHERE exchange = 'binance' LIMIT 1").get();
  if (!key) { console.log('No API key'); process.exit(1); }

  for (const c of COINS_TO_SELL) {
    try {
      const ticker = await getTicker(c.symbol);
      const price = ticker?.last || 0;
      const value = c.qty * price;
      console.log(`\n${c.coin}: ${c.qty} × $${price.toFixed(2)} = $${value.toFixed(2)}`);

      if (value < 5) {
        console.log(`  Skip — monto menor a $5 (Binance no permite)`);
        continue;
      }

      // Ajustar decimales
      let qty = c.qty;
      if (price >= 10000) qty = parseFloat(qty.toFixed(5));
      else if (price >= 100) qty = parseFloat(qty.toFixed(4));
      else if (price >= 1) qty = parseFloat(qty.toFixed(2));
      else qty = parseFloat(qty.toFixed(0));

      const order = await createOrder(key.user_id, key.id, c.symbol, 'sell', qty);
      console.log(`  ✅ VENDIDO ${c.coin}: ${qty} @ market | Order: ${order?.id || 'OK'}`);
    } catch (e) {
      console.log(`  ❌ Error ${c.coin}: ${e.message?.substring(0, 80)}`);
    }
  }

  // Esperar 2s y mostrar nuevo USDT
  await new Promise(r => setTimeout(r, 2000));
  console.log('\n=== Hecho. Reinicia el bot con: pm2 restart autotrader ===');
  process.exit(0);
}

sellAll();
