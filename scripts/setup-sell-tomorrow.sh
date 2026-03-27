#!/bin/bash
# Desactivar auto-invest y programar venta para mañana a las 10:40 ART
# Ejecutar: bash /var/www/autotrader/scripts/setup-sell-tomorrow.sh

DB="/var/www/autotrader/data/autotrader.db"

echo "=== Desactivando Auto-Invest ==="
sqlite3 "$DB" "UPDATE auto_invest_config SET enabled = 0 WHERE id = 1;"
echo "Auto-invest: DESACTIVADO"

echo ""
echo "=== Posiciones activas en DB ==="
sqlite3 "$DB" -header -column "SELECT id, ticker, quantity, price, currency, status, created_at FROM auto_investments WHERE action='BUY' AND status='EXECUTED';"

echo ""
echo "=== Programando venta para mañana 10:40 ART (13:40 UTC) ==="
# Eliminar cron anterior si existe
crontab -l 2>/dev/null | grep -v 'sell-all-cocos' | crontab -

# Agregar cron: 10:40 ART = 13:40 UTC, L-V
(crontab -l 2>/dev/null; echo "40 13 * * 1-5 bash /var/www/autotrader/scripts/sell-all-cocos.sh >> /var/www/autotrader/logs/sell-all.log 2>&1") | crontab -

echo "Cron configurado:"
crontab -l | grep sell-all
echo ""
echo "=== LISTO — Mañana a las 10:40 ART se venderá todo ==="
