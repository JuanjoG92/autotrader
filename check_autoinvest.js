// check_autoinvest.js — Verifica que el auto-inversor esté listo
require('dotenv').config();
const { initDB, getDB } = require('./src/models/db');
initDB();
const db = getDB();

console.log('\n══ AUTO-INVEST: VERIFICACIÓN ══\n');

// 1. Config
const cfg = db.prepare('SELECT * FROM auto_invest_config WHERE id = 1').get();
if (!cfg) {
  console.log('❌ auto_invest_config NO EXISTE — la tabla no se creó');
  process.exit(1);
}
console.log('Config actual:');
console.log('  enabled:         ', cfg.enabled === 1 ? '✅ SÍ' : '❌ NO');
console.log('  monitor_enabled: ', cfg.monitor_enabled === 1 ? '✅ SÍ' : '❌ NO');
console.log('  invest_pct:      ', cfg.invest_pct + '%');
console.log('  min_invest_ars:  ', '$' + cfg.min_invest_ars);
console.log('  stop_loss_pct:   ', cfg.stop_loss_pct + '%');
console.log('  take_profit_pct: ', cfg.take_profit_pct + '%');
console.log('  allow_high_risk: ', cfg.allow_high_risk ? 'SÍ' : 'NO');

// 2. Horario
const now = new Date();
const utc = now.getTime() + now.getTimezoneOffset() * 60000;
const art = new Date(utc - 3 * 3600000);
const day = art.getDay();
const hhmm = art.getHours() * 100 + art.getMinutes();
const isOpen = day >= 1 && day <= 5 && hhmm >= 1030 && hhmm < 1700;
console.log('\nHorario:');
console.log('  Hora Argentina:', art.toLocaleString('es-AR'));
console.log('  Día semana:    ', ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'][day]);
console.log('  HHMM:          ', hhmm);
console.log('  Mercado ahora: ', isOpen ? '🟢 ABIERTO' : '🔴 CERRADO');

// 3. Posiciones activas
const positions = db.prepare("SELECT * FROM auto_investments WHERE action='BUY' AND status='EXECUTED'").all();
console.log('\nPosiciones activas:', positions.length);
positions.forEach(p => console.log('  ', p.ticker, 'x' + p.quantity, '@ $' + p.price, '| SL:$' + p.stop_loss_price, '| TP:$' + p.take_profit_price));

// 4. Historial
const history = db.prepare('SELECT * FROM auto_investments ORDER BY created_at DESC LIMIT 5').all();
console.log('\nÚltimas operaciones:', history.length);
history.forEach(h => console.log('  ', h.created_at, h.action, h.ticker, 'x' + h.quantity, '@ $' + h.price, h.status));

// 5. RAG docs
const docs = db.prepare('SELECT id, name, chunks_count FROM rag_documents').all();
console.log('\nDocumentos RAG:', docs.length);
docs.forEach(d => console.log('  #' + d.id, d.name, '(' + d.chunks_count + ' chunks)'));

// 6. Noticias
const newsCount = db.prepare('SELECT COUNT(*) as c FROM news_items').get();
console.log('\nNoticias en DB:', newsCount.c);

// 7. Tickers con precio
const priceCount = db.prepare('SELECT COUNT(DISTINCT ticker) as c FROM market_prices').get();
console.log('Tickers con datos:', priceCount.c);

console.log('\n══ FIN VERIFICACIÓN ══\n');
process.exit(0);
