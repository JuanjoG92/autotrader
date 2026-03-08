#!/bin/bash
cd /var/www/autotrader
echo "=== Balance REAL de Binance ==="
curl -s --max-time 15 http://localhost:3800/api/crypto/balance 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'Total USD: \${d.get(\"_totalUSD\",0)}')
print(f'USDT libre: \${d.get(\"_freeUSDT\",0)}')
for k,v in d.items():
    if k.startswith('_') or k == 'error': continue
    t = v.get('total',0) if isinstance(v,dict) else 0
    f = v.get('free',0) if isinstance(v,dict) else 0
    if t > 0:
        print(f'  {k}: total={t} free={f}')
" 2>/dev/null || echo "Error leyendo balance"

echo ""
echo "=== Posiciones ABIERTAS en DB ==="
sqlite3 data/autotrader.db "SELECT id, symbol, quantity, entry_price, current_price, stop_loss, take_profit, status FROM crypto_positions WHERE status='OPEN';"

echo ""
echo "=== Posiciones CERRADAS recientes ==="
sqlite3 data/autotrader.db "SELECT id, symbol, ROUND(pnl,2) as pnl, ROUND(sell_price,4) as sell, ROUND(fees,3) as fees, substr(reason,-30) as motivo FROM crypto_positions WHERE status='CLOSED' AND order_id NOT LIKE 'PAPER%' ORDER BY id DESC LIMIT 5;"
