@echo off
REM Публикация версии плагина в отдельную папку (версионирование пути -> обход кэша).
REM Использование:  scripts\release.cmd v1.4.1
setlocal
set VERSION=%1
if "%VERSION%"=="" (
  echo Usage: scripts\release.cmd v1.4.1
  exit /b 1
)

cd /d "%~dp0.."

if not exist "%VERSION%" mkdir "%VERSION%"
copy /Y manifest.json "%VERSION%\" >nul
copy /Y plugin.js     "%VERSION%\" >nul
copy /Y index.html    "%VERSION%\" >nul
copy /Y icon.svg      "%VERSION%\" >nul

echo Released to %VERSION%\
endlocal
