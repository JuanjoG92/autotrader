/* ── AutoTrader - Common JS ── */

const API = window.location.origin + '/api';

function getToken() { return localStorage.getItem('at_token'); }
function setToken(t) { localStorage.setItem('at_token', t); }
function clearToken() { localStorage.removeItem('at_token'); localStorage.removeItem('at_user'); }
function getUser() { try { return JSON.parse(localStorage.getItem('at_user')); } catch { return null; } }
function setUser(u) { localStorage.setItem('at_user', JSON.stringify(u)); }

function requireAuth() {
  if (!getToken()) { window.location.href = '/login'; return false; }
  return true;
}

function logout() {
  clearToken();
  window.location.href = '/login';
}

async function apiFetch(path, opts = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  console.log('[API]', opts.method || 'GET', path);
  try {
    const res = await fetch(API + path, { ...opts, headers });
    if (res.status === 401) { clearToken(); window.location.href = '/login'; return null; }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text }; }
    if (!res.ok) {
      console.warn('[API] ERROR', path, res.status, data.error || text.substring(0, 100));
      return data; // Return error object instead of throwing
    }
    console.log('[API] OK', path, typeof data === 'object' ? (Array.isArray(data) ? data.length + ' items' : Object.keys(data).join(',')) : '');
    return data;
  } catch (e) {
    console.error('[API] FETCH FAIL', path, e.message);
    return { error: e.message };
  }
}

function formatNum(n, decimals = 2) {
  if (n == null || isNaN(n)) return '---';
  return Number(n).toLocaleString('es-AR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatUSD(n) {
  if (n == null || isNaN(n)) return '$0.00';
  return '$' + formatNum(n);
}

function formatDate(d) {
  if (!d) return '---';
  return new Date(d).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function showModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// ── WebSocket price stream ──
let ws = null;
let wsReconnectTimer = null;

function connectPriceStream() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'prices') updatePrices(msg.data);
      if (msg.type === 'trade') handleTradeEvent(msg);
      if (msg.type === 'bot_signal') handleSignalEvent(msg);
    } catch {}
  };

  ws.onclose = () => {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(connectPriceStream, 5000);
  };

  ws.onerror = () => ws.close();
}

function updatePrices(data) {
  if (!data) return;
  data.forEach(p => {
    const sym = p.symbol.split('/')[0];
    const priceEl = document.getElementById('price-' + sym);
    if (priceEl) {
      priceEl.textContent = '$' + formatNum(p.price, p.price > 100 ? 2 : 4);
      priceEl.className = 'ticker-price ' + (p.change >= 0 ? 'up' : 'down');
    }
    const lpEl = document.getElementById('lp-' + sym);
    if (lpEl) {
      lpEl.querySelector('.pc-price').textContent = '$' + formatNum(p.price, p.price > 100 ? 2 : 4);
      const changeEl = lpEl.querySelector('.pc-change');
      changeEl.textContent = (p.change >= 0 ? '+' : '') + formatNum(p.change) + '%';
      changeEl.className = 'pc-change ' + (p.change >= 0 ? 'up' : 'down');
    }
  });
}

function handleTradeEvent(msg) {
  if (typeof onNewTrade === 'function') onNewTrade(msg);
}

function handleSignalEvent(msg) {
  if (typeof onBotSignal === 'function') onBotSignal(msg);
}
