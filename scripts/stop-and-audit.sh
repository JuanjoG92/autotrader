#!/bin/bash
cd /var/www/autotrader

echo "=== 1. DESACTIVAR BOT VOLATIL ==="
sqlite3 data/autotrader.db "UPDATE crypto_config SET enabled = 0 WHERE id = 1;"
echo "Bot de volatiles: DESACTIVADO"

echo ""
echo "=== 2. POSICIONES ABIERTAS ==="
sqlite3 data/autotrader.db "SELECT id, symbol, quantity, ROUND(entry_price,4) as entry, ROUND(current_price,4) as current, ROUND(stop_loss,4) as sl, ROUND(take_profit,4) as tp, ROUND((current_price - entry_price) / entry_price * 100, 1) as pnl_pct FROM crypto_positions WHERE status='OPEN';"

echo ""
echo "=== 3. BALANCE COMPLETO ==="
sqlite3 data/autotrader.db "SELECT * FROM crypto_config WHERE id=1;"

echo ""
echo "=== 4. PnL TOTAL ACUMULADO (solo LIVE, sin PAPER) ==="
sqlite3 data/autotrader.db "SELECT ROUND(SUM(pnl),2) as pnl_total, COUNT(*) as trades, SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END) as wins, SUM(CASE WHEN pnl<=0 THEN 1 ELSE 0 END) as losses FROM crypto_positions WHERE status='CLOSED' AND order_id NOT LIKE 'PAPER%';"

echo ""
echo "=== 5. PÉRDIDAS por tipo de cripto ==="
sqlite3 data/autotrader.db "
SELECT 
  CASE 
    WHEN symbol IN ('BTC/USDT','ETH/USDT','BNB/USDT','SOL/USDT','XRP/USDT','ADA/USDT') THEN 'ESTABLE'
    ELSE 'VOLATIL'
  END as tipo,
  symbol,
  COUNT(*) as trades,
  ROUND(SUM(pnl),2) as pnl
FROM crypto_positions 
WHERE status='CLOSED' AND order_id NOT LIKE 'PAPER%'
GROUP BY symbol
ORDER BY tipo, pnl DESC;
"

echo ""
echo "=== 6. PnL solo ESTABLES vs solo VOLATILES ==="
sqlite3 data/autotrader.db "
SELECT 
  CASE 
    WHEN symbol IN ('BTC/USDT','ETH/USDT','BNB/USDT','SOL/USDT','XRP/USDT','ADA/USDT') THEN 'ESTABLE'
    ELSE 'VOLATIL'
  END as tipo,
  COUNT(*) as trades,
  ROUND(SUM(pnl),2) as pnl_total,
  ROUND(AVG(pnl),2) as pnl_promedio
FROM crypto_positions 
WHERE status='CLOSED' AND order_id NOT LIKE 'PAPER%'
GROUP BY tipo;
"
