@echo off
cd /d C:\AI\racing_game
start "racing_server" /min python serve.py
echo servers launched (http 8010 + https 8443)
