require('dotenv').config();
const{initDB,getDB}=require('./src/models/db');
const{createOrder,getTicker,getFirstBinanceBalance}=require('./src/services/binance');
initDB();
(async()=>{
console.log('=== COMPRA REAL ===');
const b1=await getFirstBinanceBalance();
console.log('USDT antes:',b1?.USDT?.free);
const t=await getTicker('XRP/USDT');
console.log('XRP:',t?.last);
const db=getDB();
const k=db.prepare("SELECT * FROM api_keys WHERE exchange='binance' LIMIT 1").get();
const q=parseFloat((5/t.last).toFixed(1));
console.log('Qty:',q,'XRP');
try{const o=await createOrder(k.user_id,k.id,'XRP/USDT','buy',q);
console.log('OK:',JSON.stringify(o).substring(0,300));}catch(e){console.log('FAIL:',e.message.substring(0,200));return;}
await new Promise(r=>setTimeout(r,2000));
const b2=await getFirstBinanceBalance();
console.log('USDT despues:',b2?.USDT?.free);
console.log('XRP:',b2?.XRP?.free||0);
console.log('Gasto:',((b1?.USDT?.free||0)-(b2?.USDT?.free||0)).toFixed(4));
})();
