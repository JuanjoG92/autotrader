// public/js/cocos.js — Panel Cocos Capital + AI Trader

const API = '/api';
let _token = localStorage.getItem('at_token') || localStorage.getItem('token') || '';
let _orderSide = 'BUY';
let _ws = null;

console.log('[Cocos] Iniciando...', 'token:', _token ? 'PRESENTE (' + _token.substring(0,20) + '...)' : 'AUSENTE');
console.log('[Cocos] localStorage keys:', Object.keys(localStorage));

const h = () => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${_token}` });

async function api(method, path, body) {
  try {
    console.log('[Cocos] API call:', method, path);
    const res = await fetch(`${API}${path}`, { method, headers: h(), body: body ? JSON.stringify(body) : undefined });
    console.log('[Cocos] Respuesta:', path, res.status);
    if (res.status === 401) {
      console.error('[Cocos] 401 UNAUTHORIZED en', path, '- token inválido o expirado');
      // Redirigir al login de forma estándar en lugar de reemplazar todo el body
      try { window.location.href = '/login'; } catch (e) { /* fallback silent */ }
      return null;
    }
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { error: text.substring(0, 100) }; }
  } catch(e) {
    console.error('[Cocos] Error fetch:', path, e.message);
    return { error: e.message };
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  console.log('[Cocos] DOMContentLoaded - token:', !!_token);
  if (!_token) {
    console.error('[Cocos] Sin token - redirigiendo a login');
    location.href = '/login';
    return;
  }
  console.log('[Cocos] Token OK, cargando datos...');
  loadStatus();
  loadMarketPrices();
  loadPortfolio();
  loadBuyingPower();
  loadSignals();
  loadAIConfig();
  connectWS();
  setInterval(loadMarketPrices, 30000);
  setInterval(loadSignals, 60000);
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${location.host}/ws`;
  _ws = new WebSocket(wsUrl);
  _ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'market_update') updatePriceRows(msg.data);
      if (msg.type === 'ai_analysis')   updateAIPanel(msg.data);
    } catch {}
  };
  _ws.onclose = () => setTimeout(connectWS, 5000);
}

// ── Status ────────────────────────────────────────────────────────────────────
async function loadStatus() {
  const s = await api('GET', '/cocos/status');
  if (!s) return;
  document.getElementById('cocosStatus').innerHTML =
    `<span class="status-dot ${s.connected ? 'green' : 'red'}"></span> ${s.connected ? 'Conectado' : 'Desconectado'}`;
  document.getElementById('cocosAccount').textContent = `ID: ${s.accountId || '-'}`;
  document.getElementById('cocosToken').textContent = s.tokenExpiresIn || '-';
  const m = await api('GET', '/cocos/market');
  if (m) {
    const open = m['24hs'] || m['CI'] || false;
    document.getElementById('marketStatus').innerHTML =
      `<span class="status-dot ${open ? 'green' : 'red'}"></span> Mercado ${open ? 'ABIERTO' : 'CERRADO'}`;
  }
}

// ── Precios ───────────────────────────────────────────────────────────────────
async function loadMarketPrices() {
  const data = await api('GET', '/ai/market/prices');
  if (!data || !Array.isArray(data)) return;
  updatePriceRows(data);
}

function updatePriceRows(data) {
  const tbody = document.getElementById('marketBody');
  if (!tbody) return;
  data.forEach(item => {
    const varNum  = parseFloat(item.variation) || 0;
    const varCls  = varNum > 0 ? 'price-up' : varNum < 0 ? 'price-down' : 'price-neutral';
    const varTxt  = (varNum >= 0 ? '+' : '') + varNum.toFixed(2) + '%';
    const ind     = item.indicators;
    const rsi     = ind?.rsi;
    const rsiCls  = !rsi ? '' : rsi > 70 ? 'price-down' : rsi < 30 ? 'price-up' : '';
    let row = document.getElementById(`row-${item.ticker}`);
    if (!row) {
      row = document.createElement('tr');
      row.id = `row-${item.ticker}`;
      row.onclick = () => setOrderTicker(item.ticker, item.price);
      tbody.appendChild(row);
    }
    row.innerHTML = `
      <td><strong>${item.ticker}</strong></td>
      <td class="price-up">$${Number(item.price || 0).toLocaleString('es-AR', {minimumFractionDigits:2})}</td>
      <td class="${varCls}">${varTxt}</td>
      <td class="${rsiCls}">${rsi ?? '-'}</td>
      <td>${ind?.sma20 ? '$' + ind.sma20.toFixed(0) : '-'}</td>
      <td><span class="ind-chip">${ind?.trend5 ? ind.trend5 + '%' : '-'}</span></td>
    `;
  });
}

