// sell-btc.js — Vender BTC para liberar capital para gainers
const { getDB, initDB } = require('./src/models/db');
const { createOrder, getBalances, getExchangeForUser } = require('./src/services/binance');

initDB();
const db = getDB();

async function sellBTC() {
  // Buscar posición BTC abierta
  const btcPos = db.prepare("SELECT * FROM crypto_positions WHERE symbol = 'BTC/USDT' AND status = 'OPEN'").get();
  if (!btcPos) {
    console.log('No hay posición BTC abierta');
    process.exit(0);
  }

  console.log(`Vendiendo BTC: ${btcPos.quantity} @ entrada $${btcPos.entry_price}`);

  // Obtener API key
  const key = db.prepare("SELECT * FROM api_keys WHERE exchange = 'binance' LIMIT 1").get();
  if (!key) {
    console.log('No hay API key');
    process.exit(1);
  }

  try {
    // Vender BTC
    const order = await createOrder(key.user_id, key.id, 'BTC/USDT', 'sell', btcPos.quantity);
    console.log('Orden de venta ejecutada:', order?.id || 'OK');

    // Cerrar posición en DB
    const price = order?.average || order?.price || btcPos.entry_price;
    const pnl = (price - btcPos.entry_price) * btcPos.quantity;
    db.prepare("UPDATE crypto_positions SET status = 'CLOSED', pnl = ?, reason = reason || ' | Vendido para liberar capital a gainers', closed_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(pnl, btcPos.id);
    console.log(`BTC vendido. PnL: $${pnl.toFixed(4)}`);

    // Ver balance post-venta
    const bal = await getBalances(key.user_id, key.id);
    console.log(`USDT libre ahora: $${(bal.USDT?.free || 0).toFixed(2)}`);
  } catch (e) {
    console.error('Error vendiendo BTC:', e.message);
  }

  process.exit(0);
}

sellBTC();
