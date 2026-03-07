require('dotenv').config();
const { initDB, getDB } = require('./src/models/db');
const { encrypt, decrypt } = require('./src/services/encryption');
const ccxt = require('ccxt');
const { SocksProxyAgent } = require('socks-proxy-agent');

initDB();
const db = getDB();

const K = 'XvcLbTYUk1AZwalknb7DVCwWIpUDeKQPit6cQjCEeksgce64neMn2rg8PODqyoSs';
const S = '6fRmyguWO8XnEcTA0ao63EpjqxiSZOAwIWwIP4KhBEaYSbZkKJNw2j7BKIOGABwC';

const eK = encrypt(K);
const eS = encrypt(S);
if (decrypt(eK) !== K) { console.log('MISMATCH'); process.exit(1); }

const row = db.prepare("SELECT id FROM api_keys WHERE exchange = 'binance' LIMIT 1").get();
if (row) {
  db.prepare('UPDATE api_keys SET api_key_enc=?, api_secret_enc=? WHERE id=?').run(eK, eS, row.id);
  console.log('Updated id:', row.id);
} else {
  const r = db.prepare('INSERT INTO api_keys (user_id,exchange,label,api_key_enc,api_secret_enc,permissions) VALUES(?,?,?,?,?,?)')
    .run(1, 'binance', 'autotrader', eK, eS, 'spot');
  console.log('Inserted id:', r.lastInsertRowid);
}

const p = (process.env.BINANCE_PROXY || '').replace('socks5h://', 'socks5://');
const a = new SocksProxyAgent(p);
const ex = new ccxt.binance({
  apiKey: K, secret: S, enableRateLimit: true,
  options: { defaultType: 'spot', adjustForTimeDifference: true, recvWindow: 10000 },
  socksProxy: p, httpAgent: a, httpsAgent: a,
});
ex.httpAgent = a;
ex.httpsAgent = a;

(async () => {
  try {
    const b = await ex.fetchBalance();
    const r = {};
    for (const [c, v] of Object.entries(b.total)) {
      if (v > 0) r[c] = v;
    }
    console.log('BALANCE OK:', JSON.stringify(r));
  } catch (e) {
    console.log('ERROR:', e.message.substring(0, 200));
    if (e.message.includes('-2008')) {
      console.log('KEY REVOCADA. Crear nueva en Binance, IP SIN RESTRICCION, pegar en /binance');
    }
  }
})();
