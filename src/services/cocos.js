// src/services/cocos.js
// Cocos Capital — Chrome headless persistente que bypassa Cloudflare.
// TODAS las llamadas API van por el browser (no fetch de Node.js).

const crypto = require('crypto');
const { getDB } = require('../models/db');
const { encrypt, decrypt } = require('./encryption');

const BASE_URL  = 'https://api.cocos.capital';
const ANON_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.ewogICJyb2xlIjogImFub24iLAogICJpc3MiOiAic3VwYWJhc2UiLAogICJpYXQiOiAxNzA0NjgyODAwLAogICJleHAiOiAxODYyNTM1NjAwCn0.f0w62k0q0eyyGBDkAP7vUUEg_Ingb9YbOlhsGCC4R3c';
const REFRESH_MS = 45 * 60 * 1000;

const SETTLEMENT_MAP = { 'CI': '0001', '24hs': '0002', '48hs': '0003' };
const CURRENCY_MAP   = { 'ARS': 'ARS', 'USD': 'USD', 'EXT': 'EXT' };

let _session = { accessToken: null, refreshToken: null, expiresAt: 0, accountId: 0 };
let _timer = null;
let _ready = false;
let _loginInProgress = false;

// ── Browser persistente (mutex + auto-recovery) ────────────────────────────
let _browser = null;
let _page = null;
let _browserLock = null;

function _killZombieChrome() {
  try {
    require('child_process').execSync(
      'pkill -f "chrome.*--headless" 2>/dev/null; pkill -f "chrome_crashpad" 2>/dev/null',
      { timeout: 5000, stdio: 'ignore' }
    );
  } catch {}
}

async function _ensureBrowser() {
  if (_page && _browser?.isConnected()) return _page;
  if (_browserLock) return _browserLock;
  _browserLock = _launchBrowser();
  try { return await _browserLock; }
  finally { _browserLock = null; }
}

async function _launchBrowser() {
  if (_browser) try { await _browser.close(); } catch {}
  _browser = null;
  _page = null;
  _killZombieChrome();

  const puppeteer = require('puppeteer');
  console.log('[Cocos] Iniciando Chrome headless...');
  _browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--no-first-run', '--disable-translate',
      '--js-flags=--max-old-space-size=256',
    ],
  });

  _page = await _browser.newPage();
  await _page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

  // Cerrar tabs extras que Puppeteer crea
  const pages = await _browser.pages();
  for (const p of pages) { if (p !== _page) await p.close().catch(() => {}); }

  // Navegar con retry para Cloudflare
  console.log('[Cocos] Resolviendo Cloudflare...');
  for (let i = 1; i <= 5; i++) {
    try {
      await _page.goto(BASE_URL, { waitUntil: 'networkidle0', timeout: 30000 });
      const html = await _page.content();
      if (html.includes('Just a moment') || html.includes('challenge-platform')) {
        const wait = 5000 + i * 3000;
        console.log(`[Cocos] Cloudflare challenge (intento ${i}/5), esperando ${Math.round(wait/1000)}s...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      console.log('[Cocos] Chrome listo');
      return _page;
    } catch (e) {
      if (i === 5) throw new Error('Cloudflare bloqueó tras 5 intentos');
      const wait = 5000 + i * 3000;
      console.log(`[Cocos] Cloudflare retry ${i}/5, esperando ${Math.round(wait/1000)}s...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw new Error('Cloudflare bloqueó la request tras 5 intentos');
}

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

// ── HTTP (todo va por el browser) ───────────────────────────────────────────

async function _call(method, path, body, _retried) {
  const token = _session.accessToken;
  if (!token) throw new Error('Sin sesión Cocos activa');

  let page;
  try {
    page = await _ensureBrowser();
  } catch (e) {
    if (!_retried) {
      console.warn('[Cocos] Browser no disponible, relanzando...');
      _browser = null; _page = null;
      return _call(method, path, body, true);
    }
    throw e;
  }

  let result;
  try {
    result = await page.evaluate(async (m, url, b, t, ak, aid) => {
      try {
        const r = await fetch(url, {
          method: m,
          headers: {
            'Content-Type': 'application/json',
            'apikey': ak,
            'Authorization': 'Bearer ' + t,
            'x-account-id': String(aid),
          },
          body: b ? JSON.stringify(b) : undefined,
        });
        const text = await r.text();
        let data;
        try { data = JSON.parse(text); } catch { data = { raw: text.substring(0, 300) }; }
        return { ok: r.ok, status: r.status, data };
      } catch (err) {
        return { ok: false, status: 0, data: { error: err.message } };
      }
    }, method, `${BASE_URL}/${path}`, body || null, token, ANON_KEY, _session.accountId);
  } catch (e) {
    if (!_retried) {
      console.warn('[Cocos] Browser crash, reintentando...', e.message.substring(0, 60));
      _browser = null; _page = null;
      return _call(method, path, body, true);
    }
    throw new Error('Browser crash: ' + e.message.substring(0, 100));
  }

  if (!result.ok) {
    const msg = result.data?.message || result.data?.error || `HTTP ${result.status}`;

    if (!_retried && (result.status === 401 || result.status === 403) &&
        (msg.includes('ssurance') || msg.includes('upgrade') || msg.includes('jwt expired'))) {
      console.log(`[Cocos] ${msg} — re-login automático...`);
      try {
        await _browserLogin();
        return _call(method, path, body, true);
      } catch (e) {
        console.error('[Cocos] Re-login falló:', e.message);
      }
    }

    const err = new Error(`Cocos: ${msg}`);
    err.status = result.status;
    throw err;
  }
  return result.data;
}

// ── TOTP ──────────────────────────────────────────────────────────────────────

function _generateTOTP(secret) {
  const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = secret.replace(/[\s=-]+/g, '').toUpperCase();
  let bits = '';
  for (const c of clean) { const v = base32Chars.indexOf(c); if (v >= 0) bits += v.toString(2).padStart(5, '0'); }
  const keyBytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) keyBytes.push(parseInt(bits.substring(i, i + 8), 2));
  const key = Buffer.from(keyBytes);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const cBuf = Buffer.alloc(8);
  cBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  cBuf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(cBuf).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[off] & 0x7f) << 24 | hmac[off + 1] << 16 | hmac[off + 2] << 8 | hmac[off + 3]) % 1000000;
  return code.toString().padStart(6, '0');
}

