#!/bin/bash
# Debug portfolio - check what Cocos API returns
cd /var/www/autotrader
node -e "
require('dotenv').config();
const cocos = require('./src/services/cocos');

async function check() {
  // Wait for Cocos to be ready
  let tries = 0;
  while (!cocos.isReady() && tries < 30) {
    await new Promise(r => setTimeout(r, 1000));
    tries++;
  }
  
  if (!cocos.isReady()) {
    console.log('ERROR: Cocos no está ready después de 30s');
    process.exit(1);
  }
  
  console.log('Cocos ready! Consultando portfolio...');
  
  try {
    const portfolio = await cocos.getPortfolio();
    console.log('=== PORTFOLIO RAW ===');
    console.log(JSON.stringify(portfolio, null, 2));
  } catch (e) {
    console.log('ERROR portfolio:', e.message);
    console.log('Status:', e.status || 'N/A');
  }
  
  try {
    const bp = await cocos.getBuyingPower();
    console.log('=== BUYING POWER ===');
    console.log(JSON.stringify(bp, null, 2));
  } catch (e) {
    console.log('ERROR buying power:', e.message);
  }
  
  process.exit(0);
}
check();
"
