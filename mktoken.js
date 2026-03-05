require('dotenv').config({ path: '/var/www/autotrader/.env' });
const jwt = require('/var/www/autotrader/node_modules/jsonwebtoken');
const db  = require('/var/www/autotrader/src/models/db').getDB();
const u   = db.prepare('SELECT id,email FROM users LIMIT 1').get();
const tok = jwt.sign({ userId: u.id, email: u.email }, process.env.JWT_SECRET || 'autotrader_secret_2024', { expiresIn: '1h' });
process.stdout.write(tok);
