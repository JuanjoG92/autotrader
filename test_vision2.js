require('dotenv').config();
const { getDB, initDB } = require('./src/models/db');
const { decrypt } = require('./src/services/encryption');
const crypto = require('crypto');
const https = require('https');

initDB();
const db = getDB();
const k = db.prepare('SELECT * FROM api_keys WHERE id = 3').get();
const apiKey = decrypt(k.api_key_enc);
const secret = decrypt(k.api_secret_enc);

// Direct signed request to Binance via data-api.binance.vision
const timestamp = Date.now();
const query = 'timestamp=' + timestamp + '&recvWindow=10000';
const signature = crypto.createHmac('sha256', secret).update(query).digest('hex');
const url = 'https://data-api.binance.vision/api/v3/account?' + query + '&signature=' + signature;

console.log('Calling /api/v3/account on data-api.binance.vision...');

https.get(url, { headers: { 'X-MBX-APIKEY': apiKey } }, (res) => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    console.log('STATUS:', res.statusCode);
    if (res.statusCode === 200) {
      const json = JSON.parse(data);
      const balances = json.balances.filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
      console.log('SUCCESS! Assets with balance:', balances.length);
      balances.forEach(b => console.log('  ' + b.asset + ': free=' + b.free + ' locked=' + b.locked));
    } else {
      console.log('ERROR:', data.substring(0, 300));
    }
  });
}).on('error', e => console.log('NET ERROR:', e.message));
