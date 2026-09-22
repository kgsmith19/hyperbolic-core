@echo off
title Deep Search - Local Research Engine
echo ==========================================================
echo   🛡️  Deep Search - Guarded Deep-Web Engine
echo ==========================================================
echo.
echo Starting Deep Search server & SearXNG meta-search engine...
echo Your browser will open automatically at: http://127.0.0.1:8765
echo SearXNG engine endpoint active at: http://127.0.0.1:8080
echo.
echo (Press Ctrl+C to stop the server when finished)
echo.
cd /d "%~dp0"
python deep_search.py --ui
pause
