#!/bin/bash
# Test: verificar que podemos obtener quotes y selling-power para las posiciones reales
# Esto es lo que sell-all necesita funcionar

echo "=== Test Cocos API - Quotes y Selling Power ==="
echo "Fecha: $(date)"
echo ""

# PBR en USD (long_ticker debería ser PBRD-0002-C-CT-USD)
echo "--- PBR (USD) ---"
curl -s --max-time 20 "http://localhost:3800/api/cocos/debug-portfolio" | python3 -m json.tool 2>/dev/null
echo ""

# Necesitamos un endpoint sin auth para probar quotes
# Usamos el debug endpoint que ya existe, pero necesitamos uno para quotes
echo "--- Test getQuote via Node ---"
node -e "
const cocos = require('./src/services/cocos');
(async () => {
  // Esperar a que Cocos esté listo
  let tries = 0;
  while (!cocos.isReady() && tries < 30) { await new Promise(r => setTimeout(r, 1000)); tries++; }
  if (!cocos.isReady()) { console.log('Cocos no listo'); process.exit(1); }

  console.log('Cocos listo, probando quotes...');

  // Probar quote PBR en USD
  try {
    const q = await cocos.getQuote('PBR', 'C', 'USD');
    console.log('PBR USD:', JSON.stringify(q, null, 2));
  } catch(e) { console.log('PBR USD error:', e.message); }

  // Probar quote VIST en USD
  try {
    const q = await cocos.getQuote('VIST', 'C', 'USD');
    console.log('VIST USD:', JSON.stringify(q, null, 2));
  } catch(e) { console.log('VIST USD error:', e.message); }

  // Probar quote NVDA en USD
  try {
    const q = await cocos.getQuote('NVDA', 'C', 'USD');
    console.log('NVDA USD:', JSON.stringify(q, null, 2));
  } catch(e) { console.log('NVDA USD error:', e.message); }

  // Probar selling-power para PBR
  try {
    const sp = await cocos.getSellingPower('PBRD-0002-C-CT-USD');
    console.log('Selling Power PBRD:', JSON.stringify(sp));
  } catch(e) { console.log('SP PBRD error:', e.message); }

  process.exit(0);
})();
" 2>&1
