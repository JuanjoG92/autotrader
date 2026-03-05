// test-cocos.js — diagnóstico de la API Cocos Capital
// Ejecutar en VPS: node /var/www/autotrader/test-cocos.js > /tmp/cocos-test.json
'use strict';
process.chdir('/var/www/autotrader');
require('dotenv').config();
const cocos = require('./src/services/cocos');

async function run() {
  const results = {};

  await cocos.init();
  await new Promise(r => setTimeout(r, 3000)); // esperar token refresh

  // 1. searchTicker
  try { results.search_GGAL = await cocos.searchTicker('GGAL'); } catch(e) { results.search_GGAL = { error: e.message }; }

  // 2. getMarketList variantes
  const listTests = [
    ['ACCIONES','LIDERES','24hs','ARS','C',1,10],
    ['ACCIONES','GENERAL','24hs','ARS','C',1,10],
    ['ACCIONES','PANEL_GENERAL','24hs','ARS','C',1,10],
    ['ACCIONES',null,'24hs','ARS','C',1,10],
  ];
  results.list_tests = {};
  for (const [type,sub,sett,cur,seg,pg,sz] of listTests) {
    const key = `${type}_${sub||'noSubtype'}`;
    try {
      const url = sub
        ? `api/v1/markets/tickers/?instrument_type=${type}&instrument_subtype=${sub}&settlement_days=0002&currency=${cur}&segment=${seg}&page=${pg}&size=${sz}`
        : `api/v1/markets/tickers/?instrument_type=${type}&settlement_days=0002&currency=${cur}&segment=${seg}&page=${pg}&size=${sz}`;
      results.list_tests[key] = await cocos._callRaw('GET', url);
    } catch(e) {
      results.list_tests[key] = { error: e.message };
    }
  }

  // 3. getQuote variantes para GGAL
  const quoteTests = [
    'GGAL-0002-C-CT-ARS',
    'GGAL',
    'GGAL?segment=C&settlement_days=0002&currency=ARS',
  ];
  results.quote_tests = {};
  for (const t of quoteTests) {
    try {
      results.quote_tests[t] = await cocos._callRaw('GET', `api/v1/markets/tickers/${t.includes('?') ? t : encodeURIComponent(t)}${t.includes('?') ? '' : '?segment=C'}`);
    } catch(e) {
      results.quote_tests[t] = { error: e.message };
    }
  }

  // 4. market status / calendar
  try { results.market_status = await cocos._callRaw('GET', 'api/v1/calendar/open-market'); } catch(e) { results.market_status = {error: e.message}; }

  console.log(JSON.stringify(results, null, 2));
}

run().catch(e => console.error('FATAL:', e));
