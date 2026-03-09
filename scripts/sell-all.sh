#!/bin/bash
cd /var/www/autotrader

echo "=== VENDIENDO TODO ==="

# Get all open positions
POSITIONS=$(sqlite3 data/autotrader.db "SELECT id, symbol, quantity, entry_price, order_id FROM crypto_positions WHERE status='OPEN';")

if [ -z "$POSITIONS" ]; then
  echo "No hay posiciones abiertas"
  exit 0
fi

echo "$POSITIONS"
echo ""

# Use the API to sell each position
while IFS='|' read -r id symbol qty entry oid; do
  echo "Vendiendo $symbol (id=$id, qty=$qty)..."
  # Call the sell endpoint
  RESULT=$(curl -s -X POST "http://localhost:3800/api/crypto/sell" \
    -H "Content-Type: application/json" \
    -d "{\"positionId\": $id}" 2>/dev/null)
  echo "  Resultado: $RESULT"
  sleep 2
done <<< "$POSITIONS"

echo ""
echo "=== ESTADO FINAL ==="
sqlite3 data/autotrader.db "SELECT id, symbol, status, ROUND(pnl,2) as pnl FROM crypto_positions WHERE id IN (SELECT id FROM crypto_positions ORDER BY id DESC LIMIT 10) ORDER BY id DESC;"
