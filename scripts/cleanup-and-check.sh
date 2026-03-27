#!/bin/bash
# Close any remaining open crypto positions in DB
echo "=== Cerrando posiciones crypto abiertas en DB ==="
sqlite3 /var/www/autotrader/data/autotrader.db "UPDATE crypto_positions SET status='CLOSED', reason=reason || ' | Cerrada manual - Binance desactivado', closed_at=CURRENT_TIMESTAMP WHERE status='OPEN';"
echo "Posiciones cerradas: $(sqlite3 /var/www/autotrader/data/autotrader.db "SELECT changes();")"

echo ""
echo "=== Verificando crypto_config ==="
sqlite3 /var/www/autotrader/data/autotrader.db "SELECT enabled, scalper_enabled FROM crypto_config WHERE id=1;"

echo ""
echo "=== Posiciones Cocos activas ==="
sqlite3 /var/www/autotrader/data/autotrader.db "SELECT id, ticker, quantity, printf('%.2f', price) as price, currency, status, printf('%.2f', stop_loss_price) as sl, printf('%.2f', take_profit_price) as tp, substr(created_at,1,16) as created FROM auto_investments WHERE action='BUY' AND status='EXECUTED' ORDER BY created_at DESC;"
