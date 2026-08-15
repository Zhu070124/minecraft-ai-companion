@echo off
chcp 65001 >nul
title MC AI Companion

echo.
echo   🎮 MC AI Companion v0.1.0
echo   ==========================
echo.

cd /d "%~dp0"

:: 检查 node_modules
if not exist "node_modules\" (
    echo   [1/2] 安装依赖...
    call npm install
    if errorlevel 1 (
        echo   依赖安装失败！检查 Node.js 和 npm
        pause
        exit /b 1
    )
    echo   安装完成。
    echo.
)

:: 检查 Memory Hub 是否在运行
echo   [*] 检查 Memory Hub...
curl -s http://127.0.0.1:8921/sources >nul 2>&1
if errorlevel 1 (
    echo   [!] Memory Hub 未启动 (端口 8921)
    echo       bot 将使用本地内存 fallback
    echo       如需完整记忆，请先启动 Memory Hub
) else (
    echo   [✓] Memory Hub 已连接
)
echo.

:: 启动
echo   [启动] MC AI Companion...
echo   Launcher: http://localhost:8848
echo   按 Ctrl+C 停止
echo.

node src/index.js

pause
