#!/bin/bash
echo "=== Posiciones OPEN en DB ==="
sqlite3 /var/www/autotrader/data/autotrader.db "SELECT id, symbol, round(quantity,6) as qty, round(entry_price,4) as entry, round(current_price,4) as current, round(stop_loss,4) as sl, round(take_profit,4) as tp, substr(order_id,1,15) as oid FROM crypto_positions WHERE status = 'OPEN';"
echo ""
echo "=== Ultimas 5 posiciones CLOSED ==="
sqlite3 /var/www/autotrader/data/autotrader.db "SELECT id, symbol, round(pnl,4) as pnl, round(entry_price,4) as entry, round(sell_price,4) as sell, substr(reason,1,50) as reason FROM crypto_positions WHERE status = 'CLOSED' ORDER BY id DESC LIMIT 5;"
