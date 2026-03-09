// scripts/force-sell-everything.js
// Vende ABSOLUTAMENTE TODO lo que haya en Binance que no sea USDT
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { initDB, getDB } = require('../src/models/db');
const { getBalances, createOrder, getTicker, formatAmount } = require('../src/services/binance');

async function forceEverything() {
  initDB();
  const db = getDB();
  const keyRow = db.prepare("SELECT * FROM api_keys WHERE exchange = 'binance' LIMIT 1").get();
  if (!keyRow) { console.log('ERROR: Sin API key'); process.exit(1); }

  console.log('Leyendo balance REAL de Binance...\n');
  const bal = await getBalances(keyRow.user_id, keyRow.id);
  if (!bal) { console.log('ERROR: No se pudo leer balance'); process.exit(1); }

  let vendidos = 0;
  for (const [coin, info] of Object.entries(bal)) {
    if (coin === 'USDT' || coin === 'ARS') continue;
    if (!info.free || info.free <= 0) continue;

    const symbol = coin + '/USDT';
    let price = 0;
    try { const t = await getTicker(symbol); price = t?.last || 0; } catch {}
    if (price <= 0) { console.log(`${coin}: sin precio, skip`); continue; }

    const value = info.free * price;
    console.log(`${coin}: ${info.free} unidades (~$${value.toFixed(2)})`);

    if (value < 1) {
      console.log(`  → Dust (<$1), no se puede vender\n`);
      continue;
    }

    // Intentar vender con cantidad ajustada
    const qty = formatAmount(symbol, info.free) || info.free;
    console.log(`  Vendiendo ${qty} ${coin}...`);

    try {
      const order = await createOrder(keyRow.user_id, keyRow.id, symbol, 'sell', qty);
      const sellPrice = order?.average || order?.price || price;
      console.log(`  ✅ VENDIDO @ $${sellPrice} (~$${(qty * sellPrice).toFixed(2)})\n`);
      vendidos++;
    } catch (e) {
      const msg = e.message || '';
      // Si falla por LOT_SIZE, intentar con menos decimales
      if (msg.includes('LOT_SIZE') || msg.includes('NOTIONAL')) {
        try {
          const qty2 = Math.floor(info.free);
          if (qty2 > 0 && qty2 * price >= 5) {
            console.log(`  Reintentando con ${qty2}...`);
            const order = await createOrder(keyRow.user_id, keyRow.id, symbol, 'sell', qty2);
            console.log(`  ✅ VENDIDO (retry)\n`);
            vendidos++;
            continue;
          }
        } catch {}
      }
      console.log(`  ❌ Error: ${msg.substring(0, 80)}\n`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  // Cerrar TODAS las posiciones abiertas en la DB
  const open = db.prepare("SELECT id FROM crypto_positions WHERE status='OPEN'").all();
  for (const p of open) {
    db.prepare("UPDATE crypto_positions SET status='CLOSED', pnl=0, reason=reason||' | FORCE CLOSE', closed_at=CURRENT_TIMESTAMP WHERE id=?").run(p.id);
  }
  console.log(`\nRegistros cerrados en DB: ${open.length}`);
  console.log(`Coins vendidas en Binance: ${vendidos}`);

  // Leer balance final
  const finalBal = await getBalances(keyRow.user_id, keyRow.id);
  const usdt = finalBal?.USDT?.free || 0;
  console.log(`\n💰 USDT FINAL: $${usdt.toFixed(2)}`);
  process.exit(0);
}

forceEverything().catch(e => { console.error(e); process.exit(1); });
