#!/bin/bash
cd /var/www/autotrader
echo "=== Trades de hoy ==="
sqlite3 data/autotrader.db "SELECT COUNT(*) as trades_hoy FROM crypto_positions WHERE order_id NOT LIKE 'PAPER%' AND created_at >= date('now') AND side = 'BUY';"
echo ""
echo "=== Posiciones abiertas ==="
sqlite3 data/autotrader.db "SELECT id, symbol, quantity, entry_price, current_price, stop_loss, take_profit, status FROM crypto_positions WHERE status='OPEN';"
echo ""
echo "=== Config ==="
sqlite3 data/autotrader.db "SELECT stop_loss_pct, take_profit_pct, analysis_interval_min FROM crypto_config WHERE id=1;"
