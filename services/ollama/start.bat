@echo off
echo Starting Ollama Compatibility Server...
echo.

REM Check if .env file exists
if not exist .env (
    echo Warning: .env file not found. Creating from template...
    copy .env.example .env
    echo Please edit .env file with your configuration and restart.
    pause
    exit /b 1
)

REM Check if node_modules exists
if not exist node_modules (
    echo Installing dependencies...
    pnpm install
    if errorlevel 1 (
        echo Failed to install dependencies!
        pause
        exit /b 1
    )
)

REM Update API key from main proxy
echo Fetching new API key from main proxy...
node update-api-key.js

if errorlevel 1 (
    echo Warning: Failed to update API key. Continuing with existing configuration...
)

echo Starting Ollama server on port 11434...
echo Main proxy should be running on %MAIN_PROXY_URL%
echo.
echo Press Ctrl+C to stop the server
echo.

node index.js

pause
