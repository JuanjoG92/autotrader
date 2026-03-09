// Script para forzar venta de TODAS las posiciones abiertas
const { getDB } = require('../src/models/db');
const { getBalances, createOrder, getTicker, getMarketInfo, formatAmount, getExchangeForUser } = require('../src/services/binance');

async function sellAll() {
  const db = getDB();
  
  // 1. Obtener API key
  const keyRow = db.prepare("SELECT * FROM api_keys WHERE exchange = 'binance' LIMIT 1").get();
  if (!keyRow) { console.log('Sin API key'); process.exit(1); }
  
  console.log('=== FORZANDO VENTA DE TODO ===\n');
  
  // 2. Leer balance real de Binance
  const balance = await getBalances(keyRow.user_id, keyRow.id);
  if (!balance) { console.log('No se pudo leer balance'); process.exit(1); }
  
  for (const [coin, info] of Object.entries(balance)) {
    if (coin === 'USDT' || coin === 'ARS' || !info.free || info.free <= 0) continue;
    const symbol = coin + '/USDT';
    
    let price = 0;
    try { const t = await getTicker(symbol); price = t?.last || 0; } catch {}
    if (price <= 0) { console.log(`${coin}: sin precio, skip`); continue; }
    
    const value = info.free * price;
    console.log(`${coin}: ${info.free} units @ $${price} = $${value.toFixed(2)}`);
    
    if (value < 5) {
      console.log(`  -> DUST ($${value.toFixed(2)} < $5), no se puede vender\n`);
      continue;
    }
    
    // Vender
    try {
      let market = null;
      try { market = await getMarketInfo(symbol); } catch {}
      const qty = market ? formatAmount(symbol, info.free) : info.free;
      console.log(`  -> VENDIENDO ${qty} ${coin}...`);
      const order = await createOrder(keyRow.user_id, keyRow.id, symbol, 'sell', qty);
      const sellPrice = order?.average || order?.price || price;
      console.log(`  -> VENDIDO @ $${sellPrice} = $${(qty * sellPrice).toFixed(2)}\n`);
    } catch (e) {
      console.log(`  -> ERROR: ${(e.message || '').substring(0, 80)}\n`);
    }
    
    await new Promise(r => setTimeout(r, 500));
  }
  
  // 3. Cerrar todas las posiciones en la DB
  const openPositions = db.prepare("SELECT * FROM crypto_positions WHERE status = 'OPEN'").all();
  for (const pos of openPositions) {
    let currentPrice = pos.current_price || pos.entry_price;
    try { const t = await getTicker(pos.symbol); currentPrice = t?.last || currentPrice; } catch {}
    const grossPnl = (currentPrice - pos.entry_price) * pos.quantity;
    const fees = pos.entry_price * pos.quantity * 0.001 + currentPrice * pos.quantity * 0.001;
    const netPnl = grossPnl - fees;
    
    db.prepare("UPDATE crypto_positions SET status = 'CLOSED', pnl = ?, sell_price = ?, fees = ?, reason = reason || ' | VENTA FORZADA', closed_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(netPnl, currentPrice, fees, pos.id);
    console.log(`DB: Cerrada ${pos.symbol} | PnL: $${netPnl.toFixed(2)}`);
  }
  
  // 4. Balance final
  await new Promise(r => setTimeout(r, 2000));
  const finalBal = await getBalances(keyRow.user_id, keyRow.id);
  const usdtFinal = finalBal?.USDT?.free || 0;
  console.log(`\n=== BALANCE FINAL: $${usdtFinal.toFixed(2)} USDT libre ===`);
  
  process.exit(0);
}

sellAll().catch(e => { console.error(e); process.exit(1); });
