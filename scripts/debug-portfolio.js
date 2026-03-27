// scripts/debug-portfolio.js
require('dotenv').config();
const cocos = require('../src/services/cocos');

(async () => {
  console.log('Inicializando Cocos...');
  await cocos.init();
  await new Promise(r => setTimeout(r, 3000));
  if (!cocos.isReady()) { console.error('❌ Cocos NO listo.'); process.exit(1); }
  console.log('✅ Cocos listo.');

  const endpoints = [
    // FCI / Fondos
    'api/v1/fci',
    'api/v1/fci/portfolio',
    'api/v1/fci/positions',
    'api/v1/fci/holdings',
    'api/v1/wallet/fci',
    'api/v1/wallet/funds',
    'api/v1/wallet/investments',
    'api/v1/funds',
    'api/v1/funds/portfolio',
    'api/v2/fci',
    'api/v2/fci/portfolio',
    'api/v1/markets/fci',
    // Wallet general
    'api/v1/wallet/totals',
    'api/v1/wallet/summary',
    'api/v1/wallet/net-equity',
    'api/v1/wallet/performance',
    'api/v1/wallet/performance/daily',
    'api/v1/wallet/performance/historic',
    // Órdenes
    'api/v2/orders?status=EXECUTED&size=10',
    'api/v2/orders?size=20',
    // Cuenta
    'api/v1/accounts/1391716',
    'api/v1/users/me/accounts',
  ];

  for (const ep of endpoints) {
    try {
      const result = await cocos.debugCall('GET', ep);
      const preview = JSON.stringify(result).substring(0, 400);
      console.log(`\n✅ ${ep}\n   ${preview}`);
    } catch (e) {
      console.log(`❌ ${ep} → ${e.status || '?'} ${e.message.substring(0, 60)}`);
    }
  }

  process.exit(0);
})();
