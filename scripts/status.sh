#!/bin/bash
cd /var/www/autotrader
echo "=== ESTADO ACTUAL ==="
echo ""
echo "--- Posiciones abiertas ---"
sqlite3 data/autotrader.db "SELECT symbol, ROUND(entry_price,4) as entrada, ROUND(current_price,4) as actual, ROUND((current_price - entry_price) / entry_price * 100, 2) as pnl_pct, ROUND(stop_loss,4) as sl, ROUND(take_profit,4) as tp FROM crypto_positions WHERE status='OPEN';"
echo ""
echo "--- Config ---"
sqlite3 data/autotrader.db "SELECT enabled, stop_loss_pct, take_profit_pct, analysis_interval_min FROM crypto_config WHERE id=1;"
echo ""
echo "--- Errores recientes ---"
wc -l /root/.pm2/logs/autotrader-error.log 2>/dev/null || echo "0 errores"