// ── Login via browser ─────────────────────────────────────────────────────────

async function _browserLogin() {
  const email    = process.env.COCOS_EMAIL;
  const password = process.env.COCOS_PASSWORD;
  const totpSec  = process.env.COCOS_TOTP;
  if (!email || !password || !totpSec) throw new Error('Faltan COCOS_EMAIL/PASSWORD/TOTP en .env');
  if (_loginInProgress) throw new Error('Login en curso');
  _loginInProgress = true;

  try {
    const page = await _ensureBrowser();

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

    const factors = loginData.user?.factors || [];
    const totpFactor = factors.find(f => f.factor_type === 'totp' && f.status === 'verified');
    const accountId = parseInt(process.env.COCOS_ACCOUNT_ID || '1391716');

    if (!totpFactor) {
      _saveSession(loginData.access_token, loginData.refresh_token, loginData.expires_at, accountId);
      _ready = true;
      console.log('[Cocos] ✅ Login exitoso (sin MFA)');
      return loginData.access_token;
    }

    console.log('[Cocos] MFA requerido → challenge + TOTP...');
    const totpCode = _generateTOTP(totpSec);

    const verifyData = await page.evaluate(async (fid, at, code, ak, bu) => {
      try {
        const cr = await fetch(bu + '/auth/v1/factors/' + fid + '/challenge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': ak, 'Authorization': 'Bearer ' + at },
        });
        const cd = await cr.json();
        if (!cd.id) return { error: 'Challenge falló: ' + JSON.stringify(cd) };
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

    _saveSession(verifyData.access_token, verifyData.refresh_token, verifyData.expires_at, accountId);
    _ready = true;
    console.log('[Cocos] ✅ Login con MFA (aal2) exitoso —', new Date().toLocaleString('es-AR'));
    return verifyData.access_token;
  } finally {
    _loginInProgress = false;
  }
}

// ── Refresh via browser ───────────────────────────────────────────────────────

async function _refresh() {
  if (!_session.refreshToken) throw new Error('Sin refresh token');

  const page = await _ensureBrowser();
  const data = await page.evaluate(async (rt, ak, bu) => {
    try {
      const r = await fetch(bu + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': ak, 'Authorization': 'Bearer ' + ak },
        body: JSON.stringify({ refresh_token: rt }),
      });
      return await r.json();
    } catch (err) { return { error: err.message }; }
  }, _session.refreshToken, ANON_KEY, BASE_URL);

  if (data.error || !data.access_token) {
    throw new Error('Refresh falló: ' + JSON.stringify(data).substring(0, 200));
  }

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
  _loadSession();

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

  if (_session.accessToken) {
    const now = Math.floor(Date.now() / 1000);
    if (_session.expiresAt > now + 60) {
      _ready = true;
      _startTimer();
      console.warn('[Cocos] Usando token almacenado (expira en', Math.round((_session.expiresAt - now) / 60), 'min)');
      return;
    }
  }

  console.warn('[Cocos] Sin sesión activa');
}

// Limpiar Chrome al salir
async function _closeBrowser() {
  if (_browser) {
    const b = _browser;
    _browser = null; _page = null;
    try { await b.close(); } catch {}
  }
}
process.on('SIGTERM', () => _closeBrowser());
process.on('SIGINT', () => _closeBrowser());
process.on('exit', () => {
  if (_browser) try { _browser.process()?.kill('SIGKILL'); } catch {}
});

// Health check cada 5 min: si Chrome murió, lo relanza
setInterval(async () => {
  if (!_ready) return;
  if (_browser && !_browser.isConnected()) {
    console.warn('[Cocos] Browser desconectado, relanzando...');
    _browser = null; _page = null;
    try { await _ensureBrowser(); console.log('[Cocos] Browser recuperado'); }
    catch (e) { console.error('[Cocos] Recovery falló:', e.message); }
  }
}, 5 * 60 * 1000);

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildLongTicker(ticker, settlement, currency, segment) {
  const s = SETTLEMENT_MAP[settlement] || '0002';
  const c = CURRENCY_MAP[currency]     || 'ARS';
  return `${ticker.toUpperCase()}-${s}-${segment || 'C'}-CT-${c}`;
}

