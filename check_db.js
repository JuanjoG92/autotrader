require('dotenv').config();
const { initDB, getDB } = require('./src/models/db');
initDB();
const users = getDB().prepare('SELECT id, email FROM users').all();
console.log('Users:', JSON.stringify(users));
const cocos = getDB().prepare('SELECT id, account_id, expires_at FROM cocos_sessions').all();
console.log('Cocos sessions:', JSON.stringify(cocos));
