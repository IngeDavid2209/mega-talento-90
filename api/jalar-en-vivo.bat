@echo off
REM ============================================================
REM  JALAR EN VIVO - Mega Talento
REM  Doble clic para mantener la base al dia: jala los relojes
REM  (targets.json) cada 5 minutos hasta que cierres la ventana.
REM  Debe correr en una PC que este en la MISMA RED que los relojes.
REM  Requisitos (una vez): Node.js instalado y, dentro de api\,
REM  haber corrido "npm install" y tener el archivo .env con DATABASE_URL.
REM ============================================================
cd /d "%~dp0"
title Jalar en vivo - Mega Talento
echo Iniciando jalado en vivo (cada 5 min). No cierres esta ventana.
echo.
call npm run jalar:watch
echo.
echo El proceso termino. Revisa el mensaje de arriba.
pause
