// Test ccxt + SOCKS proxy
const ccxt = require('ccxt');
const { SocksProxyAgent } = require('socks-proxy-agent');

const proxyUrl = 'socks5://127.0.0.1:1080';
const agent = new SocksProxyAgent(proxyUrl);

const exchange = new ccxt.binance({
  enableRateLimit: true,
  socksProxy: proxyUrl,
  httpAgent: agent,
  httpsAgent: agent,
});
exchange.httpAgent = agent;
exchange.httpsAgent = agent;

(async () => {
  try {
    const ticker = await exchange.fetchTicker('BTC/USDT');
    console.log('TICKER OK:', ticker.symbol, '$' + ticker.last);
  } catch (e) {
    console.log('TICKER ERR:', e.message);
  }
})();
