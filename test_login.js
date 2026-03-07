// test_login.js — Prueba el flujo de login de Cocos (solo lectura, no guarda nada)
require('dotenv').config();

const BASE_URL = 'https://api.cocos.capital';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.ewogICJyb2xlIjogImFub24iLAogICJpc3MiOiAic3VwYWJhc2UiLAogICJpYXQiOiAxNzA0NjgyODAwLAogICJleHAiOiAxODYyNTM1NjAwCn0.f0w62k0q0eyyGBDkAP7vUUEg_Ingb9YbOlhsGCC4R3c';

const headers = {
  'Content-Type': 'application/json',
  'apikey': ANON_KEY,
  'Authorization': `Bearer ${ANON_KEY}`,
  'User-Agent': 'Mozilla/5.0',
};

(async () => {
  const email = process.env.COCOS_EMAIL;
  const password = process.env.COCOS_PASSWORD;
  const totpSecret = process.env.COCOS_TOTP;
  
  console.log('Email:', email ? email.substring(0,5) + '***' : 'MISSING');
  console.log('Password:', password ? 'SET' : 'MISSING');
  console.log('TOTP Secret:', totpSecret ? totpSecret.substring(0,6) + '***' : 'MISSING');
  
  // Paso 1: Login
  console.log('\n=== PASO 1: Login email+password ===');
  const loginRes = await fetch(`${BASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers,
    body: JSON.stringify({ email, password }),
  });
  const loginData = await loginRes.json();
  console.log('Status:', loginRes.status);
  console.log('Has access_token:', !!loginData.access_token);
  console.log('Has refresh_token:', !!loginData.refresh_token);
  console.log('Has mfa:', !!loginData.mfa);
  
  // Mostrar estructura (sin tokens completos)
  if (loginData.access_token) {
    console.log('access_token length:', loginData.access_token.length);
    console.log('expires_at:', loginData.expires_at);
    console.log('user.id:', loginData.user?.id);
    console.log('user.aal:', loginData.user?.aal);
    console.log('user.factors:', JSON.stringify(loginData.user?.factors?.map(f => ({ id: f.id, type: f.factor_type, status: f.status }))));
  }
  if (loginData.mfa) {
    console.log('MFA data:', JSON.stringify(loginData.mfa));
  }
  // Mostrar keys del response
  console.log('Response keys:', Object.keys(loginData));
  
  // Si hay factores MFA, probar challenge + verify
  const factors = loginData.user?.factors || loginData.mfa?.factors || [];
  const totpFactor = factors.find(f => f.factor_type === 'totp' && f.status === 'verified');
  
  if (totpFactor) {
    console.log('\n=== PASO 2: Challenge MFA ===');
    console.log('Factor ID:', totpFactor.id);
    
    const challengeHeaders = { ...headers, 'Authorization': `Bearer ${loginData.access_token}` };
    const challengeRes = await fetch(`${BASE_URL}/auth/v1/factors/${totpFactor.id}/challenge`, {
      method: 'POST', headers: challengeHeaders,
    });
    const challengeData = await challengeRes.json();
    console.log('Challenge status:', challengeRes.status);
    console.log('Challenge data:', JSON.stringify(challengeData));
    
    if (challengeData.id) {
      console.log('\n=== PASO 3: Verify TOTP ===');
      const crypto = require('crypto');
      // Generate TOTP
      const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      const clean = totpSecret.replace(/[\s=-]+/g, '').toUpperCase();
      let bits = '';
      for (const c of clean) { const v = base32Chars.indexOf(c); if (v>=0) bits += v.toString(2).padStart(5,'0'); }
      const keyBytes = [];
      for (let i = 0; i+8<=bits.length; i+=8) keyBytes.push(parseInt(bits.substring(i,i+8),2));
      const key = Buffer.from(keyBytes);
      const counter = Math.floor(Date.now()/1000/30);
      const cBuf = Buffer.alloc(8);
      cBuf.writeUInt32BE(Math.floor(counter/0x100000000),0);
      cBuf.writeUInt32BE(counter>>>0,4);
      const hmac = crypto.createHmac('sha1',key).update(cBuf).digest();
      const off = hmac[hmac.length-1]&0xf;
      const code = ((hmac[off]&0x7f)<<24|hmac[off+1]<<16|hmac[off+2]<<8|hmac[off+3])%1000000;
      const totpCode = code.toString().padStart(6,'0');
      console.log('TOTP code generated:', totpCode);
      
      const verifyRes = await fetch(`${BASE_URL}/auth/v1/factors/${totpFactor.id}/verify`, {
        method: 'POST', headers: challengeHeaders,
        body: JSON.stringify({ challenge_id: challengeData.id, code: totpCode }),
      });
      const verifyData = await verifyRes.json();
      console.log('Verify status:', verifyRes.status);
      console.log('Has access_token:', !!verifyData.access_token);
      console.log('Has refresh_token:', !!verifyData.refresh_token);
      if (verifyData.access_token) {
        console.log('access_token length:', verifyData.access_token.length);
        console.log('user.aal:', verifyData.user?.aal);
        console.log('\n✅ LOGIN MFA COMPLETO');
      } else {
        console.log('Verify response:', JSON.stringify(verifyData).substring(0, 500));
      }
    }
  } else if (!loginData.access_token) {
    console.log('\n❌ Login falló completamente');
    console.log('Response:', JSON.stringify(loginData).substring(0, 500));
  } else {
    console.log('\n⚠️ Login sin MFA — nivel bajo de seguridad (aal1)');
    console.log('Esto causa "Assurance level upgrade is required" en endpoints financieros');
  }
})();
