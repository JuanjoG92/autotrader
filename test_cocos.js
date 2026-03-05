// Test: Cocos Capital API connection - flujo completo con 2FA TOTP
require('dotenv').config();
const crypto = require('crypto');

const BASE_URL  = 'https://api.cocos.capital';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.ewogICJyb2xlIjogImFub24iLAogICJpc3MiOiAic3VwYWJhc2UiLAogICJpYXQiOiAxNzA0NjgyODAwLAogICJleHAiOiAxODYyNTM1NjAwCn0.f0w62k0q0eyyGBDkAP7vUUEg_Ingb9YbOlhsGCC4R3c';

const EMAIL       = process.env.COCOS_EMAIL    || '';
const PASSWORD    = process.env.COCOS_PASSWORD || '';
const TOTP_SECRET = process.env.COCOS_TOTP     || '';

// ── TOTP (RFC 6238) ──
function generateTOTP(secret) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0, bytes = [];
  for (const c of secret.toUpperCase().replace(/=+$/, '')) {
    const idx = alpha.indexOf(c);
    if (idx < 0) continue;
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((val >> bits) & 0xFF); }
  }
  const key = Buffer.from(bytes);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset + 1] << 16 | hmac[offset + 2] << 8 | hmac[offset + 3]) % 1000000;
  return String(code).padStart(6, '0');
}

// ── HTTP helper ──
async function req(method, path, body = null, token = null, params = '') {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${token || SUPABASE_ANON_KEY}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:91.0) Gecko/20100101 Firefox/91.0',
  };
  const url = `${BASE_URL}/${path}${params ? '?' + params : ''}`;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.substring(0, 300) }; }
  return { status: res.status, ok: res.ok, data };
}

// ── Paso 1: Login con email/password ──
async function login() {
  console.log('\n=== PASO 1: Login email/password ===');
  const r = await req('POST', 'auth/v1/token', {
    email: EMAIL,
    password: PASSWORD,
    gotrue_meta_security: {},
  }, null, 'grant_type=password');

  console.log('Status:', r.status);
  if (!r.data.access_token) {
    console.log('❌ Sin access_token:', JSON.stringify(r.data).substring(0, 300));
    return null;
  }
  console.log('✅ access_token obtenido');
  return r.data.access_token;
}

// ── Paso 2: Obtener factor 2FA ──
async function get2FAFactor(accessToken) {
  console.log('\n=== PASO 2: Obtener factor 2FA ===');
  const r = await req('GET', 'auth/v1/factors/default', null, accessToken);
  console.log('Status:', r.status);
  console.log('Respuesta:', JSON.stringify(r.data).substring(0, 200));
  if (r.data.id) {
    console.log('✅ Factor ID:', r.data.id);
    return r.data.id;
  }
  return null;
}

// ── Paso 3: Challenge ──
async function challenge(accessToken, factorId) {
  console.log('\n=== PASO 3: Challenge ===');
  const r = await req('POST', `auth/v1/factors/${factorId}/challenge`, {
    expires_at: 123,
    id: factorId,
  }, accessToken);
  console.log('Status:', r.status);
  console.log('Respuesta:', JSON.stringify(r.data).substring(0, 200));
  return r.ok;
}

// ── Paso 4: Verify TOTP ──
async function verifyTOTP(accessToken, factorId) {
  const code = generateTOTP(TOTP_SECRET);
  console.log(`\n=== PASO 4: Verify TOTP (código: ${code}) ===`);
  const r = await req('POST', `auth/v1/factors/${factorId}/verify`, {
    challenge_id: '_',
    code,
  }, accessToken);
  console.log('Status:', r.status);
  if (r.data.access_token) {
    console.log('✅ 2FA OK! Nuevo access_token obtenido');
    return r.data.access_token;
  }
  console.log('Respuesta:', JSON.stringify(r.data).substring(0, 300));
  return null;
}

// ── Paso 5: Cartera y saldo ──
async function testPortfolio(accessToken) {
  console.log('\n=== PASO 5: Portfolio y saldo ===');
  const portfolio = await req('GET', 'api/v1/wallet/portfolio', null, accessToken);
  console.log('Portfolio status:', portfolio.status);
  if (portfolio.ok) {
    const d = portfolio.data;
    console.log('✅ Portfolio OK! Keys:', Object.keys(d));
    if (d.positions) console.log('Posiciones:', d.positions.length);
  } else {
    console.log('Respuesta:', JSON.stringify(portfolio.data).substring(0, 300));
  }

  const funds = await req('GET', 'api/v2/orders/buying-power', null, accessToken);
  console.log('\nBuying power status:', funds.status);
  if (funds.ok) console.log('✅ Buying power:', JSON.stringify(funds.data).substring(0, 200));

  const market = await req('GET', 'api/v1/calendar/open-market', null, accessToken);
  console.log('\nMercado abierto status:', market.status);
  if (market.ok) console.log('✅ Market status:', JSON.stringify(market.data).substring(0, 200));
}

// ── Main ──
(async () => {
  console.log('Email:', EMAIL || '❌ NO configurado');
  console.log('TOTP:', TOTP_SECRET ? '✅' : '❌ NO configurado');

  try {
    let token = await login();
    if (!token) return process.exit(1);

    const factorId = await get2FAFactor(token);
    if (factorId) {
      await challenge(token, factorId);
      const newToken = await verifyTOTP(token, factorId);
      if (newToken) token = newToken;
    } else {
      console.log('ℹ️  Sin 2FA requerido o ya autenticado');
    }

    await testPortfolio(token);
  } catch (e) {
    console.log('❌ Error inesperado:', e.message);
  }

  console.log('\n=== FIN ===');
  process.exit(0);
})();
