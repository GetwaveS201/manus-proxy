# Security Policy

## 🚨 CRITICAL SECURITY INCIDENT - RESOLVED

**Date:** February 13, 2026

### What Happened

API keys (Gemini, Manus, Render, Notion) were accidentally committed to the repository in documentation files:
- `DEPLOYMENT_SUCCESS.md`
- `COMPLETE_SESSION_SUMMARY.md`

### Actions Taken

1. ✅ Removed all API keys from documentation
2. ✅ Added `.gitignore` to prevent future commits
3. ✅ Created `.env.example` template
4. ✅ Added comprehensive README with security guidelines

### Required Actions for Users

If you cloned this repository before February 13, 2026:

1. **Delete your local clone immediately**
2. **Rotate ALL API keys:**
   - Gemini API: https://ai.google.dev/
   - Manus API: https://manus.ai/
   - Render API: https://dashboard.render.com/
   - Notion API: https://www.notion.so/my-integrations
3. **Re-clone the repository fresh**
4. **Never use the exposed keys**

### Ongoing Security Measures

This repository now implements:

#### 1. Secret Management
- ✅ `.gitignore` prevents `.env` commits
- ✅ `.env.example` template for configuration
- ✅ Documentation scrubbed of all secrets
- ✅ Environment variables only

#### 2. API Authentication
- ✅ `X-API-Key` header required for all endpoints
- ✅ Rate limiting (100 req/15min per IP)
- ✅ CORS restrictions
- ✅ Request size limits

#### 3. Error Handling
- ✅ Generic errors for production
- ✅ Technical details logged server-side only
- ✅ No API key leakage in responses

#### 4. Health Endpoint Protection
- ✅ Requires authentication
- ✅ Limited information exposure

## Reporting a Vulnerability

If you discover a security vulnerability:

1. **DO NOT** open a public GitHub issue
2. Email: [security contact - add your email]
3. Include:
   - Description of vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

We will respond within 48 hours.

## Security Best Practices

### For Developers

**Never commit:**
- API keys
- Passwords
- Private keys
- `.env` files
- `secrets.json`
- Database credentials

**Always:**
- Use environment variables
- Review commits before pushing
- Enable GitHub secret scanning
- Rotate keys regularly
- Use strong, unique keys

### For Deployers

**Render Configuration:**
1. Add all secrets as environment variables in dashboard
2. Enable auto-deploy from `main` branch only
3. Review deployment logs for exposed secrets
4. Use HTTPS only (enabled by default)

**API Key Management:**
1. Generate strong random keys (`openssl rand -base64 32`)
2. Store in password manager
3. Rotate every 90 days
4. Revoke immediately if exposed

## Security Checklist

Before deploying:

- [ ] All API keys in environment variables
- [ ] `.env` in `.gitignore`
- [ ] No secrets in documentation
- [ ] Authentication enabled
- [ ] Rate limiting configured
- [ ] CORS properly set
- [ ] HTTPS enforced
- [ ] Error messages sanitized
- [ ] Logs don't contain secrets
- [ ] Dependencies up to date

## Dependency Security

```bash
# Check for vulnerabilities
npm audit

# Fix automatically
npm audit fix

# Update dependencies
npm update
```

## Rate Limits

To prevent abuse and credit drain:

| Endpoint | Limit | Window |
|----------|-------|--------|
| `/api/chat` | 100 requests | 15 minutes |
| `/health` | 20 requests | 1 minute |

## Authentication

All requests require `X-API-Key` header:

```bash
curl -H "X-API-Key: your_secret_key" \
  https://manus-proxy-1.onrender.com/api/chat
```

**Generating secure keys:**

```bash
# Generate 32-byte random key
openssl rand -base64 32

# Or use Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Incident Response Plan

If API keys are exposed:

1. **Immediate (within 1 hour):**
   - Revoke exposed keys
   - Generate new keys
   - Update Render environment variables
   - Force restart service

2. **Short-term (within 24 hours):**
   - Review git history for other exposures
   - Purge secrets from git history
   - Monitor API usage for abuse
   - Check for unauthorized charges

3. **Long-term (within 1 week):**
   - Audit all deployment processes
   - Update security documentation
   - Train team on security practices
   - Implement automated secret scanning

## Git History Cleaning

If secrets were committed:

```bash
# Using BFG Repo-Cleaner (recommended)
bfg --replace-text passwords.txt repo.git

# Using git filter-repo
git filter-repo --path DEPLOYMENT_SUCCESS.md --invert-paths

# Force push (DANGEROUS - coordinate with team)
git push origin --force --all
```

## Monitoring

Watch for:
- Unusual API usage spikes
- Geographic anomalies
- Failed authentication attempts
- Quota exhaustion
- Error rate increases

## Contact

For security issues:
- GitHub: [Open a private security advisory]
- Email: [Add security contact]

---

**Last Updated:** February 13, 2026
**Next Review:** March 13, 2026
