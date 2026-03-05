require('dotenv').config();
const { getDB, initDB } = require('./src/models/db');
const { decrypt } = require('./src/services/encryption');
const ccxt = require('ccxt');

initDB();
const db = getDB();
const k = db.prepare('SELECT * FROM api_keys WHERE id = 3').get();
const apiKey = decrypt(k.api_key_enc);
const secret = decrypt(k.api_secret_enc);

console.log('Testing with data-api.binance.vision...');

const ex = new ccxt.binance({
  apiKey,
  secret,
  enableRateLimit: true,
  options: { defaultType: 'spot' },
  urls: {
    api: {
      public: 'https://data-api.binance.vision/api/v3',
      private: 'https://data-api.binance.vision/api/v3',
      sapi: 'https://data-api.binance.vision/sapi/v1',
      sapiV2: 'https://data-api.binance.vision/sapi/v2',
      sapiV3: 'https://data-api.binance.vision/sapi/v3',
      sapiV4: 'https://data-api.binance.vision/sapi/v4',
    }
  }
});

(async () => {
  try {
    const bal = await ex.fetchBalance({ type: 'spot' });
    const assets = Object.keys(bal.total).filter(c => bal.total[c] > 0);
    console.log('SUCCESS! Assets with balance:', assets);
    assets.forEach(a => console.log(' ', a, ':', bal.total[a]));
  } catch(e) {
    console.log('ERROR:', e.constructor.name, '-', e.message.substring(0, 300));
  }
  process.exit(0);
})();
