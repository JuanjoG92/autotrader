#!/bin/bash
cd /var/www/autotrader
echo "=== POSICIONES ABIERTAS ==="
sqlite3 data/autotrader.db "SELECT symbol, quantity, entry_price, current_price, stop_loss, take_profit, status, substr(reason,1,50), created_at FROM crypto_positions WHERE status='OPEN';"
echo ""
echo "=== ULTIMAS 10 CERRADAS ==="
sqlite3 data/autotrader.db "SELECT symbol, entry_price, sell_price, pnl, fees, status, substr(reason,1,40), created_at FROM crypto_positions WHERE status!='OPEN' ORDER BY closed_at DESC LIMIT 10;"
echo ""
echo "=== BALANCE TOTAL ==="
sqlite3 data/autotrader.db "SELECT SUM(pnl) as total_pnl, COUNT(*) as trades FROM crypto_positions WHERE status!='OPEN';"
echo ""
echo "=== CONFIG CRYPTO ==="
sqlite3 data/autotrader.db "SELECT * FROM crypto_config WHERE id=1;"
