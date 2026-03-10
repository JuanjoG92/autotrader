#!/bin/bash
cd /var/www/autotrader
node -e '
const b = require("./src/services/binance");
const { getDB } = require("./src/models/db");
(async () => {
  const key = getDB().prepare("SELECT * FROM api_keys WHERE exchange = ?").get("binance");
  if (!key) { console.log("Sin API key"); process.exit(1); }
  const ex = b.getExchangeForUser(key.user_id, key.id);
  const bal = await ex.fetchBalance();
  const coins = Object.entries(bal.total).filter(([s,v]) => v > 0 && s !== "USDT");
  console.log("Monedas a vender:", coins.length);
  for (const [symbol, amount] of coins) {
    const pair = symbol + "/USDT";
    try {
      const order = await ex.createMarketSellOrder(pair, amount);
      console.log("VENDIDO " + pair + ": " + amount + " @ $" + (order.average || order.price || "?"));
    } catch(e) {
      console.log("ERROR " + pair + ": " + e.message.substring(0,80));
    }
  }
  const finalBal = await ex.fetchBalance();
  console.log("USDT final: $" + (finalBal.total.USDT || 0));
})().catch(e => console.log("ERR:" + e.message));
'
