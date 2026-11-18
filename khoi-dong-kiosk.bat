@echo off
setlocal EnableExtensions
rem Copy file nay vao Startup (shell:startup). Chay cung Windows.
rem Mo Chrome kiosk full man hinh va giu cua so luon tren cung.
if /I not "%~1"=="run" (
  start "" /MIN "%~f0" run
  exit /b
)

set "WEB=D:\web"
set "URL=http://127.0.0.1/index.html?v=heart-20261110"
set "PROFILE=%LOCALAPPDATA%\HoaLoKiosk"
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" (
  echo Khong thay Chrome.
  exit /b 1
)

call :port80
if errorlevel 1 (
  where py >nul 2>&1
  if not errorlevel 1 (
    start "hoalo-web" /MIN /D "%WEB%" py -3 "%WEB%\mapp.py"
  ) else (
    where python >nul 2>&1
    if not errorlevel 1 start "hoalo-web" /MIN /D "%WEB%" python "%WEB%\mapp.py"
  )
)

set /a N=0
:waitweb
call :port80
if not errorlevel 1 goto launch
set /a N+=1
if %N% GEQ 40 goto launch
ping -n 2 127.0.0.1 >nul
goto waitweb

:launch
start "" "%CHROME%" --kiosk --no-first-run --no-default-browser-check --disable-infobars --disable-session-crashed-bubble --disable-translate --disable-features=TranslateUI --autoplay-policy=no-user-gesture-required --overscroll-history-navigation=0 --check-for-update-interval=31536000 --user-data-dir="%PROFILE%" "%URL%"
start "" powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%WEB%\kiosk-luon-tren.ps1"
exit /b 0

:port80
powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1', 80); $c.Close(); exit 0 } catch { exit 1 }"
exit /b %ERRORLEVEL%
