#!/bin/bash
cd /var/www/autotrader
sqlite3 data/autotrader.db "DELETE FROM auto_investments WHERE status = 'FAILED';"
echo "Borrados. Restantes:"
sqlite3 data/autotrader.db "SELECT COUNT(*) FROM auto_investments;"
