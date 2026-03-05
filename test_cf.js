const cloudscraper = require('cloudscraper');
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.ewogICJyb2xlIjogImFub24iLAogICJpc3MiOiAic3VwYWJhc2UiLAogICJpYXQiOiAxNzA0NjgyODAwLAogICJleHAiOiAxODYyNTM1NjAwCn0.f0w62k0q0eyyGBDkAP7vUUEg_Ingb9YbOlhsGCC4R3c';

const options = {
  uri: 'https://api.cocos.capital/api/v1/calendar/open-market',
  headers: {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
  }
};

console.log('Probando cloudscraper...');
cloudscraper.get(options, function(err, res, body) {
  if (err) {
    console.log('Error:', err.message || err);
  } else {
    console.log('Status:', res.statusCode);
    console.log('Body:', body.substring(0, 300));
  }
});
