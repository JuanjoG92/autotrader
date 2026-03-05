// src/services/cocos.js
// Cocos Capital — gestión de tokens + API completa
// Auto-refresh cada 45 min. Tokens encriptados en SQLite.

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

async function _call(method, path, body, tokenOverride) {
  const token = tokenOverride || _session.accessToken;
  if (!token) throw new Error('Sin sesión Cocos activa');

  const res = await fetch(`${BASE_URL}/${path}`, {
    method,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        ANON_KEY,
      'Authorization': `Bearer ${token}`,
      'x-account-id':  String(_session.accountId),
      'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.substring(0, 500) }; }

  if (!res.ok) {
    const msg = data?.message || data?.error || `HTTP ${res.status}`;
    const err = new Error(`Cocos: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return data;
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
      'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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
    try { await _refresh(); }
    catch (e) { console.error('[Cocos] Error auto-refresh:', e.message); }
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
    console.warn('[Cocos] Sin credenciales. Actualiza tokens desde el panel admin.');
    return;
  }

  // 3. Refresh inmediato para obtener token fresco
  try {
    await _refresh();
  } catch (e) {
    console.error('[Cocos] Error en refresh inicial:', e.message);
    // Usar token existente si no expiró
    const now = Math.floor(Date.now() / 1000);
    if (_session.expiresAt > now + 60) {
      _ready = true;
      console.warn('[Cocos] Usando token almacenado (expira en', Math.round((_session.expiresAt - now) / 60), 'min)');
    }
  }

  _startTimer();
  console.log('[Cocos] Servicio activo. Account ID:', _session.accountId);
}

// ── Helpers de mercado ────────────────────────────────────────────────────────

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
  const token = await _refresh();
  _startTimer();
  return token;
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
  // Primero intentar con el ticker simple (sin long format)
  const simpleTicker = ticker.includes('-') ? ticker.split('-')[0] : ticker;
  try {
    return await _call('GET', `api/v1/markets/tickers/${encodeURIComponent(simpleTicker)}?segment=${segment || 'C'}&settlement_days=0002&currency=ARS`);
  } catch {
    // Fallback con long ticker
    return await _call('GET', `api/v1/markets/tickers/${encodeURIComponent(ticker)}?segment=${segment || 'C'}`);
  }
}

async function getMarketList(type, subtype, settlement, currency, segment, page, size) {
  const s   = SETTLEMENT_MAP[settlement] || '0002';
  const c   = CURRENCY_MAP[currency]     || 'ARS';
  const seg = segment || 'C';
  const pg  = page    || 1;
  const sz  = Math.min(size || 50, 50); // Cocos max 50 por página

  // Intentar con subtype primero, si falla sin subtype
  try {
    return await _call('GET', `api/v1/markets/tickers/?instrument_type=${type}&instrument_subtype=${subtype}&settlement_days=${s}&currency=${c}&segment=${seg}&page=${pg}&size=${sz}`);
  } catch {
    return await _call('GET', `api/v1/markets/tickers/?instrument_type=${type}&settlement_days=${s}&currency=${c}&segment=${seg}&page=${pg}&size=${sz}`);
  }
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
