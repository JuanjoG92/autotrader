#!/bin/bash
cd /var/www/autotrader
node -e '
require("dotenv").config();
const binance = require("./src/services/binance");
const db = require("./src/models/db").getDB();
const k = db.prepare("SELECT * FROM api_keys WHERE exchange = ?").get("binance");
if (!k) { console.log("Sin API key binance"); process.exit(1); }
try {
  const ex = binance.getExchangeForUser(k.user_id, k.id);
  console.log("Exchange creado con proxy: " + (process.env.BINANCE_PROXY || "ninguno"));
  ex.fetchBalance().then(bal => {
    const coins = Object.entries(bal.total).filter(([s,v]) => v > 0 && s !== "USDT");
    console.log("USDT: $" + (bal.total.USDT || 0));
    console.log("Monedas:", coins.length);
    coins.forEach(([s,v]) => console.log("  " + s + ": " + v));
    
    // Vender todo
    (async () => {
      for (const [symbol, amount] of coins) {
        try {
          const order = await ex.createMarketSellOrder(symbol + "/USDT", amount);
          console.log("VENDIDO " + symbol + ": " + amount + " @ $" + (order.average||"?"));
        } catch(e) {
          console.log("ERR " + symbol + ": " + e.message.substring(0,80));
        }
      }
      const final = await ex.fetchBalance();
      console.log("USDT FINAL: $" + (final.total.USDT || 0));
      process.exit(0);
    })();
  }).catch(e => { console.log("Balance ERR: " + e.message); process.exit(1); });
} catch(e) {
  console.log("Decrypt ERR: " + e.message);
  process.exit(1);
}
'
