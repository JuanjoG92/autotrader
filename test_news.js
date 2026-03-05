require('dotenv').config();
async function test() {
  const url = 'https://news.google.com/rss/search?q=bolsa+argentina&hl=es-419&gl=AR&ceid=AR:es-419';
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    }
  });
  console.log('Status:', res.status, 'Content-Type:', res.headers.get('content-type'));
  const text = await res.text();
  console.log('Length:', text.length, 'First 200:', text.substring(0, 200));
  const items = text.match(/<item/g);
  console.log('Items found:', items ? items.length : 0);
}
test().catch(console.error);
