# Túnel SSH Binance - Corre minimizado
# Para ejecutar: click derecho > "Ejecutar con PowerShell"
# O agregar al Inicio de Windows para que arranque automático

$host.UI.RawUI.WindowTitle = "Tunel Binance"

while ($true) {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Conectando tunel SSH..." -ForegroundColor Cyan
    
    $process = Start-Process -FilePath "ssh" -ArgumentList @(
        "-R", "1080",
        "-N",
        "-o", "ServerAliveInterval=30",
        "-o", "ServerAliveCountMax=3",
        "-o", "ExitOnForwardFailure=yes",
        "-i", "$env:USERPROFILE\.ssh\nueva_llave",
        "root@172.96.8.245"
    ) -NoNewWindow -PassThru -Wait
    
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Tunel caido. Reconectando en 5s..." -ForegroundColor Yellow
    Start-Sleep -Seconds 5
}
