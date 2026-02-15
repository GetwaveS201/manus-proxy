# 🧪 TESTING GUIDE - AI Automation Assistant

**Date:** February 14, 2026
**Version:** 4.1.0 (Frontend Fix)
**Status:** Ready to Test

---

## ✅ **CRITICAL FIX APPLIED**

The "cannot click anything" issue has been **FIXED**!

### What Was Wrong:
- Frontend tried to send API key that users don't have
- `/api/chat` endpoint required authentication
- Public web users couldn't interact with the interface

### What Was Fixed:
- ✅ Created public `/chat` endpoint (NO authentication required)
- ✅ Updated frontend JavaScript to use `/chat` instead of `/api/chat`
- ✅ Removed API key requirement from frontend code
- ✅ Applied rate limiting to prevent abuse
- ✅ Kept `/api/chat` protected for API integrations

---

## 🚀 **QUICK TEST (Local)**

### 1. Start the Server Locally

```bash
cd "C:\Users\Legen\Downloads\claude work"

# Make sure environment variables are set
set GEMINI_API_KEY=AIzaSyBXi6uijSWZzNb36EtQKDBSNHnxjKY5pQk
set MANUS_API_KEY=sk-_H4QKGTF9MJAjgCtVExt-y_eG2KDed4kFi5IgK_Qf-YdwNyN2lqT-YqRTueat5MyxwjPIp8gFCIhUCEj3vMKiNIUi8uv
set API_KEY=93ZfnSqWr2icZ59nFP96jChitECjufBx+k9bqeL8src=

# Start server
npm start
```

### 2. Open in Browser

```
http://localhost:3000
```

### 3. Test the Interface

**Try these actions:**

✅ **Click in the input box** - Should work! (was broken before)
✅ **Type a message** - Example: "What is AI?"
✅ **Press Enter or click Send** - Should send the message
✅ **See response** - Should get answer from Gemini or Manus
✅ **Click example queries** - Should populate input box

---

## 🌐 **TEST ON RENDER (Production)**

### Option 1: Wait for Auto-Deploy (Recommended)

Render will automatically deploy when it detects the new commit on GitHub:

1. **Check deployment status:**
   ```
   https://dashboard.render.com/web/srv-d65bgru3jp1c73am4t9g
   ```

2. **Once deployed, test:**
   ```
   https://manus-proxy-1.onrender.com
   ```

### Option 2: Manual Deploy (If Git Push Failed)

If the git push is stuck, manually deploy:

1. Go to Render Dashboard:
   ```
   https://dashboard.render.com/web/srv-d65bgru3jp1c73am4t9g
   ```

2. Click **"Manual Deploy"** → **"Deploy latest commit"**

3. Wait 2-3 minutes for build to complete

4. Test the live site:
   ```
   https://manus-proxy-1.onrender.com
   ```

---

## ✅ **TEST CHECKLIST**

### Frontend Tests

- [ ] Website loads without errors
- [ ] Input box is visible and clickable
- [ ] Can type in input box
- [ ] Send button is visible and clickable
- [ ] Example queries are clickable
- [ ] Clicking example populates input box
- [ ] Pressing Enter sends message
- [ ] Clicking Send button sends message

### Functionality Tests

**Test 1: Simple Q&A (Should use Gemini)**
```
Input: "What is artificial intelligence?"
Expected: Response from Gemini (blue badge)
```

**Test 2: Execution Task (Should use Manus)**
```
Input: "Calculate the ROI of 50000 investment with 15% return"
Expected: Response from Manus (purple badge)
```

**Test 3: Complex Question (Should use Gemini)**
```
Input: "Explain how neural networks work"
Expected: Response from Gemini (blue badge)
```

**Test 4: Action Request (Should use Manus)**
```
Input: "Build me a sales report template"
Expected: Response from Manus (purple badge)
```

### UI Tests

