// src/services/cocos.js
// Cocos Capital — gestión de tokens + API completa
// Auto-refresh cada 45 min. Tokens encriptados en SQLite.
// Full-login automático con email+password+TOTP como fallback.

const crypto = require('crypto');
const { getDB } = require('../models/db');
const { encrypt, decrypt } = require('./encryption');

const BASE_URL  = 'https://api.cocos.capital';
const ANON_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.ewogICJyb2xlIjogImFub24iLAogICJpc3MiOiAic3VwYWJhc2UiLAogICJpYXQiOiAxNzA0NjgyODAwLAogICJleHAiOiAxODYyNTM1NjAwCn0.f0w62k0q0eyyGBDkAP7vUUEg_Ingb9YbOlhsGCC4R3c';
const REFRESH_MS = 45 * 60 * 1000; // 45 minutos

// Mapa de plazos a código BYMA
const SETTLEMENT_MAP = { 'CI': '0001', '24hs': '0002', '48hs': '0003' };
const CURRENCY_MAP   = { 'ARS': 'ARS', 'USD': 'USD', 'EXT': 'EXT' };

let _session = { accessToken: null, refreshToken: null, expiresAt: 0, accountId: 0 };
let _cfCookies = ''; // cookies de Cloudflare extraídas del browser
let _timer = null;
let _ready = false;
let _loginInProgress = false;

// ── DB ──────────────────────────────────────────────────────────────────────

function _loadSession() {
  try {
    const row = getDB().prepare('SELECT * FROM cocos_sessions WHERE id = 1').get();
    if (!row) return false;
    _session.accessToken  = decrypt(row.access_token_enc);
    _session.refreshToken = decrypt(row.refresh_token_enc);
    _session.expiresAt    = row.expires_at;
    _session.accountId    = row.account_id;
    return true;
  } catch { return false; }
}

function _saveSession(access, refresh, expiresAt, accountId) {
  const db = getDB();
  db.prepare(`
    INSERT INTO cocos_sessions (id, access_token_enc, refresh_token_enc, account_id, expires_at, updated_at)
    VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      access_token_enc  = excluded.access_token_enc,
      refresh_token_enc = excluded.refresh_token_enc,
      account_id        = excluded.account_id,
      expires_at        = excluded.expires_at,
      updated_at        = CURRENT_TIMESTAMP
  `).run(encrypt(access), encrypt(refresh), accountId || _session.accountId, expiresAt);
  _session.accessToken  = access;
  _session.refreshToken = refresh;
  _session.expiresAt    = expiresAt;
  if (accountId) _session.accountId = accountId;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

let _reloginAttempted = false;

async function _call(method, path, body, tokenOverride) {
  const token = tokenOverride || _session.accessToken;
  if (!token) throw new Error('Sin sesión Cocos activa');

  const hdrs = {
    'Content-Type':  'application/json',
    'apikey':        ANON_KEY,
    'Authorization': `Bearer ${token}`,
    'x-account-id':  String(_session.accountId),
    'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept':        'application/json',
  };
  if (_cfCookies) hdrs['Cookie'] = _cfCookies;

  const res = await fetch(`${BASE_URL}/${path}`, {
    method, headers: hdrs,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.substring(0, 500) }; }

  if (!res.ok) {
    const msg = data?.message || data?.error || `HTTP ${res.status}`;

    // Si Cocos pide MFA upgrade o JWT expiró → browser login automático
    const needsRelogin = (res.status === 401 || res.status === 403) &&
      (msg.includes('ssurance') || msg.includes('upgrade') || msg.includes('jwt expired'));

    if (needsRelogin && !_reloginAttempted && !tokenOverride) {
      _reloginAttempted = true;
      console.log(`[Cocos] ${msg} — re-login con browser...`);
      try {
        await _browserLogin();
        _reloginAttempted = false;
        return _call(method, path, body);
      } catch (e) {
        _reloginAttempted = false;
        console.error('[Cocos] Re-login falló:', e.message);
      }
    }
    _reloginAttempted = false;

    const err = new Error(`Cocos: ${msg}`);
    err.status = res.status;
    throw err;
  }
  _reloginAttempted = false;
  return data;
}

// ── TOTP ──────────────────────────────────────────────────────────────────────

function _generateTOTP(secret) {
  const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleanSecret = secret.replace(/[\s=-]+/g, '').toUpperCase();
  let bits = '';
  for (const c of cleanSecret) {
    const val = base32Chars.indexOf(c);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const keyBytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    keyBytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  const key = Buffer.from(keyBytes);
  const epoch = Math.floor(Date.now() / 1000);
  const counter = Math.floor(epoch / 30);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset + 1] << 16 | hmac[offset + 2] << 8 | hmac[offset + 3]) % 1000000;
  return code.toString().padStart(6, '0');
}

