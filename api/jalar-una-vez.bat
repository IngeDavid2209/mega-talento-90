@echo off
REM ============================================================
REM  JALAR UNA VEZ - Mega Talento
REM  Hace UN jalado de los relojes (targets.json) y termina.
REM  Pensado para el Programador de tareas de Windows (cada 5 min).
REM  Debe correr en una PC que este en la MISMA RED que los relojes.
REM ============================================================
cd /d "%~dp0"
call npm run jalar
