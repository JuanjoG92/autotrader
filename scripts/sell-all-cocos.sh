#!/bin/bash
# Script para vender TODAS las posiciones en Cocos
# Ejecutar: bash /var/www/autotrader/scripts/sell-all-cocos.sh
# O via cron para market open: 35 13 * * 1-5 bash /var/www/autotrader/scripts/sell-all-cocos.sh

echo "============================================"
echo "  SELL ALL COCOS POSITIONS"
echo "  $(date)"
echo "============================================"

# Llamar al endpoint sell-all del servidor local
RESULT=$(curl -s --max-time 120 -X POST http://localhost:3800/api/cocos/sell-all)

echo ""
echo "Resultado:"
echo "$RESULT" | python3 -m json.tool 2>/dev/null || echo "$RESULT"
echo ""
echo "============================================"
echo "  COMPLETADO: $(date)"
echo "============================================"
