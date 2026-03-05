require('dotenv').config();
const { initDB, getDB } = require('./src/models/db');
const bcrypt = require('bcryptjs');
initDB();
const db = getDB();
const email = 'saladasaldia@live.com';
const pass  = 'Juanjog1.';
const hash  = bcrypt.hashSync(pass, 10);
const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
if (exists) {
  console.log('Usuario ya existe, actualizando contraseña...');
  db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hash, email);
} else {
  db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)').run(email, 'Juan Gonzalez', hash);
  console.log('Usuario creado:', email);
}
const user = db.prepare('SELECT id, email, name FROM users WHERE email = ?').get(email);
console.log('OK:', JSON.stringify(user));