// ── Browser Login (Puppeteer — bypassa Cloudflare) ────────────────────────────

async function _browserLogin() {
  const email    = process.env.COCOS_EMAIL;
  const password = process.env.COCOS_PASSWORD;
  const totpSec  = process.env.COCOS_TOTP;
  if (!email || !password || !totpSec) throw new Error('Faltan COCOS_EMAIL/PASSWORD/TOTP en .env');
  if (_loginInProgress) throw new Error('Login en curso');
  _loginInProgress = true;

  let browser;
  try {
    const puppeteer = require('puppeteer');
    console.log('[Cocos] Lanzando Chrome headless para login...');
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

    // 1. Navegar al dominio API para resolver Cloudflare
    console.log('[Cocos] Resolviendo Cloudflare...');
    await page.goto(BASE_URL, { waitUntil: 'networkidle0', timeout: 60000 });

    // 2. Login email + password (desde el contexto del browser, CF ya resuelto)
    console.log('[Cocos] Enviando credenciales...');
    const loginData = await page.evaluate(async (e, p, ak, bu) => {
      try {
        const r = await fetch(bu + '/auth/v1/token?grant_type=password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': ak, 'Authorization': 'Bearer ' + ak },
          body: JSON.stringify({ email: e, password: p }),
        });
        return await r.json();
      } catch (err) { return { error: err.message }; }
    }, email, password, ANON_KEY, BASE_URL);

    if (loginData.error || !loginData.access_token) {
      throw new Error('Login falló: ' + JSON.stringify(loginData).substring(0, 300));
    }
    console.log('[Cocos] Login OK (aal1)');

    // 3. Verificar si necesita MFA
    const factors = loginData.user?.factors || [];
    const totpFactor = factors.find(f => f.factor_type === 'totp' && f.status === 'verified');
    const accountId = parseInt(process.env.COCOS_ACCOUNT_ID || '1391716');

    if (!totpFactor) {
      const cookies = await page.cookies();
      _cfCookies = cookies.map(c => c.name + '=' + c.value).join('; ');
      _saveSession(loginData.access_token, loginData.refresh_token, loginData.expires_at, accountId);
      _ready = true;
      console.log('[Cocos] ✅ Login exitoso (sin MFA) —', new Date().toLocaleString('es-AR'));
      return loginData.access_token;
    }

    // 4. MFA Challenge + Verify
    console.log('[Cocos] MFA requerido → challenge + TOTP...');
    const totpCode = _generateTOTP(totpSec);

    const verifyData = await page.evaluate(async (fid, at, code, ak, bu) => {
      try {
        // Challenge
        const cr = await fetch(bu + '/auth/v1/factors/' + fid + '/challenge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': ak, 'Authorization': 'Bearer ' + at },
        });
        const cd = await cr.json();
        if (!cd.id) return { error: 'Challenge falló: ' + JSON.stringify(cd) };

        // Verify
        const vr = await fetch(bu + '/auth/v1/factors/' + fid + '/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': ak, 'Authorization': 'Bearer ' + at },
          body: JSON.stringify({ challenge_id: cd.id, code: code }),
        });
        return await vr.json();
      } catch (err) { return { error: err.message }; }
    }, totpFactor.id, loginData.access_token, totpCode, ANON_KEY, BASE_URL);

    if (verifyData.error || !verifyData.access_token) {
      throw new Error('MFA falló: ' + JSON.stringify(verifyData).substring(0, 300));
    }

    // Extraer cookies CF para usarlas en fetch regular
    const cookies = await page.cookies();
    _cfCookies = cookies.map(c => c.name + '=' + c.value).join('; ');
    console.log('[Cocos] Cookies CF capturadas (' + cookies.length + ')');

    _saveSession(verifyData.access_token, verifyData.refresh_token, verifyData.expires_at, accountId);
    _ready = true;
    console.log('[Cocos] ✅ Login con MFA (aal2) exitoso —', new Date().toLocaleString('es-AR'));
    return verifyData.access_token;

  } finally {
    _loginInProgress = false;
    if (browser) try { await browser.close(); } catch {}
  }
}

// ── Token refresh ─────────────────────────────────────────────────────────────

