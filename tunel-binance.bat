@echo off
:: Túnel SSH para Binance - Corre en segundo plano
:: Tu PC (Argentina) hace de puente para que el VPS llegue a Binance
:: NO CERRAR esta ventana mientras quieras que el bot opere en REAL

title AutoTrader - Tunel Binance (NO CERRAR)
echo ============================================
echo   TUNEL BINANCE ACTIVO
echo   Tu PC conecta el VPS con Binance
echo   NO cierres esta ventana
echo ============================================
echo.
echo Conectando...

:loop
ssh -R 1080 -N -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -i "%USERPROFILE%\.ssh\nueva_llave" root@172.96.8.245
echo.
echo [%date% %time%] Tunel desconectado. Reconectando en 5 segundos...
timeout /t 5 /noqueue
goto loop
