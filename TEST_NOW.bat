@echo off
cls
echo.
echo ========================================
echo   AI AUTOMATION ASSISTANT
echo   QUICK TEST LAUNCHER
echo ========================================
echo.
echo This will:
echo  1. Start the test server
echo  2. Open your browser automatically
echo  3. Let you test the fix instantly!
echo.
echo ========================================
echo.
pause
echo.
echo Starting server...
echo.

set GEMINI_API_KEY=AIzaSyBXi6uijSWZzNb36EtQKDBSNHnxjKY5pQk
set MANUS_API_KEY=sk-_H4QKGTF9MJAjgCtVExt-y_eG2KDed4kFi5IgK_Qf-YdwNyN2lqT-YqRTueat5MyxwjPIp8gFCIhUCEj3vMKiNIUi8uv
set API_KEY=93ZfnSqWr2icZ59nFP96jChitECjufBx+k9bqeL8src=
set PORT=3000

echo Waiting 3 seconds then opening browser...
timeout /t 3 /nobreak >nul
start http://localhost:3000

echo.
echo ========================================
echo   Browser should open shortly!
echo ========================================
echo.
echo TEST THIS:
echo  1. Click in the input box (should work!)
echo  2. Type: "What is AI?"
echo  3. Press Enter or click Send
echo  4. See the response!
echo.
echo If those 4 steps work, the bug is FIXED!
echo.
echo Press Ctrl+C to stop the server when done
echo ========================================
echo.

npm start
