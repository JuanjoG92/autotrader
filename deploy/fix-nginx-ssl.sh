#!/bin/bash
cat > /etc/nginx/sites-available/autotrader << 'ENDNGINX'
server {
    listen 80;
    server_name autotrader.centralchat.pro;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name autotrader.centralchat.pro;

    ssl_certificate /etc/letsencrypt/live/autotrader.centralchat.pro/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/autotrader.centralchat.pro/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

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
ENDNGINX

nginx -t 2>&1 && systemctl reload nginx && echo "NGINX_OK"
