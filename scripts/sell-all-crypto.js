// Vender TODAS las posiciones crypto abiertas y dejar solo USDT
// Ejecutar: node scripts/sell-all-crypto.js

const binance = require('../src/services/binance');
const { getDB } = require('../src/models/db');

async function sellAll() {
  const db = getDB();
  
  // 1. Desactivar todo
  db.prepare('UPDATE crypto_config SET enabled = 0 WHERE id = 1').run();
  console.log('✅ Crypto DESACTIVADO');

  // 2. Obtener posiciones abiertas
  const positions = db.prepare("SELECT * FROM crypto_positions WHERE status = 'OPEN'").all();
  console.log(`\n${positions.length} posiciones abiertas para vender:\n`);

  for (const pos of positions) {
    try {
      console.log(`Vendiendo ${pos.symbol}: ${pos.quantity} unidades...`);
      
      // Obtener API key
      const keyRow = db.prepare('SELECT * FROM api_keys WHERE exchange = ? LIMIT 1').get('binance');
      if (!keyRow) { console.log('  ❌ Sin API key'); continue; }

      const order = await binance.createOrder(keyRow.user_id, keyRow.id, pos.symbol, 'sell', pos.quantity);
      const fillPrice = order?.average || order?.price || 0;
      const pnl = (fillPrice - pos.entry_price) * pos.quantity;

      // Cerrar en DB
      db.prepare(
        "UPDATE crypto_positions SET status = 'CLOSED', sell_price = ?, pnl = ?, reason = reason || ' | VENTA MANUAL: desactivado por usuario', closed_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(fillPrice, pnl, pos.id);

      console.log(`  ✅ VENDIDO ${pos.symbol} @ $${fillPrice} | PnL: $${pnl.toFixed(4)}`);
    } catch (e) {
      console.log(`  ❌ Error vendiendo ${pos.symbol}: ${e.message}`);
      // Marcar como cerrado igualmente para que no intente operar
      db.prepare(
        "UPDATE crypto_positions SET status = 'CLOSED', reason = reason || ' | ERROR VENTA: ' || ?, closed_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(e.message.substring(0, 100), pos.id);
    }
  }

  // 3. Verificar que no quede nada abierto
  const remaining = db.prepare("SELECT COUNT(*) as c FROM crypto_positions WHERE status = 'OPEN'").get();
  console.log(`\nPosiciones restantes abiertas: ${remaining.c}`);
  console.log('Crypto completamente desactivado. No comprará nada hasta reactivación manual.');

  process.exit(0);
}

sellAll().catch(e => { console.error(e); process.exit(1); });
