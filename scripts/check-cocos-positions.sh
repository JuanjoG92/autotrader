#!/bin/bash
cd /var/www/autotrader
echo "=== POSICIONES COCOS ACTIVAS ==="
sqlite3 data/autotrader.db "SELECT ticker, quantity, price, stop_loss_price, take_profit_price, currency, status, reason FROM auto_investments WHERE action='BUY' AND status IN ('EXECUTED','PENDING');"
echo ""
echo "=== HISTORIAL HOY ==="
sqlite3 data/autotrader.db "SELECT ticker, action, quantity, price, status, currency, reason, created_at FROM auto_investments WHERE date(created_at) >= date('now','-1 day') ORDER BY created_at DESC LIMIT 20;"
