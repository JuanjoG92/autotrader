// scripts/sell-all-now.js
// Vende TODAS las posiciones abiertas inmediatamente
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { initDB, getDB } = require('../src/models/db');
const { getBalances, createOrder, getTicker, formatAmount } = require('../src/services/binance');

async function sellAll() {
  initDB();
  const db = getDB();

  const positions = db.prepare("SELECT * FROM crypto_positions WHERE status = 'OPEN'").all();
  console.log(`${positions.length} posiciones abiertas para vender\n`);

  if (!positions.length) { console.log('Nada que vender'); process.exit(0); }

  const keyRow = db.prepare("SELECT * FROM api_keys WHERE exchange = 'binance' LIMIT 1").get();
  if (!keyRow) { console.log('ERROR: Sin API key'); process.exit(1); }

  for (const pos of positions) {
    console.log(`--- ${pos.symbol} | qty=${pos.quantity} | entrada=$${pos.entry_price} ---`);
    try {
      // Get real balance of this coin
      const bal = await getBalances(keyRow.user_id, keyRow.id);
      const coin = pos.symbol.split('/')[0];
      const realQty = bal[coin]?.free || 0;

      if (realQty <= 0 || realQty * pos.entry_price < 1) {
        console.log(`  ${coin}: sin balance real (${realQty}) — cerrando registro`);
        db.prepare("UPDATE crypto_positions SET status='CLOSED', pnl=0, reason=reason||' | Cerrada manual - sin balance', closed_at=CURRENT_TIMESTAMP WHERE id=?").run(pos.id);
        continue;
      }

      // Get current price
      let price = pos.entry_price;
      try { const t = await getTicker(pos.symbol); price = t?.last || price; } catch {}

      // Try to sell
      const sellQty = formatAmount(pos.symbol, realQty) || realQty;
      console.log(`  Vendiendo ${sellQty} ${coin} @ ~$${price}...`);

      try {
        const order = await createOrder(keyRow.user_id, keyRow.id, pos.symbol, 'sell', sellQty);
        const sellPrice = order?.average || order?.price || price;
        const pnl = (sellPrice - pos.entry_price) * pos.quantity;
        const fees = pos.entry_price * pos.quantity * 0.001 + sellPrice * pos.quantity * 0.001;

        db.prepare("UPDATE crypto_positions SET status='CLOSED', pnl=?, sell_price=?, fees=?, current_price=?, reason=reason||' | VENTA MANUAL EMERGENCIA', closed_at=CURRENT_TIMESTAMP WHERE id=?")
          .run(pnl - fees, sellPrice, fees, sellPrice, pos.id);

        console.log(`  ✅ VENDIDO @ $${sellPrice} | PnL: $${(pnl - fees).toFixed(2)}`);
      } catch (e) {
        const msg = e.message || '';
        if (msg.includes('NOTIONAL') || msg.includes('MIN_NOTIONAL')) {
          console.log(`  Monto muy bajo para vender — cerrando registro`);
          db.prepare("UPDATE crypto_positions SET status='CLOSED', pnl=0, reason=reason||' | Cerrada - monto minimo', closed_at=CURRENT_TIMESTAMP WHERE id=?").run(pos.id);
        } else {
          console.log(`  ERROR: ${msg.substring(0, 80)}`);
        }
      }
    } catch (e) {
      console.log(`  ERROR GENERAL: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log('\n=== RESULTADO FINAL ===');
  const remaining = db.prepare("SELECT COUNT(*) as c FROM crypto_positions WHERE status='OPEN'").get();
  const usdt = db.prepare("SELECT * FROM crypto_config WHERE id=1").get();
  console.log(`Posiciones abiertas: ${remaining.c}`);
  console.log(`Bot enabled: ${usdt.enabled}`);
  process.exit(0);
}

sellAll().catch(e => { console.error(e); process.exit(1); });
