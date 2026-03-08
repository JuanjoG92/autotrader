#!/bin/bash
cd /var/www/autotrader
echo "=== PnL por símbolo ==="
sqlite3 data/autotrader.db "SELECT symbol, SUM(pnl) as total_pnl, COUNT(*) as trades FROM crypto_positions WHERE status='CLOSED' GROUP BY symbol;"
echo ""
echo "=== PnL TOTAL ==="
sqlite3 data/autotrader.db "SELECT SUM(pnl) as total_pnl, COUNT(*) as total_trades FROM crypto_positions WHERE status='CLOSED';"
echo ""
echo "=== Posición abierta ==="
sqlite3 data/autotrader.db "SELECT id, symbol, quantity, entry_price, current_price, stop_loss, take_profit, status FROM crypto_positions WHERE status='OPEN';"
echo ""
echo "=== Proxy test ==="
curl -s --max-time 5 --socks5 127.0.0.1:1080 https://api.binance.com/api/v3/time 2>/dev/null && echo " PROXY OK" || echo " PROXY CAIDO"
