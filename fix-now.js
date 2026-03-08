// fix-now.js — Cerrar posiciones PAPER fantasma y verificar balance real
const { initDB, getDB } = require('./src/models/db');
const { getFirstBinanceBalance, getTicker } = require('./src/services/binance');
initDB();
const db = getDB();

async function fix() {
  // 1. Cerrar TODAS las posiciones PAPER abiertas (son fantasma, no existen en Binance)
  const paperOpen = db.prepare("SELECT * FROM crypto_positions WHERE status = 'OPEN' AND order_id LIKE 'PAPER%'").all();
  console.log(`\nPosiciones PAPER fantasma encontradas: ${paperOpen.length}`);
  for (const p of paperOpen) {
    db.prepare("UPDATE crypto_positions SET status = 'CLOSED', pnl = 0, reason = reason || ' | Cerrada: era PAPER (no real)', closed_at = CURRENT_TIMESTAMP WHERE id = ?").run(p.id);
    console.log(`  Cerrada: #${p.id} ${p.symbol} (era PAPER, no existía en Binance)`);
  }

  // 2. Ver posiciones abiertas reales
  const realOpen = db.prepare("SELECT * FROM crypto_positions WHERE status = 'OPEN'").all();
  console.log(`\nPosiciones REALES abiertas: ${realOpen.length}`);
  realOpen.forEach(r => console.log(`  ${r.symbol}: ${r.quantity} @ $${r.entry_price} | ${r.order_id}`));

  // 3. Ver balance real de Binance
  try {
    const bal = await getFirstBinanceBalance();
    console.log('\n=== BALANCE REAL BINANCE ===');
    let totalUSD = 0;
    for (const [coin, info] of Object.entries(bal)) {
      if (info.total > 0) {
        let usdVal = coin === 'USDT' ? info.total : 0;
        if (coin !== 'USDT') {
          try {
            const t = await getTicker(coin + '/USDT');
            usdVal = (t?.last || 0) * info.total;
          } catch {}
        }
        totalUSD += usdVal;
        console.log(`  ${coin}: ${info.free} libre | ${info.total} total | ~$${usdVal.toFixed(2)}`);
      }
    }
    console.log(`\n💰 TOTAL en Binance: ~$${totalUSD.toFixed(2)}`);
    console.log(`💵 USDT libre para operar: $${(bal.USDT?.free || 0).toFixed(2)}`);
  } catch (e) {
    console.error('Error leyendo balance:', e.message);
  }

  process.exit(0);
}
fix();
