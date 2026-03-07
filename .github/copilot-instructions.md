# Copilot Instructions - AutoTrader

## Proyecto
Plataforma de trading automatizado con IA. Conecta la cuenta de Binance del usuario via API Key y ejecuta operaciones automáticamente con estrategias (SMA, RSI, MACD).

## Stack técnico
- **Frontend**: HTML5 + CSS3 + JavaScript vanilla (NO frameworks)
- **Backend**: Node.js + Express
- **DB**: SQLite (better-sqlite3)
- **Exchange API**: ccxt (Binance y otros)
- **Deploy**: PM2 en VPS
- **NO hay .sln ni compilación**. NUNCA usar `run_build`.

## Repositorio Git
- **Repo**: `https://github.com/tecnocentersistemas/autotrader.git`
- **Branch principal**: `main`
- **Carpeta local**: `C:\autotrader`

## VPS
- IP: `172.96.8.245`
- SSH: `ssh -i "$env:USERPROFILE\.ssh\nueva_llave" root@172.96.8.245`
- Ruta: `/var/www/autotrader`
- Puerto: 3800

## Reglas
- Archivos modulares de 500-700 líneas máximo.
- Mobile-first responsive.
- Usar `;` como separador en PowerShell, NO `&&`.
- NUNCA usar `run_build`.
- Todo cambio via git push, NUNCA scp.
- Cuando necesites ejecutar comandos en el VPS (como consultas sqlite3), crea un archivo de script local, haz commit y push, y luego ejecútalo en el VPS a través de SSH. No intentes ejecutar comandos SSH complejos en línea con comillas, ya que fallan. Siempre utiliza el flujo de trabajo de git commit+push para cualquier cambio de código.
