// test_api.js — Test rápido de la API (solo lectura)
require('dotenv').config();
const jwt = require('jsonwebtoken');

// Generar JWT válido para el owner (user id=1)
const token = jwt.sign({ id: 1, email: 'owner' }, process.env.JWT_SECRET, { expiresIn: '1h' });
console.log('JWT generado para owner (id=1)');

async function test(path) {
  try {
    const res = await fetch('http://localhost:3800/api' + path, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text.substring(0, 200); }
    console.log(path, '→', res.status, JSON.stringify(body).substring(0, 150));
  } catch (e) {
    console.log(path, '→ ERROR:', e.message);
  }
}

(async () => {
  await test('/cocos/status');
  await test('/cocos/market');
  await test('/cocos/buying-power');
  await test('/ai/market/prices');
  await test('/ai/config');
  await test('/ai/signals?limit=3');
  console.log('\nDone.');
})();
