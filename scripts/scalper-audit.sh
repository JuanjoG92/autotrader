#!/bin/bash
cd /var/www/autotrader
echo "=== TRADES SCALPER ==="
sqlite3 data/autotrader.db "SELECT symbol, ROUND(pnl,2) as pnl, substr(reason,1,50) as motivo FROM crypto_positions WHERE order_id LIKE 'SCALP%' ORDER BY id DESC LIMIT 10;"
echo ""
echo "=== PnL TOTAL SCALPER ==="
sqlite3 data/autotrader.db "SELECT COUNT(*) as trades, ROUND(SUM(pnl),2) as pnl_total FROM crypto_positions WHERE order_id LIKE 'SCALP%' AND status='CLOSED';"
echo ""
echo "=== POSICIONES ABIERTAS ==="
sqlite3 data/autotrader.db "SELECT symbol, ROUND(entry_price,4), ROUND(current_price,4), ROUND((current_price-entry_price)/entry_price*100,1) as pnl_pct, order_id FROM crypto_positions WHERE status='OPEN';"
echo ""
echo "=== BALANCE ==="
sqlite3 data/autotrader.db "SELECT enabled FROM crypto_config WHERE id=1;"
