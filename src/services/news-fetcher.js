// src/services/news-fetcher.js
// Obtiene noticias financieras argentinas desde RSS gratuitos
// Sin API key — parseo RSS simple

const { getDB } = require('../models/db');

const FETCH_INTERVAL_MS = 30 * 60 * 1000; // 30 min
const MAX_AGE_HOURS     = 48;

const RSS_FEEDS = [
  { name: 'Google Finanzas AR',  url: 'https://news.google.com/rss/search?q=bolsa+argentina+merval+acciones&hl=es-419&gl=AR&ceid=AR:es-419' },
  { name: 'Google YPF/GGAL',    url: 'https://news.google.com/rss/search?q=YPF+Galicia+Pampa+acciones+BYMA&hl=es-419&gl=AR&ceid=AR:es-419' },
  { name: 'Google CEDEARs',      url: 'https://news.google.com/rss/search?q=cedear+apple+nvidia+microsoft+tesla&hl=es-419&gl=AR&ceid=AR:es-419' },
  { name: 'Google Economia AR',  url: 'https://news.google.com/rss/search?q=economia+argentina+dolar+inflacion+BCRA&hl=es-419&gl=AR&ceid=AR:es-419' },
  { name: 'Bolsar',              url: 'https://www.bolsar.com/Vistas/Publicas/RSSNoticias.aspx' },
];

// Palabras clave por sector/ticker para indexar noticias
const SECTOR_KEYWORDS = {
  YPF:    ['ypf', 'vaca muerta', 'petroleo', 'hidrocarburo', 'upstream'],
  GGAL:   ['galicia', 'banco', 'financiero', 'credito', 'tasa'],
  PAMP:   ['pampa energía', 'pampa energia', 'electricidad', 'energia'],
  TGNO4:  ['transportadora', 'gas norte', 'gasoducto'],
  TGSU2:  ['transportadora', 'gas sur', 'gasoducto'],
  CEPU:   ['central puerto', 'generacion electrica'],
  ALUA:   ['aluar', 'aluminio'],
  LOMA:   ['loma negra', 'cemento', 'construccion'],
  TXAR:   ['ternium', 'acero', 'siderurgica'],
  TECO2:  ['telecom', 'telecomunicaciones'],
  BBAR:   ['banco frances', 'bbva'],
  BMA:    ['banco macro'],
  MELI:   ['mercadolibre', 'mercado libre', 'ecommerce'],
  AAPL:   ['apple', 'iphone', 'tim cook'],
  MSFT:   ['microsoft', 'windows', 'azure', 'openai'],
  NVDA:   ['nvidia', 'gpu', 'chips', 'inteligencia artificial', 'ia'],
  GOOGL:  ['google', 'alphabet', 'android', 'youtube'],
  AMZN:   ['amazon', 'aws', 'cloud'],
  TSLA:   ['tesla', 'elon musk', 'electrico', 'vehiculo electrico'],
  GENERAL: ['merval', 'byma', 'bolsa', 'cedear', 'dolar', 'inflacion', 'economia argentina', 'reservas', 'bcra', 'banco central'],
};

// ── Parser RSS simple ─────────────────────────────────────────────────────────

function parseRSS(xml) {
  const items = [];
  const itemRx = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRx.exec(xml)) !== null) {
    const block = match[1];
    const title   = strip(extract(block, 'title'));
    const desc    = strip(extract(block, 'description'));
    const link    = strip(extract(block, 'link'));
    const pubDate = strip(extract(block, 'pubDate'));
    if (title && title.length > 5) {
      items.push({ title, summary: desc.substring(0, 300), url: link, pubDate });
    }
  }
  return items;
}

function extract(text, tag) {
  const rx = new RegExp(`<${tag}[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/${tag}>`, 'i');
  const m = text.match(rx);
  return m ? m[1] : '';
}

function strip(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

// ── Indexar keywords ──────────────────────────────────────────────────────────

function extractKeywords(title, summary) {
  const text = (title + ' ' + summary).toLowerCase();
  const found = new Set(['GENERAL']); // siempre incluye general
  for (const [ticker, words] of Object.entries(SECTOR_KEYWORDS)) {
    for (const w of words) {
      if (text.includes(w)) { found.add(ticker); break; }
    }
  }
  return Array.from(found).join(',');
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function saveNews(items, source) {
  const db   = getDB();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO news_items (title, summary, source, url, keywords, published_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);
  let saved = 0;
  for (const item of items) {
    const kw = extractKeywords(item.title, item.summary);
    try { stmt.run(item.title, item.summary, source, item.url || '', kw); saved++; }
    catch {}
  }
  return saved;
}

function cleanOldNews() {
  const cutoff = new Date(Date.now() - MAX_AGE_HOURS * 3600000).toISOString();
  getDB().prepare('DELETE FROM news_items WHERE fetched_at < ?').run(cutoff);
}

function getNewsForTickers(tickers, limit) {
  const db      = getDB();
  const lim     = limit || 8;
  const allNews = [];
  const checked = new Set();
  for (const ticker of [...tickers, 'GENERAL']) {
    const rows = db.prepare(`
      SELECT title, summary, source, published_at FROM news_items
      WHERE keywords LIKE ? ORDER BY published_at DESC LIMIT ?
    `).all(`%${ticker}%`, 3);
    for (const r of rows) {
      if (!checked.has(r.title)) { checked.add(r.title); allNews.push(r); }
    }
  }
  return allNews.slice(0, lim);
}

function getLatestNews(limit) {
  return getDB().prepare(
    'SELECT title, source, published_at FROM news_items ORDER BY published_at DESC LIMIT ?'
  ).all(limit || 20);
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return 0;
    const xml   = await res.text();
    const items = parseRSS(xml);
    const saved = saveNews(items, feed.name);
    console.log(`[News] ${feed.name}: ${saved} noticias guardadas`);
    return saved;
  } catch (e) {
    console.warn(`[News] Error en ${feed.name}:`, e.message);
    return 0;
  }
}

async function fetchAllFeeds() {
  cleanOldNews();
  let total = 0;
  for (const feed of RSS_FEEDS) {
    total += await fetchFeed(feed);
    await new Promise(r => setTimeout(r, 1000)); // pausa entre feeds
  }
  console.log(`[News] Total noticias nuevas: ${total}`);
  return total;
}

// ── Init ──────────────────────────────────────────────────────────────────────

let _timer = null;
function init() {
  fetchAllFeeds().catch(e => console.error('[News] Error inicial:', e.message));
  _timer = setInterval(() => fetchAllFeeds().catch(e => console.error('[News] Error:', e.message)), FETCH_INTERVAL_MS);
  console.log('[News] Fetcher iniciado — actualiza cada 30 min');
}

module.exports = { init, fetchAllFeeds, getNewsForTickers, getLatestNews, extractKeywords };
