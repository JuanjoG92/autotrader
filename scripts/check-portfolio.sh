#!/bin/bash
echo "=== POSICIONES ACTIVAS COCOS ==="
sqlite3 /var/www/autotrader/data/autotrader.db "SELECT id, ticker, quantity, price, total_ars, currency, status, stop_loss_price, take_profit_price, created_at FROM auto_investments WHERE action='BUY' AND status='EXECUTED' ORDER BY created_at DESC;"

echo ""
echo "=== HISTORIAL RECIENTE (últimas 10) ==="
sqlite3 /var/www/autotrader/data/autotrader.db "SELECT id, ticker, action, quantity, price, total_ars, currency, status, substr(created_at,1,16) FROM auto_investments ORDER BY created_at DESC LIMIT 10;"

echo ""
echo "=== PM2 CPU/MEM ==="
pm2 jlist 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); [print(f\"{p['name']}: cpu={p['monit']['cpu']}% mem={round(p['monit']['memory']/1024/1024)}MB\") for p in d if p['name']=='autotrader']"