// ── Portfolio ─────────────────────────────────────────────────────────────────
async function loadPortfolio() {
  const p = await api('GET', '/cocos/portfolio');
  const el = document.getElementById('portfolioList');
  if (!el) return;

  // Normalizar: puede ser array directo o { positions: [...] }
  let positions = [];
  if (Array.isArray(p)) {
    positions = p;
  } else if (p?.positions && Array.isArray(p.positions)) {
    positions = p.positions;
  }

  if (!positions.length || p?.error) {
    el.innerHTML = '<p style="color:var(--muted);font-size:.8rem">Cartera vacía</p>'; return;
  }

  el.innerHTML = positions.map(pos => {
    const ticker = pos.ticker || pos.instrument_code || '';
    const qty    = pos.quantity || pos.shares || 0;
    const price  = pos.last_price || pos.price || 0;
    const curr   = pos.currency || 'ARS';
    const pnl    = pos.pnl || 0;
    const pnlPct = pos.pnl_pct || 0;
    const pnlCls = pnl >= 0 ? 'price-up' : 'price-down';
    const pnlSign = pnl >= 0 ? '+' : '';
    const value  = pos.value || (price * qty);
    return `
    <div class="portfolio-item" style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
      <div>
        <div class="port-ticker" style="font-weight:700">${ticker}</div>
        <div class="port-qty" style="font-size:.75rem;color:var(--muted)">${qty} × ${curr} $${price.toLocaleString('es-AR',{minimumFractionDigits:2})}</div>
      </div>
      <div style="text-align:right">
        <div style="font-weight:600">${curr} $${value.toLocaleString('es-AR',{minimumFractionDigits:2})}</div>
        <div class="${pnlCls}" style="font-size:.75rem">${pnlSign}${pnl.toFixed(2)} (${pnlSign}${pnlPct.toFixed(1)}%)</div>
      </div>
    </div>`;
  }).join('');

  // Total
  const totalValue = p.total_value || positions.reduce((s, pos) => s + (pos.value || 0), 0);
  if (totalValue > 0) {
    el.innerHTML += `<div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.1);display:flex;justify-content:space-between;font-weight:700">
      <span>Total</span><span>$${totalValue.toLocaleString('es-AR',{minimumFractionDigits:2})}</span></div>`;
  }
}

async function loadBuyingPower() {
  const bp = await api('GET', '/cocos/buying-power');
  if (!bp || bp.error) return;
  const ars = bp['24hs']?.ars || 0;
  const usd = bp['24hs']?.usd || 0;
  document.getElementById('buyingPower').innerHTML =
    `<div style="font-size:1.2rem;font-weight:700">$${ars.toLocaleString('es-AR',{minimumFractionDigits:2})}</div>
     <div style="color:var(--muted);font-size:.75rem">ARS disponibles 24hs</div>
     <div style="margin-top:.25rem">USD ${usd.toFixed(2)}</div>`;
}

// ── Órdenes manuales ──────────────────────────────────────────────────────────
function setOrderSide(side) {
  _orderSide = side;
  document.getElementById('tabBuy').className  = 'order-tab' + (side === 'BUY'  ? ' active-buy'  : '');
  document.getElementById('tabSell').className = 'order-tab' + (side === 'SELL' ? ' active-sell' : '');
}

function setOrderTicker(ticker, price) {
  document.getElementById('orderTicker').value = ticker;
  if (price) document.getElementById('orderPrice').value = price.toFixed(2);
  document.getElementById('orderTicker').scrollIntoView({ behavior: 'smooth' });
}

async function submitOrder() {
  const ticker   = document.getElementById('orderTicker').value.trim().toUpperCase();
  const qty      = parseInt(document.getElementById('orderQty').value);
  const price    = parseFloat(document.getElementById('orderPrice').value);
  const settlement = document.getElementById('orderSettlement').value;
  const currency = document.getElementById('orderCurrency').value;

  if (!ticker || !qty || !price) { alert('Completá todos los campos'); return; }

  const endpoint = _orderSide === 'BUY' ? '/cocos/orders/buy' : '/cocos/orders/sell';
  const result   = await api('POST', endpoint, { ticker, quantity: qty, price, settlement, currency });
  if (!result) return;
  if (result.error) { alert('Error: ' + result.error); return; }
  alert(`✅ Orden enviada: ${_orderSide} ${qty} ${ticker} @ $${price}`);
  loadBuyingPower();
  loadPortfolio();
}

