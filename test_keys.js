// Test: decrypt keys from DB and try Binance directly
require('dotenv').config();
const { getDB, initDB } = require('./src/models/db');
const { decrypt } = require('./src/services/encryption');
const ccxt = require('ccxt');

initDB();
const db = getDB();

// Get all API keys
const keys = db.prepare('SELECT * FROM api_keys').all();
console.log('=== API Keys in DB:', keys.length, '===');

keys.forEach(k => {
  console.log('\n--- Key ID:', k.id, '| Exchange:', k.exchange, '| Label:', k.label, '---');
  try {
    const apiKey = decrypt(k.api_key_enc);
    const secret = decrypt(k.api_secret_enc);
    console.log('Decrypted API Key:', apiKey.substring(0, 8) + '...' + apiKey.substring(apiKey.length - 4));
    console.log('Decrypted Secret:', secret.substring(0, 8) + '...' + secret.substring(secret.length - 4));
    console.log('API Key length:', apiKey.length, '| Secret length:', secret.length);

    // Try connecting WITHOUT proxy
    const proxy = process.env.BINANCE_PROXY;
    console.log('BINANCE_PROXY:', proxy || 'NOT SET');

    const config = {
      apiKey,
      secret,
      enableRateLimit: true,
      options: { defaultType: 'spot' },
    };

    if (k.exchange === 'binance' && proxy) {
      if (proxy.startsWith('socks')) {
        config.socksProxy = proxy;
      } else {
        config.httpsProxy = proxy;
      }
      console.log('Using proxy:', proxy);
    }

    const exchange = new ccxt[k.exchange](config);

    console.log('Fetching balance...');
    exchange.fetchBalance().then(bal => {
      const assets = Object.keys(bal.total).filter(c => bal.total[c] > 0);
      console.log('SUCCESS! Assets:', assets.length, assets.slice(0, 5));
    }).catch(err => {
      console.log('ERROR:', err.constructor.name, '-', err.message.substring(0, 200));
    });
  } catch (err) {
    console.log('DECRYPT ERROR:', err.message);
  }
});

// Give time for async ops
setTimeout(() => process.exit(0), 15000);
