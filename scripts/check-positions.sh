#!/bin/bash
sqlite3 /var/www/autotrader/data/autotrader.db "SELECT id, symbol, quantity, entry_price, current_price, stop_loss, take_profit, status, substr(order_id,1,15) as oid FROM crypto_positions WHERE status = 'OPEN' ORDER BY id DESC LIMIT 10;"
echo "---"
echo "Balance coins in wallet:"
sqlite3 /var/www/autotrader/data/autotrader.db "SELECT id, symbol, quantity, entry_price, current_price, pnl, status, substr(order_id,1,15) as oid FROM crypto_positions ORDER BY id DESC LIMIT 15;"
