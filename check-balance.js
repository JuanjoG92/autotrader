// check-balance.js - Ver balance REAL de Binance
const { initDB } = require('./src/models/db');
const { getFirstBinanceBalance } = require('./src/services/binance');
initDB();

async function check() {
  try {
    const bal = await getFirstBinanceBalance();
    console.log('\n=== BALANCE REAL EN BINANCE ===');
    let total = 0;
    for (const [coin, info] of Object.entries(bal)) {
      if (info.total > 0) {
        console.log(`  ${coin}: free=${info.free} | locked=${info.used || 0} | total=${info.total}`);
        if (coin === 'USDT') total += info.total;
      }
    }
    console.log(`\nUSDT LIBRE para operar: $${(bal.USDT?.free || 0).toFixed(2)}`);
    console.log(`USDT TOTAL: $${(bal.USDT?.total || 0).toFixed(2)}`);
  } catch (e) {
    console.error('Error:', e.message);
  }
  process.exit(0);
}
check();
