require('dotenv').config();
const { initDB, getDB } = require('./src/models/db');
const { encrypt, decrypt } = require('./src/services/encryption');
initDB();
const db = getDB();
const KEY = 'XGy0MRStzN9aiqvs6UwP7EhtHEkhQjSkeDM6Ybj565Zem6bwP4bLqEMPI9StNJZI';
const SEC = 'fdswazh6xB6euw9Czlc9hce8N6P7TcIymIN36rkJDXEMhw3BPb2w9wQAq3AFuFnp';
const ek = encrypt(KEY);
const es = encrypt(SEC);
if (decrypt(ek) !== KEY || decrypt(es) !== SEC) { console.log('ENCRYPT MISMATCH!'); process.exit(1); }
db.prepare('UPDATE api_keys SET api_key_enc=?, api_secret_enc=? WHERE id=1').run(ek, es);
console.log('API KEY SAVED AND VERIFIED OK');
