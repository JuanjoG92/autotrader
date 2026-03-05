// Test con token real del browser + refresh desde VPS
require('dotenv').config();

const BASE_URL = 'https://api.cocos.capital';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.ewogICJyb2xlIjogImFub24iLAogICJpc3MiOiAic3VwYWJhc2UiLAogICJpYXQiOiAxNzA0NjgyODAwLAogICJleHAiOiAxODYyNTM1NjAwCn0.f0w62k0q0eyyGBDkAP7vUUEg_Ingb9YbOlhsGCC4R3c';

async function apiCall(method, path, body, token, accountId) {
  const headers = {
    'Content-Type': 'application/json',
    'apikey': ANON_KEY,
    'Authorization': `Bearer ${token}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };
  if (accountId) headers['x-account-id'] = String(accountId);
  const res = await fetch(`${BASE_URL}/${path}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch { return { status: res.status, data: { raw: text.substring(0, 200) } }; }
}

(async () => {
  const accessToken  = process.env.COCOS_ACCESS_TOKEN;
  const refreshToken = process.env.COCOS_REFRESH_TOKEN;

  // ── Test 1: Refresh token desde VPS ──
  console.log('=== TEST 1: Refresh token desde VPS ===');
  const r = await apiCall('POST', 'auth/v1/token?grant_type=refresh_token',
    { refresh_token: refreshToken }, ANON_KEY);
  console.log('Status:', r.status);
  let token = accessToken;
  if (r.data.access_token) {
    console.log('✅ REFRESH OK! Token renovado automaticamente desde VPS');
    token = r.data.access_token;
  } else {
    console.log('⚠️  Refresh falló:', JSON.stringify(r.data).substring(0, 200));
    console.log('Usando token del browser...');
  }

  // ── Test 2: Obtener Account ID ──
  console.log('\n=== TEST 2: Obtener Account ID ===');
  const me = await apiCall('GET', 'api/v1/users/me', null, token);
  console.log('Status:', me.status);
  let accountId = null;
  if (me.status === 200 && me.data.id_accounts) {
    accountId = me.data.id_accounts[0];
    console.log('✅ Account ID:', accountId);
    console.log('Nombre:', me.data.first_name, me.data.last_name);
  } else {
    console.log('Respuesta:', JSON.stringify(me.data).substring(0, 300));
  }

  // ── Test 3: Portfolio ──
  console.log('\n=== TEST 3: Portfolio ===');
  const p = await apiCall('GET', 'api/v1/wallet/portfolio', null, token, accountId);
  console.log('Status:', p.status);
  if (p.status === 200) {
    console.log('✅ PORTFOLIO OK!');
    if (p.data.positions) {
      console.log('Posiciones:', p.data.positions.length);
      p.data.positions.slice(0, 5).forEach(pos => {
        console.log(' -', pos.ticker || pos.instrument_code, '| cant:', pos.quantity, '| precio:', pos.last_price);
      });
    }
    if (p.data.total_value !== undefined) console.log('Valor total:', p.data.total_value);
  } else {
    console.log('Respuesta:', JSON.stringify(p.data).substring(0, 300));
  }

  // ── Test 4: Fondos disponibles ──
  console.log('\n=== TEST 4: Buying power ===');
  const f = await apiCall('GET', 'api/v2/orders/buying-power', null, token, accountId);
  console.log('Status:', f.status);
  if (f.status === 200) console.log('✅ BUYING POWER:', JSON.stringify(f.data).substring(0, 300));
  else console.log('Respuesta:', JSON.stringify(f.data).substring(0, 200));

  // ── Test 5: Mercado ──
  console.log('\n=== TEST 5: Estado del mercado ===');
  const m = await apiCall('GET', 'api/v1/calendar/open-market', null, token, accountId);
  if (m.status === 200) console.log('✅ MERCADO:', JSON.stringify(m.data));
  else console.log('Respuesta:', JSON.stringify(m.data).substring(0, 200));

  process.exit(0);
})();
