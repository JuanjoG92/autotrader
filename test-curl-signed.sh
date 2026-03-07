#!/bin/bash
APIKEY="XvcLbTYUk1AZwalknb7DVCwWIpUDeKQPit6cQjCEeksgce64neMn2rg8PODqyoSs"
APISECRET="6fRmyguWO8XnEcTA0ao63EpjqxiSZOAwIWwIP4KhBEaYSbZkKJNw2j7BKIOGABwC"
TS=$(date +%s000)
PARAMS="timestamp=$TS"
SIG=$(echo -n "$PARAMS" | openssl dgst -sha256 -hmac "$APISECRET" | awk '{print $2}')

echo "=== Con proxy SOCKS (IP argentina) ==="
curl -s --socks5 127.0.0.1:1080 "https://api.binance.com/api/v3/account?${PARAMS}&signature=${SIG}" -H "X-MBX-APIKEY: ${APIKEY}"
echo ""

echo "=== Sin proxy (IP VPS directo) ==="
curl -s --connect-timeout 5 "https://api.binance.com/api/v3/account?${PARAMS}&signature=${SIG}" -H "X-MBX-APIKEY: ${APIKEY}"
echo ""
