# PROMPT PARA NUEVO CHAT — AutoTrader: Sistema de Inversión con IA + Binance

## CONTEXTO DEL PROYECTO
Plataforma de trading automatizado con IA en Node.js + Express + SQLite. 
- Repo: `https://github.com/JuanjoG92/autotrader.git`
- Carpeta local: `C:\autotrader`
- VPS: `172.96.8.245` puerto 3800, dominio: `autotrader.centralchat.pro`
- SSH: `ssh -i "$env:USERPROFILE\.ssh\nueva_llave" root@172.96.8.245`
- Deploy: git push → VPS: `git pull; pm2 restart autotrader --update-env`
- PM2 PATH fix: siempre usar `export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin;` antes de comandos SSH

## STACK
- Backend: Node.js + Express + better-sqlite3 + ccxt (Binance)
- Frontend: HTML + CSS + JS vanilla (NO frameworks)
- IA: OpenAI gpt-4o-mini (token se obtiene de ai-token.js)
- Deploy: PM2 en VPS Ubuntu

## PROBLEMA DE BINANCE (RESUELTO)
El VPS está en USA. Binance bloquea IPs de datacenters USA.
SOLUCIÓN: Túnel SSH reverso desde la PC del usuario (Argentina) que crea un proxy SOCKS5 en el VPS:
- PC del usuario ejecuta: `ssh -R 1080 -N -i key root@172.96.8.245`
- VPS .env tiene: `BINANCE_PROXY=socks5h://127.0.0.1:1080`
- ccxt en `src/services/binance.js` usa `config.socksProxy = proxy` cuando detecta BINANCE_PROXY
- El archivo `tunel-binance.bat` ya existe en C:\autotrader para ejecutar el túnel
- **El túnel FUNCIONA**: `curl --socks5 127.0.0.1:1080 'https://api.binance.com/api/v3/ping'` devuelve `{}`

## API KEY DE BINANCE (YA CONFIGURADA EN DB)
- API Key: XvcLbTYUk1AZwalknb7DVCwWIpUDeKQPit6cQjCEeksgce64neMn2rg8PODqyoSs
- Secret: 6fRmyguWO8XnEcTA0ao63EpjqxiSZOAwIWwIP4KhBEaYSbZkKJNw2j7BKIOGABwC
- Permisos: Lectura + Spot Trading
- IP restringida: 172.96.8.245
- Guardada en DB como api_keys id=1, exchange='binance', label='autotrader'
- Balance: ~67 USDT en billetera Spot

## ARCHIVOS EXISTENTES RELEVANTES

### Backend
- `server.js` — Express + WebSocket, importa todas las rutas y servicios
- `src/services/binance.js` — ccxt, CoinGecko cache, getTicker, createOrder, getBalances, testConnection (con proxy SOCKS)
- `src/services/crypto-trader.js` — AI Crypto Trader: runAnalysis (GPT), monitorPositions (SL/TP), _executeTrade (intenta LIVE, fallback PAPER)
- `src/routes/crypto.js` — /api/crypto/status, /api/crypto/analyze, /api/crypto/config, /api/crypto/reset
- `src/routes/user.js` — /api/user/keys (CRUD), /api/user/keys/:id/test, /api/user/keys/:id/balances
- `src/routes/trading.js` — /api/trading/bots (CRUD), /api/trading/trades, /api/trading/trades/summary
- `src/services/news-fetcher.js` — Scraper de noticias Google para análisis
- `src/services/ai-token.js` — Obtiene token OpenAI
- `src/services/rag.js` — RAG con documentos subidos
- `src/services/cocos.js` — Servicio Cocos Capital (acciones argentinas, separado)

### Frontend
- `public/dashboard.html` + `public/js/dashboard.js` + `public/css/app.css` — Dashboard principal (crypto bots)
- `public/cocos.html` + `public/js/cocos.js` + `public/css/cocos.css` — Panel Cocos Capital
- `public/js/app.js` — Funciones comunes (apiFetch, WebSocket, formatters)

### DB Tables
- `users` — id, email, password_hash, name
- `api_keys` — id, user_id, exchange, label, api_key_enc, api_secret_enc, permissions
- `crypto_config` — id, enabled, api_key_id, max_per_trade_usd, risk_level, stop_loss_pct, take_profit_pct, min_confidence, analysis_interval_min
- `crypto_positions` — id, symbol, side, quantity, entry_price, current_price, stop_loss, take_profit, status, pnl, order_id, reason, created_at, closed_at
- `bots` — id, user_id, api_key_id, name, pair, strategy, config, status
- `trades` — id, user_id, bot_id, pair, side, amount, price, total, pnl, created_at
- `news_items` — id, title, source, url, ticker, sentiment, created_at

