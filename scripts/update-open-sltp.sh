#!/bin/bash
cd /var/www/autotrader
echo "=== Actualizando SL/TP de posiciones abiertas a 5%/15% ==="
sqlite3 data/autotrader.db "
UPDATE crypto_positions 
SET stop_loss = ROUND(entry_price * 0.95, 6),
    take_profit = ROUND(entry_price * 1.15, 6)
WHERE status = 'OPEN';
"
echo "=== Posiciones actualizadas ==="
sqlite3 data/autotrader.db "SELECT id, symbol, entry_price, stop_loss, take_profit, ROUND(stop_loss/entry_price*100-100,1) as sl_pct, ROUND(take_profit/entry_price*100-100,1) as tp_pct FROM crypto_positions WHERE status='OPEN';"

echo ""
echo "=== Config actual ==="
sqlite3 data/autotrader.db "SELECT stop_loss_pct, take_profit_pct FROM crypto_config WHERE id=1;"
