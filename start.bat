@echo off
chcp 65001 >nul
cd /d %~dp0
echo.
echo  ============================================
echo   Keep Proxy Gateway 启动中...
echo   管理后台: http://127.0.0.1:8080/admin
echo   按 Ctrl+C 停止服务
echo  ============================================
echo.
node server.js
pause
