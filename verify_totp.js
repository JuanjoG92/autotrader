const secret = '6557EM6W55WGBRH7A5VEMVM3Q66IIQJC';
const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
let bits = 0, val = 0, bytes = [];
for (const c of secret.toUpperCase().replace(/=+$/, '')) {
  const idx = alpha.indexOf(c);
  if (idx < 0) continue;
  val = (val << 5) | idx;
  bits += 5;
  if (bits >= 8) { bits -= 8; bytes.push((val >> bits) & 0xFF); }
}
const key = Buffer.from(bytes);
const crypto = require('crypto');
const counter = Math.floor(Date.now() / 1000 / 30);
const buf = Buffer.alloc(8);
buf.writeBigUInt64BE(BigInt(counter));
const hmac = crypto.createHmac('sha1', key).update(buf).digest();
const offset = hmac[hmac.length - 1] & 0xf;
const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset+1] << 16 | hmac[offset+2] << 8 | hmac[offset+3]) % 1000000;
console.log('Codigo TOTP actual:', String(code).padStart(6, '0'));
console.log('Verificalo en Google Authenticator - deben coincidir');
