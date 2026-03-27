// scripts/debug-portfolio.js
// Ejecutar en VPS: node scripts/debug-portfolio.js
require('dotenv').config();
const cocos = require('../src/services/cocos');

(async () => {
  console.log('Inicializando Cocos...');
  await cocos.init();
  await new Promise(r => setTimeout(r, 3000));

  if (!cocos.isReady()) {
    console.error('❌ Cocos NO está listo.');
    process.exit(1);
  }
  console.log('✅ Cocos listo.');

  const endpoints = [
    'api/v1/wallet/portfolio',
    'api/v2/wallet/portfolio',
    'api/v1/portfolio',
    'api/v2/portfolio',
    'api/v1/wallet/positions',
    'api/v1/wallet/assets',
    'api/v1/wallet/holdings',
    'api/v1/wallet/balance',
    'api/v1/accounts/1391716/portfolio',
    'api/v1/accounts/1391716/positions',
    'api/v1/wallet',
    'api/v1/wallet/overview',
    'api/v1/wallet/totals',
    'api/v2/wallet',
    'api/v2/orders/buying-power',
    'api/v1/markets/portfolio',
    'api/v1/instruments/portfolio',
  ];

  for (const ep of endpoints) {
    try {
      const result = await cocos.debugCall('GET', ep);
      const preview = JSON.stringify(result).substring(0, 300);
      console.log(`✅ ${ep} → ${preview}`);
    } catch (e) {
      console.log(`❌ ${ep} → ${e.status || '?'} ${e.message.substring(0, 80)}`);
    }
  }

  process.exit(0);
})();
