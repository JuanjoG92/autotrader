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

let _reloginAttempted = false; // evitar loops de relogin

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
    'Origin':        'https://app.cocos.capital',
    'Referer':       'https://app.cocos.capital/',
  };

  const res = await fetch(`${BASE_URL}/${path}`, {
    method, headers: hdrs,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.substring(0, 500) }; }

  if (!res.ok) {
    const msg = data?.message || data?.error || `HTTP ${res.status}`;

    // Auto-relogin si Cocos pide MFA upgrade o JWT expirado
    const needsRelogin = (res.status === 401 || res.status === 403) &&
      (msg.includes('ssurance') || msg.includes('upgrade') || msg.includes('jwt expired'));

    if (needsRelogin && !_reloginAttempted && !tokenOverride) {
      _reloginAttempted = true;
      console.log(`[Cocos] ${msg} — intentando re-login automático...`);
      try {
        await _fullLogin();
        _reloginAttempted = false;
        // Reintentar la llamada original con el nuevo token
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

// ── Full Login (fallback) ─────────────────────────────────────────────────────

// Helper: fetch seguro que detecta Cloudflare challenges y reintenta
async function _safeFetch(url, opts, retries = 4) {
  for (let i = 0; i <= retries; i++) {
    const res = await fetch(url, opts);
    const ct = res.headers.get('content-type') || '';
    // Cloudflare devuelve HTML en vez de JSON
    if (ct.includes('text/html') || (!ct.includes('json') && res.status === 403)) {
      if (i < retries) {
        const wait = 5000 + i * 8000; // 5s, 13s, 21s, 29s
        console.warn(`[Cocos] Cloudflare challenge (intento ${i+1}/${retries+1}), esperando ${Math.round(wait/1000)}s...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw new Error('Cloudflare bloqueó la request tras ' + (retries+1) + ' intentos');
    }
    return res;
  }
}

async function _fullLogin() {
  const email    = process.env.COCOS_EMAIL;
  const password = process.env.COCOS_PASSWORD;
  const totpSec  = process.env.COCOS_TOTP;

  if (!email || !password || !totpSec) {
    throw new Error('Faltan COCOS_EMAIL, COCOS_PASSWORD o COCOS_TOTP en .env');
  }

  if (_loginInProgress) {
    throw new Error('Login ya en curso, esperando...');
  }
  _loginInProgress = true;

  try {
    console.log('[Cocos] Iniciando full-login con email+password+TOTP...');

    const authHeaders = {
      'Content-Type':  'application/json',
      'apikey':        ANON_KEY,
      'Authorization': `Bearer ${ANON_KEY}`,
      'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept':        'application/json',
      'Origin':        'https://app.cocos.capital',
      'Referer':       'https://app.cocos.capital/',
    };

    // Paso 1: Login con email + password
    const loginRes = await _safeFetch(`${BASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ email, password }),
    });

    const loginData = await loginRes.json();

    if (!loginData.access_token) {
      throw new Error('Login falló: ' + JSON.stringify(loginData).substring(0, 300));
    }

    // Paso 2: Verificar si necesita MFA (aal2)
    // Supabase devuelve access_token aal1 + user.factors con los factores MFA
    const factors = loginData.user?.factors || loginData.mfa?.factors || [];
    const totpFactor = factors.find(f => f.factor_type === 'totp' && f.status === 'verified');

    if (!totpFactor) {
      // Sin factor MFA — login directo (aal1 suficiente)
      console.log('[Cocos] Login sin MFA (aal1)');
      const accountId = parseInt(process.env.COCOS_ACCOUNT_ID || '1391716');
      _saveSession(loginData.access_token, loginData.refresh_token, loginData.expires_at, accountId);
      _ready = true;
      console.log('[Cocos] ✅ Full-login exitoso —', new Date().toLocaleString('es-AR'));
      return loginData.access_token;
    }

    console.log('[Cocos] MFA requerido (aal1→aal2), factor:', totpFactor.id);

    // Paso 3: Challenge — usar el access_token aal1 para autenticarse
    const mfaHeaders = { ...authHeaders, 'Authorization': `Bearer ${loginData.access_token}` };
    const challengeRes = await _safeFetch(`${BASE_URL}/auth/v1/factors/${totpFactor.id}/challenge`, {
      method: 'POST',
      headers: mfaHeaders,
    });

    const challengeData = await challengeRes.json();
    const challengeId = challengeData.id;
    if (!challengeId) {
      throw new Error('Challenge sin ID: ' + JSON.stringify(challengeData).substring(0, 300));
    }

    console.log('[Cocos] Challenge recibido:', challengeId);

    // Paso 4: Generar TOTP y verificar
    const totpCode = _generateTOTP(totpSec);
    console.log('[Cocos] TOTP generado (6 dígitos)');

    const verifyRes = await _safeFetch(`${BASE_URL}/auth/v1/factors/${totpFactor.id}/verify`, {
      method: 'POST',
      headers: mfaHeaders,
      body: JSON.stringify({ challenge_id: challengeId, code: totpCode }),
    });

    const verifyData = await verifyRes.json();

    if (!verifyData.access_token) {
      throw new Error('Verify MFA falló: ' + JSON.stringify(verifyData).substring(0, 300));
    }

    const accountId = parseInt(process.env.COCOS_ACCOUNT_ID || '1391716');
    _saveSession(verifyData.access_token, verifyData.refresh_token, verifyData.expires_at, accountId);
    _ready = true;
    console.log('[Cocos] ✅ Full-login con MFA (aal2) exitoso —', new Date().toLocaleString('es-AR'));
    return verifyData.access_token;

  } finally {
    _loginInProgress = false;
  }
}

// ── Token refresh ─────────────────────────────────────────────────────────────

async function _refresh() {
  if (!_session.refreshToken) throw new Error('Sin refresh token');

  const res = await _safeFetch(`${BASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        ANON_KEY,
      'Authorization': `Bearer ${ANON_KEY}`,
      'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept':        'application/json',
      'Origin':        'https://app.cocos.capital',
      'Referer':       'https://app.cocos.capital/',
    },
    body: JSON.stringify({ refresh_token: _session.refreshToken }),
  });

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
      console.error('[Cocos] Error auto-refresh:', e.message);
      console.log('[Cocos] Intentando full-login como fallback...');
      try {
        await _fullLogin();
        console.log('[Cocos] ✅ Recuperado via full-login');
      } catch (e2) {
        console.error('[Cocos] ❌ Full-login también falló:', e2.message);
        _ready = false;
      }
    }
  }, REFRESH_MS);
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  // 1. Intentar cargar desde DB
  let loaded = _loadSession();

  // 2. Si no hay en DB, migrar desde .env (primer arranque)
  if (!loaded && process.env.COCOS_REFRESH_TOKEN) {
    console.log('[Cocos] Migrando tokens desde .env a DB...');
    const accessToken  = process.env.COCOS_ACCESS_TOKEN  || '';
    const refreshToken = process.env.COCOS_REFRESH_TOKEN;
    const accountId    = parseInt(process.env.COCOS_ACCOUNT_ID || '1391716');
    const expiresAt    = Math.floor(Date.now() / 1000) + 3600;
    _saveSession(accessToken, refreshToken, expiresAt, accountId);
    loaded = true;
  }

  if (!loaded) {
    // Sin sesión previa — intentar full-login directo
    if (process.env.COCOS_EMAIL && process.env.COCOS_PASSWORD && process.env.COCOS_TOTP) {
      console.log('[Cocos] Sin sesión previa, intentando full-login...');
      try {
        await _fullLogin();
        _startTimer();
        console.log('[Cocos] Servicio activo. Account ID:', _session.accountId);
        return;
      } catch (e) {
        console.error('[Cocos] Full-login falló:', e.message);
      }
    }
    console.warn('[Cocos] Sin credenciales. Actualiza tokens desde el panel admin.');
    return;
  }

  // 3. Refresh inmediato para obtener token fresco
  try {
    await _refresh();
  } catch (e) {
    console.error('[Cocos] Error en refresh inicial:', e.message);
    // Fallback: full-login con email+password+TOTP
    console.log('[Cocos] Intentando full-login como fallback...');
    try {
      await _fullLogin();
      console.log('[Cocos] ✅ Recuperado via full-login');
    } catch (e2) {
      console.error('[Cocos] Full-login falló:', e2.message);
      // Último recurso: usar token existente si no expiró
      const now = Math.floor(Date.now() / 1000);
      if (_session.expiresAt > now + 60) {
        _ready = true;
        console.warn('[Cocos] Usando token almacenado (expira en', Math.round((_session.expiresAt - now) / 60), 'min)');
      }
    }
  }

  _startTimer();

  // Siempre programar reintentos si no se logró MFA completo
  _scheduleReloginIfNeeded();

  console.log('[Cocos] Servicio activo. Account ID:', _session.accountId);
}

// Intenta fullLogin cada 5 min en background hasta tener aal2
let _reloginRetryTimer = null;
function _scheduleReloginIfNeeded() {
  if (_reloginRetryTimer) return;
  _reloginRetryTimer = setInterval(async () => {
    if (!_ready) return;
    try {
      // Testear si tenemos aal2 intentando un endpoint financiero
      await _call('GET', 'api/v2/orders/buying-power');
      console.log('[Cocos] ✅ Token aal2 confirmado — deteniendo reintentos');
      clearInterval(_reloginRetryTimer);
      _reloginRetryTimer = null;
    } catch (e) {
      if (e.message?.includes('ssurance') || e.message?.includes('upgrade')) {
        console.log('[Cocos] Token aal1 detectado, intentando upgrade via fullLogin...');
        try {
          await _fullLogin();
          console.log('[Cocos] ✅ Upgrade a aal2 exitoso');
          clearInterval(_reloginRetryTimer);
          _reloginRetryTimer = null;
        } catch (e2) {
          console.warn('[Cocos] Reintento fullLogin pendiente:', e2.message);
        }
      }
    }
  }, 5 * 60 * 1000); // cada 5 min
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
    console.log('[Cocos] forceRefresh falló, intentando full-login...');
    const token = await _fullLogin();
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