function isReady() { return _ready; }

function getSessionInfo() {
  const now = Math.floor(Date.now() / 1000);
  return {
    connected: _ready,
    accountId: _session.accountId,
    tokenExpiresIn: Math.round((_session.expiresAt - now) / 60) + ' min',
    nextRefresh: REFRESH_MS / 60000 + ' min (auto)',
  };
}

async function forceRefresh() {
  try { return await _refresh(); }
  catch { return await _browserLogin(); }
}

async function updateTokens(accessToken, refreshToken, accountId) {
  _saveSession(accessToken, refreshToken, Math.floor(Date.now() / 1000) + 3600, accountId || _session.accountId);
  _ready = true;
  _startTimer();
}

// ── API pública ───────────────────────────────────────────────────────────────

const getMarketStatus = () => _call('GET', 'api/v1/calendar/open-market');
const getDolarMEP     = () => _call('GET', 'api/v1/markets/dolar-mep');
const searchTicker    = q  => _call('GET', `api/v1/markets/tickers/search?q=${encodeURIComponent(q)}`);
const getMyData       = () => _call('GET', 'api/v1/users/me');
const getPortfolio    = () => _call('GET', 'api/v1/wallet/portfolio');
const getBuyingPower  = () => _call('GET', 'api/v2/orders/buying-power');
const getOrders       = () => _call('GET', 'api/v2/orders');
const getOrderStatus  = id => _call('GET', `api/v2/orders/${encodeURIComponent(id)}`);
const cancelOrder     = id => _call('DELETE', `api/v2/orders/${encodeURIComponent(id)}`);

function getPerformance(type) {
  return _call('GET', type === 'historic' ? 'api/v1/wallet/performance/historic' : 'api/v1/wallet/performance/daily');
}

function getSellingPower(longTicker) {
  return _call('GET', `api/v2/orders/selling-power/?long_ticker=${encodeURIComponent(longTicker)}`);
}

async function getQuote(ticker, segment) {
  const simple = ticker.includes('-') ? ticker.split('-')[0] : ticker;
  const results = await _call('GET', `api/v1/markets/tickers/${encodeURIComponent(simple)}?segment=${segment || 'C'}`);
  if (Array.isArray(results)) {
    return results.find(r => r.long_ticker?.includes('-0002-') && r.long_ticker?.endsWith('-ARS'))
        || results.find(r => r.long_ticker?.endsWith('-ARS'))
        || results.find(r => r.long_ticker?.includes('-0002-'))
        || results[0] || {};
  }
  return results;
}

function getMarketList(type, subtype, settlement, currency, segment, page, size) {
  const s = SETTLEMENT_MAP[settlement] || '0002';
  const c = CURRENCY_MAP[currency] || 'ARS';
  return _call('GET', `api/v1/markets/tickers/?instrument_type=${type}&instrument_subtype=${subtype}&settlement_days=${s}&currency=${c}&segment=${segment || 'C'}&page=${page || 1}&size=${Math.min(size || 50, 50)}`);
}

function placeBuyOrder(ticker, quantity, price, settlement, currency, segment) {
  return _call('POST', 'api/v2/orders', {
    long_ticker: buildLongTicker(ticker, settlement || '24hs', currency || 'ARS', segment || 'C'),
    side: 'BUY', type: 'LIMIT', quantity: String(quantity), price: String(price),
  });
}

function placeSellOrder(ticker, quantity, price, settlement, currency, segment) {
  return _call('POST', 'api/v2/orders', {
    long_ticker: buildLongTicker(ticker, settlement || '24hs', currency || 'ARS', segment || 'C'),
    side: 'SELL', type: 'LIMIT', quantity: String(quantity), price: String(price),
  });
}

function placeOrderByLongTicker(longTicker, side, quantity, price) {
  return _call('POST', 'api/v2/orders', {
    long_ticker: longTicker, side: side.toUpperCase(), type: 'LIMIT',
    quantity: String(quantity), price: String(price),
  });
}

function getHealth() {
  const now = Math.floor(Date.now() / 1000);
  return {
    ready: _ready,
    browserConnected: !!(_browser?.isConnected()),
    hasPage: !!_page,
    accountId: _session.accountId,
    tokenExpiresIn: _session.expiresAt ? Math.round((_session.expiresAt - now) / 60) + ' min' : 'N/A',
    uptimeSeconds: Math.round(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
}

module.exports = {
  init, isReady, getSessionInfo, getHealth, forceRefresh, updateTokens, buildLongTicker,
  getMarketStatus, getDolarMEP, searchTicker, getQuote, getMarketList,
  getMyData, getPortfolio, getBuyingPower, getPerformance,
  getOrders, getOrderStatus, getSellingPower,
  placeBuyOrder, placeSellOrder, placeOrderByLongTicker, cancelOrder,
};
