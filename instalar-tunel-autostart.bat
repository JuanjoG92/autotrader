@echo off
:: Instala el tunel para que arranque con Windows (minimizado)
:: Ejecutar UNA VEZ como administrador

set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set SCRIPT=%~dp0tunel-binance.bat

echo Creando acceso directo en Inicio de Windows...

powershell -Command "$ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut('%STARTUP%\TunelBinance.lnk'); $sc.TargetPath = '%SCRIPT%'; $sc.WindowStyle = 7; $sc.Save()"

echo.
echo LISTO! El tunel se ejecutara automaticamente al iniciar Windows (minimizado).
echo Para probarlo ahora, ejecuta: tunel-binance.bat
pause
