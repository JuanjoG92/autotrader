#!/bin/bash
set -e

echo "=== AutoTrader VPS Setup ==="

# 1. Clone repo
if [ ! -d "/var/www/autotrader" ]; then
  echo "Cloning repo..."
  cd /var/www
  git clone https://github.com/JuanjoG92/autotrader.git
else
  echo "Repo exists, pulling latest..."
  cd /var/www/autotrader
  git pull origin main
fi

cd /var/www/autotrader

# 2. Install dependencies
echo "Installing dependencies..."
npm install --production

# 3. Create .env
echo "Creating .env..."
JWT_SECRET=$(openssl rand -hex 32)
ENC_KEY=$(openssl rand -hex 32)
WH_SECRET=$(openssl rand -hex 16)

cat > .env << EOF
PORT=3800
JWT_SECRET=$JWT_SECRET
ENCRYPTION_KEY=$ENC_KEY
WEBHOOK_SECRET=$WH_SECRET
DOMAIN=autotrader.centralchat.pro
EOF

# 4. Create data directory
mkdir -p data

# 5. Setup Nginx
echo "Configuring Nginx..."
cat > /etc/nginx/sites-available/autotrader << 'NGINX'
server {
    listen 80;
    server_name autotrader.centralchat.pro;

    location / {
        proxy_pass http://127.0.0.1:3800;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
NGINX

# Enable site
ln -sf /etc/nginx/sites-available/autotrader /etc/nginx/sites-enabled/autotrader

# Test and reload nginx
nginx -t && systemctl reload nginx

# 6. Start with PM2
echo "Starting with PM2..."
cd /var/www/autotrader
pm2 delete autotrader 2>/dev/null || true
pm2 start server.js --name autotrader
pm2 save

echo ""
echo "=== Setup complete ==="
echo "App running at: http://autotrader.centralchat.pro"
echo "Now run: certbot --nginx -d autotrader.centralchat.pro"
