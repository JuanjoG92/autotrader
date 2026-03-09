#!/bin/bash
cd /var/www/autotrader
export $(cat .env | grep -v '^#' | xargs)
node scripts/force-sell-all.js
