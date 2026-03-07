// Test ccxt + SOCKS proxy + API Key (fetchBalance)
require('dotenv').config();

const ccxt = require('ccxt');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { initDB, getDB } = require('./src/models/db');
const { decrypt } = require('./src/services/encryption');

initDB();

const proxyUrl = (process.env.BINANCE_PROXY || '').replace('socks5h://', 'socks5://');
const agent = new SocksProxyAgent(proxyUrl);

const db = getDB();
const row = db.prepare("SELECT * FROM api_keys WHERE exchange = 'binance' LIMIT 1").get();
if (!row) { console.log('No Binance API key found'); process.exit(1); }

const apiKey = decrypt(row.api_key_enc);
const secret = decrypt(row.api_secret_enc);

console.log('API Key length:', apiKey.length, 'starts:', apiKey.substring(0, 10));
console.log('Secret length:', secret.length, 'starts:', secret.substring(0, 10));
console.log('Proxy:', proxyUrl);

const exchange = new ccxt.binance({
  apiKey, secret,
  enableRateLimit: true,
  verbose: false,
  options: { defaultType: 'spot', adjustForTimeDifference: true, recvWindow: 10000 },
  socksProxy: proxyUrl,
  httpAgent: agent,
  httpsAgent: agent,
});
exchange.httpAgent = agent;
exchange.httpsAgent = agent;

(async () => {
  // Test 1: fetchTime (no auth needed but uses proxy)
  try {
    const time = await exchange.fetchTime();
    console.log('1. fetchTime OK:', new Date(time).toISOString());
  } catch (e) {
    console.log('1. fetchTime ERR:', e.message.substring(0, 100));
  }

  // Test 2: fetchBalance (auth + proxy)
  try {
    const balance = await exchange.fetchBalance();
    const assets = {};
    for (const [coin, val] of Object.entries(balance.total)) {
      if (val > 0) assets[coin] = val;
    }
    console.log('2. fetchBalance OK:', JSON.stringify(assets));
  } catch (e) {
    console.log('2. fetchBalance ERR:', e.message.substring(0, 150));
  }

  // Test 3: Try with hardcoded key (bypass DB decrypt)
  try {
    const ex2 = new ccxt.binance({
      apiKey: 'XvcLbTYUk1AZwalknb7DVCwWIpUDeKQPit6cQjCEeksgce64neMn2rg8PODqyoSs',
      secret: '6fRmyguWO8XnEcTA0ao63EpjqxiSZOAwIWwIP4KhBEaYSbZkKJNw2j7BKIOGABwC',
      enableRateLimit: true,
      options: { defaultType: 'spot', adjustForTimeDifference: true, recvWindow: 10000 },
      socksProxy: proxyUrl,
      httpAgent: agent,
      httpsAgent: agent,
    });
    ex2.httpAgent = agent;
    ex2.httpsAgent = agent;
    const bal = await ex2.fetchBalance();
    const assets = {};
    for (const [coin, val] of Object.entries(bal.total)) {
      if (val > 0) assets[coin] = val;
    }
    console.log('3. hardcoded key OK:', JSON.stringify(assets));
  } catch (e) {
    console.log('3. hardcoded key ERR:', e.message.substring(0, 150));
  }
})();
