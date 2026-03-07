require('dotenv').config();
const { initDB, getDB } = require('./src/models/db');
const { encrypt, decrypt } = require('./src/services/encryption');
const ccxt = require('ccxt');
const { SocksProxyAgent } = require('socks-proxy-agent');

initDB();
const db = getDB();

// Step 1: Verify decrypt works
const row = db.prepare('SELECT api_key_enc, api_secret_enc FROM api_keys WHERE id = 1').get();
if (!row) { console.log('NO API KEY IN DB'); process.exit(1); }

let apiKey, apiSecret;
try {
  apiKey = decrypt(row.api_key_enc);
  apiSecret = decrypt(row.api_secret_enc);
  console.log('1. DECRYPT OK - key len:', apiKey.length, 'starts:', apiKey.substring(0, 8));
} catch (e) {
  console.log('1. DECRYPT FAILED:', e.message);
  console.log('   Re-encrypting with current ENCRYPTION_KEY...');
  apiKey = 'XvcLbTYUk1AZwalknb7DVCwWIpUDeKQPit6cQjCEeksgce64neMn2rg8PODqyoSs';
  apiSecret = '6fRmyguWO8XnEcTA0ao63EpjqxiSZOAwIWwIP4KhBEaYSbZkKJNw2j7BKIOGABwC';
  db.prepare('UPDATE api_keys SET api_key_enc=?, api_secret_enc=? WHERE id=1')
    .run(encrypt(apiKey), encrypt(apiSecret));
  console.log('   Re-encrypted OK');
}

// Step 2: Test public endpoint via proxy
const proxyUrl = (process.env.BINANCE_PROXY || '').replace('socks5h://', 'socks5://');
console.log('2. Proxy:', proxyUrl);
const agent = new SocksProxyAgent(proxyUrl);

const pubEx = new ccxt.binance({ enableRateLimit: true, socksProxy: proxyUrl, httpAgent: agent, httpsAgent: agent });
pubEx.httpAgent = agent;
pubEx.httpsAgent = agent;

(async () => {
  try {
    const t = await pubEx.fetchTicker('BTC/USDT');
    console.log('3. PUBLIC fetchTicker OK:', t.symbol, '$' + t.last);
  } catch (e) {
    console.log('3. PUBLIC fetchTicker FAIL:', e.message.substring(0, 100));
  }

  // Step 3: Test authenticated endpoint
  const authAgent = new SocksProxyAgent(proxyUrl);
  const authEx = new ccxt.binance({
    apiKey, secret: apiSecret, enableRateLimit: true,
    verbose: true,
    options: { defaultType: 'spot', adjustForTimeDifference: true, recvWindow: 60000 },
    socksProxy: proxyUrl, httpAgent: authAgent, httpsAgent: authAgent,
  });
  authEx.httpAgent = authAgent;
  authEx.httpsAgent = authAgent;

  // First sync time
  try { await authEx.loadTimeDifference(); console.log('4a. Time diff:', authEx.options.timeDifference); } catch(e) { console.log('4a. Time diff fail:', e.message.substring(0,80)); }

  try {
    const bal = await authEx.fetchBalance();
    const assets = {};
    for (const [c, v] of Object.entries(bal.total)) { if (v > 0) assets[c] = v; }
    console.log('4. AUTH fetchBalance OK:', JSON.stringify(assets));
  } catch (e) {
    const msg = e.message || '';
    console.log('4. AUTH fetchBalance FAIL:', msg.substring(0, 300));
    if (msg.includes('-2008') || msg.includes('-2015')) {
      console.log('');
      console.log('Probando con key hardcoded directa (sin DB)...');
    }
  }

  // Step 4: Try with explicit key to rule out encoding issues  
  const ex2agent = new SocksProxyAgent(proxyUrl);
  const ex2 = new ccxt.binance({
    apiKey: 'XvcLbTYUk1AZwalknb7DVCwWIpUDeKQPit6cQjCEeksgce64neMn2rg8PODqyoSs',
    secret: '6fRmyguWO8XnEcTA0ao63EpjqxiSZOAwIWwIP4KhBEaYSbZkKJNw2j7BKIOGABwC',
    enableRateLimit: true,
    verbose: false,
    options: { defaultType: 'spot', adjustForTimeDifference: true, recvWindow: 60000 },
    socksProxy: proxyUrl, httpAgent: ex2agent, httpsAgent: ex2agent,
  });
  ex2.httpAgent = ex2agent;
  ex2.httpsAgent = ex2agent;

  try {
    await ex2.loadTimeDifference();
    const bal = await ex2.fetchBalance();
    const assets = {};
    for (const [c, v] of Object.entries(bal.total)) { if (v > 0) assets[c] = v; }
    console.log('5. HARDCODED fetchBalance OK:', JSON.stringify(assets));
  } catch (e) {
    console.log('5. HARDCODED fetchBalance FAIL:', e.message.substring(0, 300));
  }
})();
