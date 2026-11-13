@echo off
cd /d "%~dp0"
start "" http://localhost:5500
python -m http.server 5500 --bind 127.0.0.1