// ── AI Agent ──────────────────────────────────────────────────────────────────
async function loadAIConfig() {
  const cfg = await api('GET', '/ai/config');
  if (!cfg) return;
  document.getElementById('aiEnabled').checked     = !!cfg.enabled;
  document.getElementById('aiAutoExec').checked    = !!cfg.auto_execute;
  document.getElementById('aiMaxTrade').value      = cfg.max_per_trade_ars || 50000;
  document.getElementById('aiMinConf').value       = ((cfg.min_confidence || 0.75) * 100).toFixed(0);
  document.getElementById('aiRisk').value          = cfg.risk_level || 'medium';
  document.getElementById('aiStatusBadge').innerHTML =
    cfg.enabled ? '<span class="badge badge-purple">🤖 Activo</span>' : '<span class="badge badge-gray">⏸ Inactivo</span>';
}

async function saveAIConfig() {
  const cfg = {
    enabled:          document.getElementById('aiEnabled').checked ? 1 : 0,
    auto_execute:     document.getElementById('aiAutoExec').checked ? 1 : 0,
    max_per_trade_ars:parseFloat(document.getElementById('aiMaxTrade').value),
    min_confidence:   parseFloat(document.getElementById('aiMinConf').value) / 100,
    risk_level:       document.getElementById('aiRisk').value,
  };
  await api('PUT', '/ai/config', cfg);
  loadAIConfig();
  alert('✅ Configuración guardada');
}

async function triggerAnalysis() {
  const btn = document.getElementById('btnAnalyze');
  btn.disabled = true;
  btn.textContent = '🔄 Analizando...';
  // Guardar config primero para asegurar que enabled=1
  const cfg = {
    enabled:           1,
    auto_execute:      document.getElementById('aiAutoExec').checked ? 1 : 0,
    max_per_trade_ars: parseFloat(document.getElementById('aiMaxTrade').value),
    min_confidence:    parseFloat(document.getElementById('aiMinConf').value) / 100,
    risk_level:        document.getElementById('aiRisk').value,
  };
  await api('PUT', '/ai/config', cfg);
  try {
    const r = await api('POST', '/ai/analyze');
    if (r?.error) { alert('Error: ' + r.error); return; }
    if (r) updateAIPanel(r);
  } finally {
    btn.disabled = false;
    btn.textContent = '🤖 Analizar Ahora';
  }
}

function updateAIPanel(data) {
  if (!data) return;
  if (data.analysis) {
    const el = document.getElementById('aiAnalysis');
    if (el) el.textContent = data.analysis;
  }
  const sent = data.market_sentiment || 'NEUTRAL';
  const sentEl = document.getElementById('aiSentiment');
  if (sentEl) {
    const colors = { BULLISH: 'badge-green', BEARISH: 'badge-red', NEUTRAL: 'badge-yellow' };
    sentEl.innerHTML = `<span class="badge ${colors[sent] || 'badge-yellow'}">${sent}</span>`;
  }
  loadSignals();
}

async function loadSignals() {
  const signals = await api('GET', '/ai/signals?limit=10');
  const el = document.getElementById('signalsList');
  if (!el || !signals?.length) {
    if (el) el.innerHTML = '<p style="color:var(--muted);font-size:.8rem">Sin señales aún</p>';
    return;
  }
  el.innerHTML = signals.map(s => {
    const color = { BUY: 'badge-green', SELL: 'badge-red', HOLD: 'badge-gray' }[s.action] || 'badge-gray';
    const dt    = new Date(s.created_at).toLocaleString('es-AR', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    return `<div class="signal-item ${s.action}">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span class="signal-ticker">${s.ticker}</span>
        <span class="badge ${color}">${s.action}</span>
      </div>
      <div class="signal-reason">${s.reason || '-'}</div>
      <div class="signal-meta">
        <span class="badge badge-gray">${(s.confidence * 100).toFixed(0)}% confianza</span>
        ${s.price ? `<span class="badge badge-gray">$${Number(s.price).toLocaleString('es-AR')}</span>` : ''}
        ${s.executed ? '<span class="badge badge-green">✓ Ejecutada</span>' : ''}
        <span style="font-size:.65rem;color:var(--muted)">${dt}</span>
      </div>
    </div>`;
  }).join('');
}