## BUGS ACTUALES QUE NECESITAN FIX

### 1. BINANCE LIVE NO EJECUTA (CRITICO)
ccxt no está usando el proxy SOCKS. El túnel SSH FUNCIONA confirmado:
```
curl --socks5 127.0.0.1:1080 'https://api.binance.com/api/v3/account' -H 'X-MBX-APIKEY: XvcLb...' 
→ {"code":-1102,"msg":"Mandatory parameter 'signature' was not sent..."}  (= BINANCE RESPONDE, falta firma)
```
Pero ccxt sigue dando "Unsupported state or unable to authenticate data" (= no usa el proxy, va directo y Binance bloquea).

El `.env` tiene `BINANCE_PROXY=socks5h://127.0.0.1:1080`.
En `src/services/binance.js` línea 84-88: `config.socksProxy = proxy` (cuando proxy empieza con 'socks').
El paquete `socks-proxy-agent@8.0.5` está instalado.

**LO QUE HAY QUE HACER**: Crear un test script en el VPS que instancie ccxt.binance con `{ socksProxy: 'socks5h://127.0.0.1:1080' }` y haga `exchange.fetchBalance()`. Si falla, probar con `socksProxy: 'socks5://127.0.0.1:1080'`, o con `httpProxy`/`httpsProxy` usando un proxy HTTP local, o configurar `agent` manualmente con `socks-proxy-agent`. Este es el UNICO blocker para trading real.

### 2. DASHBOARD NO CARGA DATOS AL ABRIR
Al abrir autotrader.centralchat.pro/dashboard, las stats (bots, operaciones, volumen, PnL) quedan en 0.
Solo carga después de varios minutos. El `loadOverview()` en dashboard.js hace fetch a `/api/trading/bots` y `/api/trading/trades/summary`.
Posible causa: el token JWT no está en el header al hacer la primera request, o los endpoints fallan silenciosamente.

### 3. FALTA PÁGINA COMPLETA DE BINANCE/CRYPTO
El panel de Cocos Capital tiene UI completa (3 columnas: fondos/cartera, mercado, IA).
Necesito lo mismo pero para Binance/Crypto:
- Página: `public/binance.html` (nuevo)
- Columna izquierda: Balance USDT, posiciones abiertas, formulario de orden manual
- Columna centro: Tabla de mercado crypto (top 10-20 pares con precio, variación, RSI, señal IA)
- Columna derecha: Agente IA (on/off, configuración, análisis recientes, señales)
- Link en el sidebar del dashboard

### 4. getTicker FALLA PARA SOL, ETH, etc.
`getTicker` usa CoinGecko que no siempre devuelve datos. El crypto-trader ahora intenta Binance primero (via proxy ccxt) pero como el proxy no funciona en ccxt, falla para muchos pares.
Solución: hacer que getTicker use Binance via proxy cuando está disponible.

## LO QUE FUNCIONA
- ✅ IA analiza mercado + noticias y genera señales (GPT-4o-mini)
- ✅ Paper trading funciona (crea posiciones con precios reales de CoinGecko)
- ✅ Monitor de posiciones cada 30s (SL/TP/trailing)
- ✅ Noticias scrapeadas de Google (688+ noticias crypto)
- ✅ WebSocket para precios en vivo
- ✅ Túnel SSH funciona (curl con socks5 llega a Binance)
- ✅ API key de Binance guardada y encriptada en DB
- ✅ Panel Cocos Capital completo (para acciones argentinas)
- ✅ Sistema RAG con documentos

## LO QUE FALTA
1. **FIX ccxt + proxy SOCKS** — para que las órdenes vayan LIVE a Binance
2. **Página Binance completa** — como cocos.html pero para crypto (balance, mercado, IA, señales)
3. **Dashboard que cargue datos siempre** — fix del loadOverview
4. **getTicker robusto** — que use Binance via proxy primero, CoinGecko fallback
5. **Mostrar balance real de Binance** en el dashboard y en la nueva página

## REGLAS IMPORTANTES
- NO usar `run_build` (no hay .sln ni compilación)
- Archivos modulares de 500-700 líneas máximo
- Mobile-first responsive
- Usar `;` como separador en PowerShell, NO `&&`
- Todo cambio via git push, NUNCA scp
- NO tocar la funcionalidad de Cocos Capital que ya funciona
- Siempre `export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin;` antes de comandos SSH