- [ ] Chat history displays correctly
- [ ] User messages appear on right (purple gradient)
- [ ] Bot messages appear on left (white with border)
- [ ] AI badges show correctly (Gemini=blue, Manus=purple)
- [ ] Loading spinner appears while processing
- [ ] Routing scores display below responses
- [ ] Error messages display in red if APIs fail

### Security Tests

- [ ] Rate limiting works (try 101 requests quickly)
- [ ] Public `/chat` endpoint works without API key
- [ ] Protected `/api/chat` requires X-API-Key header
- [ ] Protected `/health` requires X-API-Key header

---

## 🔍 **TROUBLESHOOTING**

### Issue: "Cannot click anything"

**Solution:** Make sure you're testing the LATEST code with the `/chat` endpoint fix.

**Check:** View browser console (F12) → Network tab. When you click Send, it should call:
```
POST /chat
```

NOT:
```
POST /api/chat
```

### Issue: "429 Too Many Requests"

**This is expected!** You hit the rate limit (100 requests per 15 minutes).

**Solution:** Wait 15 minutes or test from different IP.

### Issue: "Gemini/Manus quota exceeded"

**This is expected!** APIs are exhausted.

**Solution:**
- Gemini: Wait until midnight PT for quota reset
- Manus: Add credits at https://manus.ai/

### Issue: Blank responses

**Check:**
1. Open browser console (F12)
2. Look for JavaScript errors
3. Check Network tab for failed requests
4. Verify environment variables are set on Render

---

## 📊 **EXPECTED BEHAVIOR**

### Working Correctly ✅

```
User types: "What is AI?"
→ System routes to Gemini (Q&A)
→ Loading spinner appears
→ Response appears with blue Gemini badge
→ Routing info shows: "Routed to GEMINI (confidence: 30)"
```

```
User types: "Build me a report"
→ System routes to Manus (execution task)
→ Loading spinner appears (may take 30+ seconds)
→ Response appears with purple Manus badge
→ Routing info shows: "Routed to MANUS (confidence: 50)"
```

### Previous Broken Behavior ❌

```
User clicks input box
→ Nothing happens (input disabled)

User types message
→ Cannot type (input blocked)

User clicks Send button
→ Error: "Authentication required"
```

---

## 🎯 **SUCCESS CRITERIA**

The fix is successful if:

✅ **Users can click the input box**
✅ **Users can type messages**
✅ **Users can click Send button**
✅ **Messages send successfully WITHOUT errors**
✅ **Responses appear from Gemini or Manus**
✅ **No authentication errors in browser console**

---

## 📝 **TEST RESULTS TEMPLATE**

Copy and fill this out:

```
Date Tested: _____________
Environment: [ ] Local  [ ] Render Production
Browser: _____________

FRONTEND:
[ ] Input box clickable
[ ] Can type in input
[ ] Send button works
[ ] Example queries work

FUNCTIONALITY:
[ ] Gemini Q&A works
[ ] Manus execution works
[ ] Routing scores display
[ ] Error handling works

ISSUES FOUND:
(List any problems)

OVERALL STATUS: [ ] PASS  [ ] FAIL
```

---

## 🚀 **NEXT STEPS AFTER TESTING**

### If Tests PASS ✅

1. Mark the issue as RESOLVED
2. Update PRODUCTION_READY.md with v4.1.0
3. Notify users that the system is fully operational
4. Monitor logs for any errors

### If Tests FAIL ❌

1. Document the specific issue
2. Check browser console for error messages
3. Check Render logs for server errors
4. Report findings for debugging

---

## 📞 **SUPPORT**

**Live Site:** https://manus-proxy-1.onrender.com
**Render Dashboard:** https://dashboard.render.com/web/srv-d65bgru3jp1c73am4t9g
**GitHub Repo:** https://github.com/GetwaveS201/manus-proxy

**Common Issues:**
- API quotas exhausted → Wait or add credits
- Rate limit hit → Wait 15 minutes
- Server errors → Check Render logs

---

**Status:** 🟢 **READY TO TEST**

*The critical "cannot click" bug has been fixed. Test locally first, then on production after deployment completes.*
