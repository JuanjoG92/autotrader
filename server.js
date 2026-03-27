require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const http = require('http');
const { WebSocketServer } = require('ws');
const { initDB } = require('./src/models/db');
const authRoutes = require('./src/routes/auth');
const tradingRoutes = require('./src/routes/trading');
const userRoutes = require('./src/routes/user');
const webhookRoutes = require('./src/routes/webhook');
const { startAllActiveBots, priceStream } = require('./src/services/bot');
const cocosRoutes  = require('./src/routes/cocos');
const aiRoutes     = require('./src/routes/ai');
const ragRoutes    = require('./src/routes/rag');
const cocos        = require('./src/services/cocos');
const marketMonitor= require('./src/services/market-monitor');
const aiTrader     = require('./src/services/ai-trader');
const newsFetcher  = require('./src/services/news-fetcher');
const autoInvestor = require('./src/services/auto-investor');
const cryptoTrader = require('./src/services/crypto-trader');
const scalper      = require('./src/services/scalper');
const cryptoRoutes = require('./src/routes/crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ── Middleware ──
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.css') || filePath.endsWith('.js') || filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// ── API Routes ──
app.use('/api/auth', authRoutes);
app.use('/api/trading', tradingRoutes);
app.use('/api/user', userRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/cocos',   cocosRoutes);
app.use('/api/ai',      aiRoutes);
app.use('/api/rag',     ragRoutes);
app.use('/api/crypto',  cryptoRoutes);

// ── Health check (sin auth — para PM2 / monitoreo) ──
app.get('/api/health', (req, res) => {
  const health = cocos.getHealth ? cocos.getHealth() : { ready: cocos.isReady() };
  const cryptoStatus = cryptoTrader.getStatus ? cryptoTrader.getStatus() : {};
  const scalperStatus = scalper.getStatus ? scalper.getStatus() : {};
  const status = health.ready ? 'ok' : 'degraded';
  res.status(health.ready ? 200 : 503).json({
    status,
    uptime: Math.round(process.uptime()) + 's',
    memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB',
    cocos: health,
    crypto: cryptoStatus,
    scalper: scalperStatus,
    timestamp: new Date().toISOString(),
  });
});

// ── SPA fallback ──
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/cocos',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'cocos.html')));
app.get('/binance',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'binance.html')));
app.get('/rag',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'rag.html')));
app.get('/login',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));

// ── WebSocket: broadcast prices ──
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {});
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

// ── Init ──
const PORT = process.env.PORT || 3800;

initDB();
cocos.init().catch(e => console.error('[Cocos] Init error:', e.message));
marketMonitor.init(broadcast);
aiTrader.init(broadcast);
newsFetcher.init();
autoInvestor.init(broadcast);

// Crypto/Scalper: solo iniciar si están habilitados en DB
try {
  const cryptoCfg = cryptoTrader.getConfig ? cryptoTrader.getConfig() : null;
  if (cryptoCfg && cryptoCfg.enabled) {
    cryptoTrader.init(broadcast);
    scalper.init(broadcast);
  } else {
    console.log('[Server] Crypto/Scalper DESACTIVADOS — no se inician');
  }
} catch (e) {
  console.log('[Server] Crypto/Scalper no iniciados:', e.message);
}

server.listen(PORT, () => {
  console.log(`AutoTrader running on port ${PORT}`);
  startAllActiveBots(broadcast);
  // priceStream usa Binance API — solo activar si crypto está habilitado
  try {
    const cryptoCfg = cryptoTrader.getConfig ? cryptoTrader.getConfig() : null;
    if (cryptoCfg && cryptoCfg.enabled) {
      priceStream(broadcast);
    } else {
      console.log('[Server] priceStream (Binance) desactivado');
    }
  } catch {}
});
