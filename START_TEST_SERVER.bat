@echo off
echo ========================================
echo   AI AUTOMATION ASSISTANT - TEST SERVER
echo ========================================
echo.
echo Setting up environment variables...

set GEMINI_API_KEY=AIzaSyBXi6uijSWZzNb36EtQKDBSNHnxjKY5pQk
set MANUS_API_KEY=sk-_H4QKGTF9MJAjgCtVExt-y_eG2KDed4kFi5IgK_Qf-YdwNyN2lqT-YqRTueat5MyxwjPIp8gFCIhUCEj3vMKiNIUi8uv
set API_KEY=93ZfnSqWr2icZ59nFP96jChitECjufBx+k9bqeL8src=
set PORT=3000
set NODE_ENV=development

echo.
echo Environment variables set successfully!
echo.
echo Starting server on http://localhost:3000
echo.
echo ========================================
echo   READY TO TEST!
echo ========================================
echo.
echo 1. Open your browser
echo 2. Go to: http://localhost:3000
echo 3. Try clicking in the input box
echo 4. Type a message and click Send
echo.
echo Press Ctrl+C to stop the server
echo ========================================
echo.

npm start
