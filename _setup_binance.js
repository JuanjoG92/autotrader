// Guardar API key de Binance y probar conexion
const { encrypt } = require('./src/services/encryption');
const db = require('better-sqlite3')('data/autotrader.db');

const API_KEY = 'XvcLbTYUk1AZwalknb7DVCwWIpUDeKQPit6cQjCEeksgce64neMn2rg8PODqyoSs';
const SECRET  = '6fRmyguWO8XnEcTA0ao63EpjqxiSZOAwIWwIP4KhBEaYSbZkKJNw2j7BKIOGABwC';

// Buscar usuario existente
const user = db.prepare('SELECT id FROM users LIMIT 1').get();
if (!user) { console.error('No hay usuarios en la DB'); process.exit(1); }

// Borrar keys viejas de binance
db.prepare("DELETE FROM api_keys WHERE exchange = 'binance'").run();

// Insertar nueva
const r = db.prepare(
  'INSERT INTO api_keys (user_id, exchange, label, api_key_enc, api_secret_enc, permissions) VALUES (?,?,?,?,?,?)'
).run(user.id, 'binance', 'autotrader', encrypt(API_KEY), encrypt(SECRET), 'spot,read');

console.log('API Key guardada con id:', r.lastInsertRowid, 'para user:', user.id);

// Actualizar crypto_config para usar esta key
db.prepare('UPDATE crypto_config SET api_key_id = ?, enabled = 1 WHERE id = 1').run(r.lastInsertRowid);
console.log('Crypto trader ACTIVADO con api_key_id:', r.lastInsertRowid);

db.close();
console.log('LISTO - reiniciar PM2 para que tome los cambios');
