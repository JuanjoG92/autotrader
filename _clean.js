var d=require('better-sqlite3')('data/autotrader.db');
d.prepare("UPDATE crypto_positions SET status='CLOSED',reason='Limpieza paper' WHERE status='OPEN'").run();
console.log('Posiciones paper cerradas');
d.close();
