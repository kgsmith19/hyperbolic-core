@echo off
setlocal
node "%~dp0..\hooks\lane.mjs" gate -- %*
if %ERRORLEVEL% EQU 42 exit /b 42
set "ACC_REAL_CLAUDE=%ACC_REAL_CLAUDE_EXE%"
if "%ACC_REAL_CLAUDE%"=="" set "ACC_REAL_CLAUDE=C:\Users\kyleg\.local\bin\claude.exe"
"%ACC_REAL_CLAUDE%" %*
exit /b %ERRORLEVEL%
