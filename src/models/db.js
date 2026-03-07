const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'autotrader.db');
let db;

function getDB() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initDB() {
  const conn = getDB();

  conn.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      exchange TEXT NOT NULL DEFAULT 'bybit',
      label TEXT DEFAULT '',
      api_key_enc TEXT NOT NULL,
      api_secret_enc TEXT NOT NULL,
      permissions TEXT DEFAULT 'spot',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS bots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      api_key_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      pair TEXT NOT NULL DEFAULT 'BTC/USDT',
      strategy TEXT NOT NULL DEFAULT 'sma_crossover',
      config TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'paused',
      last_signal TEXT DEFAULT NULL,
      last_run DATETIME DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      bot_id INTEGER,
      exchange TEXT NOT NULL DEFAULT 'bybit',
      pair TEXT NOT NULL,
      side TEXT NOT NULL,
      amount REAL NOT NULL,
      price REAL NOT NULL,
      total REAL NOT NULL,
      fee REAL DEFAULT 0,
      pnl REAL DEFAULT 0,
      order_id TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id);
    CREATE INDEX IF NOT EXISTS idx_bots_user ON bots(user_id);
    CREATE INDEX IF NOT EXISTS idx_apikeys_user ON api_keys(user_id);

    CREATE TABLE IF NOT EXISTS cocos_sessions (
      id INTEGER PRIMARY KEY DEFAULT 1,
      access_token_enc TEXT NOT NULL,
      refresh_token_enc TEXT NOT NULL,
      account_id INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT UNIQUE NOT NULL,
      instrument_type TEXT DEFAULT 'ACCIONES',
      segment TEXT DEFAULT 'C',
      currency TEXT DEFAULT 'ARS',
      active INTEGER DEFAULT 1,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS market_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      price REAL NOT NULL,
      variation REAL DEFAULT 0,
      volume REAL DEFAULT 0,
      open_price REAL DEFAULT 0,
      high_price REAL DEFAULT 0,
      low_price REAL DEFAULT 0,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ai_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      action TEXT NOT NULL,
      confidence REAL NOT NULL,
      price REAL,
      quantity INTEGER DEFAULT 0,
      reason TEXT,
      executed INTEGER DEFAULT 0,
      order_id TEXT DEFAULT NULL,
      analysis TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ai_config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      enabled INTEGER DEFAULT 0,
      auto_execute INTEGER DEFAULT 0,
      max_per_trade_ars REAL DEFAULT 50000,
      min_confidence REAL DEFAULT 0.75,
      risk_level TEXT DEFAULT 'medium',
      sectors TEXT DEFAULT 'all',
      asset_types TEXT DEFAULT 'BOTH',
      news_driven INTEGER DEFAULT 1,
      news_weight REAL DEFAULT 0.5,
      use_rag INTEGER DEFAULT 1,
      max_positions INTEGER DEFAULT 5,
      stop_loss_pct REAL DEFAULT 5.0,
      take_profit_pct REAL DEFAULT 10.0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_prices_ticker ON market_prices(ticker);
    CREATE INDEX IF NOT EXISTS idx_prices_time ON market_prices(timestamp);
    CREATE INDEX IF NOT EXISTS idx_signals_ticker ON ai_signals(ticker);

    CREATE TABLE IF NOT EXISTS news_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      summary TEXT DEFAULT '',
      source TEXT DEFAULT '',
      url TEXT DEFAULT '',
      keywords TEXT DEFAULT '',
      published_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_news_time ON news_items(published_at);

    CREATE TABLE IF NOT EXISTS rag_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'txt',
      size INTEGER DEFAULT 0,
      chunks_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS rag_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT DEFAULT NULL,
      keywords TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (doc_id) REFERENCES rag_documents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_doc ON rag_chunks(doc_id);

    CREATE TABLE IF NOT EXISTS auto_invest_config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      enabled INTEGER DEFAULT 1,
      monitor_enabled INTEGER DEFAULT 1,
      invest_pct INTEGER DEFAULT 50,
      min_invest_ars REAL DEFAULT 10000,
      stop_loss_pct REAL DEFAULT 5.0,
      take_profit_pct REAL DEFAULT 10.0,
      allow_high_risk INTEGER DEFAULT 0,
      num_positions INTEGER DEFAULT 3,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS auto_investments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      action TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0,
      price REAL NOT NULL DEFAULT 0,
      total_ars REAL NOT NULL DEFAULT 0,
      order_id TEXT DEFAULT '',
      status TEXT DEFAULT 'PENDING',
      stop_loss_price REAL DEFAULT 0,
      take_profit_price REAL DEFAULT 0,
      reason TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      executed_at DATETIME DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auto_inv_ticker ON auto_investments(ticker);
    CREATE INDEX IF NOT EXISTS idx_auto_inv_status ON auto_investments(status);

    -- ── Crypto AI Trader (Binance — separado de Cocos) ──
    CREATE TABLE IF NOT EXISTS crypto_config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      enabled INTEGER DEFAULT 0,
      api_key_id INTEGER DEFAULT 0,
      max_per_trade_usd REAL DEFAULT 50,
      min_confidence REAL DEFAULT 0.75,
      risk_level TEXT DEFAULT 'medium',
      stop_loss_pct REAL DEFAULT 3.0,
      take_profit_pct REAL DEFAULT 6.0,
      analysis_interval_min INTEGER DEFAULT 15,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS crypto_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 0,
      entry_price REAL NOT NULL DEFAULT 0,
      current_price REAL DEFAULT 0,
      stop_loss REAL DEFAULT 0,
      take_profit REAL DEFAULT 0,
      status TEXT DEFAULT 'OPEN',
      order_id TEXT DEFAULT '',
      reason TEXT DEFAULT '',
      pnl REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      closed_at DATETIME DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_crypto_pos_status ON crypto_positions(status);
  `);

  // Migrar intervalo de análisis de 3 a 15 min (optimización costo OpenAI)
  try {
    conn.prepare("UPDATE crypto_config SET analysis_interval_min = 15 WHERE analysis_interval_min = 3").run();
  } catch {}

  console.log('Database initialized');
}

module.exports = { getDB, initDB };
