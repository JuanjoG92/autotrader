#!/bin/bash
# Recalcular PnL histórico: corregir posiciones con PnL=0 que deberían tener pérdida/ganancia real
cd /var/www/autotrader

echo "============================================"
echo "  RECALCULAR PnL HISTÓRICO"
echo "============================================"

echo ""
echo "=== ANTES: PnL total registrado ==="
sqlite3 data/autotrader.db "SELECT ROUND(SUM(pnl), 4) as pnl_registrado FROM crypto_positions WHERE status='CLOSED' AND order_id NOT LIKE 'PAPER%';"

echo ""
echo "=== Posiciones con PnL=0 que se van a corregir ==="
sqlite3 data/autotrader.db "SELECT id, symbol, quantity, entry_price, current_price, pnl FROM crypto_positions WHERE status='CLOSED' AND (pnl = 0 OR pnl IS NULL) AND current_price > 0 AND order_id NOT LIKE 'PAPER%';"

echo ""
echo "=== Aplicando corrección: PnL = (current - entry) * qty - fees(0.2%) ==="
sqlite3 data/autotrader.db "
UPDATE crypto_positions 
SET pnl = ROUND(
  (current_price - entry_price) * quantity 
  - (entry_price * quantity * 0.001) 
  - (current_price * quantity * 0.001), 
4)
WHERE status = 'CLOSED' 
  AND (pnl = 0 OR pnl IS NULL) 
  AND current_price > 0 
  AND order_id NOT LIKE 'PAPER%';
"

echo ""
echo "=== También corregir PnL existentes que no incluían fees ==="
sqlite3 data/autotrader.db "
UPDATE crypto_positions 
SET pnl = ROUND(
  (current_price - entry_price) * quantity 
  - (entry_price * quantity * 0.001) 
  - (current_price * quantity * 0.001), 
4)
WHERE status = 'CLOSED' 
  AND pnl != 0
  AND current_price > 0 
  AND order_id NOT LIKE 'PAPER%';
"

echo ""
echo "=== DESPUÉS: PnL total corregido ==="
sqlite3 data/autotrader.db "SELECT ROUND(SUM(pnl), 4) as pnl_corregido FROM crypto_positions WHERE status='CLOSED' AND order_id NOT LIKE 'PAPER%';"

echo ""
echo "=== PnL por símbolo (corregido) ==="
sqlite3 data/autotrader.db "SELECT symbol, ROUND(SUM(pnl), 4) as pnl, COUNT(*) as trades FROM crypto_positions WHERE status='CLOSED' AND order_id NOT LIKE 'PAPER%' GROUP BY symbol;"

echo ""
echo "=== Fees totales estimados ==="
sqlite3 data/autotrader.db "SELECT ROUND(SUM((entry_price * quantity + current_price * quantity) * 0.001), 4) as total_fees FROM crypto_positions WHERE status='CLOSED' AND order_id NOT LIKE 'PAPER%' AND current_price > 0;"

echo ""
echo "=== Verificación final ==="
sqlite3 data/autotrader.db "SELECT 
  COUNT(*) as total_live,
  ROUND(SUM(CASE WHEN pnl > 0 THEN pnl ELSE 0 END), 2) as ganancias,
  ROUND(SUM(CASE WHEN pnl < 0 THEN pnl ELSE 0 END), 2) as perdidas,
  ROUND(SUM(pnl), 2) as neto
FROM crypto_positions WHERE status='CLOSED' AND order_id NOT LIKE 'PAPER%';"
