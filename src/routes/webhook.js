const express = require('express');
const crypto = require('crypto');
const { execSync } = require('child_process');
const router = express.Router();

router.post('/github', (req, res) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return res.status(500).send('Webhook not configured');

  const sig = req.headers['x-hub-signature-256'] || '';
  const hmac = 'sha256=' + crypto.createHmac('sha256', secret).update(JSON.stringify(req.body)).digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(hmac))) {
    return res.status(401).send('Invalid signature');
  }

  try {
    execSync('cd /var/www/autotrader && git pull origin main', { timeout: 30000 });
    execSync('cd /var/www/autotrader && npm install --production', { timeout: 60000 });
    execSync('pm2 restart autotrader', { timeout: 10000 });
    res.send('Deployed');
  } catch (err) {
    console.error('Deploy error:', err.message);
    res.status(500).send('Deploy failed');
  }
});

module.exports = router;
