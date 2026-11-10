@echo off
chcp 65001 >nul
title EletrocarDoGuiGui - Sistema de Estoque (Offline + Wi-Fi)
echo ============================================================
echo   INICIANDO ELETROCARDOGUIGUI - SISTEMA DE ESTOQUE...
echo ============================================================
echo.
start "" "http://localhost:3080"
node "%~dp0server.js"
pause
