// Test real buy order - $5 of ADA/USDT (cheapest to test)
require('dotenv').config();
const { initDB, getDB } = require('./src/models/db');
const { createOrder, getTicker, getFirstBinanceBalance } = require('./src/services/binance');
initDB();

(async () => {
  // 1. Check balance
  console.log('1. Checking balance...');
  const bal = await getFirstBinanceBalance();
  console.log('   USDT:', bal?.USDT?.free || 0);

  // 2. Get price
  console.log('2. Getting BTC price...');
  const ticker = await getTicker('BTC/USDT');
  console.log('   BTC/USDT:', ticker?.last);

  // 3. Try a tiny buy - $5 worth of XRP
  console.log('3. Attempting LIVE BUY $5 of XRP/USDT...');
  const db = getDB();
  const key = db.prepare("SELECT * FROM api_keys WHERE exchange = 'binance' LIMIT 1").get();
  if (!key) { console.log('   NO KEY!'); return; }

  const xrpTicker = await getTicker('XRP/USDT');
  const xrpPrice = xrpTicker?.last || 0;
  console.log('   XRP price:', xrpPrice);

  if (xrpPrice <= 0) { console.log('   No price!'); return; }

  const qty = parseFloat((5 / xrpPrice).toFixed(1)); // XRP qty for $5
  console.log('   Quantity:', qty, 'XRP (~$5)');

  try {
    const order = await createOrder(key.user_id, key.id, 'XRP/USDT', 'buy', qty);
    console.log('   ORDER SUCCESS:', JSON.stringify(order).substring(0, 200));
  } catch (e) {
    console.log('   ORDER FAILED:', e.message.substring(0, 200));
    if (e.message.includes('-2015') || e.message.includes('permissions')) {
      console.log('   >> Trading permission NOT enabled on API key!');
      console.log('   >> Enable "Habilitar trading de margenes y spot" in Binance');
    }
  }

  // 4. Check balance after
  const bal2 = await getFirstBinanceBalance();
  console.log('4. Balance after:', bal2?.USDT?.free || 0, 'USDT');
})();
