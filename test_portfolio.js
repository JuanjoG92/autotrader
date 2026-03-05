require('dotenv').config();
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.ewogICJyb2xlIjogImFub24iLAogICJpc3MiOiAic3VwYWJhc2UiLAogICJpYXQiOiAxNzA0NjgyODAwLAogICJleHAiOiAxODYyNTM1NjAwCn0.f0w62k0q0eyyGBDkAP7vUUEg_Ingb9YbOlhsGCC4R3c';

async function apiCall(method, path, body, token, accountId) {
  const headers = {
    'Content-Type': 'application/json',
    'apikey': ANON,
    'Authorization': `Bearer ${token}`,
    'x-account-id': accountId ? String(accountId) : undefined,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };
  if (!accountId) delete headers['x-account-id'];
  const res = await fetch(`https://api.cocos.capital/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch { return { status: res.status, raw: text.substring(0, 150) }; }
}

(async () => {
  // 1. Refresh primero
  console.log('Refreshing token...');
  const r = await apiCall('POST', 'auth/v1/token?grant_type=refresh_token',
    { refresh_token: process.env.COCOS_REFRESH_TOKEN }, ANON);
  if (!r.data || !r.data.access_token) {
    console.log('ERROR refresh:', r.status, JSON.stringify(r.data || r.raw));
    process.exit(1);
  }
  const token = r.data.access_token;
  const newRefresh = r.data.refresh_token;
  console.log('Token OK, nuevo refresh:', newRefresh);

  // 2. Guardar nuevo refresh en .env
  const fs = require('fs');
  let env = fs.readFileSync('.env', 'utf8');
  env = env.replace(/COCOS_REFRESH_TOKEN=.*/, `COCOS_REFRESH_TOKEN=${newRefresh}`);
  env = env.replace(/COCOS_ACCESS_TOKEN=.*/, `COCOS_ACCESS_TOKEN=${token}`);
  fs.writeFileSync('.env', env);
  console.log('Tokens guardados en .env\n');

  const urls = [
    'api/v1/wallet/portfolio',
    'api/v1/wallet/portfolio?settlement=48hs',
    'api/v1/wallet/performance/daily',
    'api/v2/wallet/portfolio',
  ];
  for (const u of urls) {
    const res = await apiCall('GET', u, null, token, 1391716);
    const body = res.data ? JSON.stringify(res.data).substring(0, 200) : res.raw;
    console.log(u, '->', res.status, body);
  }
  process.exit(0);
})();
