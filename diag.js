// diag.js — Diagnóstico Cocos (solo lectura)
require('dotenv').config();
const { initDB, getDB } = require('./src/models/db');
initDB();
const db = getDB();

// Sesión Cocos (sin imprimir tokens)
const sess = db.prepare('SELECT id, account_id, expires_at, updated_at FROM cocos_sessions').get();
const now = Math.floor(Date.now() / 1000);
if (sess) {
  const minLeft = Math.round((sess.expires_at - now) / 60);
  console.log('Sesión Cocos:', JSON.stringify({ ...sess, expires_in_min: minLeft, expired: minLeft <= 0 }));
} else {
  console.log('SIN SESION EN DB');
}

// Vars env relevantes (sin valores)
const vars = ['COCOS_EMAIL','COCOS_PASSWORD','COCOS_TOTP','COCOS_ACCESS_TOKEN','COCOS_REFRESH_TOKEN','COCOS_ACCOUNT_ID','ENCRYPTION_KEY'];
vars.forEach(v => console.log(v + ':', process.env[v] ? 'SET (' + process.env[v].length + ' chars)' : 'MISSING'));

// Test refresh directo
const { decrypt } = require('./src/services/encryption');
const row = db.prepare('SELECT * FROM cocos_sessions WHERE id=1').get();
if (row) {
  try {
    const rt = decrypt(row.refresh_token_enc);
    console.log('refresh_token decrypt: OK (' + rt.length + ' chars)');
    console.log('refresh_token starts:', rt.substring(0, 10) + '...');
  } catch(e) {
    console.log('refresh_token decrypt FAILED:', e.message);
  }
}
