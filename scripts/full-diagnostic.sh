#!/bin/bash
cd /var/www/autotrader
echo "============================================"
echo "  DIAGNÓSTICO COMPLETO DEL BOT"
echo "============================================"

echo ""
echo "=== 1. POSICIONES ABIERTAS ==="
sqlite3 data/autotrader.db "SELECT id, symbol, quantity, entry_price, current_price, stop_loss, take_profit, ROUND((current_price - entry_price) / entry_price * 100, 2) as pnl_pct, created_at FROM crypto_positions WHERE status='OPEN' AND order_id NOT LIKE 'PAPER%';"

echo ""
echo "=== 2. ÚLTIMAS 15 OPERACIONES CERRADAS (con fees y sell_price) ==="
sqlite3 data/autotrader.db "SELECT id, symbol, quantity, ROUND(entry_price,4) as entry, ROUND(sell_price,4) as sell, ROUND(pnl,4) as pnl, ROUND(fees,4) as fees, substr(reason,1,50), created_at, closed_at FROM crypto_positions WHERE status='CLOSED' AND order_id NOT LIKE 'PAPER%' ORDER BY id DESC LIMIT 15;"

echo ""
echo "=== 3. WIN RATE ==="
sqlite3 data/autotrader.db "
SELECT 
  COUNT(*) as total,
  SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
  SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses,
  ROUND(CAST(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS FLOAT) / COUNT(*) * 100, 1) as win_rate_pct,
  ROUND(SUM(pnl), 2) as pnl_total,
  ROUND(AVG(CASE WHEN pnl > 0 THEN pnl END), 4) as avg_win,
  ROUND(AVG(CASE WHEN pnl <= 0 THEN pnl END), 4) as avg_loss
FROM crypto_positions WHERE status='CLOSED' AND order_id NOT LIKE 'PAPER%';
"

echo ""
echo "=== 4. PnL por SÍMBOLO ==="
sqlite3 data/autotrader.db "SELECT symbol, COUNT(*) as trades, SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END) as wins, ROUND(SUM(pnl),2) as pnl_total FROM crypto_positions WHERE status='CLOSED' AND order_id NOT LIKE 'PAPER%' GROUP BY symbol ORDER BY pnl_total DESC;"

echo ""
echo "=== 5. CONFIG ACTUAL ==="
sqlite3 data/autotrader.db "SELECT enabled, api_key_id, max_per_trade_usd, min_confidence, risk_level, stop_loss_pct, take_profit_pct, analysis_interval_min FROM crypto_config WHERE id=1;"

echo ""
echo "=== 6. OPERACIONES QUE DURARON MENOS DE 10 MIN (compra-venta rápida = mala señal) ==="
sqlite3 data/autotrader.db "
SELECT id, symbol, ROUND(entry_price,4) as entry, ROUND(sell_price,4) as sell, ROUND(pnl,4) as pnl,
  ROUND((julianday(closed_at) - julianday(created_at)) * 24 * 60, 1) as min_duracion
FROM crypto_positions 
WHERE status='CLOSED' AND order_id NOT LIKE 'PAPER%' AND closed_at IS NOT NULL
  AND (julianday(closed_at) - julianday(created_at)) * 24 * 60 < 10
ORDER BY id DESC;
"

echo ""
echo "=== 7. CRIPTO COMPRADA Y VENDIDA MÁS DE 3 VECES (loop detection) ==="
sqlite3 data/autotrader.db "SELECT symbol, COUNT(*) as veces, ROUND(SUM(pnl),2) as pnl_acum FROM crypto_positions WHERE status='CLOSED' AND order_id NOT LIKE 'PAPER%' GROUP BY symbol HAVING COUNT(*) >= 3 ORDER BY veces DESC;"

echo ""
echo "=== 8. BALANCE ACTUAL via API ==="
curl -s --max-time 10 http://localhost:3800/api/crypto/balance 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Total USD: \${d.get(\"_totalUSD\",0)}')" 2>/dev/null || echo "No se pudo leer balance"

echo ""
echo "=== 9. PROXY STATUS ==="
curl -s --max-time 5 --socks5 127.0.0.1:1080 https://api.binance.com/api/v3/time 2>/dev/null && echo " PROXY OK" || echo " PROXY CAIDO"
