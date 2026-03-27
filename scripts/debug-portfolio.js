// scripts/debug-portfolio.js
// Ejecutar en VPS: node scripts/debug-portfolio.js
require('dotenv').config();
const cocos = require('../src/services/cocos');

(async () => {
  console.log('Inicializando Cocos...');
  await cocos.init();
  await new Promise(r => setTimeout(r, 3000));

  if (!cocos.isReady()) {
    console.error('❌ Cocos NO está listo. Revisar credenciales.');
    process.exit(1);
  }
  console.log('✅ Cocos listo. Session:', cocos.getSessionInfo());

  console.log('\n--- PORTFOLIO ---');
  try {
    const p = await cocos.getPortfolio();
    console.log(JSON.stringify(p, null, 2));
  } catch (e) {
    console.error('Error portfolio:', e.message, 'status:', e.status);
  }

  console.log('\n--- BUYING POWER ---');
  try {
    const bp = await cocos.getBuyingPower();
    console.log(JSON.stringify(bp, null, 2));
  } catch (e) {
    console.error('Error buying-power:', e.message, 'status:', e.status);
  }

  console.log('\n--- MY DATA ---');
  try {
    const me = await cocos.getMyData();
    console.log(JSON.stringify(me, null, 2));
  } catch (e) {
    console.error('Error mydata:', e.message, 'status:', e.status);
  }

  process.exit(0);
})();
