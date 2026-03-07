require('dotenv').config();
const crypto = require('crypto');
const https = require('https');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { initDB, getDB } = require('./src/models/db');
const { decrypt } = require('./src/services/encryption');

initDB();
const db = getDB();

const row = db.prepare('SELECT api_key_enc, api_secret_enc FROM api_keys WHERE id = 1').get();
if (!row) { console.log('NO KEY'); process.exit(1); }

const apiKey = decrypt(row.api_key_enc);
const apiSecret = decrypt(row.api_secret_enc);

console.log('API Key:', apiKey.substring(0, 12) + '... len=' + apiKey.length);
console.log('Secret:', apiSecret.substring(0, 12) + '... len=' + apiSecret.length);
console.log('Expected key start: XvcLbTYUk1AZ');
console.log('Expected secret start: 6fRmyguWO8Xn');
console.log('Key match:', apiKey.startsWith('XvcLbTYUk1AZ'));
console.log('Secret match:', apiSecret.startsWith('6fRmyguWO8Xn'));

// Test: get Binance server time then make signed request
const proxyUrl = (process.env.BINANCE_PROXY || '').replace('socks5h://', 'socks5://');
const agent = proxyUrl ? new SocksProxyAgent(proxyUrl) : undefined;

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const opts = { headers: headers || {} };
    if (agent) opts.agent = agent;
    https.get(url, opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  // Step 1: Server time
  const timeResp = await httpsGet('https://api.binance.com/api/v3/time');
  console.log('\nBinance server time:', timeResp.serverTime);
  console.log('Local time:', Date.now());
  console.log('Diff:', Date.now() - timeResp.serverTime, 'ms');

  // Step 2: Signed request with server time
  const ts = timeResp.serverTime;
  const queryString = 'timestamp=' + ts + '&recvWindow=60000';
  const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
  const url = 'https://api.binance.com/api/v3/account?' + queryString + '&signature=' + signature;

  console.log('\nSigned URL:', url.substring(0, 80) + '...');
  console.log('Signature:', signature.substring(0, 16) + '...');

  try {
    const resp = await httpsGet(url, { 'X-MBX-APIKEY': apiKey });
    if (resp.code) {
      console.log('\nBinance ERROR:', resp.code, resp.msg);
      if (resp.code === -2015) {
        console.log('=> SIGNATURE FAILED. The API SECRET might be wrong.');
        console.log('=> Please create a NEW API key in Binance and enter it in /binance');
      }
    } else {
      const balances = (resp.balances || []).filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
      console.log('\n=== BALANCE OK! ===');
      balances.forEach(b => console.log(b.asset + ': free=' + b.free + ' locked=' + b.locked));
    }
  } catch (e) {
    console.log('Request error:', e.message);
  }
})();
