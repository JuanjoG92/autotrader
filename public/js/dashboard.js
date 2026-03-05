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
      if (sec === 'market') loadMarket();
      if (sec === 'bots') loadBots();
      if (sec === 'trades') loadAllTrades();
      if (sec === 'keys') loadKeys();
    });
  });

  // ── Init ──
  connectPriceStream();
  loadOverview();
  loadKeys();

  // ── Overview ──
  async function loadOverview() {
    try {
      const [bots, summary] = await Promise.all([
        apiFetch('/trading/bots'),
        apiFetch('/trading/trades/summary'),
      ]);
      document.getElementById('activeBots').textContent = bots.filter(b => b.status === 'active').length;
      document.getElementById('totalTrades').textContent = summary.total || 0;
      document.getElementById('totalVolume').textContent = formatUSD(summary.volume);
      const pnl = summary.total_pnl || 0;
      document.getElementById('totalPnl').textContent = (pnl >= 0 ? '+' : '') + formatUSD(pnl);
      const pnlIcon = document.getElementById('pnlIcon');
      pnlIcon.className = 'stat-icon ' + (pnl >= 0 ? 'green' : 'red');

      const trades = await apiFetch('/trading/trades?limit=10');
      renderTrades('recentTrades', trades, false);
    } catch (err) {
      console.error('Overview error:', err);
    }
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
