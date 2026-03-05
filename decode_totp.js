const data = 'CjgKFPd78jPW72xgxP8HakZVm4e8hEEiEgVjb2NvcyABKAEwAkITODgzMzE3MTc3MjI1MjQxMTAzOBACGAEgAA==';
const buf = Buffer.from(data, 'base64');
const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(bytes) {
  let bits = 0, val = 0, out = '';
  for (const byte of bytes) {
    val = (val << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; out += alpha[(val >> bits) & 31]; }
  }
  if (bits > 0) out += alpha[(val << (5 - bits)) & 31];
  return out;
}

function readVarint(buf, i) {
  let result = 0, shift = 0, b;
  do { b = buf[i++]; result |= (b & 0x7F) << shift; shift += 7; } while (b & 0x80);
  return { value: result, pos: i };
}

let i = 0;
while (i < buf.length) {
  const tag = buf[i++];
  const fieldNum = tag >> 3;
  const wireType = tag & 0x7;
  if (wireType === 2) {
    const v = readVarint(buf, i); i = v.pos;
    const inner = buf.slice(i, i + v.value);
    if (fieldNum === 1) {
      let j = 0;
      while (j < inner.length) {
        const t2 = inner[j++];
        const f2 = t2 >> 3; const w2 = t2 & 0x7;
        if (w2 === 2) {
          const v2 = readVarint(inner, j); j = v2.pos;
          const val = inner.slice(j, j + v2.value);
          if (f2 === 1) console.log('TOTP_SECRET=' + base32(val));
          if (f2 === 2) console.log('NAME=' + val.toString('utf8'));
          j += v2.value;
        } else if (w2 === 0) {
          const v3 = readVarint(inner, j); j = v3.pos;
        } else break;
      }
    }
    i += v.value;
  } else if (wireType === 0) {
    const v = readVarint(buf, i); i = v.pos;
  } else break;
}
