#!/bin/bash
cd /var/www/autotrader
sqlite3 data/autotrader.db "UPDATE crypto_config SET enabled = 1 WHERE id = 1;"
echo "Bot reactivado"
