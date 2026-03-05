#!/usr/bin/env python3
# Test conexión Cocos Capital via pyCocos
import os, sys
from dotenv import dotenv_values

cfg = dotenv_values('/var/www/autotrader/.env')
EMAIL    = cfg.get('COCOS_EMAIL', '')
PASSWORD = cfg.get('COCOS_PASSWORD', '')
TOTP     = cfg.get('COCOS_TOTP', '')

if not EMAIL or not PASSWORD:
    print('ERROR: COCOS_EMAIL y COCOS_PASSWORD no estan en .env')
    sys.exit(1)

print(f'Email: {EMAIL}')
print(f'TOTP: {"SI" if TOTP else "NO"}')

try:
    from pycocos import Cocos
    print('\nConectando con pyCocos...')
    app = Cocos(email=EMAIL, password=PASSWORD, topt_secret_key=TOTP if TOTP else None)
    print('LOGIN OK!')

    print('\n--- Market status ---')
    market = app.market_status()
    print(market)

    print('\n--- Portfolio ---')
    portfolio = app.my_portfolio()
    if isinstance(portfolio, dict):
        print('Keys:', list(portfolio.keys()))
    else:
        print(portfolio)

    print('\n--- Fondos disponibles ---')
    funds = app.funds_available()
    print(funds)

except Exception as e:
    print(f'ERROR: {e}')
    sys.exit(1)
