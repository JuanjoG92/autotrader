/* ── Dashboard JS ── */
(function() {
  if (!requireAuth()) return;
  const user = getUser();
  if (user) {
    const el = document.getElementById('userName');
    if (el) el.textContent = user.name || user.email;
  }

  // ── Navigation ──
  document.querySelectorAll('.sidebar-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const sec = link.dataset.section;
      if (!sec) return;
      document.querySelectorAll('.sidebar-link').forEach(l => l.classList.remove('active'));
      link.classList.add('active');
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      document.getElementById('sec-' + sec).classList.add('active');
      document.getElementById('sidebar').classList.remove('open');
      const overlay = document.getElementById('sidebarOverlay');
      if (overlay) overlay.classList.remove('open');
      if (sec === 'overview') loadOverview();
      if (sec === 'market') loadMarket();
      if (sec === 'bots') loadBots();
      if (sec === 'trades') loadAllTrades();
      if (sec === 'keys') loadKeys();
    });
  });

  // Sidebar toggle
  const toggleBtn = document.getElementById('sidebarToggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      document.getElementById('sidebar').classList.toggle('collapsed');
    });
  }

  // ── Init ──
  connectPriceStream();
  loadOverview();
  loadKeys();
  loadTopGainers();
  setInterval(loadOverview, 30000);
  setInterval(loadTopGainers, 5 * 60 * 1000); // Actualizar gainers cada 5 min

  // ── Top Gainers ──
  async function loadTopGainers() {
    apiFetch('/crypto/gainers').then(gainers => {
      if (!gainers || !Array.isArray(gainers) || !gainers.length) return;
      const grid = document.getElementById('topGainersGrid');
      if (!grid) return;
      grid.innerHTML = gainers.map(g => {
        const sym = g.symbol.split('/')[0];
        const color = g.change24h >= 10 ? '#10b981' : g.change24h >= 5 ? '#22c55e' : '#64748b';
        const bg = g.change24h >= 10 ? 'rgba(16,185,129,.08)' : 'rgba(100,116,139,.04)';
        return `<div style="background:${bg};border:1px solid rgba(255,255,255,.06);border-radius:8px;padding:10px 12px;border-left:3px solid ${color}">
          <div style="font-weight:600;font-size:13px;color:#e2e8f0">${sym}</div>
          <div style="font-size:18px;font-weight:700;color:${color};margin:2px 0">+${g.change24h.toFixed(1)}%</div>
          <div style="font-size:11px;color:#64748b">$${g.price < 1 ? g.price.toFixed(4) : g.price.toFixed(2)} · Vol $${Math.round(g.volume / 1e6)}M</div>
        </div>`;
      }).join('');
    }).catch(() => {});
  }

  // ── Overview (progressive loading — cada dato se muestra al llegar) ──
  async function loadOverview() {
    // Fast local data first (no proxy needed)
    apiFetch('/crypto/status').then(s => {
      if (!s || s.error) return;
      const openPositions = s.openPositions || 0;
      document.getElementById('activeBots').textContent = openPositions;

      // Positions table
      const positions = s.positions || [];
      const posCard = document.getElementById('cryptoPositionsCard');
      const posBody = document.getElementById('cryptoPositions');
      if (positions.length > 0) {
        posCard.style.display = '';
        posBody.innerHTML = positions.map(p => {
          const pnlPct = p.pnlPct || 'N/A';
          const cls = parseFloat(pnlPct) >= 0 ? 'tag-buy' : 'tag-sell';
          return `<tr>
            <td><strong>${p.symbol}</strong></td>
            <td><span class="tag-buy">${p.side || 'BUY'}</span></td>
            <td>${formatNum(p.qty, 6)}</td>
            <td>$${formatNum(p.entry)}</td>
            <td>$${formatNum(p.current)}</td>
            <td><span class="${cls}">${pnlPct}</span></td>
          </tr>`;
        }).join('');
      } else {
        posCard.style.display = 'none';
      }

      // AI Analysis section
      const la = s.lastAnalysis;
      if (la) {
        const txt = document.getElementById('aiAnalysisText');
        txt.textContent = la.analysis || 'Sin análisis';
        const badge = document.getElementById('aiSentimentBadge');
        const sent = la.market_sentiment || 'NEUTRAL';
        badge.textContent = sent;
        badge.style.background = sent === 'BULLISH' ? 'rgba(16,185,129,.15)' : sent === 'BEARISH' ? 'rgba(239,68,68,.15)' : 'rgba(245,158,11,.15)';
        badge.style.color = sent === 'BULLISH' ? '#10b981' : sent === 'BEARISH' ? '#ef4444' : '#f59e0b';
        const sigList = document.getElementById('aiSignalsList');
        sigList.innerHTML = (la.signals || []).map(sig => {
          const color = sig.action === 'BUY' ? '#10b981' : sig.action === 'SELL' ? '#ef4444' : '#64748b';
          const bg = sig.action === 'BUY' ? 'rgba(16,185,129,.08)' : sig.action === 'SELL' ? 'rgba(239,68,68,.08)' : 'rgba(100,116,139,.06)';
          return `<div style="padding:6px 10px;border-radius:6px;margin-bottom:4px;background:${bg};border-left:3px solid ${color};font-size:12px">
            <strong style="color:${color}">${sig.action}</strong> ${sig.symbol}
            <span style="color:#64748b;margin-left:6px">${((sig.confidence||0)*100).toFixed(0)}%</span>
            ${sig.amount_usd ? '<span style="color:#94a3b8;margin-left:4px">~$'+sig.amount_usd+'</span>' : ''}
            <div style="color:#94a3b8;font-size:11px;margin-top:2px">${(sig.reason||'').substring(0,120)}</div>
          </div>`;
        }).join('');
        const wl = document.getElementById('aiWatchlist');
        wl.textContent = la.watchlist?.length ? '👀 Watchlist: ' + la.watchlist.join(', ') : '';
      }
    }).catch(() => {});

    apiFetch('/crypto/summary').then(s => {
      if (!s || s.error) return;
      // Only count LIVE trades (not paper)
      document.getElementById('totalTrades').textContent = s.live_trades || s.total_positions || 0;
      document.getElementById('totalVolume').textContent = formatUSD(s.live_volume || 0);
      const pnl = s.total_pnl || 0;
      document.getElementById('totalPnl').textContent = (pnl >= 0 ? '+' : '') + formatUSD(pnl);
      const pnlIcon = document.getElementById('pnlIcon');
      if (pnlIcon) pnlIcon.className = 'stat-icon ' + (pnl >= 0 ? 'green' : 'red');
    }).catch(() => {});

    // All operations history
    apiFetch('/crypto/history?limit=30').then(history => {
      if (!history || !Array.isArray(history) || !history.length) return;
      const tbody = document.getElementById('recentTrades');
      if (!history.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty">Sin operaciones aún</td></tr>';
        return;
      }
      tbody.innerHTML = history.map(t => {
        const dt = formatDate(t.created_at);
        const sideCls = t.side === 'SELL' ? 'tag-sell' : 'tag-buy';
        const isPaper = t.order_id && t.order_id.startsWith('PAPER');
        const statusCls = t.status === 'OPEN' ? 'tag-buy' : 'tag-sell';
        const statusTxt = t.status === 'OPEN' ? '🟢 Abierta' : '🔴 Cerrada';
        const modeBadge = isPaper ? ' <small style="color:#f59e0b;font-size:10px">PAPER</small>' : ' <small style="color:#10b981;font-size:10px">LIVE</small>';
        const pnl = t.pnl ? (t.pnl >= 0 ? '+' : '') + formatNum(t.pnl) : '';
        return `<tr${isPaper ? ' style="opacity:0.6"' : ''}>
          <td>${dt}</td>
          <td><strong>${t.symbol}</strong></td>
          <td><span class="${sideCls}">${t.side || 'BUY'}</span>${modeBadge}</td>
          <td>${formatNum(t.quantity, 6)}</td>
          <td>$${formatNum(t.entry_price)}</td>
          <td>$${formatNum(t.entry_price * t.quantity)}</td>
          <td><span class="${statusCls}">${statusTxt}</span> ${pnl ? '<small>'+pnl+'</small>' : ''}</td>
        </tr>`;
      }).join('');
    }).catch(() => {});

    // Balance: server-calculated total
    apiFetch('/crypto/balance').then(bal => {
      const balEl = document.getElementById('binanceBalance');
      const freeEl = document.getElementById('binanceFree');
      if (bal && typeof bal === 'object' && !bal.error) {
        balEl.textContent = '$' + formatNum(bal._totalUSD || 0);
        if (freeEl) freeEl.textContent = 'Libre: $' + formatNum(bal._freeUSDT || 0);
      } else {
        balEl.textContent = bal?.error ? '...' : '$---';
      }
    }).catch(() => {
      document.getElementById('binanceBalance').textContent = '$---';
    });
  }

  // ── Bots ──
  window.showCreateBot = async function() {
    await populateKeySelect();
    updateStrategyParams();
    showModal('botModal');
  };

  async function populateKeySelect() {
    const keys = await apiFetch('/user/keys');
    const sel = document.getElementById('botApiKey');
    sel.innerHTML = '';
    if (keys.length === 0) {
      sel.innerHTML = '<option value="">-- Agregá una API Key primero --</option>';
      return;
    }
    keys.forEach(k => {
      sel.innerHTML += `<option value="${k.id}">${k.label || k.exchange} #${k.id}</option>`;
    });
  }

  window.updateStrategyParams = function() {
    const strat = document.getElementById('botStrategy').value;
    const container = document.getElementById('strategyParams');
    const desc = document.getElementById('strategyDesc');
    const DESCS = {
      sma_crossover: 'Cruza media móvil corta vs larga',
      rsi: 'Compra en sobreventa, vende en sobrecompra',
      macd: 'Señales de cruce MACD/Signal',
    };
    desc.textContent = DESCS[strat] || '';

    const PARAMS = {
      sma_crossover: `
        <div class="form-row">
          <div class="form-group"><label>Período corto</label><input type="number" id="sp_shortPeriod" value="10" min="2"></div>
          <div class="form-group"><label>Período largo</label><input type="number" id="sp_longPeriod" value="30" min="5"></div>
        </div>`,
      rsi: `
        <div class="form-row">
          <div class="form-group"><label>Período RSI</label><input type="number" id="sp_rsiPeriod" value="14" min="2"></div>
          <div class="form-group"><label>Sobrecompra</label><input type="number" id="sp_overbought" value="70" min="50" max="99"></div>
        </div>
        <div class="form-group"><label>Sobreventa</label><input type="number" id="sp_oversold" value="30" min="1" max="50"></div>`,
      macd: `
        <div class="form-row">
          <div class="form-group"><label>Fast</label><input type="number" id="sp_fastPeriod" value="12" min="2"></div>
          <div class="form-group"><label>Slow</label><input type="number" id="sp_slowPeriod" value="26" min="5"></div>
        </div>
        <div class="form-group"><label>Signal</label><input type="number" id="sp_signalPeriod" value="9" min="2"></div>`,
    };
    container.innerHTML = PARAMS[strat] || '';
  };

  document.getElementById('createBotForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const apiKeyId = document.getElementById('botApiKey').value;
    if (!apiKeyId) return alert('Primero agregá una API Key en la sección "API Keys"');

    const strat = document.getElementById('botStrategy').value;
    const config = { timeframe: document.getElementById('botTimeframe').value, interval: document.getElementById('botInterval').value, tradeAmount: parseFloat(document.getElementById('botAmount').value) };
    document.querySelectorAll('[id^="sp_"]').forEach(el => { config[el.id.replace('sp_', '')] = parseFloat(el.value); });

    try {
      await apiFetch('/trading/bots', {
        method: 'POST',
        body: JSON.stringify({ name: document.getElementById('botName').value, pair: document.getElementById('botPair').value, strategy: strat, config, apiKeyId: parseInt(apiKeyId) }),
      });
      closeModal('botModal');
      document.getElementById('createBotForm').reset();
      loadBots();
    } catch (err) {
      alert(err.message);
    }
  });

  async function loadBots() {
    try {
      const bots = await apiFetch('/trading/bots');
      const container = document.getElementById('botsList');
      if (bots.length === 0) {
        container.innerHTML = '<div class="card" style="padding:40px;text-align:center"><i class="fas fa-robot" style="font-size:48px;color:var(--text3);margin-bottom:12px"></i><p style="color:var(--text3)">No tenés bots creados aún</p></div>';
        return;
      }
      container.innerHTML = bots.map(b => `
        <div class="bot-card">
          <div class="bot-card-header">
            <h4><i class="fas fa-robot"></i> ${b.name}</h4>
            <span class="bot-status ${b.status}">${b.status === 'active' ? '● Activo' : '⏸ Pausado'}</span>
          </div>
          <div class="bot-meta">
            <div><span>Par: </span><strong>${b.pair}</strong></div>
            <div><span>Estrategia: </span><strong>${b.strategy}</strong></div>
            <div><span>Monto: </span><strong>${b.config.tradeAmount || '-'} USDT</strong></div>
            <div><span>Última señal: </span><strong>${b.last_signal || '-'}</strong></div>
          </div>
          <div class="bot-actions">
            ${b.status === 'active'
              ? `<button class="btn btn-outline btn-sm" onclick="toggleBot(${b.id},'stop')"><i class="fas fa-pause"></i> Pausar</button>`
              : `<button class="btn btn-success btn-sm" onclick="toggleBot(${b.id},'start')"><i class="fas fa-play"></i> Activar</button>`
            }
            <button class="btn btn-danger btn-sm" onclick="deleteBot(${b.id})"><i class="fas fa-trash"></i></button>
          </div>
        </div>
      `).join('');
    } catch (err) {
      console.error('Load bots error:', err);
    }
  }

  window.toggleBot = async function(id, action) {
    try {
      await apiFetch(`/trading/bots/${id}/${action}`, { method: 'POST' });
      loadBots();
      loadOverview();
    } catch (err) {
      alert(err.message);
    }
  };

  window.deleteBot = async function(id) {
    if (!confirm('¿Eliminar este bot?')) return;
    try {
      await apiFetch(`/trading/bots/${id}`, { method: 'DELETE' });
      loadBots();
      loadOverview();
    } catch (err) {
      alert(err.message);
    }
  };

  // ── Market ──
  async function loadMarket() {
    try {
      const pairs = await apiFetch('/trading/top-pairs');
      const tbody = document.getElementById('marketTable');
      if (!pairs.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty">No se pudieron cargar los datos</td></tr>'; return; }
      tbody.innerHTML = pairs.map(p => `
        <tr>
          <td><strong>${p.symbol}</strong></td>
          <td>$${formatNum(p.price, p.price > 100 ? 2 : 6)}</td>
          <td><span class="${p.change24h >= 0 ? 'tag-buy' : 'tag-sell'}">${p.change24h >= 0 ? '+' : ''}${formatNum(p.change24h)}%</span></td>
          <td>$${formatNum(p.volume, 0)}</td>
          <td>$${formatNum(p.high, p.high > 100 ? 2 : 6)}</td>
          <td>$${formatNum(p.low, p.low > 100 ? 2 : 6)}</td>
        </tr>
      `).join('');
    } catch (err) {
      console.error('Market error:', err);
    }
  }

  // ── Trades ──
  async function loadAllTrades() {
    try {
      const trades = await apiFetch('/trading/trades?limit=100');
      renderTrades('allTrades', trades, true);
    } catch (err) {
      console.error('Trades error:', err);
    }
  }

  function renderTrades(containerId, trades, showBot) {
    const tbody = document.getElementById(containerId);
    if (!trades || trades.length === 0) {
      const cols = showBot ? 7 : 6;
      tbody.innerHTML = `<tr><td colspan="${cols}" class="empty">Sin operaciones aún</td></tr>`;
      return;
    }
    tbody.innerHTML = trades.map(t => `
      <tr>
        <td>${formatDate(t.created_at)}</td>
        ${showBot ? `<td>Bot #${t.bot_id || '-'}</td>` : ''}
        <td>${t.pair}</td>
        <td><span class="tag-${t.side}">${t.side.toUpperCase()}</span></td>
        <td>${formatNum(t.amount, 6)}</td>
        <td>$${formatNum(t.price)}</td>
        <td>$${formatNum(t.total)}</td>
      </tr>
    `).join('');
  }

  // ── API Keys ──
  async function loadKeys() {
    try {
      const keys = await apiFetch('/user/keys');
      const container = document.getElementById('keysList');
      if (!keys.length) {
        container.innerHTML = '<div class="card" style="padding:40px;text-align:center"><i class="fas fa-key" style="font-size:48px;color:var(--text3);margin-bottom:12px"></i><p style="color:var(--text3)">No tenés API Keys configuradas</p></div>';
        return;
      }
      container.innerHTML = keys.map(k => `
        <div class="key-card">
          <div class="key-info">
            <div class="key-icon"><i class="fas fa-key"></i></div>
            <div>
              <div class="key-label">${k.label || 'API Key #' + k.id}</div>
              <div class="key-exchange">${k.exchange} · ${k.permissions} · Agregada: ${formatDate(k.created_at)}</div>
            </div>
          </div>
          <div class="key-actions">
            <button class="btn btn-outline btn-sm" onclick="testKey(${k.id})"><i class="fas fa-plug"></i> Probar</button>
            <button class="btn btn-outline btn-sm" onclick="viewBalances(${k.id})"><i class="fas fa-wallet"></i> Balance</button>
            <button class="btn btn-danger btn-sm" onclick="deleteKey(${k.id})"><i class="fas fa-trash"></i></button>
          </div>
        </div>
      `).join('');
    } catch (err) {
      console.error('Keys error:', err);
    }
  }

  document.getElementById('addKeyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = await apiFetch('/user/keys', {
        method: 'POST',
        body: JSON.stringify({
          apiKey: document.getElementById('keyApiKey').value.trim(),
          apiSecret: document.getElementById('keyApiSecret').value.trim(),
          exchange: document.getElementById('keyExchange').value,
          label: document.getElementById('keyLabel').value.trim(),
        }),
      });
      closeModal('keyModal');
      document.getElementById('addKeyForm').reset();
      loadKeys();
      alert('✅ API Key guardada. Probando conexión...');
      await testKey(data.id);
    } catch (err) {
      alert('Error: ' + err.message);
    }
  });

  window.testKey = async function(id) {
    try {
      const result = await apiFetch(`/user/keys/${id}/test`, { method: 'POST' });
      alert(`✅ Conexión exitosa. Se encontraron ${result.totalAssets} activos en tu cuenta.`);
    } catch (err) {
      alert('❌ Error de conexión: ' + err.message);
    }
  };

  window.viewBalances = async function(id) {
    try {
      const balances = await apiFetch(`/user/keys/${id}/balances`);
      const lines = Object.entries(balances).map(([coin, info]) => `${coin}: ${formatNum(info.total, 8)}`).join('\n');
      alert('💰 Balances:\n\n' + (lines || 'Sin fondos'));
    } catch (err) {
      alert('Error: ' + err.message);
    }
  };

  window.deleteKey = async function(id) {
    if (!confirm('¿Eliminar esta API Key? Los bots asociados dejarán de funcionar.')) return;
    try {
      await apiFetch(`/user/keys/${id}`, { method: 'DELETE' });
      loadKeys();
    } catch (err) {
      alert('Error: ' + err.message);
    }
  };

  // ── WS events ──
  window.onNewTrade = function() { loadOverview(); };
  window.onBotSignal = function() {};
})();
