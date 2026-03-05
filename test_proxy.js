require('dotenv').config();
const ccxt = require('ccxt');

console.log('BINANCE_PROXY:', process.env.BINANCE_PROXY);

const exchange = new ccxt.binance({
  socksProxy: process.env.BINANCE_PROXY,
  enableRateLimit: true,
});

exchange.fetchTicker('BTC/USDT').then(t => {
  console.log('SUCCESS! BTC price:', t.last);
}).catch(e => {
  console.log('ERROR:', e.message);
});
