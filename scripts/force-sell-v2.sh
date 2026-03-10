#!/bin/bash
cd /var/www/autotrader
node -e '
require("dotenv").config();
const {decrypt} = require("./src/services/encryption");
const db = require("./src/models/db").getDB();
const k = db.prepare("SELECT * FROM api_keys WHERE exchange = ?").get("binance");
if (!k) { console.log("Sin API key binance"); process.exit(1); }
try {
  const apiKey = decrypt(k.api_key_enc);
  const secret = decrypt(k.api_secret_enc);
  console.log("Decrypt OK - key:" + apiKey.substring(0,8) + "... secret:" + secret.substring(0,8) + "...");
  
  const ccxt = require("ccxt");
  const {SocksProxyAgent} = require("socks-proxy-agent");
  const proxy = process.env.BINANCE_PROXY;
  const agent = proxy ? new SocksProxyAgent(proxy.replace("socks5h://","socks5://")) : undefined;
  
  const ex = new ccxt.binance({apiKey, secret, httpAgent: agent, httpsAgent: agent});
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
