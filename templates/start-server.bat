@echo off
setlocal
REM wa-concierge — server runner with restart loop (Windows).
REM The installer copies this to the PROJECT ROOT and replaces PROJETO_AQUI and PORTA_AQUI.
cd /d PROJETO_AQUI

REM If something already listens on the port, another instance is running - exit.
netstat -ano | findstr ":PORTA_AQUI " | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 exit /b 0

set MAX_RESTART=20
set COUNT=0

:restart
node src\web-entry.js
set /a COUNT+=1
if %COUNT% geq %MAX_RESTART% exit /b 1
timeout /t 10 /nobreak >nul
goto restart
