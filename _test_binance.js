// Test: conexion Binance + balance + orden test
const { getBalances, testConnection, getTicker } = require('./src/services/binance');

async function test() {
  console.log('=== TEST CONEXION BINANCE ===\n');
  
  // 1. Test connection
  console.log('1. Probando conexion...');
  try {
    const r = await testConnection(1, 1);
    console.log('   ✅ Conexion OK -', r.totalAssets, 'activos');
  } catch (e) {
    console.log('   ❌ Error:', e.message);
    return;
  }

  // 2. Balance
  console.log('\n2. Obteniendo balance...');
  try {
    const bal = await getBalances(1, 1);
    const entries = Object.entries(bal).filter(([k,v]) => v.total > 0);
    if (entries.length === 0) {
      console.log('   ⚠️ Cuenta vacia - necesitas depositar USDT para operar');
    } else {
      entries.forEach(([coin, info]) => {
        console.log(`   ${coin}: ${info.total} (libre: ${info.free}, en uso: ${info.used})`);
      });
    }
  } catch (e) {
    console.log('   ❌ Error balance:', e.message);
  }

  // 3. Precio BTC
  console.log('\n3. Precio BTC/USDT...');
  try {
    const t = await getTicker('BTC/USDT');
    console.log(`   BTC: $${t.last} | 24h: ${t.percentage?.toFixed(1)}%`);
  } catch (e) {
    console.log('   ❌ Error:', e.message);
  }
  
  console.log('\n=== TEST COMPLETO ===');
}

test().catch(e => console.error('Fatal:', e.message));
