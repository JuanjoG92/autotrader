require('dotenv').config();
const { initDB, getDB } = require('./src/models/db');
initDB();
getDB().prepare('UPDATE crypto_config SET max_per_trade_usd = 10 WHERE id = 1').run();
const c = getDB().prepare('SELECT max_per_trade_usd, stop_loss_pct, take_profit_pct, risk_level FROM crypto_config WHERE id = 1').get();
console.log('Config actualizada:', JSON.stringify(c));
