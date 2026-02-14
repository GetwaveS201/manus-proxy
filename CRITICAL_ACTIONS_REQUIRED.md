# 🚨 CRITICAL SECURITY ACTIONS REQUIRED

**Date:** February 13, 2026
**Severity:** CRITICAL
**Status:** IMMEDIATE ACTION NEEDED

---

## ⚠️ YOUR API KEYS WERE EXPOSED TO THE PUBLIC

Your API keys were committed to GitHub in documentation files. **Anyone who viewed the repository can see and use your keys.**

---

## 🔥 DO THESE NOW (Next 30 Minutes)

### 1. Rotate ALL API Keys Immediately

**Why:** The exposed keys can drain your credits and access your services.

#### Gemini API Key
1. Go to: https://ai.google.dev/
2. Go to "API Keys" section
3. **DELETE** the old key: `AIzaSyDh2jaXdYXm-SXkwQzUQ2KgeVOsC88ZiA0`
4. Create a new key
5. Copy the new key

#### Manus API Key
1. Go to: https://manus.ai/
2. Go to account settings → API Keys
3. **REVOKE** the old key: `sk-aCKYHvdt4QQvZh6LDfd0...`
4. Generate a new key
5. Copy the new key

#### Render API Key (if you have one)
1. Go to: https://dashboard.render.com/
2. Go to Account Settings → API Keys
3. Delete the old key
4. Create a new key

#### Notion API Key (if you have one)
1. Go to: https://www.notion.so/my-integrations
2. Find your integration
3. Regenerate the secret
4. Copy the new secret

### 2. Update Render Environment Variables

1. Go to: https://dashboard.render.com
2. Select service: `manus-proxy-1`
3. Go to "Environment" tab
4. Update these variables with NEW keys:
   - `GEMINI_API_KEY` → [new Gemini key]
   - `MANUS_API_KEY` → [new Manus key]
5. Click "Save Changes"
6. Service will auto-restart

### 3. Monitor for Unauthorized Usage

Check for suspicious activity:

**Manus:**
- Check https://manus.ai/ dashboard for unusual task history
- Look for tasks you didn't create
- Check credit usage for spikes

**Gemini:**
- Check https://ai.google.dev/ quota usage
- Look for unexpected request counts

**Render:**
- Check deployment logs for unusual activity
- Monitor for unexpected deployments

---

## 📋 VERIFY IT WORKED

After rotating keys:

```bash
# Test the service still works
curl -X POST https://manus-proxy-1.onrender.com/api/chat \
  -H "Content-Type: application/json" \
  -d '{"prompt":"test"}'

# Should get either:
# - A response (if quotas renewed)
# - Quota exceeded error (expected if still exhausted)
```

---

## 🛡️ ADDITIONAL SECURITY STEPS (Next 24 Hours)

### 4. Clean Git History (Advanced)

The old keys are still in git history. Anyone can access them.

**Option A: Easy but Nuclear** (deletes all history)
```bash
# Creates a fresh repo with current state only
git checkout --orphan new-main
git add -A
git commit -m "Fresh start - removed secret history"
git branch -D main
git branch -m main
git push -f origin main
```

**Option B: Surgical** (requires git-filter-repo)
```bash
# Install git-filter-repo
pip install git-filter-repo

# Remove specific files from history
git filter-repo --path DEPLOYMENT_SUCCESS.md --invert-paths --force
git filter-repo --path COMPLETE_SESSION_SUMMARY.md --invert-paths --force

# Force push
git push origin --force --all
```

⚠️ **WARNING:** Force pushing rewrites history. Coordinate with any collaborators first.

### 5. Enable GitHub Security Features

1. Go to: https://github.com/GetwaveS201/manus-proxy/settings/security_analysis
2. Enable:
   - ✅ **Secret scanning**
   - ✅ **Dependabot alerts**
   - ✅ **Dependency graph**

This prevents future accidental key commits.

### 6. Set Up Monitoring

**Credit Alerts:**
- Manus: Set budget alerts at https://manus.ai/
- Gemini: Monitor quota at https://ai.google.dev/

**GitHub Alerts:**
- Watch for new commits from unknown users
- Enable 2FA on GitHub account

---

## 🔒 PREVENT THIS FROM HAPPENING AGAIN

### Developer Checklist

Before every commit:

```bash
# Check for secrets
git diff | grep -E "(sk-|AIza|ghp_|rnd_)"

# Use git-secrets (install once)
brew install git-secrets  # macOS
# or: apt-get install git-secrets  # Linux

git secrets --scan
```

### Use .env Files Only

```bash
# Create .env file (NOT committed)
cp .env.example .env

# Edit .env with real keys
nano .env

# Verify .gitignore blocks it
git status  # should NOT show .env
```

### Automation

Add to `.git/hooks/pre-commit`:
```bash
#!/bin/sh
if git diff --cached | grep -E "(sk-|AIza|ghp_|rnd_)"; then
    echo "❌ ERROR: Potential API key detected!"
    echo "Do NOT commit API keys. Use .env instead."
    exit 1
fi
```

---

## 📊 DAMAGE ASSESSMENT

### What Was Exposed

| Service | Key Format | Exposed Since | Public |
|---------|-----------|---------------|--------|
| Gemini | `AIzaSy...` | ~2 days | Yes |
| Manus | `sk-...` | ~2 days | Yes |
| Render | `rnd_...` | ~2 days | Maybe |
| Notion | `ntn_...` | ~2 days | Maybe |
| GitHub | `ghp_...` | ~2 days | **YES** |

### Potential Impact

**GitHub Token** - Most Critical:
- Can read/write to ALL your repositories
- Can delete repositories
- Can access private repos
- **ROTATE IMMEDIATELY**

**Manus Credits:**
- Current: Exhausted ($0)
- Risk: Low (no credits to steal)

**Gemini Quota:**
- Current: Exhausted (free tier)
- Risk: Low (free tier can't be abused for $)

**Render:**
- Can deploy malicious code
- Can access logs
- **ROTATE IMMEDIATELY**

---

## ✅ COMPLETION CHECKLIST

Mark as done:

- [ ] Revoked old Gemini API key
- [ ] Created new Gemini API key
- [ ] Revoked old Manus API key
- [ ] Created new Manus API key
- [ ] Revoked old Render API key
- [ ] Created new Render API key
- [ ] Revoked old Notion API key (if applicable)
- [ ] Created new Notion API key (if applicable)
- [ ] **REVOKED OLD GITHUB TOKEN**
- [ ] **CREATED NEW GITHUB TOKEN**
- [ ] Updated Render environment variables
- [ ] Tested service still works
- [ ] Checked Manus for unauthorized tasks
- [ ] Checked Gemini for unusual usage
- [ ] Enabled GitHub secret scanning
- [ ] (Optional) Cleaned git history
- [ ] (Optional) Set up credit alerts
- [ ] Read SECURITY.md
- [ ] Saved new keys in password manager

---

## 🆘 NEED HELP?

**Immediate Security Issue:**
- Manus support: https://manus.ai/
- Google AI: https://ai.google.dev/docs/support
- GitHub support: https://support.github.com/

**Questions:**
- See README.md for general setup
- See SECURITY.md for security practices

---

## 📞 CONTACT

If you've already seen suspicious activity:

1. Document everything (screenshots, timestamps)
2. Contact API provider support immediately
3. File a GitHub security advisory (if needed)
4. Consider professional security audit

---

**Remember:** The keys are still in git history until you clean it. Rotate NOW.

**Status:** 🔴 **ACTION REQUIRED**
