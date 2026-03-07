// Test ccxt + SOCKS proxy + API Key (fetchBalance)
const ccxt = require('ccxt');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { getDB } = require('./src/models/db');
const { decrypt } = require('./src/services/encryption');

require('dotenv').config();

const { initDB } = require('./src/models/db');
initDB();

const proxyUrl = (process.env.BINANCE_PROXY || '').replace('socks5h://', 'socks5://');
const agent = new SocksProxyAgent(proxyUrl);

const db = getDB();
const row = db.prepare("SELECT * FROM api_keys WHERE exchange = 'binance' LIMIT 1").get();
if (!row) { console.log('No Binance API key found'); process.exit(1); }

const apiKey = decrypt(row.api_key_enc);
const secret = decrypt(row.api_secret_enc);

const exchange = new ccxt.binance({
  apiKey, secret,
  enableRateLimit: true,
  options: { defaultType: 'spot', adjustForTimeDifference: true },
  socksProxy: proxyUrl,
  httpAgent: agent,
  httpsAgent: agent,
});
exchange.httpAgent = agent;
exchange.httpsAgent = agent;

(async () => {
  try {
    const balance = await exchange.fetchBalance();
    const assets = {};
    for (const [coin, val] of Object.entries(balance.total)) {
      if (val > 0) assets[coin] = val;
    }
    console.log('BALANCE OK:', JSON.stringify(assets, null, 2));
  } catch (e) {
    console.log('BALANCE ERR:', e.message);
  }
})();
