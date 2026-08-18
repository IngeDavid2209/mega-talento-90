@echo off
REM ═══════════════════════════════════════════════════════════════════
REM  Reinstala el Agente de Checadas como servicio de Windows.
REM
REM  Se auto-eleva a administrador (sale el aviso de UAC: dale "Sí").
REM  Doble clic y listo — no hay que abrir consola de administrador a mano.
REM
REM  Reinstalar (no solo reiniciar) es a proposito: regenera el servicio con
REM  la cuenta correcta (NT AUTHORITY\LocalSystem) y toma el codigo nuevo del
REM  agente (modo relojes: lee los equipos directo y detecta cada movimiento).
REM ═══════════════════════════════════════════════════════════════════

REM ¿Ya somos administrador? Si no, relanzarse elevado.
net session >nul 2>&1
if %errorLevel% neq 0 (
  echo Pidiendo permisos de administrador...
  powershell -Command "Start-Process '%~f0' -Verb RunAs"
  exit /b
)

cd /d "%~dp0"

echo.
echo === Quitando el servicio anterior ===
node instalar-servicio.js quitar

echo.
echo === Instalando el servicio (modo relojes) ===
node instalar-servicio.js instalar

echo.
echo === Revision ===
node instalar-servicio.js revisar

echo.
echo Comprueba que diga Running:
powershell -NoProfile -Command "Get-Service megatalentoagentedechecadas.exe | Select-Object Name,Status | Format-List"

echo.
echo Listo. El servicio queda leyendo los 10 relojes directo y sube cada
echo checada nueva en menos de un minuto, sin que nadie tenga que hacer nada.
echo.
pause