async function _refresh() {
  if (!_session.refreshToken) throw new Error('Sin refresh token');

  const res = await fetch(`${BASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        ANON_KEY,
      'Authorization': `Bearer ${ANON_KEY}`,
    },
    body: JSON.stringify({ refresh_token: _session.refreshToken }),
  });

  // Cloudflare devuelve HTML → necesitamos browser login
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/html') || res.status === 403) {
    throw new Error('Cloudflare bloqueó refresh — se usará browser login');
  }

  const data = await res.json();
  if (!data.access_token) throw new Error('Refresh inválido: ' + JSON.stringify(data));

  _saveSession(data.access_token, data.refresh_token, data.expires_at);
  _ready = true;
  console.log('[Cocos] Token renovado —', new Date().toLocaleString('es-AR'));
  return data.access_token;
}

function _startTimer() {
  if (_timer) clearInterval(_timer);
  _timer = setInterval(async () => {
    try {
      await _refresh();
    } catch (e) {
      console.warn('[Cocos] Refresh falló:', e.message);
      try {
        await _browserLogin();
        console.log('[Cocos] ✅ Recuperado via browser login');
      } catch (e2) {
        console.error('[Cocos] ❌ Browser login falló:', e2.message);
        _ready = false;
      }
    }
  }, REFRESH_MS);
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  let loaded = _loadSession();

  if (!loaded && process.env.COCOS_REFRESH_TOKEN) {
    const accessToken  = process.env.COCOS_ACCESS_TOKEN  || '';
    const refreshToken = process.env.COCOS_REFRESH_TOKEN;
    const accountId    = parseInt(process.env.COCOS_ACCOUNT_ID || '1391716');
    _saveSession(accessToken, refreshToken, Math.floor(Date.now() / 1000) + 3600, accountId);
    loaded = true;
  }

  // Intentar refresh rápido primero (si tenemos tokens)
  if (loaded) {
    try {
      await _refresh();
      _startTimer();
      console.log('[Cocos] Servicio activo. Account ID:', _session.accountId);
      return;
    } catch (e) {
      console.warn('[Cocos] Refresh falló:', e.message);
    }
  }

  // Fallback: browser login (siempre funciona, bypassa Cloudflare)
  if (process.env.COCOS_EMAIL && process.env.COCOS_PASSWORD && process.env.COCOS_TOTP) {
    try {
      await _browserLogin();
      _startTimer();
      console.log('[Cocos] Servicio activo. Account ID:', _session.accountId);
      return;
    } catch (e) {
      console.error('[Cocos] Browser login falló:', e.message);
    }
  }

  // Último recurso: token existente si no expiró
  if (loaded) {
    const now = Math.floor(Date.now() / 1000);
    if (_session.expiresAt > now + 60) {
      _ready = true;
      _startTimer();
      console.warn('[Cocos] Usando token almacenado (expira en', Math.round((_session.expiresAt - now) / 60), 'min)');
      console.log('[Cocos] Servicio activo. Account ID:', _session.accountId);
      return;
    }
  }

  console.warn('[Cocos] Sin sesión activa. Configurar credenciales en .env');
}

// ── Helpers de mercado

function buildLongTicker(ticker, settlement, currency, segment) {
  const s = SETTLEMENT_MAP[settlement] || '0002';
  const c = CURRENCY_MAP[currency]     || 'ARS';
  const seg = segment || 'C';
  return `${ticker.toUpperCase()}-${s}-${seg}-CT-${c}`;
}

// ── API pública ───────────────────────────────────────────────────────────────

function isReady() { return _ready; }

function getSessionInfo() {
  const now = Math.floor(Date.now() / 1000);
  const minLeft = _session.expiresAt ? Math.round((_session.expiresAt - now) / 60) : 0;
  return {
    connected: _ready,
    accountId: _session.accountId,
    tokenExpiresIn: minLeft + ' min',
    nextRefresh: REFRESH_MS / 60000 + ' min (auto)',
  };
}

async function forceRefresh() {
  try {
    const token = await _refresh();
    _startTimer();
    return token;
  } catch (e) {
    console.log('[Cocos] forceRefresh falló, usando browser login...');
    const token = await _browserLogin();
    _startTimer();
    return token;
  }
}

// Actualización manual de tokens (desde browser o admin)
async function updateTokens(accessToken, refreshToken, accountId) {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  _saveSession(accessToken, refreshToken, expiresAt, accountId || _session.accountId);
  _ready = true;
  _startTimer();
  console.log('[Cocos] Tokens actualizados manualmente');
}

// ── Mercado ───────────────────────────────────────────────────────────────────

async function getMarketStatus() {
  return _call('GET', 'api/v1/calendar/open-market');
}

async function getDolarMEP() {
  return _call('GET', 'api/v1/markets/dolar-mep');
}

async function searchTicker(q) {
  return _call('GET', `api/v1/markets/tickers/search?q=${encodeURIComponent(q)}`);
}

async function getQuote(ticker, segment) {
  // La API acepta solo el ticker simple y devuelve ARRAY con todos los plazos/monedas
  const simpleTicker = ticker.includes('-') ? ticker.split('-')[0] : ticker;
  const results = await _call('GET', `api/v1/markets/tickers/${encodeURIComponent(simpleTicker)}?segment=${segment || 'C'}`);
  if (Array.isArray(results)) {
    // Prioridad: 24hs (0002) + ARS
    return results.find(r => r.long_ticker?.includes('-0002-') && r.long_ticker?.endsWith('-ARS'))
        || results.find(r => r.long_ticker?.endsWith('-ARS'))
        || results.find(r => r.long_ticker?.includes('-0002-'))
        || results[0] || {};
  }
  return results;
}

async function getMarketList(type, subtype, settlement, currency, segment, page, size) {
  // getMarketList con pagination no funciona en la API actual de Cocos
  // Usar getQuote individual por ticker como alternativa
  const s   = SETTLEMENT_MAP[settlement] || '0002';
  const c   = CURRENCY_MAP[currency]     || 'ARS';
  const seg = segment || 'C';
  const pg  = page    || 1;
  const sz  = Math.min(size || 50, 50);
  return _call('GET', `api/v1/markets/tickers/?instrument_type=${type}&instrument_subtype=${subtype}&settlement_days=${s}&currency=${c}&segment=${seg}&page=${pg}&size=${sz}`);
}

// ── Cuenta ────────────────────────────────────────────────────────────────────

async function getMyData() {
  return _call('GET', 'api/v1/users/me');
}

async function getPortfolio() {
  return _call('GET', 'api/v1/wallet/portfolio');
}

async function getBuyingPower() {
  return _call('GET', 'api/v2/orders/buying-power');
}

async function getPerformance(type) {
  if (type === 'historic') return _call('GET', 'api/v1/wallet/performance/historic');
  return _call('GET', 'api/v1/wallet/performance/daily');
}

async function getOrders() {
  return _call('GET', 'api/v2/orders');
}

async function getOrderStatus(orderId) {
  return _call('GET', `api/v2/orders/${encodeURIComponent(orderId)}`);
}

async function getSellingPower(longTicker) {
  return _call('GET', `api/v2/orders/selling-power/?long_ticker=${encodeURIComponent(longTicker)}`);
}

// ── Órdenes ───────────────────────────────────────────────────────────────────

async function placeBuyOrder(ticker, quantity, price, settlement, currency, segment) {
  const longTicker = buildLongTicker(ticker, settlement || '24hs', currency || 'ARS', segment || 'C');
  return _call('POST', 'api/v2/orders', {
    long_ticker: longTicker,
    side:        'BUY',
    type:        'LIMIT',
    quantity:    String(quantity),
    price:       String(price),
  });
}

async function placeSellOrder(ticker, quantity, price, settlement, currency, segment) {
  const longTicker = buildLongTicker(ticker, settlement || '24hs', currency || 'ARS', segment || 'C');
  return _call('POST', 'api/v2/orders', {
    long_ticker: longTicker,
    side:        'SELL',
    type:        'LIMIT',
    quantity:    String(quantity),
    price:       String(price),
  });
}

async function placeOrderByLongTicker(longTicker, side, quantity, price) {
  return _call('POST', 'api/v2/orders', {
    long_ticker: longTicker,
    side:        side.toUpperCase(),
    type:        'LIMIT',
    quantity:    String(quantity),
    price:       String(price),
  });
}

async function cancelOrder(orderId) {
  return _call('DELETE', `api/v2/orders/${encodeURIComponent(orderId)}`);
}

module.exports = {
  init,
  isReady,
  getSessionInfo,
  forceRefresh,
  updateTokens,
  buildLongTicker,
  // Mercado
  getMarketStatus,
  getDolarMEP,
  searchTicker,
  getQuote,
  getMarketList,
  // Cuenta
  getMyData,
  getPortfolio,
  getBuyingPower,
  getPerformance,
  getOrders,
  getOrderStatus,
  getSellingPower,
  // Órdenes (solo owner)
  placeBuyOrder,
  placeSellOrder,
  placeOrderByLongTicker,
  cancelOrder,
};
