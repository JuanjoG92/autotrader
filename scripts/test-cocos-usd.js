// Test: verificar que getQuote funciona en USD para los tickers clave
// Ejecutar: node scripts/test-cocos-usd.js

const cocos = require('../src/services/cocos');

async function test() {
  console.log('Esperando que Cocos se conecte...');
  
  // Esperar hasta 30s a que Cocos esté listo
  for (let i = 0; i < 30; i++) {
    if (cocos.isReady()) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  
  if (!cocos.isReady()) {
    console.log('ERROR: Cocos no se conectó en 30s');
    process.exit(1);
  }
  
  console.log('Cocos listo. Testeando quotes USD...\n');
  
  const tickers = ['PBR', 'VIST', 'YPFD', 'NVDA', 'PLTR', 'MSFT'];
  
  for (const ticker of tickers) {
    try {
      // Test USD quote
      const qUSD = await cocos.getQuote(ticker, 'C', 'USD');
      const usdPrice = qUSD?.last_price || qUSD?.close_price || qUSD?.previous_close_price || 0;
      const usdLong = qUSD?.long_ticker || 'N/A';
      
      // Test ARS quote (comparación)
      const qARS = await cocos.getQuote(ticker, 'C', 'ARS');
      const arsPrice = qARS?.last_price || qARS?.close_price || qARS?.previous_close_price || 0;
      const arsLong = qARS?.long_ticker || 'N/A';
      
      console.log(`${ticker}:`);
      console.log(`  USD: $${usdPrice} | long_ticker: ${usdLong}`);
      console.log(`  ARS: $${arsPrice} | long_ticker: ${arsLong}`);
      console.log(`  Ratio ARS/USD: ${arsPrice > 0 && usdPrice > 0 ? (arsPrice/usdPrice).toFixed(0) : 'N/A'}`);
      console.log('');
      
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.log(`${ticker}: ERROR - ${e.message}\n`);
    }
  }
  
  // Test buying power
  try {
    const bp = await cocos.getBuyingPower();
    console.log('Buying Power:', JSON.stringify(bp, null, 2));
  } catch (e) {
    console.log('Buying Power ERROR:', e.message);
  }
  
  // Test dolar MEP
  try {
    const mep = await cocos.getDolarMEP();
    console.log('\nDolar MEP:', JSON.stringify(mep, null, 2));
  } catch (e) {
    console.log('Dolar MEP ERROR:', e.message);
  }
  
  process.exit(0);
}

test().catch(e => { console.error(e); process.exit(1); });
