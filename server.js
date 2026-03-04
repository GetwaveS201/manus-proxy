/**
 * AI Automation Assistant - Production Server
 * Dual AI System: Gemini (Q&A) + OpenClaw (local AI agent)
 *
 * Features:
 * - X-API-Key authentication for all endpoints
 * - Rate limiting (100 req/15min per IP)
 * - CORS with whitelist
 * - Helmet security headers
 * - Request size limits & timeouts
 * - Score-based routing (not keyword matching)
 * - Async task support with task status endpoint
 * - Comprehensive error handling & logging
 * - Production-ready frontend UI
 *
 * @version 4.0.0
 * @license MIT
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// ============================================
// CONFIGURATION & ENVIRONMENT
// ============================================

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENCLAW_URL   = process.env.OPENCLAW_URL   || 'http://localhost:18789';
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN  || '';
const RENDER_API_KEY = process.env.RENDER_API_KEY;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const API_KEY = process.env.API_KEY || 'your-secure-api-key-here';

// ============================================
// USER ACCOUNTS
// ============================================

const USERS_MAP = new Map();
const TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

(function parseUsers() {
  const raw = process.env.USERS || '';
  if (!raw.trim()) {
    // Backwards-compat fallback: any username, password = API_KEY value
    USERS_MAP.set('__fallback__', API_KEY);
    return;
  }
  raw.split(',').forEach(pair => {
    const colon = pair.indexOf(':');
    if (colon < 1) return;
    const user = pair.slice(0, colon).trim().toLowerCase();
    const pass = pair.slice(colon + 1).trim();
    if (user && pass) USERS_MAP.set(user, pass);
  });
})();

// ============================================
// FILE-BASED USER STORE
// ============================================

const USERS_FILE = process.env.USERS_FILE || path.join('/data', 'users.json');
let userStore = { users: [], pending: [] };

function loadUserStore() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      userStore = { users: parsed.users || [], pending: parsed.pending || [] };
    }
  } catch (e) { log('WARN', `Could not load users file: ${e.message}`); }
}

function saveUserStore() {
  try {
    const dir = path.dirname(USERS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(USERS_FILE, JSON.stringify(userStore, null, 2), 'utf8');
  } catch (e) { log('ERROR', `Could not save users file: ${e.message}`); }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = stored.split('$');
    const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
  } catch { return false; }
}

loadUserStore(); // Load on startup (log() is a function declaration — hoisted)

// ============================================
// TOKEN HELPERS (HMAC-SHA256, no JWT library)
// ============================================

const TOKEN_SECRET = API_KEY;

function createLoginToken(username) {
  const issuedAt  = Date.now();
  const expiresAt = issuedAt + TOKEN_EXPIRY_MS;
  const payload   = Buffer.from(`${username}:${issuedAt}:${expiresAt}`).toString('base64url');
  const hmac      = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  return `${payload}.${hmac}`;
}

function verifyLoginToken(token) {
  if (!token || typeof token !== 'string') return { valid: false, reason: 'missing' };
  const dot = token.lastIndexOf('.');
  if (dot < 1) return { valid: false, reason: 'malformed' };
  const payload  = token.slice(0, dot);
  const hmac     = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(expected, 'hex')))
      return { valid: false, reason: 'invalid_signature' };
  } catch { return { valid: false, reason: 'invalid_signature' }; }
  let decoded;
  try { decoded = Buffer.from(payload, 'base64url').toString(); } catch { return { valid: false, reason: 'decode_error' }; }
  const parts = decoded.split(':');
  if (parts.length < 3) return { valid: false, reason: 'malformed_payload' };
  const username  = parts[0];
  const expiresAt = parseInt(parts[2], 10);
  if (isNaN(expiresAt) || Date.now() > expiresAt) return { valid: false, reason: 'expired' };
  return { valid: true, username };
}

// CORS whitelist (add your frontend domains)
const CORS_WHITELIST = [
  'http://localhost:3000',
  'http://localhost:5000',
  'https://manus-proxy-1.onrender.com',
  'https://your-production-domain.com'
];

// ============================================
// LOGGING UTILITY
// ============================================

/**
 * Logs messages with timestamp and request ID
 * @param {string} level - Log level (INFO, WARN, ERROR)
 * @param {string} message - Log message
 * @param {string} [requestId] - Optional request ID
 * @param {Object} [data] - Optional additional data
 */
function log(level, message, requestId = null, data = null) {
  const timestamp = new Date().toISOString();
  const reqId = requestId ? `[${requestId}]` : '';
  let logMsg = `[${timestamp}] [${level}] ${reqId} ${message}`;

  if (data) {
    logMsg += ` | ${JSON.stringify(data)}`;
  }

  console.log(logMsg);
}

// ============================================
// IN-MEMORY TASK STORAGE
// ============================================

/**
 * In-memory storage for async tasks
 * In production, use Redis or a database
 */
const taskStore = new Map();

/**
 * Task status constants
 */
const TaskStatus = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

/**
 * Creates a new task in the store
 * @param {string} prompt - The user prompt
 * @returns {string} Task ID
 */
function createTask(prompt) {
  const taskId = crypto.randomUUID();
  taskStore.set(taskId, {
    id: taskId,
    prompt,
    status: TaskStatus.PENDING,
    createdAt: Date.now(),
    response: null,
    error: null,
    ai: null
  });
  return taskId;
}

/**
 * Updates task status
 * @param {string} taskId - Task ID
 * @param {Object} updates - Updates to apply
 */
function updateTask(taskId, updates) {
  const task = taskStore.get(taskId);
  if (task) {
    taskStore.set(taskId, { ...task, ...updates, updatedAt: Date.now() });
  }
}

/**
 * Gets task by ID
 * @param {string} taskId - Task ID
 * @returns {Object|null} Task object or null
 */
function getTask(taskId) {
  return taskStore.get(taskId) || null;
}

// Clean up old tasks (older than 1 hour)
setInterval(() => {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  for (const [taskId, task] of taskStore.entries()) {
    if (task.createdAt < oneHourAgo) {
      taskStore.delete(taskId);
      log('INFO', `Cleaned up old task: ${taskId}`);
    }
  }
}, 10 * 60 * 1000); // Run every 10 minutes

// ============================================
// EXPRESS APP SETUP
// ============================================

const app = express();

// Trust Render's proxy (required for express-rate-limit to work correctly)
app.set('trust proxy', 1);

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));

// CORS with whitelist
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);

    // Allow file:// protocol for local testing
    if (typeof origin === 'string' && origin.startsWith('file://')) return callback(null, true);

    // Allow any onrender.com subdomain (same-origin on Render)
    if (typeof origin === 'string' && origin.endsWith('.onrender.com')) return callback(null, true);

    // Allow whitelisted domains
    if (CORS_WHITELIST.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      log('WARN', `CORS blocked origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// Body parser with size limit (10MB)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request ID middleware
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-ID', req.id);
  next();
});

// Request logging middleware
app.use((req, res, next) => {
  log('INFO', `${req.method} ${req.path}`, req.id, {
    ip: req.ip,
    userAgent: req.get('user-agent')
  });
  next();
});

// Rate limiting (100 requests per 15 minutes per IP)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: {
    error: 'Too many requests from this IP, please try again after 15 minutes',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    log('WARN', 'Rate limit exceeded', req.id, { ip: req.ip });
    res.status(429).json({
      error: 'Too many requests from this IP, please try again after 15 minutes',
      retryAfter: '15 minutes'
    });
  }
});

app.use('/api/', limiter);
app.use('/chat', limiter);
app.use('/generate-invoice-followup', limiter);
app.use('/generate-adjuster-followup', limiter);
app.use('/generate-estimate', limiter);
app.use('/generate-change-order', limiter);

// Strict rate limiter for login attempts: 10 per 15 min per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Please wait 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Rate limiter for signup requests: 5 per hour per IP
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many signup attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

// ============================================
// AUTHENTICATION MIDDLEWARE
// ============================================

/**
 * Validates API key from X-API-Key header
 */
function requireApiKey(req, res, next) {
  const apiKey = req.get('X-API-Key');

  if (!apiKey) {
    log('WARN', 'Missing API key', req.id);
    return res.status(401).json({
      error: 'Authentication required',
      message: 'Please provide X-API-Key header'
    });
  }

  if (apiKey !== API_KEY) {
    log('WARN', 'Invalid API key', req.id);
    return res.status(403).json({
      error: 'Invalid API key',
      message: 'The provided API key is not valid'
    });
  }

  next();
}

/**
 * Validates a Bearer login token issued by POST /login.
 * Used on /chat (the frontend chat endpoint).
 */
function requireLogin(req, res, next) {
  const authHeader = req.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    log('WARN', 'Missing login token', req.id);
    return res.status(401).json({ error: 'Authentication required', message: 'Please log in to use the chat' });
  }
  const result = verifyLoginToken(token);
  if (!result.valid) {
    log('WARN', `Invalid login token: ${result.reason}`, req.id);
    return res.status(401).json({ error: 'Session expired or invalid', message: 'Please log in again' });
  }
  req.authenticatedUser = result.username;
  next();
}

// ============================================
// SCORE-BASED AI ROUTING LOGIC
// ============================================

/**
 * Calculates routing score for each AI based on prompt characteristics
 * Higher score = better match
 *
 * @param {string} prompt - User prompt
 * @returns {Object} { ai: 'gemini'|'openclaw', confidence: number, scores: Object }
 */
function chooseAI(prompt) {
  const lower = prompt.toLowerCase().trim();
  const words = prompt.trim().split(/\s+/);

  let geminiScore = 0;
  let openclawScore = 0;

  // ===== GEMINI SCORING =====

  // Pure questions without action verbs (+30 points)
  const pureQuestions = /^(what|why|when|where|who|which|whose|how much|how many|is it|are there|can you explain|tell me about|define)\s/i;
  if (pureQuestions.test(prompt)) {
    geminiScore += 30;
  }

  // Question words at start (+10 points)
  const questionStarters = ['what is', 'what are', 'what does', 'why is', 'why do', 'when did', 'where is', 'who is', 'who was'];
  for (const starter of questionStarters) {
    if (lower.startsWith(starter)) {
      geminiScore += 10;
      break;
    }
  }

  // Explanation requests (+15 points)
  if (lower.includes('explain') || lower.includes('definition') || lower.includes('meaning of')) {
    geminiScore += 15;
  }

  // Short queries (≤5 words) that are greetings (+20 points)
  if (words.length <= 5) {
    const greetings = ['hi', 'hello', 'hey', 'thanks', 'thank you', 'goodbye', 'bye'];
    if (greetings.some(g => lower === g || lower.startsWith(g + ' '))) {
      geminiScore += 20;
    }
  }

  // ===== OPENCLAW SCORING =====

  // EXECUTION VERBS (highest priority - +50 points each)
  const executionVerbs = [
    'build', 'create', 'generate', 'make', 'develop', 'design',
    'write', 'draft', 'compose', 'author',
    'calculate', 'compute', 'sum', 'total', 'average', 'count',
    'find', 'search', 'look up', 'locate', 'discover',
    'analyze', 'evaluate', 'assess', 'review', 'examine',
    'implement', 'execute', 'run', 'perform', 'do',
    'optimize', 'improve', 'enhance', 'refactor',
    'compare', 'contrast', 'research', 'investigate',
    'summarize', 'summarise', 'summary', 'list', 'show', 'get'
  ];

  for (const verb of executionVerbs) {
    if (lower.includes(verb)) {
      openclawScore += 50;
      break; // Only count once
    }
  }

  // CRITICAL: "How can you [ACTION_VERB]" patterns should route to OpenClaw (+60 points)
  const howCanYouPattern = /how (can|could|do) (you|i|we) (build|create|find|make|generate|calculate|analyze|write|design|develop)/i;
  if (howCanYouPattern.test(prompt)) {
    openclawScore += 60;
    geminiScore = 0; // Override gemini score
  }

  // Data processing keywords (+30 points)
  const dataKeywords = ['csv', 'spreadsheet', 'data', 'parse', 'process', 'extract', 'transform'];
  for (const keyword of dataKeywords) {
    if (lower.includes(keyword)) {
      openclawScore += 30;
      break;
    }
  }

  // Business/professional tasks (+25 points)
  const businessKeywords = ['proposal', 'report', 'presentation', 'analysis', 'strategy', 'plan', 'roadmap', 'market research'];
  for (const keyword of businessKeywords) {
    if (lower.includes(keyword)) {
      openclawScore += 25;
      break;
    }
  }

  // User data access (+50 points - VERY IMPORTANT)
  const dataAccess = ['my emails', 'my calendar', 'my data', 'my files', 'my documents', 'my messages'];
  for (const keyword of dataAccess) {
    if (lower.includes(keyword)) {
      openclawScore += 50;
      break;
    }
  }

  // Generic "my" + data pattern (+40 points)
  if (/\bmy\s+(last|recent|latest|first|next)\s+\d+\s+\w+/.test(lower)) {
    // Matches: "my last 5 emails", "my recent 10 messages", etc.
    openclawScore += 40;
  }

  // Complex/multi-step indicators (+20 points)
  const complexityIndicators = ['comprehensive', 'detailed', 'in-depth', 'thorough', 'step-by-step'];
  for (const indicator of complexityIndicators) {
    if (lower.includes(indicator)) {
      openclawScore += 20;
      break;
    }
  }

  // Longer prompts tend to be tasks (+1 point per word over 10)
  if (words.length > 10) {
    openclawScore += (words.length - 10);
  }

  // ===== DECISION =====

  const ai = openclawScore > geminiScore ? 'openclaw' : 'gemini';
  const confidence = Math.abs(openclawScore - geminiScore);

  return {
    ai,
    confidence,
    scores: {
      gemini: geminiScore,
      openclaw: openclawScore
    }
  };
}

// ============================================
// GEMINI API INTEGRATION
// ============================================

/**
 * Calls Gemini API with timeout and AbortController
 * @param {string} prompt - User prompt
 * @param {number} timeoutMs - Timeout in milliseconds (default: 30s)
 * @returns {Promise<string>} AI response
 */
async function callGemini(prompt, timeoutMs = 30000) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_NOT_CONFIGURED');
  }

  log('INFO', 'Calling Gemini API');

  const models = [
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-2.5-flash'
  ];

  let quotaError = false;
  let lastError = '';

  for (const model of models) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [{ text: prompt }]
            }]
          }),
          signal: controller.signal
        }
      );

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

        if (text) {
          log('INFO', `Gemini (${model}) responded successfully`);
          return text;
        }
      } else if (response.status === 403) {
        const errorData = await response.json();
        if (errorData.error?.message?.includes('leaked') || errorData.error?.message?.includes('PERMISSION_DENIED')) {
          log('ERROR', 'Gemini API key has been flagged as leaked!');
          throw new Error('GEMINI_API_KEY_LEAKED');
        }
      } else if (response.status === 429) {
        quotaError = true;
        const errorData = await response.json();
        lastError = errorData.error?.message || 'Quota exceeded';
        log('WARN', `Gemini quota exceeded for ${model}`);
        continue;
      }

      log('WARN', `Gemini model ${model} failed (status ${response.status})`);

    } catch (err) {
      clearTimeout(timeoutId);

      if (err.name === 'AbortError') {
        log('ERROR', `Gemini ${model} timeout after ${timeoutMs}ms`);
        lastError = 'Request timeout';
      } else {
        log('ERROR', `Gemini ${model} error: ${err.message}`);
        lastError = err.message;
      }
      continue;
    }
  }

  if (quotaError) {
    throw new Error('GEMINI_QUOTA_EXCEEDED');
  }

  throw new Error(`GEMINI_FAILED: ${lastError}`);
}

// ============================================
// OPENCLAW API INTEGRATION
// ============================================

/**
 * Calls a locally-running or VPS-hosted OpenClaw instance
 * via its OpenAI-compatible chat completions API.
 *
 * OpenClaw exposes: POST <url>/v1/chat/completions
 * Auth: Bearer token in Authorization header (optional)
 *
 * @param {string} prompt         - User prompt
 * @param {string} openclawUrl    - Base URL, e.g. http://your-vps:18789
 * @param {string} openclawToken  - Bearer token (may be empty)
 * @param {number} timeoutMs      - Request timeout in ms (default: 60s)
 * @returns {Promise<string>} AI response text
 */
async function callOpenClaw(prompt, openclawUrl, openclawToken, timeoutMs = 25000, isAdmin = false) {
  // Non-admin users must supply their own credentials — never fall back to env vars
  const url   = openclawUrl   || (isAdmin ? OPENCLAW_URL   : '');
  const token = openclawToken || (isAdmin ? OPENCLAW_TOKEN : '');

  if (!url) {
    throw new Error(isAdmin ? 'OPENCLAW_NOT_CONFIGURED' : 'OPENCLAW_CREDENTIALS_REQUIRED');
  }

  // Basic SSRF guard: only allow http/https URLs
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new Error('OPENCLAW_NOT_CONFIGURED');
  }

  const endpoint = `${url.replace(/\/$/, '')}/v1/chat/completions`;
  log('INFO', `Calling OpenClaw at: ${endpoint}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {
    'Content-Type': 'application/json',
    'x-openclaw-agent-id': 'main'
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'openclaw',
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (response.status === 401 || response.status === 403) {
      log('ERROR', `OpenClaw auth failed: HTTP ${response.status}`);
      throw new Error('OPENCLAW_AUTH_FAILED');
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      log('ERROR', `OpenClaw HTTP ${response.status}: ${errText}`);
      throw new Error('OPENCLAW_UNREACHABLE');
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;

    if (!text) {
      log('ERROR', 'OpenClaw returned empty response');
      throw new Error('OPENCLAW_UNREACHABLE');
    }

    log('INFO', 'OpenClaw responded successfully');
    return text;

  } catch (err) {
    clearTimeout(timeoutId);

    if (err.name === 'AbortError') {
      log('ERROR', `OpenClaw timeout after ${timeoutMs}ms`);
      throw new Error('OPENCLAW_TIMEOUT');
    }

    // Re-throw known OpenClaw errors as-is
    if (err.message.startsWith('OPENCLAW_')) {
      throw err;
    }

    // All other network errors (ECONNREFUSED, ENOTFOUND, etc.) = not reachable
    log('ERROR', `OpenClaw connection error: ${err.message}`);
    throw new Error('OPENCLAW_UNREACHABLE');
  }
}

// ============================================
// API ENDPOINTS
// ============================================

/**
 * Frontend HTML interface
 */
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Automation Assistant</title>

    <!-- Fonts -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">

    <!-- Markdown and syntax highlighting -->
    <script src="https://cdn.jsdelivr.net/npm/marked@11.1.1/marked.min.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>

    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }

        /* ============================================
           DESIGN SYSTEM
           Aesthetic: Modern dark dashboard
           Font: Inter
           Palette: Deep purple/navy bg, violet accent, white text
           ============================================ */

        :root {
            --bg:          #0d0b1e;
            --bg-mid:      #100d22;
            --bg-panel:    #140f2a;
            --bg-raised:   #1c1638;
            --bg-hover:    #231b44;
            --border:      rgba(139,92,246,0.12);
            --border-mid:  rgba(139,92,246,0.2);
            --border-hi:   rgba(139,92,246,0.32);
            --text:        #f0eeff;
            --text-mid:    #a89cc8;
            --text-dim:    #6b5f8a;
            --accent:      #8b5cf6;
            --accent-lo:   rgba(139,92,246,.15);
            --accent-glow: rgba(139,92,246,.4);
            --green:       #10b981;
            --green-lo:    rgba(16,185,129,.12);
            --orange:      #f59e0b;
            --orange-lo:   rgba(245,158,11,.12);
            --red:         #ef4444;
            --red-lo:      rgba(239,68,68,.1);
            --mono:        'Inter', ui-monospace, 'JetBrains Mono', monospace;
            --serif:       'Inter', ui-sans-serif, system-ui, sans-serif;
            --sans:        'Inter', ui-sans-serif, system-ui, sans-serif;
            --radius-sm:   10px;
            --radius:      14px;
            --radius-lg:   18px;
            --shadow:      0 4px 24px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,0.04);
            --shadow-lg:   0 20px 60px rgba(0,0,0,.8);
        }

        /* Screen reader only content */
        .sr-only {
            position: absolute;
            width: 1px;
            height: 1px;
            padding: 0;
            margin: -1px;
            overflow: hidden;
            clip: rect(0, 0, 0, 0);
            white-space: nowrap;
            border-width: 0;
        }

        /* Focus visible for better keyboard navigation */
        *:focus-visible {
            outline: 1.5px solid var(--accent);
            outline-offset: 2px;
        }

        body {
            font-family: var(--sans);
            background: linear-gradient(135deg, #0d0b1e 0%, #1a1232 50%, #0f0c20 100%);
            background-attachment: fixed;
            min-height: 100vh;
            display: flex;
            overflow: hidden;
            color: var(--text);
        }

        /* Ambient glow orbs */
        body::before {
            content: '';
            position: fixed;
            inset: 0;
            background:
                radial-gradient(ellipse 70% 60% at 15% 20%, rgba(139,92,246,0.1) 0%, transparent 60%),
                radial-gradient(ellipse 50% 50% at 80% 80%, rgba(59,130,246,0.07) 0%, transparent 60%);
            pointer-events: none;
            z-index: 0;
        }

        /* ===== SIDEBAR ===== */
        .sidebar {
            width: 252px;
            background: rgba(20,15,42,0.92);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border-right: 1px solid rgba(139,92,246,0.12);
            display: flex;
            flex-direction: column;
            height: 100vh;
            flex-shrink: 0;
            overflow: hidden;
            position: relative;
            z-index: 1;
        }
        .sidebar-header {
            padding: 14px 10px 10px;
            border-bottom: 1px solid var(--border);
        }
        .home-btn {
            width: 100%;
            padding: 9px 12px;
            background: transparent;
            color: var(--text-mid);
            border: 1px solid var(--border-mid);
            border-radius: var(--radius-sm);
            font-weight: 500;
            font-size: 12px;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            cursor: pointer;
            transition: all 0.15s;
            display: flex;
            align-items: center;
            gap: 8px;
            font-family: var(--mono);
        }
        .home-btn:hover {
            background: var(--bg-hover);
            border-color: var(--border-hi);
            color: var(--text);
        }

        /* AI Mode Selector */
        .ai-mode-section {
            padding: 10px 10px 10px;
            border-bottom: 1px solid var(--border);
        }
        .ai-mode-label {
            color: var(--text-dim);
            font-size: 9px;
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.12em;
            margin-bottom: 7px;
            padding: 0 2px;
            font-family: var(--mono);
        }
        .ai-mode-tabs {
            display: flex;
            gap: 4px;
        }
        .ai-mode-btn {
            flex: 1;
            padding: 7px 5px;
            border-radius: var(--radius-sm);
            border: 1px solid var(--border);
            background: transparent;
            color: var(--text-dim);
            font-size: 11px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.15s;
            text-align: center;
            font-family: var(--mono);
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 5px;
        }
        .ai-mode-btn:hover:not(.active) {
            border-color: var(--border-hi);
            color: var(--text-mid);
            background: var(--bg-hover);
        }
        .ai-mode-btn.active.gemini {
            background: var(--green-lo);
            border-color: var(--green);
            color: var(--green);
        }
        .ai-mode-btn.active.openclaw {
            background: var(--orange-lo);
            border-color: var(--orange);
            color: var(--orange);
        }

        /* OpenClaw Status Bar */
        .openclaw-status {
            padding: 7px 12px;
            font-size: 10px;
            display: flex;
            align-items: center;
            gap: 6px;
            border-bottom: 1px solid var(--border);
            background: var(--bg);
            color: var(--text-mid);
            font-family: var(--mono);
        }
        .openclaw-status-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--text-dim);
            flex-shrink: 0;
        }
        .openclaw-status-dot.online  { background: var(--green); }
        .openclaw-status-dot.offline { background: var(--red); }
        .openclaw-status-dot.checking {
            background: var(--accent);
            animation: blink 1.2s ease-in-out infinite;
        }
        @keyframes blink {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.25; }
        }
        .openclaw-settings-link {
            margin-left: auto;
            background: none;
            border: none;
            color: var(--accent);
            font-size: 10px;
            cursor: pointer;
            padding: 0;
            font-family: var(--mono);
            display: flex;
            align-items: center;
            gap: 4px;
            letter-spacing: 0.05em;
        }
        .openclaw-settings-link:hover { color: var(--text); }

        /* ===== FULL SETTINGS PANEL ===== */
        .settings-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.6);
            z-index: 999;
            display: none;
            backdrop-filter: blur(3px);
        }
        .settings-overlay.open { display: block; }
        .settings-panel {
            position: fixed;
            top: 0; right: 0;
            width: 400px;
            height: 100vh;
            background: var(--bg-panel);
            border-left: 1px solid var(--border);
            z-index: 1000;
            padding: 0;
            transform: translateX(100%);
            transition: transform 0.22s cubic-bezier(0.4,0,0.2,1);
            overflow: hidden;
            display: flex;
            flex-direction: column;
            box-shadow: -20px 0 80px rgba(0,0,0,0.7);
        }
        .settings-panel.open { transform: translateX(0); }

        /* Header */
        .settings-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 18px 18px 14px;
            border-bottom: 1px solid var(--border);
            flex-shrink: 0;
        }
        .settings-header-user {
            display: flex;
            align-items: center;
            gap: 11px;
        }
        .settings-header-avatar {
            width: 36px;
            height: 36px;
            border-radius: var(--radius-sm);
            background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            font-weight: 700;
            color: #ffffff;
            flex-shrink: 0;
            text-transform: uppercase;
            font-family: var(--mono);
        }
        .settings-header-name {
            font-size: 14px;
            font-weight: 600;
            color: #ececec;
        }
        .settings-header-sub {
            font-size: 11px;
            color: #6b6b6b;
            margin-top: 1px;
        }
        .settings-close-btn {
            background: var(--bg-raised);
            border: 1px solid var(--border-mid);
            color: var(--text-dim);
            cursor: pointer;
            padding: 6px 9px;
            border-radius: var(--radius-sm);
            transition: all 0.15s;
            font-family: var(--mono);
            line-height: 1;
            display: flex;
            align-items: center;
        }
        .settings-close-btn:hover { color: var(--text); border-color: var(--border-hi); }

        /* Tab nav */
        .stabs {
            display: flex;
            gap: 0;
            padding: 0 16px;
            border-bottom: 1px solid var(--border);
            flex-shrink: 0;
            background: var(--bg-panel);
        }
        .stab {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 5px;
            padding: 10px 4px 11px;
            background: transparent;
            border: none;
            border-bottom: 2px solid transparent;
            color: var(--text-dim);
            font-size: 11px;
            font-weight: 500;
            cursor: pointer;
            font-family: var(--mono);
            letter-spacing: 0.04em;
            transition: color 0.15s, border-color 0.15s;
            white-space: nowrap;
            margin-bottom: -1px;
            text-transform: uppercase;
        }
        .stab:hover { color: var(--text-mid); }
        .stab.active {
            color: var(--text);
            border-bottom-color: var(--accent);
        }

        /* Tab content area */
        .stab-content {
            display: none;
            padding: 18px 18px;
            overflow-y: auto;
            flex: 1;
        }
        .stab-content.active { display: block; }

        .stab-section-title {
            display: flex;
            align-items: center;
            gap: 7px;
            font-size: 10px;
            font-weight: 500;
            color: var(--text-dim);
            text-transform: uppercase;
            letter-spacing: 0.1em;
            margin-bottom: 14px;
            font-family: var(--mono);
        }

        /* Form elements */
        .settings-group {
            margin-bottom: 16px;
        }
        .settings-group label {
            display: block;
            color: var(--text-mid);
            font-size: 11px;
            margin-bottom: 5px;
            font-weight: 500;
            font-family: var(--mono);
            letter-spacing: 0.04em;
            text-transform: uppercase;
        }
        .settings-group input[type="text"],
        .settings-group input[type="password"],
        .settings-group textarea,
        .settings-group select {
            width: 100%;
            padding: 8px 11px;
            background: var(--bg-raised);
            border: 1px solid var(--border-mid);
            border-radius: var(--radius-sm);
            color: var(--text);
            font-size: 13px;
            font-family: var(--sans);
            transition: border-color 0.15s;
            box-sizing: border-box;
        }
        .settings-group textarea {
            resize: vertical;
            min-height: 110px;
            line-height: 1.5;
            font-family: var(--mono);
            font-size: 12px;
        }
        .settings-group select {
            appearance: none;
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2355555f' stroke-width='2.5' stroke-linecap='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
            background-repeat: no-repeat;
            background-position: right 10px center;
            cursor: pointer;
        }
        .settings-group input:focus,
        .settings-group textarea:focus,
        .settings-group select:focus {
            border-color: var(--accent);
            outline: none;
            box-shadow: 0 0 0 2px var(--accent-lo);
        }
        .settings-hint {
            color: var(--text-dim);
            font-size: 11px;
            margin-top: 5px;
            line-height: 1.5;
            font-family: var(--mono);
        }

        /* Slider */
        .settings-slider-row {
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .settings-slider-row input[type="range"] {
            flex: 1;
            accent-color: var(--accent);
            height: 4px;
            cursor: pointer;
            background: transparent;
            padding: 0;
            border: none;
            box-shadow: none;
        }
        .settings-slider-row input[type="range"]:focus { box-shadow: none; }
        .settings-slider-val {
            min-width: 30px;
            text-align: right;
            font-size: 12px;
            font-weight: 600;
            color: var(--accent);
            font-family: var(--mono);
        }

        /* Save buttons */
        .settings-save-btn {
            width: 100%;
            padding: 9px;
            background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%);
            color: #ffffff;
            border: none;
            border-radius: var(--radius-sm);
            font-weight: 700;
            font-size: 12px;
            cursor: pointer;
            margin-top: 4px;
            transition: opacity 0.15s;
            font-family: var(--mono);
            letter-spacing: 0.06em;
            text-transform: uppercase;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 7px;
            box-shadow: 0 4px 16px rgba(139,92,246,0.4);
        }
        .settings-save-btn:hover { opacity: 0.88; }
        .settings-save-btn-sm {
            padding: 7px 12px;
            background: var(--bg-raised);
            color: var(--text-mid);
            border: 1px solid var(--border-mid);
            border-radius: var(--radius-sm);
            font-size: 11px;
            font-weight: 500;
            cursor: pointer;
            font-family: var(--mono);
            letter-spacing: 0.04em;
            transition: all 0.15s;
            display: inline-flex;
            align-items: center;
            gap: 6px;
        }
        .settings-save-btn-sm:hover { background: var(--bg-hover); color: var(--text); border-color: var(--border-hi); }
        .settings-danger-btn {
            width: 100%;
            padding: 8px 12px;
            background: transparent;
            color: var(--red);
            border: 1px solid rgba(224,85,85,0.25);
            border-radius: var(--radius-sm);
            font-size: 11px;
            font-weight: 500;
            cursor: pointer;
            font-family: var(--mono);
            letter-spacing: 0.04em;
            text-transform: uppercase;
            transition: all 0.15s;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .settings-danger-btn:hover { background: var(--red-lo); border-color: rgba(224,85,85,0.5); }

        .settings-divider {
            border: none;
            border-top: 1px solid var(--border);
            margin: 16px 0;
        }
        .settings-instructions {
            color: var(--text-dim);
            font-size: 11px;
            line-height: 1.8;
            font-family: var(--mono);
        }
        .settings-instructions strong { color: var(--text-mid); }

        /* Profile avatar row */
        .settings-avatar-row {
            display: flex;
            align-items: center;
            gap: 14px;
            margin-bottom: 18px;
            padding: 12px;
            background: var(--bg);
            border-radius: var(--radius-sm);
            border: 1px solid var(--border);
        }
        .settings-big-avatar {
            width: 48px;
            height: 48px;
            border-radius: var(--radius-sm);
            background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 18px;
            font-weight: 700;
            color: #ffffff;
            flex-shrink: 0;
            text-transform: uppercase;
            font-family: var(--mono);
        }
        .settings-avatar-hint {
            font-size: 11px;
            color: var(--text-dim);
            line-height: 1.5;
            font-family: var(--mono);
        }

        /* Test result */
        .settings-test-result {
            margin-top: 10px;
            padding: 8px 12px;
            border-radius: var(--radius-sm);
            font-size: 11px;
            font-weight: 500;
            font-family: var(--mono);
        }
        .settings-test-result.success {
            background: var(--green-lo);
            border: 1px solid rgba(45,184,125,0.3);
            color: var(--green);
        }
        .settings-test-result.error {
            background: var(--red-lo);
            border: 1px solid rgba(224,85,85,0.3);
            color: var(--red);
        }

        /* Connector cards */
        .connector-card {
            border: 1px solid var(--border);
            border-radius: var(--radius-sm);
            overflow: hidden;
            margin-bottom: 10px;
            background: var(--bg);
        }
        .connector-card-header {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 12px 12px 10px;
            cursor: pointer;
            user-select: none;
        }
        .connector-card-header:hover { background: var(--bg-hover); }
        .connector-icon {
            width: 30px;
            height: 30px;
            border-radius: var(--radius-sm);
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
        }
        .gemini-icon  { background: var(--green-lo); color: var(--green); }
        .notion-icon  { background: rgba(255,255,255,0.05); color: var(--text-mid); }
        .webhook-icon { background: rgba(139,92,246,0.12); color: #a78bfa; }
        .connector-info { flex: 1; min-width: 0; }
        .connector-name { font-size: 12px; font-weight: 600; color: var(--text); font-family: var(--mono); }
        .connector-desc { font-size: 10px; color: var(--text-dim); margin-top: 2px; font-family: var(--mono); }
        .connector-status {
            display: flex;
            align-items: center;
            gap: 5px;
            font-size: 10px;
            color: var(--text-dim);
            flex-shrink: 0;
            font-family: var(--mono);
        }
        .connector-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--border-hi);
        }
        .connector-dot.connected { background: var(--green); }
        .connector-body {
            padding: 0 12px 12px;
            border-top: 1px solid var(--border);
        }

        /* ===== SIDEBAR HISTORY ===== */
        .history-section {
            flex: 1;
            overflow-y: auto;
            padding: 6px 6px 6px;
            min-height: 0;
        }
        .history-title {
            color: var(--text-dim);
            font-size: 9px;
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.12em;
            margin-bottom: 4px;
            padding: 8px 6px 4px;
            font-family: var(--mono);
        }
        .history-item {
            padding: 9px 9px;
            margin-bottom: 1px;
            background: transparent;
            border-radius: var(--radius-sm);
            cursor: pointer;
            transition: background 0.12s;
            border: 1px solid transparent;
            position: relative;
        }
        .history-item:hover {
            background: var(--bg-hover);
            border-color: var(--border);
        }
        .history-item:hover .delete-chat-btn {
            opacity: 1;
        }
        .history-item-title {
            color: var(--text);
            font-size: 12px;
            margin-bottom: 2px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            padding-right: 26px;
            font-weight: 400;
        }
        .history-item-preview {
            color: var(--text-dim);
            font-size: 10px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-family: var(--mono);
        }
        .history-item-time {
            color: var(--text-dim);
            font-size: 9px;
            margin-top: 3px;
            font-family: var(--mono);
        }
        .delete-chat-btn {
            position: absolute;
            top: 7px;
            right: 7px;
            background: transparent;
            color: var(--text-dim);
            border: none;
            padding: 3px 5px;
            border-radius: 3px;
            font-size: 10px;
            cursor: pointer;
            opacity: 0;
            transition: all 0.12s;
            z-index: 10;
            display: flex;
            align-items: center;
        }
        .delete-chat-btn:hover {
            background: var(--red-lo);
            color: var(--red);
        }

        /* ===== ACCOUNT SECTION ===== */
        .account-section {
            padding: 8px 8px 10px;
            border-top: 1px solid var(--border);
            flex-shrink: 0;
            display: flex;
            align-items: center;
            gap: 5px;
        }
        .account-btn {
            flex: 1;
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 7px 8px;
            border-radius: var(--radius-sm);
            border: 1px solid transparent;
            background: transparent;
            cursor: pointer;
            transition: all 0.12s;
            text-align: left;
            font-family: var(--sans);
            min-width: 0;
        }
        .account-btn:hover {
            background: var(--bg-hover);
            border-color: var(--border);
        }
        .account-avatar {
            width: 28px;
            height: 28px;
            border-radius: var(--radius-sm);
            background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 11px;
            font-weight: 700;
            color: #ffffff;
            text-transform: uppercase;
            flex-shrink: 0;
            font-family: var(--mono);
        }
        .account-info {
            flex: 1;
            min-width: 0;
        }
        .account-name {
            color: var(--text);
            font-size: 12px;
            font-weight: 500;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .account-plan {
            color: var(--text-dim);
            font-size: 10px;
            font-family: var(--mono);
        }
        .logout-btn {
            background: none;
            border: 1px solid transparent;
            color: var(--text-dim);
            cursor: pointer;
            padding: 5px 6px;
            border-radius: var(--radius-sm);
            display: flex;
            align-items: center;
            flex-shrink: 0;
            transition: all 0.12s;
        }
        .logout-btn:hover { color: var(--red); background: var(--red-lo); border-color: rgba(224,85,85,0.2); }

        /* ===== MAIN CONTENT ===== */
        .main-content {
            flex: 1;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: var(--bg);
            min-width: 0;
            position: relative;
            z-index: 1;
        }
        .container {
            width: 100%;
            max-width: 100%;
            margin: 0 auto;
            background: transparent;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            height: 100vh;
        }

        /* ===== HEADER ===== */
        .header {
            background: rgba(20,15,42,0.85);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            color: var(--text);
            padding: 11px 20px;
            border-bottom: 1px solid rgba(139,92,246,0.12);
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-shrink: 0;
        }
        .header-left {
            display: flex;
            align-items: center;
            gap: 9px;
        }
        .header-icon {
            width: 28px;
            height: 28px;
            background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%);
            border-radius: var(--radius-sm);
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            box-shadow: 0 2px 10px rgba(139,92,246,0.5);
        }
        .header h1 {
            font-family: var(--mono);
            font-size: 13px;
            font-weight: 500;
            color: var(--text-mid);
            letter-spacing: 0.06em;
            text-transform: uppercase;
        }
        .header-right {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .status-badge {
            display: flex;
            align-items: center;
            gap: 5px;
            padding: 4px 9px;
            background: var(--green-lo);
            border: 1px solid rgba(45,184,125,.2);
            border-radius: 3px;
            font-size: 10px;
            color: var(--green);
            font-family: var(--mono);
            letter-spacing: 0.06em;
            text-transform: uppercase;
        }
        .status-indicator {
            display: inline-block;
            width: 5px;
            height: 5px;
            border-radius: 50%;
            background: var(--green);
            animation: glow 2.5s ease-in-out infinite;
        }
        @keyframes glow {
            0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(45,184,125,.4); }
            50% { opacity: 0.7; box-shadow: 0 0 0 3px rgba(45,184,125,0); }
        }
        .ai-models {
            font-size: 10px;
            color: var(--text-dim);
            font-family: var(--mono);
        }
        .ai-models span {
            color: var(--accent);
            font-weight: 500;
        }

        /* ===== CHAT AREA ===== */
        .chat-area {
            flex: 1;
            overflow-y: auto;
            padding: 0;
            background: var(--bg);
        }
        .chat-inner {
            max-width: 700px;
            margin: 0 auto;
            padding: 28px 22px;
        }

        /* ===== EMPTY STATE ===== */
        .empty-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 60vh;
            color: var(--text-dim);
            text-align: center;
            padding: 48px 24px;
        }
        .empty-logo {
            width: 52px;
            height: 52px;
            background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%);
            border-radius: var(--radius-sm);
            display: flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 22px;
            box-shadow: 0 6px 24px rgba(139,92,246,0.5);
        }
        .empty-state h2 {
            font-family: var(--sans);
            font-size: 2rem;
            font-style: normal;
            margin-bottom: 10px;
            color: var(--text);
            font-weight: 700;
            letter-spacing: -0.02em;
        }
        .empty-state p {
            font-size: 13px;
            margin-bottom: 36px;
            color: var(--text-dim);
            max-width: 340px;
            line-height: 1.7;
            font-family: var(--mono);
        }
        .example-queries {
            text-align: left;
            max-width: 540px;
            width: 100%;
        }
        .example-queries h3 {
            font-size: 9px;
            margin-bottom: 10px;
            color: var(--text-dim);
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.12em;
            font-family: var(--mono);
        }
        .example-queries ul {
            list-style: none;
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 6px;
        }
        .example-queries li {
            padding: 13px 14px;
            background: var(--bg-panel);
            border: 1px solid var(--border);
            border-radius: var(--radius-sm);
            color: var(--text-mid);
            cursor: pointer;
            font-size: 12px;
            transition: all 0.15s;
            line-height: 1.5;
            display: flex;
            align-items: flex-start;
            gap: 9px;
        }
        .example-queries li:hover {
            background: var(--bg-hover);
            border-color: var(--accent);
            color: var(--text);
        }
        .example-queries li svg {
            flex-shrink: 0;
            margin-top: 1px;
            opacity: 0.45;
            color: var(--accent);
        }
        .example-queries li:hover svg { opacity: 0.8; }

        /* ===== MESSAGES ===== */
        .message-row {
            display: flex;
            gap: 14px;
            margin-bottom: 24px;
            align-items: flex-start;
        }
        .message-row.user-row {
            flex-direction: row-reverse;
        }
        .msg-avatar {
            width: 28px;
            height: 28px;
            border-radius: var(--radius-sm);
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            font-size: 11px;
            font-weight: 700;
            font-family: var(--mono);
        }
        .msg-avatar.user-av {
            background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%);
            color: #ffffff;
        }
        .msg-avatar.bot-av {
            background: var(--green-lo);
            color: var(--green);
            border: 1px solid rgba(45,184,125,.25);
        }
        .msg-avatar.bot-av.openclaw-av {
            background: var(--orange-lo);
            color: var(--orange);
            border: 1px solid rgba(224,112,51,.25);
        }
        .message {
            padding: 13px 16px;
            border-radius: var(--radius);
            max-width: 85%;
            word-wrap: break-word;
            line-height: 1.65;
            animation: fadeUp 0.18s ease-out;
            position: relative;
            font-size: 14px;
        }
        .message-actions {
            position: absolute;
            top: 7px;
            right: 8px;
            display: flex;
            gap: 3px;
            opacity: 0;
            transition: opacity 0.15s;
        }
        .message:hover .message-actions { opacity: 1; }
        .message-action-btn {
            background: rgba(0,0,0,.3);
            color: var(--text-mid);
            border: none;
            padding: 4px 8px;
            border-radius: 3px;
            font-size: 10px;
            cursor: pointer;
            transition: background 0.15s;
            font-family: var(--mono);
            display: flex;
            align-items: center;
            gap: 3px;
        }
        .message-action-btn:hover { background: rgba(0,0,0,.5); color: var(--text); }
        .user .message-action-btn { background: rgba(255,255,255,.1); }
        .user .message-action-btn:hover { background: rgba(255,255,255,.2); }
        @keyframes fadeUp {
            from { opacity: 0; transform: translateY(6px); }
            to   { opacity: 1; transform: translateY(0); }
        }
        .user {
            background: linear-gradient(135deg, rgba(139,92,246,0.2) 0%, rgba(109,40,217,0.12) 100%);
            color: var(--text);
            margin-left: auto;
            border: 1px solid rgba(139,92,246,0.3);
        }
        .bot {
            background: rgba(255,255,255,0.04);
            border: 1px solid rgba(255,255,255,0.08);
            color: var(--text);
        }
        .bot.gemini { border-left: 2px solid var(--green); }
        .bot.openclaw { border-left: 2px solid var(--orange); }
        .ai-badge {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 2px 7px 2px 5px;
            border-radius: 3px;
            font-size: 9px;
            font-weight: 600;
            margin-bottom: 9px;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            font-family: var(--mono);
        }
        .ai-badge.gemini {
            background: var(--green-lo);
            color: var(--green);
            border: 1px solid rgba(45,184,125,.3);
        }
        .ai-badge.openclaw {
            background: var(--orange-lo);
            color: var(--orange);
            border: 1px solid rgba(224,112,51,.3);
        }
        .thinking {
            background: var(--bg-panel);
            border: 1px solid var(--border);
            color: var(--text-dim);
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 13px;
            font-family: var(--mono);
        }
        .spinner {
            width: 13px;
            height: 13px;
            border: 1.5px solid var(--border-hi);
            border-top-color: var(--accent);
            border-radius: 50%;
            animation: spin 0.7s linear infinite;
            flex-shrink: 0;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .error {
            background: var(--red-lo);
            border: 1px solid rgba(224,85,85,.25);
            color: var(--red);
            border-left: 2px solid var(--red);
        }
        .routing-info {
            font-size: 10px;
            color: var(--text-dim);
            margin-top: 7px;
            font-family: var(--mono);
        }

        /* ===== INPUT AREA ===== */
        .input-area {
            padding: 14px 20px 18px;
            background: rgba(20,15,42,0.85);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border-top: 1px solid rgba(139,92,246,0.12);
            flex-shrink: 0;
        }
        .input-wrap {
            max-width: 700px;
            margin: 0 auto;
            display: flex;
            align-items: center;
            gap: 0;
            background: rgba(255,255,255,0.05);
            border: 1px solid rgba(139,92,246,0.2);
            border-radius: 16px;
            transition: border-color 0.15s, box-shadow 0.15s;
            padding: 4px 6px 4px 16px;
        }
        .input-wrap:focus-within {
            border-color: var(--accent);
            box-shadow: 0 0 0 2px var(--accent-lo);
        }
        input {
            flex: 1;
            padding: 9px 0;
            background: transparent;
            border: none;
            font-size: 14px;
            font-family: var(--sans);
            color: var(--text);
            outline: none;
            min-width: 0;
        }
        input::placeholder { color: var(--text-dim); }
        .send-btn {
            width: 36px;
            height: 36px;
            min-width: 36px;
            padding: 0;
            background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%);
            color: #ffffff;
            border: none;
            border-radius: 12px;
            cursor: pointer;
            transition: opacity 0.15s, transform 0.1s;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            font-family: var(--mono);
            box-shadow: 0 2px 12px rgba(139,92,246,0.4);
        }
        .send-btn:hover:not(:disabled) { opacity: 0.85; }
        .send-btn:active:not(:disabled) { transform: scale(0.93); }
        .send-btn:disabled { background: var(--bg-hover); color: var(--text-dim); cursor: not-allowed; }
        .send-btn.thinking-state { background: var(--bg-hover); }

        /* Markdown and code styling */
        .message pre {
            background: var(--bg);
            border: 1px solid var(--border-mid);
            border-radius: var(--radius-sm);
            padding: 14px;
            margin: 10px 0;
            overflow-x: auto;
            position: relative;
        }
        .message code {
            font-family: var(--mono);
            font-size: 12px;
            line-height: 1.5;
        }
        .message p code {
            background: rgba(255,255,255,.05);
            padding: 2px 5px;
            border-radius: 3px;
            font-size: 12px;
            color: var(--accent);
            font-family: var(--mono);
        }
        .message pre code { background: transparent; padding: 0; color: var(--text-mid); }
        .message h1, .message h2, .message h3 {
            color: var(--text);
            margin: 16px 0 7px;
            font-weight: 600;
            letter-spacing: -0.01em;
        }
        .message h1 { font-size: 1.3em; border-bottom: 1px solid var(--border); padding-bottom: 7px; }
        .message h2 { font-size: 1.15em; }
        .message h3 { font-size: 1.02em; }
        .message p { margin: 7px 0; }
        .message ul, .message ol { margin: 9px 0; padding-left: 20px; }
        .message li { margin: 4px 0; line-height: 1.65; }
        .message blockquote {
            border-left: 2px solid var(--accent);
            padding-left: 12px;
            margin: 10px 0;
            color: var(--text-dim);
            font-style: italic;
        }
        .message a { color: var(--accent); text-decoration: none; }
        .message a:hover { text-decoration: underline; }
        .message table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 13px; }
        .message th, .message td { border: 1px solid var(--border-mid); padding: 7px 11px; text-align: left; }
        .message th { background: var(--bg); font-weight: 600; color: var(--text-mid); font-family: var(--mono); font-size: 11px; }
        .message td { color: var(--text-mid); }
        .message tr:nth-child(even) td { background: rgba(255,255,255,.015); }
        .message img { max-width: 100%; border-radius: var(--radius-sm); margin: 10px 0; }
        .copy-code-btn {
            position: absolute;
            top: 7px; right: 7px;
            background: var(--border-hi);
            color: var(--text-mid);
            border: none;
            padding: 4px 9px;
            border-radius: 3px;
            font-size: 10px;
            cursor: pointer;
            opacity: 0;
            transition: opacity 0.15s;
            font-family: var(--mono);
            display: flex;
            align-items: center;
            gap: 3px;
        }
        .message pre:hover .copy-code-btn { opacity: 1; }
        .copy-code-btn:hover { background: var(--text-dim); color: var(--text); }

        /* ===== TIMEOUT MESSAGE ===== */
        .timeout-msg {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 10px;
            font-size: 12px;
            color: var(--accent);
            font-family: var(--mono);
        }
        .retry-btn {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            padding: 6px 13px;
            background: var(--bg-raised);
            border: 1px solid var(--border-mid);
            border-radius: var(--radius-sm);
            color: var(--text-mid);
            font-size: 11px;
            font-weight: 500;
            cursor: pointer;
            font-family: var(--mono);
            transition: border-color 0.15s, color 0.15s;
        }
        .retry-btn:hover { border-color: var(--accent); color: var(--accent); }
        .retry-btn svg { color: inherit; }

        /* Scrollbar */
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: var(--border-hi); border-radius: 2px; }
        ::-webkit-scrollbar-thumb:hover { background: var(--text-dim); }

        /* Mobile */
        @media (max-width: 768px) {
            body { flex-direction: column; }
            .sidebar { width: 100%; height: auto; border-right: none; border-bottom: 1px solid var(--border); max-height: 180px; overflow-y: auto; }
            .sidebar-header { padding: 8px; }
            .history-section { max-height: 100px; }
            .main-content { height: calc(100vh - 180px); }
            .header { padding: 10px 14px; }
            .header h1 { font-size: 13px; }
            .chat-inner { padding: 16px 12px; }
            .message { max-width: 100%; padding: 10px 13px; font-size: 14px; }
            .input-area { padding: 10px 12px 14px; }
            .example-queries ul { grid-template-columns: 1fr; }
            .empty-state h2 { font-size: 1.4rem; }
        }
        @media (max-width: 480px) {
            .header h1 { font-size: 12px; }
            .message { padding: 9px 11px; font-size: 13px; }
            .ai-badge { font-size: 9px; padding: 2px 6px; }
            .empty-state h2 { font-size: 1.2rem; }
        }

        /* ===== LOGIN OVERLAY ===== */
        .login-overlay {
            position: fixed; inset: 0; z-index: 9999;
            background: linear-gradient(135deg, #0d0b1e 0%, #1a1232 50%, #0f0c20 100%);
            display: flex; align-items: center; justify-content: center;
            font-family: var(--sans);
        }
        .login-overlay::before {
            content: '';
            position: absolute;
            inset: 0;
            background:
                radial-gradient(ellipse 70% 60% at 30% 30%, rgba(139,92,246,0.2) 0%, transparent 60%),
                radial-gradient(ellipse 50% 50% at 70% 70%, rgba(59,130,246,0.12) 0%, transparent 60%);
            pointer-events: none;
        }
        .login-card {
            width: 100%;
            max-width: 360px;
            background: rgba(20,15,42,0.9);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(139,92,246,0.25);
            border-radius: 20px;
            padding: 40px 32px 32px;
            box-shadow: 0 20px 80px rgba(0,0,0,.6), 0 0 0 1px rgba(139,92,246,.08) inset;
            display: flex;
            flex-direction: column;
            align-items: center;
            position: relative;
            animation: loginIn 0.3s cubic-bezier(0.4,0,0.2,1);
        }
        @keyframes loginIn {
            from { opacity: 0; transform: translateY(12px) scale(0.98); }
            to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes spin {
            from { transform: rotate(0deg); }
            to   { transform: rotate(360deg); }
        }
        .login-logo {
            width: 52px; height: 52px;
            background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%);
            border-radius: 14px;
            display: flex; align-items: center; justify-content: center;
            margin-bottom: 18px;
            flex-shrink: 0;
            box-shadow: 0 4px 24px rgba(139,92,246,0.5);
        }
        .login-card h1 {
            font-family: var(--sans);
            font-size: 20px;
            font-weight: 700;
            color: var(--text);
            text-align: center;
            margin-bottom: 6px;
            letter-spacing: -0.01em;
        }
        .login-card-tagline {
            font-family: var(--sans);
            font-size: 13px;
            font-style: normal;
            color: var(--text-mid);
            text-align: center;
            margin-bottom: 28px;
            letter-spacing: 0;
            line-height: 1.4;
        }
        .login-error {
            width: 100%; font-size: 11px; color: var(--red);
            background: var(--red-lo);
            border: 1px solid rgba(224,85,85,.25);
            border-radius: var(--radius-sm);
            padding: 0; max-height: 0; overflow: hidden;
            transition: max-height .2s, padding .2s, margin-bottom .2s;
            text-align: center; box-sizing: border-box;
            font-family: var(--mono); letter-spacing: 0.03em;
        }
        .login-error.visible { padding: 8px 12px; max-height: 80px; margin-bottom: 12px; }
        .login-success {
            width: 100%; font-size: 11px; color: var(--green);
            background: var(--green-lo);
            border: 1px solid rgba(45,184,125,.25);
            border-radius: var(--radius-sm);
            padding: 0; max-height: 0; overflow: hidden;
            transition: max-height .2s, padding .2s, margin-bottom .2s;
            text-align: center; box-sizing: border-box;
            font-family: var(--mono); letter-spacing: 0.03em;
        }
        .login-success.visible { padding: 8px 12px; max-height: 80px; margin-bottom: 12px; }
        .login-field { width: 100%; margin-bottom: 10px; }
        .login-field input {
            width: 100%; padding: 10px 12px;
            background: var(--bg-raised);
            border: 1px solid var(--border-mid);
            border-radius: var(--radius-sm);
            color: var(--text);
            font-size: 13px;
            font-family: var(--mono);
            box-sizing: border-box; outline: none;
            transition: border-color .15s, box-shadow .15s;
            letter-spacing: 0.03em;
        }
        .login-field input:focus {
            border-color: var(--accent);
            box-shadow: 0 0 0 2px var(--accent-lo);
        }
        .login-field input::placeholder { color: var(--text-dim); }
        .login-submit-btn {
            width: 100%; padding: 12px;
            background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%);
            color: #ffffff;
            border: none;
            border-radius: 12px;
            font-size: 14px; font-weight: 600;
            cursor: pointer;
            font-family: var(--sans);
            transition: opacity .15s, box-shadow .15s;
            margin-top: 6px;
            letter-spacing: 0;
            box-shadow: 0 4px 20px rgba(139,92,246,0.5);
        }
        .login-submit-btn:hover:not(:disabled) { opacity: 0.88; }
        .login-submit-btn:disabled { opacity: .5; cursor: not-allowed; box-shadow: none; }
        .login-card-hint { font-size: 10px; color: var(--text-dim); text-align: center; margin-top: 10px; width: 100%; font-family: var(--mono); letter-spacing: 0.04em; }
        /* login tab bar */
        .login-tab-bar { display: flex; width: 100%; gap: 0; margin-bottom: 20px; border-radius: var(--radius-sm); overflow: hidden; border: 1px solid var(--border-mid); }
        .login-tab { flex: 1; padding: 9px 0; background: var(--bg-raised); color: var(--text-dim); border: none; cursor: pointer; font-size: 11px; font-family: var(--mono); text-transform: uppercase; letter-spacing: 0.08em; transition: background .15s, color .15s; }
        .login-tab.active { background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%); color: #ffffff; font-weight: 600; }

        /* ===== SIDEBAR TOOL NAV ===== */
        .sidebar-tools-section { padding: 6px 6px 4px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
        .sidebar-tools-label { color: var(--text-dim); font-size: 9px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.12em; padding: 4px 6px 3px; font-family: var(--mono); }
        .tool-nav-btn { width: 100%; display: flex; align-items: center; gap: 8px; padding: 7px 9px; margin-bottom: 2px; background: transparent; border: 1px solid transparent; border-radius: var(--radius-sm); color: var(--text-mid); font-size: 11px; font-weight: 500; font-family: var(--mono); letter-spacing: 0.04em; text-transform: uppercase; cursor: pointer; transition: all 0.12s; text-align: left; }
        .tool-nav-btn:hover { background: var(--bg-hover); border-color: var(--border); color: var(--text); }
        .tool-nav-btn.active { background: var(--accent-lo); border-color: rgba(139,92,246,.3); color: var(--accent); }
        .tool-nav-btn svg { flex-shrink: 0; }

        /* ===== TOOL VIEWS ===== */
        .tool-view { display: none; flex: 1; flex-direction: column; height: 100vh; background: var(--bg); min-width: 0; overflow: hidden; }
        .tool-view.active { display: flex; }
        .tool-header { background: var(--bg-panel); border-bottom: 1px solid var(--border); padding: 11px 20px; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
        .tool-header-left { display: flex; align-items: center; gap: 9px; }
        .tool-header-icon { width: 28px; height: 28px; background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%); border-radius: var(--radius-sm); display: flex; align-items: center; justify-content: center; flex-shrink: 0; box-shadow: 0 2px 10px rgba(139,92,246,0.5); }
        .tool-header h1 { font-family: var(--mono); font-size: 13px; font-weight: 500; color: var(--text-mid); letter-spacing: 0.06em; text-transform: uppercase; }
        .tool-body { flex: 1; overflow-y: auto; padding: 24px; display: flex; flex-direction: column; gap: 18px; max-width: 760px; width: 100%; margin: 0 auto; box-sizing: border-box; }

        /* Drop zone */
        .drop-zone { border: 2px dashed var(--border-mid); border-radius: var(--radius); padding: 36px 24px; text-align: center; cursor: pointer; transition: all 0.2s; background: var(--bg-raised); position: relative; }
        .drop-zone:hover, .drop-zone.drag-over { border-color: var(--accent); background: var(--accent-lo); }
        .drop-zone-icon { margin: 0 auto 10px; width: 38px; height: 38px; background: var(--bg-hover); border-radius: var(--radius); display: flex; align-items: center; justify-content: center; color: var(--text-dim); }
        .drop-zone-title { font-family: var(--mono); font-size: 12px; font-weight: 500; color: var(--text-mid); letter-spacing: 0.05em; margin-bottom: 4px; text-transform: uppercase; }
        .drop-zone-hint { font-family: var(--mono); font-size: 11px; color: var(--text-dim); letter-spacing: 0.03em; }
        .drop-zone-filename { margin-top: 10px; font-family: var(--mono); font-size: 12px; color: var(--accent); font-weight: 500; }
        .drop-zone input[type="file"] { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }

        /* Tool form fields */
        .tool-field-group { display: flex; flex-direction: column; gap: 14px; }
        .tool-field { display: flex; flex-direction: column; gap: 5px; }
        .tool-field label { font-family: var(--mono); font-size: 10px; font-weight: 500; color: var(--text-mid); letter-spacing: 0.07em; text-transform: uppercase; }
        .tool-field input[type="text"],
        .tool-field input[type="number"],
        .tool-field input[type="date"],
        .tool-field textarea { width: 100%; padding: 9px 12px; background: var(--bg-raised); border: 1px solid var(--border-mid); border-radius: var(--radius-sm); color: var(--text); font-size: 13px; font-family: var(--sans); transition: border-color 0.15s; box-sizing: border-box; }
        .tool-field input:focus, .tool-field textarea:focus { border-color: var(--accent); outline: none; box-shadow: 0 0 0 2px var(--accent-lo); }
        .tool-field textarea { resize: vertical; min-height: 90px; font-family: var(--sans); line-height: 1.5; }
        .tool-field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }

        /* Escalation badge */
        .escalation-badge { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border-radius: 3px; font-family: var(--mono); font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; }
        .escalation-badge.friendly { background: var(--green-lo); color: var(--green); border: 1px solid rgba(45,184,125,.25); }
        .escalation-badge.firm { background: var(--accent-lo); color: var(--accent); border: 1px solid rgba(139,92,246,.3); }
        .escalation-badge.urgent { background: var(--orange-lo); color: var(--orange); border: 1px solid rgba(224,112,51,.25); }
        .escalation-badge.final { background: var(--red-lo); color: var(--red); border: 1px solid rgba(224,85,85,.25); }

        /* Generate button */
        .tool-generate-btn { width: 100%; padding: 12px; background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%); color: #ffffff; border: none; border-radius: var(--radius-sm); font-weight: 600; font-size: 13px; font-family: var(--sans); letter-spacing: 0; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; transition: opacity 0.15s; box-shadow: 0 4px 16px rgba(139,92,246,0.4); }
        .tool-generate-btn:hover:not(:disabled) { opacity: 0.88; }
        .tool-generate-btn:disabled { opacity: 0.4; cursor: not-allowed; }

        /* Output area */
        .tool-output { background: var(--bg-panel); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; display: none; }
        .tool-output.visible { display: block; }
        .tool-output-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--border); background: var(--bg-raised); }
        .tool-output-label { font-family: var(--mono); font-size: 10px; font-weight: 500; color: var(--text-dim); letter-spacing: 0.1em; text-transform: uppercase; }
        .tool-copy-btn { background: var(--bg-hover); border: 1px solid var(--border-mid); color: var(--text-mid); font-family: var(--mono); font-size: 10px; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; padding: 4px 10px; border-radius: 3px; cursor: pointer; display: flex; align-items: center; gap: 5px; transition: all 0.12s; }
        .tool-copy-btn:hover { color: var(--text); border-color: var(--border-hi); }
        .tool-output-body { padding: 16px 18px; font-family: var(--sans); font-size: 14px; color: var(--text); line-height: 1.7; white-space: pre-wrap; word-break: break-word; max-height: 500px; overflow-y: auto; }
        .tool-output-thinking { padding: 18px; font-family: var(--mono); font-size: 12px; color: var(--text-dim); display: flex; align-items: center; gap: 10px; letter-spacing: 0.04em; }

        /* ===== ESTIMATE & CHANGE ORDER TOOLS ===== */
        .line-items-table { width: 100%; border-collapse: collapse; font-size: 13px; font-family: var(--mono); }
        .line-items-table th { background: var(--bg-raised); color: var(--text-mid); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border); }
        .line-items-table td { padding: 7px 10px; border-bottom: 1px solid var(--border); color: var(--text); }
        .line-items-table td input { width: 100%; background: transparent; border: none; color: var(--text); font-family: var(--mono); font-size: 13px; outline: none; padding: 2px 0; }
        .line-items-table td input:focus { border-bottom: 1px solid var(--accent); }
        .line-items-table .del-row-btn { background: none; border: none; color: var(--text-dim); cursor: pointer; padding: 2px 6px; border-radius: 3px; font-size: 14px; line-height: 1; }
        .line-items-table .del-row-btn:hover { color: var(--red); background: var(--red-lo); }
        .add-line-btn { background: var(--accent-lo); border: 1px dashed var(--border-mid); color: var(--accent); font-family: var(--mono); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; padding: 7px 14px; border-radius: var(--radius-sm); cursor: pointer; margin-top: 8px; transition: all 0.15s; }
        .add-line-btn:hover { background: var(--accent); color: #fff; border-color: var(--accent); }
        .estimate-total-row { display: flex; justify-content: flex-end; align-items: center; gap: 14px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border-mid); font-family: var(--mono); font-size: 13px; color: var(--text-mid); }
        .estimate-total-row strong { color: var(--text); font-size: 16px; }
        .co-status-badge { display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; padding: 4px 10px; border-radius: 20px; }
        .co-status-pending  { background: var(--orange-lo); color: var(--orange); border: 1px solid rgba(245,158,11,.3); }
        .co-status-approved { background: var(--green-lo); color: var(--green); border: 1px solid rgba(16,185,129,.3); }
        .co-status-rejected { background: var(--red-lo); color: var(--red); border: 1px solid rgba(239,68,68,.3); }

        /* ===== SUBCONTRACTOR TOOL ===== */
        .sub-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .sub-table th { background: var(--bg-raised); color: var(--text-mid); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; padding: 9px 12px; text-align: left; border-bottom: 1px solid var(--border); }
        .sub-table td { padding: 10px 12px; border-bottom: 1px solid var(--border); color: var(--text); vertical-align: middle; }
        .sub-table tr:last-child td { border-bottom: none; }
        .sub-table .sub-status { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; padding: 2px 8px; border-radius: 12px; }
        .sub-status-active { background: var(--green-lo); color: var(--green); }
        .sub-status-inactive { background: var(--bg-raised); color: var(--text-dim); }
        .sub-action-btn { background: var(--accent-lo); border: 1px solid var(--border-mid); color: var(--accent); font-family: var(--mono); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; padding: 3px 9px; border-radius: 4px; cursor: pointer; margin-right: 4px; transition: all 0.12s; }
        .sub-action-btn:hover { background: var(--accent); color: #fff; }
        .sub-action-btn.danger:hover { background: var(--red); border-color: var(--red); color: #fff; }
        .sub-add-form { background: var(--bg-raised); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; margin-bottom: 16px; display: none; gap: 12px; flex-direction: column; }
        .sub-add-form.visible { display: flex; }
        .sub-add-form .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .sub-add-form .form-row-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
        .tool-action-bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
        .tool-action-bar-title { font-family: var(--mono); font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-mid); }

        /* ===== MATERIALS CHECKLIST TOOL ===== */
        .mat-add-row { display: flex; gap: 8px; margin-bottom: 14px; }
        .mat-add-row input { flex: 1; }
        .mat-add-row select { background: var(--bg-raised); border: 1px solid var(--border); color: var(--text); padding: 8px 10px; border-radius: var(--radius-sm); font-family: var(--mono); font-size: 12px; outline: none; }
        .mat-add-row select:focus { border-color: var(--accent); }
        .mat-list { display: flex; flex-direction: column; gap: 6px; max-height: 380px; overflow-y: auto; }
        .mat-item { display: flex; align-items: center; gap: 10px; background: var(--bg-raised); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 14px; transition: all 0.12s; }
        .mat-item.checked { opacity: 0.55; }
        .mat-item.checked .mat-item-name { text-decoration: line-through; color: var(--text-dim); }
        .mat-item input[type=checkbox] { accent-color: var(--accent); width: 16px; height: 16px; cursor: pointer; flex-shrink: 0; }
        .mat-item-name { flex: 1; font-family: var(--sans); font-size: 13px; color: var(--text); }
        .mat-item-cat { font-family: var(--mono); font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; padding: 2px 7px; border-radius: 10px; background: var(--accent-lo); color: var(--accent); flex-shrink: 0; }
        .mat-item-del { background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 14px; padding: 2px 6px; border-radius: 3px; transition: all 0.12s; }
        .mat-item-del:hover { color: var(--red); background: var(--red-lo); }
        .mat-progress { margin-bottom: 14px; }
        .mat-progress-bar { height: 4px; background: var(--bg-raised); border-radius: 2px; overflow: hidden; margin-top: 4px; }
        .mat-progress-fill { height: 100%; background: linear-gradient(90deg, var(--accent), #a78bfa); border-radius: 2px; transition: width 0.3s ease; }
        .mat-progress-label { font-family: var(--mono); font-size: 11px; color: var(--text-dim); letter-spacing: 0.05em; }

        /* ===== PHOTO LOG TOOL ===== */
        .photo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-top: 14px; }
        .photo-card { background: var(--bg-raised); border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; cursor: pointer; transition: all 0.15s; }
        .photo-card:hover { border-color: var(--border-hi); transform: translateY(-2px); }
        .photo-card img { width: 100%; height: 110px; object-fit: cover; display: block; }
        .photo-card-label { padding: 6px 8px; font-family: var(--mono); font-size: 10px; color: var(--text-dim); letter-spacing: 0.04em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .photo-lightbox { position: fixed; inset: 0; background: rgba(0,0,0,0.9); z-index: 9999; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 12px; }
        .photo-lightbox img { max-width: 90vw; max-height: 80vh; object-fit: contain; border-radius: var(--radius); }
        .photo-lightbox-close { position: absolute; top: 20px; right: 24px; background: none; border: none; color: #fff; font-size: 28px; cursor: pointer; }
        .photo-lightbox-caption { color: rgba(255,255,255,0.7); font-family: var(--mono); font-size: 12px; }
        .photo-empty { padding: 40px; text-align: center; color: var(--text-dim); font-family: var(--mono); font-size: 12px; letter-spacing: 0.06em; }
        .photo-drop-zone { border: 2px dashed var(--border-mid); border-radius: var(--radius); padding: 28px; text-align: center; cursor: pointer; transition: all 0.2s; background: var(--bg-raised); }
        .photo-drop-zone:hover, .photo-drop-zone.drag-over { border-color: var(--accent); background: var(--accent-lo); }
        .photo-drop-zone p { color: var(--text-dim); font-family: var(--mono); font-size: 12px; margin: 8px 0 0; letter-spacing: 0.05em; }

        /* ===== SAFETY CHECKLIST TOOL ===== */
        .safety-category { background: var(--bg-raised); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 12px; overflow: hidden; }
        .safety-category-header { display: flex; align-items: center; gap: 10px; padding: 12px 16px; cursor: pointer; user-select: none; }
        .safety-category-header:hover { background: var(--bg-hover); }
        .safety-cat-title { flex: 1; font-family: var(--mono); font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text); }
        .safety-cat-count { font-family: var(--mono); font-size: 11px; color: var(--text-dim); }
        .safety-cat-chevron { color: var(--text-dim); font-size: 12px; transition: transform 0.2s; }
        .safety-category.open .safety-cat-chevron { transform: rotate(180deg); }
        .safety-items { display: none; padding: 0 16px 12px; border-top: 1px solid var(--border); }
        .safety-category.open .safety-items { display: block; }
        .safety-item { display: flex; align-items: flex-start; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--border); }
        .safety-item:last-child { border-bottom: none; }
        .safety-item input[type=checkbox] { accent-color: var(--accent); width: 15px; height: 15px; margin-top: 2px; cursor: pointer; flex-shrink: 0; }
        .safety-item-text { font-family: var(--sans); font-size: 13px; color: var(--text); line-height: 1.5; }
        .safety-item.checked .safety-item-text { text-decoration: line-through; color: var(--text-dim); }
        .safety-progress-bar { height: 6px; background: var(--bg-raised); border-radius: 3px; overflow: hidden; margin: 12px 0; }
        .safety-progress-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--green)); border-radius: 3px; transition: width 0.35s ease; }
        .safety-actions { display: flex; gap: 10px; margin-top: 14px; }
        .safety-log-entry { background: var(--bg-raised); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 14px; margin-bottom: 8px; font-family: var(--mono); font-size: 12px; display: flex; align-items: center; gap: 12px; }
        .safety-log-date { color: var(--accent); font-weight: 600; }
        .safety-log-score { color: var(--text-mid); }
    </style>
</head>
<body>
    <!-- Login overlay — shown when not authenticated -->
    <div id="login-overlay" class="login-overlay" style="display:none;">
        <div class="login-card">
            <div class="login-logo" aria-hidden="true">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            </div>
            <h1>AI Automation Assistant</h1>
            <div class="login-card-tagline">Think. Automate. Execute.</div>
            <div class="login-tab-bar">
                <button class="login-tab active" id="tab-signin" onclick="switchAuthTab('signin')">Sign In</button>
                <button class="login-tab" id="tab-signup" onclick="switchAuthTab('signup')">Sign Up</button>
            </div>
            <div class="login-error" id="login-error" role="alert" aria-live="polite"></div>
            <div class="login-success" id="login-success" role="status" aria-live="polite"></div>
            <div id="signin-fields">
                <div class="login-field"><input type="text" id="login-username" placeholder="Username" autocomplete="username" autocapitalize="none" spellcheck="false" /></div>
                <div class="login-field"><input type="password" id="login-password" placeholder="Password" autocomplete="current-password" /></div>
                <button class="login-submit-btn" id="login-btn" onclick="handleLogin()">Sign In</button>
            </div>
            <div id="signup-fields" style="display:none;">
                <div class="login-field"><input type="text" id="signup-username" placeholder="Username (3–20 chars, letters/numbers/_)" autocomplete="username" autocapitalize="none" spellcheck="false" /></div>
                <div class="login-field"><input type="email" id="signup-email" placeholder="Email (optional)" autocomplete="email" /></div>
                <div class="login-field"><input type="password" id="signup-password" placeholder="Password (min 8 characters)" autocomplete="new-password" /></div>
                <button class="login-submit-btn" id="signup-btn" onclick="handleSignup()">Create Account</button>
            </div>
        </div>
    </div>

    <!-- Sidebar -->
    <aside class="sidebar" role="complementary" aria-label="Chat history sidebar">
        <div class="sidebar-header">
            <button class="home-btn" onclick="goHome()" aria-label="Start new chat" title="New Chat (Ctrl+K)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M12 5v14M5 12h14"/>
                </svg>
                New Chat
            </button>
        </div>

        <!-- AI Mode Selector -->
        <div class="ai-mode-section">
            <div class="ai-mode-label">AI Mode</div>
            <div class="ai-mode-tabs" role="tablist" aria-label="Select AI mode">
                <button class="ai-mode-btn gemini active" id="mode-gemini"
                        onclick="setAIMode('gemini')"
                        role="tab" aria-selected="true"
                        aria-label="Use Chat AI for Q&amp;A">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="10"/></svg>
                    Chat
                </button>
                <button class="ai-mode-btn openclaw" id="mode-openclaw"
                        onclick="setAIMode('openclaw')"
                        role="tab" aria-selected="false"
                        aria-label="Use Agent AI for automation">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                    Agent
                </button>
            </div>
        </div>

        <!-- OpenClaw Status (only shown in OpenClaw mode) -->
        <div class="openclaw-status" id="openclaw-status" style="display:none;" aria-live="polite">
            <div class="openclaw-status-dot checking" id="openclaw-status-dot" aria-hidden="true"></div>
            <span id="openclaw-status-text">Checking...</span>
            <button class="openclaw-settings-link" onclick="openSettings()" aria-label="Open OpenClaw settings">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
                Settings
            </button>
        </div>

        <!-- Tool Nav -->
        <div class="sidebar-tools-section">
            <div class="sidebar-tools-label">Tools</div>
            <button class="tool-nav-btn" id="tool-nav-invoices" onclick="showToolView('invoices')" aria-label="Open Invoice Follow-up tool">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                Invoice Follow-up
            </button>
            <button class="tool-nav-btn" id="tool-nav-adjusters" onclick="showToolView('adjusters')" aria-label="Open Adjuster Follow-up tool">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                Adjuster Follow-up
            </button>
            <button class="tool-nav-btn" id="tool-nav-estimate" onclick="showToolView('estimate')" aria-label="Open Estimate Generator tool">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                Estimate Generator
            </button>
            <button class="tool-nav-btn" id="tool-nav-changeorder" onclick="showToolView('changeorder')" aria-label="Open Change Order tool">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                Change Order
            </button>
            <button class="tool-nav-btn" id="tool-nav-subs" onclick="showToolView('subs')" aria-label="Open Subcontractor Management tool">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                Subcontractors
            </button>
            <button class="tool-nav-btn" id="tool-nav-materials" onclick="showToolView('materials')" aria-label="Open Materials Checklist tool">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
                Materials List
            </button>
            <button class="tool-nav-btn" id="tool-nav-photos" onclick="showToolView('photos')" aria-label="Open Photo Log tool">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                Photo Log
            </button>
            <button class="tool-nav-btn" id="tool-nav-safety" onclick="showToolView('safety')" aria-label="Open Safety Checklist tool">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                Safety Checklist
            </button>
        </div>

        <!-- Chat History -->
        <nav class="history-section" aria-label="Previous conversations">
            <h2 class="history-title">Recents</h2>
            <div id="history-list" role="list">
                <!-- History items will be added here -->
            </div>
        </nav>

        <!-- Account Section (pinned to sidebar bottom) -->
        <div class="account-section">
            <!-- Account button — clicking opens the full Settings panel -->
            <button class="account-btn" id="account-btn" onclick="openSettings()" aria-label="Open Settings">
                <div class="account-avatar" id="account-avatar">U</div>
                <div class="account-info">
                    <div class="account-name" id="account-name">User</div>
                    <div class="account-plan">Free Plan</div>
                </div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
            </button>
            <button class="logout-btn" id="logout-btn" onclick="handleLogout()" aria-label="Sign out" title="Sign out" style="display:none;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            </button>
        </div>
    </aside>

    <!-- Settings Overlay -->
    <div class="settings-overlay" id="settings-overlay" onclick="closeSettings()"></div>

    <!-- Full Settings Panel -->
    <div class="settings-panel" id="settings-panel" role="dialog" aria-modal="true" aria-label="Settings">

        <!-- Panel Header -->
        <div class="settings-header">
            <div class="settings-header-user">
                <div class="settings-header-avatar" id="settings-header-avatar">U</div>
                <div>
                    <div class="settings-header-name" id="settings-header-name">User</div>
                    <div class="settings-header-sub">Settings</div>
                </div>
            </div>
            <button class="settings-close-btn" onclick="closeSettings()" aria-label="Close settings">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
        </div>

        <!-- Tab Nav -->
        <div class="stabs">
            <button class="stab active" id="stab-profile" data-tab="profile" onclick="switchSettingsTab('profile')">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
                Profile
            </button>
            <button class="stab" id="stab-system" data-tab="system" onclick="switchSettingsTab('system')">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                System
            </button>
            <button class="stab" id="stab-agent" data-tab="agent" onclick="switchSettingsTab('agent')">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                Agent
            </button>
            <button class="stab" id="stab-connectors" data-tab="connectors" onclick="switchSettingsTab('connectors')">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                Connectors
            </button>
            <button class="stab" id="stab-invoices" data-tab="invoices" onclick="switchSettingsTab('invoices')">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/></svg>
                Invoices
            </button>
            <button class="stab" id="stab-adjusters" data-tab="adjusters" onclick="switchSettingsTab('adjusters')">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
                Adjusters
            </button>
            <button class="stab" id="stab-estimates" data-tab="estimates" onclick="switchSettingsTab('estimates')">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/></svg>
                Estimates
            </button>
            <button class="stab" id="stab-changeorders" data-tab="changeorders" onclick="switchSettingsTab('changeorders')">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>
                Change Orders
            </button>
        </div>

        <!-- TAB: Profile -->
        <div class="stab-content active" id="stab-content-profile">
            <div class="settings-avatar-row">
                <div class="settings-big-avatar" id="profile-big-avatar">U</div>
                <div class="settings-avatar-hint">Avatar auto-generated<br>from your display name.</div>
            </div>
            <div class="settings-group">
                <label for="settings-name-input">Display Name</label>
                <input type="text" id="settings-name-input" placeholder="Enter your name" maxlength="40" autocomplete="off" oninput="updateProfilePreview()" />
            </div>
            <div class="settings-group">
                <label for="settings-plan-select">Plan</label>
                <select id="settings-plan-select">
                    <option value="free">Free Plan</option>
                    <option value="pro">Pro Plan</option>
                    <option value="team">Team Plan</option>
                </select>
                <div class="settings-hint">Displayed below your name in the sidebar.</div>
            </div>
            <button class="settings-save-btn" onclick="saveProfile()">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                Save Profile
            </button>
            <hr class="settings-divider">
            <div class="settings-group">
                <label style="color:#8e8ea0;">Danger Zone</label>
                <button class="settings-danger-btn" onclick="clearAllHistory()">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                    Clear All Chat History
                </button>
                <button class="settings-danger-btn" onclick="resetAccount()" style="margin-top:6px;">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                    Reset Account
                </button>
            </div>
        </div>

        <!-- TAB: System Prompt -->
        <div class="stab-content" id="stab-content-system">
            <div class="settings-group">
                <label for="system-prompt-input">System Prompt</label>
                <textarea id="system-prompt-input" rows="8" placeholder="Enter a system prompt to customize how the AI responds. Leave blank to use the default behavior.&#10;&#10;Example: You are a helpful assistant for a software company. Always be concise and professional." autocomplete="off"></textarea>
                <div class="settings-hint">This prompt is prepended to every conversation. It sets the AI's persona, tone, and focus area.</div>
            </div>
            <div class="settings-group">
                <label for="chat-temp-input">Chat Temperature</label>
                <div class="settings-slider-row">
                    <input type="range" id="chat-temp-input" min="0" max="2" step="0.1" value="1" oninput="document.getElementById('chat-temp-val').textContent=this.value" />
                    <span class="settings-slider-val" id="chat-temp-val">1.0</span>
                </div>
                <div class="settings-hint">Controls response creativity. 0 = deterministic, 2 = very creative.</div>
            </div>
            <div class="settings-group">
                <label for="chat-lang-input">Response Language</label>
                <select id="chat-lang-input">
                    <option value="">Auto-detect (default)</option>
                    <option value="en">English</option>
                    <option value="es">Spanish</option>
                    <option value="fr">French</option>
                    <option value="de">German</option>
                    <option value="zh">Chinese</option>
                    <option value="ja">Japanese</option>
                    <option value="pt">Portuguese</option>
                    <option value="ar">Arabic</option>
                    <option value="hi">Hindi</option>
                </select>
                <div class="settings-hint">Force responses in a specific language.</div>
            </div>
            <button class="settings-save-btn" onclick="saveSystemSettings()">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                Save System Settings
            </button>
        </div>

        <!-- TAB: Agent (OpenClaw) -->
        <div class="stab-content" id="stab-content-agent">
            <div class="stab-section-title">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef7623" stroke-width="2.5" stroke-linecap="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                Agent Connection
            </div>
            <div class="settings-group">
                <label for="openclaw-url-input">Server URL</label>
                <input type="text" id="openclaw-url-input" placeholder="http://your-vps-ip:18789" autocomplete="off" />
                <div class="settings-hint">URL of your Agent VPS. Example: <code style="color:#ef7623">http://1.2.3.4:18789</code></div>
            </div>
            <div class="settings-group">
                <label for="openclaw-token-input">Bearer Token</label>
                <input type="password" id="openclaw-token-input" placeholder="Leave blank if no auth required" autocomplete="off" />
                <div class="settings-hint">Your Agent authentication token (if configured).</div>
            </div>
            <button class="settings-save-btn" onclick="saveOpenClawSettings()">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
                Save &amp; Test Connection
            </button>
            <div id="agent-test-result" class="settings-test-result" style="display:none;"></div>
            <hr class="settings-divider">
            <div class="stab-section-title" style="margin-top:0;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
                How to connect
            </div>
            <div class="settings-instructions">
                1. Start your Agent on your VPS server<br>
                2. Enter your VPS IP/URL above<br>
                3. Click "Save &amp; Test Connection"<br>
                4. The status dot turns green when ready<br><br>
                <strong>Default port:</strong> 18789<br>
                <strong>Docs:</strong> <a href="https://docs.openclaw.ai" target="_blank" style="color:#ef7623;">docs.openclaw.ai</a>
            </div>
        </div>

        <!-- TAB: Connectors -->
        <div class="stab-content" id="stab-content-connectors">
            <div class="stab-section-title">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                API Connectors
            </div>

            <!-- Gemini -->
            <div class="connector-card">
                <div class="connector-card-header">
                    <div class="connector-icon gemini-icon">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg>
                    </div>
                    <div class="connector-info">
                        <div class="connector-name">Chat (Gemini)</div>
                        <div class="connector-desc">Google Gemini AI — powers the Chat mode</div>
                    </div>
                    <div class="connector-status" id="gemini-connector-status">
                        <span class="connector-dot connected"></span>
                        <span class="connector-status-text">Active</span>
                    </div>
                </div>
                <div class="connector-body">
                    <div class="settings-group">
                        <label for="gemini-api-key-input">API Key</label>
                        <input type="password" id="gemini-api-key-input" placeholder="AIza..." autocomplete="off" />
                        <div class="settings-hint">Get your key at <a href="https://aistudio.google.com/" target="_blank" style="color:#10a37f;">aistudio.google.com</a></div>
                    </div>
                    <div class="settings-group">
                        <label for="gemini-model-select">Model</label>
                        <select id="gemini-model-select">
                            <option value="gemini-2.0-flash">gemini-2.0-flash (default)</option>
                            <option value="gemini-1.5-pro">gemini-1.5-pro</option>
                            <option value="gemini-1.5-flash">gemini-1.5-flash</option>
                        </select>
                    </div>
                    <button class="settings-save-btn-sm" onclick="saveGeminiSettings()">Save Chat Config</button>
                </div>
            </div>

            <!-- Notion -->
            <div class="connector-card">
                <div class="connector-card-header">
                    <div class="connector-icon notion-icon">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect width="18" height="18" x="3" y="3" rx="2"/></svg>
                    </div>
                    <div class="connector-info">
                        <div class="connector-name">Notion</div>
                        <div class="connector-desc">Connect your workspace to read and write pages</div>
                    </div>
                    <div class="connector-status" id="notion-connector-status">
                        <span class="connector-dot"></span>
                        <span class="connector-status-text">Not connected</span>
                    </div>
                </div>
                <div class="connector-body">
                    <div class="settings-group">
                        <label for="notion-api-key-input">Integration Token</label>
                        <input type="password" id="notion-api-key-input" placeholder="secret_..." autocomplete="off" />
                        <div class="settings-hint">Create an integration at <a href="https://www.notion.so/my-integrations" target="_blank" style="color:#8e8ea0;">notion.so/my-integrations</a></div>
                    </div>
                    <button class="settings-save-btn-sm" onclick="saveNotionSettings()">Save Notion Config</button>
                </div>
            </div>

            <!-- Webhook / Custom -->
            <div class="connector-card">
                <div class="connector-card-header">
                    <div class="connector-icon webhook-icon">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                    </div>
                    <div class="connector-info">
                        <div class="connector-name">Webhook / Custom API</div>
                        <div class="connector-desc">Send AI responses to any HTTP endpoint</div>
                    </div>
                    <div class="connector-status" id="webhook-connector-status">
                        <span class="connector-dot"></span>
                        <span class="connector-status-text">Not set</span>
                    </div>
                </div>
                <div class="connector-body">
                    <div class="settings-group">
                        <label for="webhook-url-input">Webhook URL</label>
                        <input type="text" id="webhook-url-input" placeholder="https://your-endpoint.com/hook" autocomplete="off" />
                        <div class="settings-hint">POST requests will be sent with <code>{ prompt, response, mode }</code></div>
                    </div>
                    <div class="settings-group">
                        <label for="webhook-secret-input">Secret Header (optional)</label>
                        <input type="password" id="webhook-secret-input" placeholder="Bearer token or API key" autocomplete="off" />
                    </div>
                    <button class="settings-save-btn-sm" onclick="saveWebhookSettings()">Save Webhook Config</button>
                </div>
            </div>

        </div><!-- /connectors -->

        <!-- TAB: Invoices -->
        <div class="stab-content" id="stab-content-invoices">
            <div class="stab-section-title">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                Invoice Follow-up Prompt
            </div>
            <div class="settings-group">
                <label for="invoice-system-prompt">Custom System Prompt</label>
                <textarea id="invoice-system-prompt" rows="12" placeholder="You are a professional accounts receivable specialist for a construction company. Generate a follow-up email for an overdue invoice.

Adjust tone based on escalation level:
- Friendly Reminder (1-30 days): Polite, assume oversight
- Firm / Professional (31-60 days): Firm, set deadline
- Urgent / Serious (61-90 days): Serious, mention service suspension
- Final Notice (90+ days): Final warning, reference legal/collections

Format: Subject line, greeting, body, sign-off."></textarea>
                <div class="settings-hint">Customize with your company name, contact details, and preferred tone. Escalation level is added automatically based on days overdue.</div>
            </div>
            <button class="settings-save-btn" onclick="saveInvoicePrompt()">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                Save Invoice Prompt
            </button>
        </div><!-- /invoices -->

        <!-- TAB: Adjusters -->
        <div class="stab-content" id="stab-content-adjusters">
            <div class="stab-section-title">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
                Adjuster Follow-up Prompt
            </div>
            <div class="settings-group">
                <label for="adjuster-system-prompt">Custom System Prompt</label>
                <textarea id="adjuster-system-prompt" rows="12" placeholder="You are a professional claims coordinator for a construction company. Generate a follow-up email to an insurance adjuster.

Reference the claim number and date of last contact. Request a clear status update and specific timeline. Mention project impact if appropriate.

Format: Subject line, greeting, body, professional sign-off."></textarea>
                <div class="settings-hint">Customize with your company name, contact info, and any standard language you want included in every adjuster email.</div>
            </div>
            <button class="settings-save-btn" onclick="saveAdjusterPrompt()">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                Save Adjuster Prompt
            </button>
        </div><!-- /adjusters -->

        <!-- TAB: Estimates -->
        <div class="stab-content" id="stab-content-estimates">
            <div class="stab-section-title">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/></svg>
                Estimate Generator Prompt
            </div>
            <p style="font-family:var(--mono);font-size:12px;color:var(--text-dim);line-height:1.6;margin:0 0 12px;">Customize how AI generates your estimates and quotes.</p>
            <div class="settings-group">
                <label for="estimate-system-prompt">System Prompt</label>
                <textarea id="estimate-system-prompt" class="settings-textarea" rows="7" placeholder="You are a professional construction estimator. Generate a detailed quote based on the project description and line items provided. Include a brief scope summary, itemized costs, labor/materials breakdown, and total. Format as a professional quote document."></textarea>
            </div>
            <button class="settings-save-btn" onclick="saveEstimatePrompt()">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                Save Estimate Prompt
            </button>
        </div><!-- /estimates -->

        <!-- TAB: Change Orders -->
        <div class="stab-content" id="stab-content-changeorders">
            <div class="stab-section-title">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>
                Change Order Prompt
            </div>
            <p style="font-family:var(--mono);font-size:12px;color:var(--text-dim);line-height:1.6;margin:0 0 12px;">Customize how AI drafts change order documents.</p>
            <div class="settings-group">
                <label for="changeorder-system-prompt">System Prompt</label>
                <textarea id="changeorder-system-prompt" class="settings-textarea" rows="7" placeholder="You are a professional construction project manager. Generate a formal change order document based on the information provided. Include the reason for change, scope changes, cost impact, schedule impact, and require client sign-off language. Format as a professional change order."></textarea>
            </div>
            <button class="settings-save-btn" onclick="saveChangeOrderPrompt()">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                Save Change Order Prompt
            </button>
        </div><!-- /changeorders -->

    </div><!-- /settings-panel -->

    <!-- Main Content -->
    <main class="main-content" role="main">
        <div class="container">
            <header class="header" role="banner">
                <div class="header-left">
                    <div class="header-icon" aria-hidden="true">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z"/><path d="M12 8v4l3 3"/></svg>
                    </div>
                    <h1>AI Automation Assistant</h1>
                </div>
                <div class="header-right">
                    <div class="status-badge" role="status" aria-label="Connection status: Online">
                        <span class="status-indicator" aria-hidden="true"></span>
                        <span>Online</span>
                    </div>
                    <div class="ai-models" aria-label="Active AI mode">
                        <span id="header-ai-display">Gemini</span>
                    </div>
                </div>
            </header>
        <div class="chat-area" id="chat" role="log" aria-live="polite" aria-label="Chat conversation">
            <div class="chat-inner">
            <div class="empty-state">
                <div class="empty-logo" aria-hidden="true">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                </div>
                <h2>How can I help you?</h2>
                <p>Ask me anything — I can answer questions, analyze data, and automate tasks using Chat or Agent mode.</p>
                <div class="example-queries">
                    <h3>Try asking</h3>
                    <ul role="list">
                        <li onclick="setPrompt('Build me a sales report for Q1')" role="button" tabindex="0" aria-label="Example: Build me a sales report for Q1">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                            Build me a sales report for Q1
                        </li>
                        <li onclick="setPrompt('Find the best CRM tools for small businesses')" role="button" tabindex="0" aria-label="Example: Find the best CRM tools for small businesses">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                            Find the best CRM tools for small businesses
                        </li>
                        <li onclick="setPrompt('Calculate the ROI of our marketing campaign')" role="button" tabindex="0" aria-label="Example: Calculate the ROI of our marketing campaign">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                            Calculate the ROI of our marketing campaign
                        </li>
                        <li onclick="setPrompt('What is machine learning?')" role="button" tabindex="0" aria-label="Example: What is machine learning">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                            What is machine learning?
                        </li>
                    </ul>
                </div>
            </div>
            </div>
        </div>
        <div class="input-area" role="region" aria-label="Message input">
            <form id="chat-form" onsubmit="return false;">
                <div class="input-wrap">
                    <input
                        type="text"
                        id="input"
                        placeholder="Message AI Assistant..."
                        autocomplete="off"
                        aria-label="Message input"
                        aria-describedby="input-help"
                    >
                    <span id="input-help" class="sr-only">Press Enter to send message</span>
                    <button type="button" id="send-btn" class="send-btn" aria-label="Send message">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
                    </button>
                </div>
            </form>
        </div>
        </div>
    </main>

    <!-- ===== TOOL VIEW: Invoice Follow-up ===== -->
    <div class="tool-view" id="tool-view-invoices" role="main" aria-label="Invoice Follow-up Tool">
        <div class="tool-header">
            <div class="tool-header-left">
                <div class="tool-header-icon" aria-hidden="true">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                </div>
                <h1>Invoice Follow-up</h1>
            </div>
            <button class="tool-nav-btn" style="width:auto;padding:6px 14px;margin:0;" onclick="showToolView('chat')" aria-label="Back to chat">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M19 12H5M5 12l7 7M5 12l7-7"/></svg>
                Back to Chat
            </button>
        </div>
        <div class="tool-body">

            <!-- Days overdue + escalation badge -->
            <div class="tool-field-row" style="align-items:end;">
                <div class="tool-field">
                    <label for="invoice-days-input">Days Past Due</label>
                    <input type="number" id="invoice-days-input" placeholder="e.g. 45" min="0" max="999" oninput="updateEscalationBadge()" />
                </div>
                <div id="escalation-badge-wrap" style="padding-bottom:2px;"></div>
            </div>

            <!-- Drop zone -->
            <div class="drop-zone" id="invoice-drop-zone"
                 ondragover="handleInvoiceDragOver(event)"
                 ondragleave="handleInvoiceDragLeave(event)"
                 ondrop="handleInvoiceFileDrop(event)">
                <input type="file" id="invoice-file-input" accept=".csv,.pdf,.txt,.xlsx,.png,.jpg,.jpeg,.webp" onchange="handleInvoiceFileSelect(event)" aria-label="Upload invoice file" />
                <div class="drop-zone-icon" aria-hidden="true">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>
                </div>
                <div class="drop-zone-title">Drop invoice file here</div>
                <div class="drop-zone-hint">CSV, PDF, TXT, or image exports from QuickBooks, FreshBooks, etc.</div>
                <div class="drop-zone-filename" id="invoice-file-name"></div>
            </div>

            <!-- Optional notes -->
            <div class="tool-field">
                <label for="invoice-notes-input">Additional Context (optional)</label>
                <textarea id="invoice-notes-input" placeholder="Client name, project name, invoice number, any special circumstances..." rows="3"></textarea>
            </div>

            <!-- Generate button -->
            <button class="tool-generate-btn" id="invoice-generate-btn" onclick="generateInvoiceFollowup()" disabled>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                Generate Follow-up Email
            </button>

            <!-- Output -->
            <div class="tool-output" id="invoice-output">
                <div class="tool-output-header">
                    <span class="tool-output-label">Generated Email</span>
                    <button class="tool-copy-btn" onclick="copyToolOutput('invoice-output-body')" aria-label="Copy to clipboard">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                        Copy
                    </button>
                </div>
                <div class="tool-output-body" id="invoice-output-body"></div>
            </div>

        </div>
    </div>

    <!-- ===== TOOL VIEW: Adjuster Follow-up ===== -->
    <div class="tool-view" id="tool-view-adjusters" role="main" aria-label="Adjuster Follow-up Tool">
        <div class="tool-header">
            <div class="tool-header-left">
                <div class="tool-header-icon" aria-hidden="true">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                </div>
                <h1>Adjuster Follow-up</h1>
            </div>
            <button class="tool-nav-btn" style="width:auto;padding:6px 14px;margin:0;" onclick="showToolView('chat')" aria-label="Back to chat">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M19 12H5M5 12l7 7M5 12l7-7"/></svg>
                Back to Chat
            </button>
        </div>
        <div class="tool-body">

            <div class="tool-field-row">
                <div class="tool-field">
                    <label for="adj-name-input">Adjuster Name</label>
                    <input type="text" id="adj-name-input" placeholder="John Smith" autocomplete="off" />
                </div>
                <div class="tool-field">
                    <label for="adj-company-input">Insurance Company</label>
                    <input type="text" id="adj-company-input" placeholder="State Farm" autocomplete="off" />
                </div>
            </div>

            <div class="tool-field-row">
                <div class="tool-field">
                    <label for="adj-claim-input">Claim Number</label>
                    <input type="text" id="adj-claim-input" placeholder="CLM-2024-001234" autocomplete="off" />
                </div>
                <div class="tool-field">
                    <label for="adj-lastcontact-input">Date of Last Contact</label>
                    <input type="date" id="adj-lastcontact-input" />
                </div>
            </div>

            <div class="tool-field">
                <label for="adj-status-input">Status / Notes</label>
                <textarea id="adj-status-input" placeholder="Describe the current situation — what was discussed, what's pending, any promises made, how this is affecting the project..." rows="4"></textarea>
            </div>

            <button class="tool-generate-btn" id="adj-generate-btn" onclick="generateAdjusterFollowup()">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                Generate Follow-up Email
            </button>

            <div class="tool-output" id="adjuster-output">
                <div class="tool-output-header">
                    <span class="tool-output-label">Generated Email</span>
                    <button class="tool-copy-btn" onclick="copyToolOutput('adjuster-output-body')" aria-label="Copy to clipboard">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                        Copy
                    </button>
                </div>
                <div class="tool-output-body" id="adjuster-output-body"></div>
            </div>

        </div>
    </div>

    <!-- ===== TOOL VIEW: Estimate Generator ===== -->
    <div class="tool-view" id="tool-view-estimate" role="main" aria-label="Estimate Generator Tool">
        <div class="tool-header">
            <div class="tool-header-left">
                <button class="tool-back-btn" onclick="showToolView(null)" aria-label="Back to chat">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
                    Back
                </button>
                <div class="tool-header-icon">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                </div>
                <h1>Estimate Generator</h1>
            </div>
        </div>
        <div class="tool-body">
            <div class="tool-field-group">
                <div class="tool-field-row">
                    <div class="tool-field">
                        <label>Client Name</label>
                        <input type="text" id="est-client" placeholder="John Smith">
                    </div>
                    <div class="tool-field">
                        <label>Project Name</label>
                        <input type="text" id="est-project" placeholder="Kitchen Remodel">
                    </div>
                </div>
                <div class="tool-field-row">
                    <div class="tool-field">
                        <label>Job Address</label>
                        <input type="text" id="est-address" placeholder="123 Main St, City, State">
                    </div>
                    <div class="tool-field">
                        <label>Est. Start Date</label>
                        <input type="date" id="est-start">
                    </div>
                </div>
                <div class="tool-field">
                    <label>Project Scope / Description</label>
                    <textarea id="est-scope" rows="3" placeholder="Describe the work to be done..."></textarea>
                </div>
            </div>

            <div class="tool-field-group" style="margin-top:18px;">
                <div class="tool-action-bar">
                    <span class="tool-action-bar-title">Line Items</span>
                    <button class="add-line-btn" onclick="addEstimateRow()">+ Add Item</button>
                </div>
                <table class="line-items-table" id="est-line-table">
                    <thead>
                        <tr>
                            <th style="width:40%">Description</th>
                            <th style="width:15%">Qty</th>
                            <th style="width:20%">Unit Price ($)</th>
                            <th style="width:18%">Total</th>
                            <th style="width:7%"></th>
                        </tr>
                    </thead>
                    <tbody id="est-line-body"></tbody>
                </table>
                <div class="estimate-total-row">
                    Subtotal: <strong id="est-subtotal">$0.00</strong>
                    &nbsp;|&nbsp; Tax (
                    <input type="number" id="est-tax-pct" value="0" min="0" max="30" step="0.5" style="width:40px;background:transparent;border:none;border-bottom:1px solid var(--border-mid);color:var(--text);font-family:var(--mono);font-size:13px;text-align:center;outline:none;" oninput="updateEstimateTotal()">
                    %): <strong id="est-tax-amt">$0.00</strong>
                    &nbsp;|&nbsp; <strong style="font-size:18px;" id="est-grand-total">$0.00</strong>
                </div>
            </div>

            <div class="tool-field" style="margin-top:14px;">
                <label>Additional Notes / Terms</label>
                <textarea id="est-notes" rows="2" placeholder="Payment terms, warranty info, exclusions..."></textarea>
            </div>

            <button class="tool-generate-btn" id="est-generate-btn" onclick="generateEstimate()">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                Generate Estimate
            </button>

            <div class="tool-output" id="est-output" style="display:none;">
                <div class="tool-output-header">
                    <span class="tool-output-label">Generated Estimate</span>
                    <button class="tool-copy-btn" onclick="copyToolOutput('est-output-body')">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                        Copy
                    </button>
                </div>
                <div class="tool-output-body" id="est-output-body"></div>
            </div>
        </div>
    </div>

    <!-- ===== TOOL VIEW: Change Order ===== -->
    <div class="tool-view" id="tool-view-changeorder" role="main" aria-label="Change Order Tool">
        <div class="tool-header">
            <div class="tool-header-left">
                <button class="tool-back-btn" onclick="showToolView(null)" aria-label="Back to chat">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
                    Back
                </button>
                <div class="tool-header-icon">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </div>
                <h1>Change Order</h1>
            </div>
        </div>
        <div class="tool-body">
            <div class="tool-field-group">
                <div class="tool-field-row">
                    <div class="tool-field">
                        <label>Client Name</label>
                        <input type="text" id="co-client" placeholder="John Smith">
                    </div>
                    <div class="tool-field">
                        <label>Project / Contract #</label>
                        <input type="text" id="co-contract" placeholder="Contract #2024-001">
                    </div>
                </div>
                <div class="tool-field-row">
                    <div class="tool-field">
                        <label>Change Order #</label>
                        <input type="text" id="co-number" placeholder="CO-001">
                    </div>
                    <div class="tool-field">
                        <label>Status</label>
                        <select id="co-status" style="background:var(--bg-raised);border:1px solid var(--border);color:var(--text);padding:9px 12px;border-radius:var(--radius-sm);font-family:var(--mono);font-size:12px;width:100%;outline:none;">
                            <option value="pending">Pending Approval</option>
                            <option value="approved">Approved</option>
                            <option value="rejected">Rejected</option>
                        </select>
                    </div>
                </div>
                <div class="tool-field">
                    <label>Reason for Change</label>
                    <textarea id="co-reason" rows="3" placeholder="Describe what changed and why (e.g., client requested additional bathroom, unforeseen structural issue, material substitution)..."></textarea>
                </div>
                <div class="tool-field">
                    <label>Scope Changes</label>
                    <textarea id="co-scope" rows="3" placeholder="Describe the specific work being added, removed, or modified..."></textarea>
                </div>
                <div class="tool-field-row">
                    <div class="tool-field">
                        <label>Cost Impact ($)</label>
                        <input type="number" id="co-cost" placeholder="0.00" step="0.01">
                    </div>
                    <div class="tool-field">
                        <label>Schedule Impact (days)</label>
                        <input type="number" id="co-days" placeholder="0" min="-30" max="365">
                    </div>
                </div>
            </div>

            <button class="tool-generate-btn" onclick="generateChangeOrder()">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                Generate Change Order
            </button>

            <div class="tool-output" id="co-output" style="display:none;">
                <div class="tool-output-header">
                    <span class="tool-output-label">Generated Change Order</span>
                    <button class="tool-copy-btn" onclick="copyToolOutput('co-output-body')">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                        Copy
                    </button>
                </div>
                <div class="tool-output-body" id="co-output-body"></div>
            </div>
        </div>
    </div>

    <!-- ===== TOOL VIEW: Subcontractor Management ===== -->
    <div class="tool-view" id="tool-view-subs" role="main" aria-label="Subcontractor Management Tool">
        <div class="tool-header">
            <div class="tool-header-left">
                <button class="tool-back-btn" onclick="showToolView(null)" aria-label="Back to chat">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
                    Back
                </button>
                <div class="tool-header-icon">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                </div>
                <h1>Subcontractor Management</h1>
            </div>
        </div>
        <div class="tool-body">
            <div class="tool-action-bar">
                <span class="tool-action-bar-title">Subcontractors (<span id="sub-count">0</span>)</span>
                <button class="tool-generate-btn" style="padding:8px 16px;font-size:12px;" onclick="toggleSubAddForm()">+ Add Subcontractor</button>
            </div>

            <div class="sub-add-form" id="sub-add-form">
                <div class="form-row">
                    <div class="tool-field"><label>Name / Company</label><input type="text" id="sub-name" placeholder="ABC Electric LLC"></div>
                    <div class="tool-field"><label>Trade / Specialty</label><input type="text" id="sub-trade" placeholder="Electrical"></div>
                </div>
                <div class="form-row">
                    <div class="tool-field"><label>Phone</label><input type="tel" id="sub-phone" placeholder="(555) 123-4567"></div>
                    <div class="tool-field"><label>Email</label><input type="email" id="sub-email" placeholder="contact@abc.com"></div>
                </div>
                <div class="form-row-3">
                    <div class="tool-field"><label>License #</label><input type="text" id="sub-license" placeholder="LIC-12345"></div>
                    <div class="tool-field"><label>Insurance Exp.</label><input type="date" id="sub-ins-exp"></div>
                    <div class="tool-field"><label>Rate ($/hr)</label><input type="number" id="sub-rate" placeholder="85" min="0"></div>
                </div>
                <div class="tool-field"><label>Notes</label><input type="text" id="sub-notes" placeholder="Preferred for large commercial jobs..."></div>
                <div style="display:flex;gap:10px;">
                    <button class="tool-generate-btn" style="padding:8px 16px;font-size:12px;" onclick="saveSub()">Save</button>
                    <button class="add-line-btn" onclick="toggleSubAddForm()">Cancel</button>
                </div>
            </div>

            <div style="overflow-x:auto;">
                <table class="sub-table">
                    <thead>
                        <tr>
                            <th>Name / Company</th>
                            <th>Trade</th>
                            <th>Phone</th>
                            <th>Insurance Exp.</th>
                            <th>Rate</th>
                            <th>Status</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody id="sub-table-body">
                        <tr id="sub-empty-row"><td colspan="7" style="text-align:center;color:var(--text-dim);font-family:var(--mono);font-size:12px;padding:28px;">No subcontractors added yet</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>

    <!-- ===== TOOL VIEW: Materials & Supply Checklist ===== -->
    <div class="tool-view" id="tool-view-materials" role="main" aria-label="Materials Checklist Tool">
        <div class="tool-header">
            <div class="tool-header-left">
                <button class="tool-back-btn" onclick="showToolView(null)" aria-label="Back to chat">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
                    Back
                </button>
                <div class="tool-header-icon">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
                </div>
                <h1>Materials & Supply Checklist</h1>
            </div>
        </div>
        <div class="tool-body">
            <div class="mat-progress">
                <div class="mat-progress-label" id="mat-progress-label">0 of 0 items checked</div>
                <div class="mat-progress-bar"><div class="mat-progress-fill" id="mat-progress-fill" style="width:0%"></div></div>
            </div>

            <div class="mat-add-row">
                <input type="text" id="mat-item-input" placeholder="Add material or supply item..." style="flex:1;" onkeydown="if(event.key==='Enter')addMaterialItem()">
                <select id="mat-cat-select">
                    <option value="Lumber">Lumber</option>
                    <option value="Concrete">Concrete</option>
                    <option value="Electrical">Electrical</option>
                    <option value="Plumbing">Plumbing</option>
                    <option value="Hardware">Hardware</option>
                    <option value="Tools">Tools</option>
                    <option value="Safety">Safety</option>
                    <option value="Other">Other</option>
                </select>
                <button class="tool-generate-btn" style="padding:8px 14px;font-size:12px;" onclick="addMaterialItem()">+ Add</button>
            </div>

            <div class="mat-list" id="mat-list"></div>

            <div style="display:flex;gap:10px;margin-top:14px;">
                <button class="add-line-btn" onclick="clearCheckedMaterials()">Clear Checked</button>
                <button class="add-line-btn" onclick="clearAllMaterials()">Clear All</button>
            </div>
        </div>
    </div>

    <!-- ===== TOOL VIEW: Job Site Photo Log ===== -->
    <div class="tool-view" id="tool-view-photos" role="main" aria-label="Photo Log Tool">
        <div class="tool-header">
            <div class="tool-header-left">
                <button class="tool-back-btn" onclick="showToolView(null)" aria-label="Back to chat">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
                    Back
                </button>
                <div class="tool-header-icon">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                </div>
                <h1>Job Site Photo Log</h1>
            </div>
        </div>
        <div class="tool-body">
            <div class="tool-field-row" style="margin-bottom:14px;">
                <div class="tool-field">
                    <label>Job Name / Tag</label>
                    <input type="text" id="photo-job-tag" placeholder="Roof repair - Unit 4B" style="max-width:320px;">
                </div>
            </div>

            <div class="photo-drop-zone" id="photo-drop-zone" onclick="document.getElementById('photo-file-input').click()" ondragover="photoHandleDragOver(event)" ondragleave="photoHandleDragLeave(event)" ondrop="photoHandleDrop(event)">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                <p>Click or drag photos here to add to log</p>
                <p style="font-size:10px;color:var(--text-dim);margin-top:4px!important;">JPG, PNG, WEBP, GIF supported &bull; Photos stored in session only</p>
                <input type="file" id="photo-file-input" accept="image/*" multiple style="display:none;" onchange="photoHandleFileSelect(event)">
            </div>

            <div style="display:flex;justify-content:space-between;align-items:center;margin:14px 0 4px;">
                <span style="font-family:var(--mono);font-size:11px;color:var(--text-dim);letter-spacing:0.06em;text-transform:uppercase;"><span id="photo-count">0</span> photos</span>
                <button class="add-line-btn" onclick="clearAllPhotos()" style="padding:4px 10px;font-size:10px;">Clear All</button>
            </div>

            <div class="photo-grid" id="photo-grid">
                <div class="photo-empty" id="photo-empty" style="grid-column:1/-1;">No photos added yet</div>
            </div>
        </div>
    </div>

    <!-- ===== TOOL VIEW: OSHA Safety Checklist ===== -->
    <div class="tool-view" id="tool-view-safety" role="main" aria-label="Safety Checklist Tool">
        <div class="tool-header">
            <div class="tool-header-left">
                <button class="tool-back-btn" onclick="showToolView(null)" aria-label="Back to chat">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
                    Back
                </button>
                <div class="tool-header-icon">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                </div>
                <h1>OSHA Safety Checklist</h1>
            </div>
        </div>
        <div class="tool-body">
            <div class="tool-field-row" style="margin-bottom:16px;align-items:flex-end;gap:12px;">
                <div class="tool-field" style="max-width:220px;">
                    <label>Inspection Date</label>
                    <input type="date" id="safety-date">
                </div>
                <div class="tool-field" style="max-width:220px;">
                    <label>Job Site</label>
                    <input type="text" id="safety-site" placeholder="Site name or address">
                </div>
                <div class="tool-field" style="max-width:180px;">
                    <label>Inspector Name</label>
                    <input type="text" id="safety-inspector" placeholder="Your name">
                </div>
            </div>

            <div style="margin-bottom:12px;">
                <div class="mat-progress-label" id="safety-progress-label">0 of 0 items checked</div>
                <div class="safety-progress-bar"><div class="safety-progress-fill" id="safety-progress-fill" style="width:0%"></div></div>
            </div>

            <div id="safety-categories"></div>

            <div class="safety-actions">
                <button class="tool-generate-btn" style="padding:9px 18px;font-size:12px;" onclick="saveSafetyLog()">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/></svg>
                    Save Inspection Log
                </button>
                <button class="add-line-btn" onclick="resetSafetyChecklist()">Reset Checklist</button>
                <button class="add-line-btn" onclick="toggleSafetyLogs()">View Past Logs</button>
            </div>

            <div id="safety-logs-panel" style="display:none;margin-top:18px;">
                <div style="font-family:var(--mono);font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-mid);margin-bottom:10px;">Past Inspection Logs</div>
                <div id="safety-logs-list"></div>
            </div>
        </div>
    </div>

    <script>
        // ============================================
        // AUTH LAYER — runs before anything else
        // ============================================

        const AUTH_TOKEN_KEY = 'auth_token';
        const AUTH_USER_KEY  = 'auth_username';

        function getAuthToken() {
            try { return localStorage.getItem(AUTH_TOKEN_KEY) || null; } catch(e) { return null; }
        }

        function setAuthToken(token, username) {
            try {
                localStorage.setItem(AUTH_TOKEN_KEY, token);
                if (username) localStorage.setItem(AUTH_USER_KEY, username);
            } catch(e) { console.error('Failed to save auth token:', e); }
        }

        function clearAuthToken() {
            try {
                localStorage.removeItem(AUTH_TOKEN_KEY);
                localStorage.removeItem(AUTH_USER_KEY);
            } catch(e) {}
            showLoginScreen();
        }

        function getAuthUsername() {
            try { return localStorage.getItem(AUTH_USER_KEY) || 'User'; } catch(e) { return 'User'; }
        }

        function isAuthenticated() {
            return !!getAuthToken();
        }

        function showLoginScreen() {
            const overlay = document.getElementById('login-overlay');
            if (overlay) overlay.style.display = 'flex';
            if (typeof switchAuthTab === 'function') switchAuthTab('signin');
            setTimeout(() => {
                const u = document.getElementById('login-username');
                if (u) u.focus();
            }, 50);
        }

        function hideLoginScreen() {
            const overlay = document.getElementById('login-overlay');
            if (overlay) overlay.style.display = 'none';
        }

        function setLoginError(msg) {
            const el = document.getElementById('login-error');
            if (!el) return;
            el.textContent = msg;
            el.classList.toggle('visible', !!msg);
        }

        async function handleLogin() {
            const uInput = document.getElementById('login-username');
            const pInput = document.getElementById('login-password');
            const btn    = document.getElementById('login-btn');
            if (!uInput || !pInput || !btn) return;

            const username = uInput.value.trim();
            const password = pInput.value;

            if (!username) { setLoginError('Please enter your username.'); uInput.focus(); return; }
            if (!password) { setLoginError('Please enter your password.'); pInput.focus(); return; }

            btn.disabled    = true;
            btn.textContent = 'Signing in...';
            setLoginError('');

            try {
                const res = await fetch('/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json();

                if (res.ok && data.success && data.token) {
                    setAuthToken(data.token, data.username || username);
                    // Seed display name from login username only if not already customised
                    const existingName = localStorage.getItem('account_name');
                    if (!existingName || existingName === 'User') {
                        localStorage.setItem('account_name', data.username || username);
                    }
                    hideLoginScreen();
                    if (typeof refreshAccountUI === 'function') refreshAccountUI();
                } else if (res.status === 429) {
                    setLoginError('Too many attempts. Please wait 15 minutes and try again.');
                } else if (res.status === 403) {
                    setLoginError(data.error || 'Your account is pending admin approval.');
                    pInput.value = '';
                } else {
                    setLoginError(data.error || 'Invalid username or password.');
                    pInput.value = '';
                    pInput.focus();
                }
            } catch(e) {
                setLoginError('Network error. Please check your connection and try again.');
                console.error('Login error:', e);
            } finally {
                btn.disabled    = false;
                btn.textContent = 'Sign In';
            }
        }

        function handleLogout() {
            if (!confirm('Sign out of your account?')) return;
            clearAuthToken();
        }

        function setLoginSuccess(msg) {
            const el = document.getElementById('login-success');
            if (!el) return;
            el.textContent = msg;
            el.classList.toggle('visible', !!msg);
        }

        function switchAuthTab(tab) {
            const signinFields = document.getElementById('signin-fields');
            const signupFields = document.getElementById('signup-fields');
            const tabSignin = document.getElementById('tab-signin');
            const tabSignup = document.getElementById('tab-signup');
            if (!signinFields || !signupFields) return;
            setLoginError('');
            setLoginSuccess('');
            if (tab === 'signin') {
                signinFields.style.display = '';
                signupFields.style.display = 'none';
                tabSignin?.classList.add('active');
                tabSignup?.classList.remove('active');
                setTimeout(() => document.getElementById('login-username')?.focus(), 50);
            } else {
                signinFields.style.display = 'none';
                signupFields.style.display = '';
                tabSignin?.classList.remove('active');
                tabSignup?.classList.add('active');
                setTimeout(() => document.getElementById('signup-username')?.focus(), 50);
            }
        }

        async function handleSignup() {
            const uInput = document.getElementById('signup-username');
            const eInput = document.getElementById('signup-email');
            const pInput = document.getElementById('signup-password');
            const btn    = document.getElementById('signup-btn');
            if (!uInput || !pInput || !btn) return;

            const username = uInput.value.trim();
            const email    = eInput?.value.trim() || '';
            const password = pInput.value;

            if (!username) { setLoginError('Please enter a username.'); uInput.focus(); return; }
            if (!password) { setLoginError('Please enter a password.'); pInput.focus(); return; }

            btn.disabled = true;
            btn.textContent = 'Sending...';
            setLoginError('');
            setLoginSuccess('');

            try {
                const res = await fetch('/signup', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password, email })
                });
                const data = await res.json();
                if (res.ok && data.success) {
                    setLoginSuccess(data.message || 'Account created! You can now sign in.');
                    uInput.value = '';
                    if (eInput) eInput.value = '';
                    pInput.value = '';
                } else if (res.status === 429) {
                    setLoginError('Too many attempts. Please wait before trying again.');
                } else {
                    setLoginError(data.error || 'Signup failed. Please try again.');
                }
            } catch(e) {
                setLoginError('Network error. Please check your connection.');
                console.error('Signup error:', e);
            } finally {
                btn.disabled = false;
                btn.textContent = 'Create Account';
            }
        }

        // Enter key navigation in login form
        document.getElementById('login-username')?.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') document.getElementById('login-password')?.focus();
        });
        document.getElementById('login-password')?.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') handleLogin();
        });

        // Enter key navigation in signup form
        document.getElementById('signup-username')?.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') document.getElementById('signup-email')?.focus();
        });
        document.getElementById('signup-email')?.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') document.getElementById('signup-password')?.focus();
        });
        document.getElementById('signup-password')?.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') handleSignup();
        });

        // Gate: show login screen immediately if not authenticated
        if (!isAuthenticated()) {
            showLoginScreen();
        }

        // ============================================
        // END AUTH LAYER
        // ============================================

        const chat = document.getElementById('chat');
        const input = document.getElementById('input');
        const sendBtn = document.getElementById('send-btn');
        const historyList = document.getElementById('history-list');

        // Chat history management with error handling
        let chatHistory = [];
        let currentChatId = '';
        let currentMessages = [];

        try {
            chatHistory = JSON.parse(localStorage.getItem('chatHistory') || '[]');
            currentChatId = localStorage.getItem('currentChatId') || generateChatId();
        } catch (e) {
            console.error('Failed to load chat history:', e);
            localStorage.setItem('chatHistory', '[]');
            currentChatId = generateChatId();
        }

        function generateChatId() {
            return 'chat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        }

        function saveChatHistory() {
            try {
                const data = JSON.stringify(chatHistory);
                localStorage.setItem('chatHistory', data);
            } catch (e) {
                console.error('Failed to save chat history:', e);
                // If quota exceeded, remove oldest chats
                if (e.name === 'QuotaExceededError' && chatHistory.length > 10) {
                    chatHistory = chatHistory.slice(0, 10);
                    try {
                        localStorage.setItem('chatHistory', JSON.stringify(chatHistory));
                    } catch (e2) {
                        console.error('Still failed after trimming:', e2);
                    }
                }
            }
        }

        function deleteChat(index, event) {
            event.stopPropagation(); // Prevent loading the chat when clicking delete
            if (confirm('Delete this chat?')) {
                chatHistory.splice(index, 1);
                saveChatHistory();
                loadHistoryUI();

                // If we deleted the current chat, start a new one
                if (chatHistory[index]?.id === currentChatId) {
                    goHome();
                }
            }
        }

        function loadHistoryUI() {
            historyList.innerHTML = '';
            chatHistory.forEach((chat, index) => {
                const item = document.createElement('div');
                item.className = 'history-item';
                item.setAttribute('role', 'listitem');
                item.setAttribute('tabindex', '0');
                item.setAttribute('aria-label', 'Chat: ' + (chat.title || 'New Chat') + ', ' + formatTime(chat.timestamp));
                item.onclick = () => loadChat(index);
                item.onkeypress = (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        loadChat(index);
                    }
                };

                const title = document.createElement('div');
                title.className = 'history-item-title';
                title.textContent = chat.title || 'New Chat';

                const preview = document.createElement('div');
                preview.className = 'history-item-preview';
                preview.textContent = chat.messages[0]?.text?.substring(0, 60) || 'No messages';

                const time = document.createElement('div');
                time.className = 'history-item-time';
                time.textContent = formatTime(chat.timestamp);

                // Delete button
                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'delete-chat-btn';
                deleteBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
                deleteBtn.setAttribute('aria-label', 'Delete chat: ' + (chat.title || 'New Chat'));
                deleteBtn.setAttribute('title', 'Delete chat');
                deleteBtn.onclick = (e) => deleteChat(index, e);

                item.appendChild(title);
                item.appendChild(preview);
                item.appendChild(time);
                item.appendChild(deleteBtn);
                historyList.appendChild(item);
            });
        }

        function formatTime(timestamp) {
            const date = new Date(timestamp);
            const now = new Date();
            const diff = now - date;
            const hours = Math.floor(diff / 3600000);
            const days = Math.floor(diff / 86400000);

            if (hours < 1) return 'Just now';
            if (hours < 24) return hours + 'h ago';
            if (days < 7) return days + 'd ago';
            return date.toLocaleDateString();
        }

        function saveCurrentChat() {
            if (currentMessages.length === 0) return;

            const existingIndex = chatHistory.findIndex(c => c.id === currentChatId);
            const chatData = {
                id: currentChatId,
                title: currentMessages[0]?.text?.substring(0, 50) || 'New Chat',
                messages: currentMessages,
                timestamp: Date.now()
            };

            if (existingIndex >= 0) {
                chatHistory[existingIndex] = chatData;
            } else {
                chatHistory.unshift(chatData);
            }

            saveChatHistory();
            loadHistoryUI();
        }

        function loadChat(index) {
            const selectedChat = chatHistory[index];
            if (!selectedChat || !selectedChat.messages || !Array.isArray(selectedChat.messages)) return;

            currentChatId = selectedChat.id;
            currentMessages = selectedChat.messages;
            try {
                localStorage.setItem('currentChatId', currentChatId);
            } catch (e) {
                console.error('Failed to save current chat ID:', e);
            }

            // Clear and reload chat
            const chatArea = document.getElementById('chat');
            chatArea.innerHTML = '';
            currentMessages.forEach(msg => {
                addMsg(msg.type, msg.text, msg.aiType, msg.routingInfo);
            });
        }

        function goHome() {
            saveCurrentChat();
            currentChatId = generateChatId();
            currentMessages = [];
            localStorage.setItem('currentChatId', currentChatId);
            location.reload();
        }

        function setPrompt(text) {
            input.value = text;
            input.focus();
        }

        // Load history on startup
        loadHistoryUI();

        // Add keyboard support for example query buttons
        document.querySelectorAll('.example-queries li[role="button"]').forEach(li => {
            li.addEventListener('keypress', function(e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.click();
                }
            });
        });

        function getChatInner() {
            let inner = chat.querySelector('.chat-inner');
            if (!inner) {
                inner = document.createElement('div');
                inner.className = 'chat-inner';
                chat.appendChild(inner);
            }
            return inner;
        }

        function addMsg(type, text, aiType = null, routingInfo = null) {
            const emptyState = chat.querySelector('.empty-state');
            if (emptyState) emptyState.remove();

            const inner = getChatInner();

            // Row wrapper (for avatar + bubble layout)
            const row = document.createElement('div');
            row.className = 'message-row' + (type === 'user' ? ' user-row' : '');

            // Avatar
            const avatar = document.createElement('div');
            if (type === 'user') {
                avatar.className = 'msg-avatar user-av';
                avatar.setAttribute('aria-hidden', 'true');
                avatar.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
            } else {
                const isOC = type === 'bot' && aiType === 'openclaw';
                avatar.className = 'msg-avatar bot-av' + (isOC ? ' openclaw-av' : '');
                avatar.setAttribute('aria-hidden', 'true');
                avatar.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>';
            }
            row.appendChild(avatar);

            // Message bubble
            const msg = document.createElement('div');
            msg.className = 'message ' + type;
            if (type === 'bot' && aiType) msg.className += ' ' + aiType;
            msg.setAttribute('role', type === 'error' ? 'alert' : 'article');
            if (type === 'bot') msg.setAttribute('aria-label', (aiType || 'AI') + ' response');
            if (type === 'user') msg.setAttribute('aria-label', 'Your message');
            if (type === 'error') msg.setAttribute('aria-label', 'Error message');

            if (type === 'bot' && aiType) {
                const badge = document.createElement('div');
                badge.className = 'ai-badge ' + aiType;
                badge.textContent = aiType === 'gemini' ? '🔵 Chat' : '🟠 Agent';
                badge.setAttribute('aria-label', 'Response from ' + aiType);
                msg.appendChild(badge);
            }

            // Render markdown for bot messages, plain text for user/error
            if (type === 'bot' && typeof marked !== 'undefined') {
                const contentDiv = document.createElement('div');
                contentDiv.innerHTML = marked.parse(text);
                msg.appendChild(contentDiv);

                // Highlight code blocks
                if (typeof hljs !== 'undefined') {
                    msg.querySelectorAll('pre code').forEach((block) => {
                        hljs.highlightElement(block);
                        const pre = block.parentElement;
                        if (pre.tagName === 'PRE') {
                            const copyBtn = document.createElement('button');
                            copyBtn.className = 'copy-code-btn';
                            copyBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy';
                            copyBtn.onclick = () => {
                                navigator.clipboard.writeText(block.textContent);
                                copyBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg> Copied';
                                setTimeout(() => { copyBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy'; }, 2000);
                            };
                            pre.appendChild(copyBtn);
                        }
                    });
                }
            } else {
                msg.appendChild(document.createTextNode(text));
            }

            // Copy action button (on hover)
            if (type !== 'thinking') {
                const actions = document.createElement('div');
                actions.className = 'message-actions';
                actions.setAttribute('role', 'group');
                actions.setAttribute('aria-label', 'Message actions');

                const copyBtn = document.createElement('button');
                copyBtn.className = 'message-action-btn';
                copyBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy';
                copyBtn.setAttribute('aria-label', 'Copy message to clipboard');
                copyBtn.onclick = () => {
                    navigator.clipboard.writeText(text);
                    copyBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg> Copied';
                    copyBtn.setAttribute('aria-label', 'Message copied');
                    setTimeout(() => {
                        copyBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy';
                        copyBtn.setAttribute('aria-label', 'Copy message to clipboard');
                    }, 2000);
                };
                actions.appendChild(copyBtn);
                msg.appendChild(actions);
            }

            if (routingInfo) {
                const info = document.createElement('div');
                info.className = 'routing-info';
                info.textContent = routingInfo;
                msg.appendChild(info);
            }

            row.appendChild(msg);
            inner.appendChild(row);
            chat.scrollTop = chat.scrollHeight;

            // Save to current messages
            currentMessages.push({ type, text, aiType, routingInfo });
            saveCurrentChat();

            return row;
        }

        function addThinking() {
            const inner = getChatInner();

            const row = document.createElement('div');
            row.className = 'message-row';

            const avatar = document.createElement('div');
            avatar.className = 'msg-avatar bot-av';
            avatar.setAttribute('aria-hidden', 'true');
            avatar.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>';
            row.appendChild(avatar);

            const msg = document.createElement('div');
            msg.className = 'message thinking';

            const spinner = document.createElement('div');
            spinner.className = 'spinner';
            msg.appendChild(spinner);

            const txt = document.createTextNode('Thinking...');
            msg.appendChild(txt);

            row.appendChild(msg);
            inner.appendChild(row);
            chat.scrollTop = chat.scrollHeight;
            return row;
        }

        function addTimeoutMsg(originalPrompt) {
            const inner = getChatInner();
            const row = document.createElement('div');
            row.className = 'message-row';

            const avatar = document.createElement('div');
            avatar.className = 'msg-avatar bot-av';
            avatar.setAttribute('aria-hidden', 'true');
            avatar.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>';
            row.appendChild(avatar);

            const msg = document.createElement('div');
            msg.className = 'message error';
            msg.innerHTML =
                '<div class="timeout-msg">' +
                '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="flex-shrink:0;color:#f59e0b"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
                '<span>Request timed out. The AI took too long to respond.</span>' +
                '</div>' +
                '<button class="retry-btn" onclick="retryPrompt(this, ' + JSON.stringify(JSON.stringify(originalPrompt)) + ')">'+
                '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>' +
                'Retry</button>';
            row.appendChild(msg);
            inner.appendChild(row);
            chat.scrollTop = chat.scrollHeight;
        }

        function retryPrompt(btn, promptJson) {
            const prompt = JSON.parse(promptJson);
            // Remove the timeout message row
            btn.closest('.message-row').remove();
            // Put the prompt back in the input and resend
            input.value = prompt;
            handleSend();
        }

        // ============================================
        // AI MODE MANAGEMENT
        // ============================================

        let currentAIMode = 'gemini';
        try { currentAIMode = localStorage.getItem('aiMode') || 'gemini'; } catch(e) {}

        function setAIMode(mode) {
            currentAIMode = mode;
            try { localStorage.setItem('aiMode', mode); } catch(e) {}

            // Update tab buttons
            const geminiBtn = document.getElementById('mode-gemini');
            const openclawBtn = document.getElementById('mode-openclaw');
            if (geminiBtn) {
                geminiBtn.classList.toggle('active', mode === 'gemini');
                geminiBtn.setAttribute('aria-selected', mode === 'gemini');
            }
            if (openclawBtn) {
                openclawBtn.classList.toggle('active', mode === 'openclaw');
                openclawBtn.setAttribute('aria-selected', mode === 'openclaw');
            }

            // Show/hide OpenClaw status bar
            const statusBar = document.getElementById('openclaw-status');
            if (statusBar) statusBar.style.display = mode === 'openclaw' ? 'flex' : 'none';

            // Update header display
            const headerDisplay = document.getElementById('header-ai-display');
            if (headerDisplay) {
                headerDisplay.textContent = mode === 'gemini' ? 'Chat' : 'Agent';
            }

            // Check connection when switching to OpenClaw
            if (mode === 'openclaw') checkOpenClawStatus();
        }

        // Apply saved mode on page load
        setAIMode(currentAIMode);

        // ============================================
        // OPENCLAW SETTINGS
        // ============================================

        function getOpenClawSetting(key) {
            try { return localStorage.getItem('openclaw_' + key) || ''; } catch(e) { return ''; }
        }

        function openSettings(tab) {
            // Populate all form fields from localStorage
            const el = id => document.getElementById(id);

            // Profile tab
            if (el('settings-name-input')) el('settings-name-input').value = getDisplayName();
            if (el('settings-plan-select')) {
                const planLabel = localStorage.getItem('account_plan') || 'Free Plan';
                const planVal = { 'Free Plan': 'free', 'Pro Plan': 'pro', 'Team Plan': 'team' }[planLabel] || 'free';
                el('settings-plan-select').value = planVal;
            }

            // System tab
            if (el('settings-system-prompt')) el('settings-system-prompt').value = localStorage.getItem('system_prompt') || '';
            if (el('settings-temperature')) {
                const temp = localStorage.getItem('chat_temperature') || '0.7';
                el('settings-temperature').value = temp;
                if (el('settings-temperature-val')) el('settings-temperature-val').textContent = temp;
            }
            if (el('settings-language')) el('settings-language').value = localStorage.getItem('chat_language') || 'en';

            // Agent tab
            if (el('openclaw-url-input')) el('openclaw-url-input').value = getOpenClawSetting('url') || 'http://your-vps-ip:18789';
            if (el('openclaw-token-input')) el('openclaw-token-input').value = getOpenClawSetting('token');

            // Connectors tab
            if (el('gemini-api-key-input')) el('gemini-api-key-input').value = localStorage.getItem('gemini_api_key') || '';
            if (el('gemini-model-select')) el('gemini-model-select').value = localStorage.getItem('gemini_model') || 'gemini-2.0-flash';
            if (el('notion-token-input')) el('notion-token-input').value = localStorage.getItem('notion_api_key') || '';
            if (el('webhook-url-input')) el('webhook-url-input').value = localStorage.getItem('webhook_url') || '';
            if (el('webhook-secret-input')) el('webhook-secret-input').value = localStorage.getItem('webhook_secret') || '';

            // Update connector status dots
            updateConnectorStatus('notion', !!localStorage.getItem('notion_api_key'), 'Connected', 'Not connected');
            updateConnectorStatus('webhook', !!localStorage.getItem('webhook_url'), 'Connected', 'Not configured');

            // Tool prompt tabs
            if (el('invoice-system-prompt')) el('invoice-system-prompt').value = localStorage.getItem('invoice_system_prompt') || '';
            if (el('adjuster-system-prompt')) el('adjuster-system-prompt').value = localStorage.getItem('adjuster_system_prompt') || '';

            // Switch to requested tab (default: profile)
            switchSettingsTab(tab || 'profile');

            // Open panel
            document.getElementById('settings-panel')?.classList.add('open');
            document.getElementById('settings-overlay')?.classList.add('open');
        }

        function closeSettings() {
            document.getElementById('settings-panel')?.classList.remove('open');
            document.getElementById('settings-overlay')?.classList.remove('open');
        }

        async function saveOpenClawSettings() {
            const url   = document.getElementById('openclaw-url-input')?.value.trim() || '';
            const token = document.getElementById('openclaw-token-input')?.value.trim() || '';
            try {
                localStorage.setItem('openclaw_url', url);
                localStorage.setItem('openclaw_token', token);
            } catch(e) { console.error('Failed to save Agent settings:', e); }
            await checkOpenClawStatus();
            showSettingsToast('Agent settings saved');
        }

        // ============================================
        // OPENCLAW CONNECTION STATUS CHECK
        // ============================================

        async function checkOpenClawStatus() {
            const dot  = document.getElementById('openclaw-status-dot');
            const text = document.getElementById('openclaw-status-text');
            if (!dot || !text) return;

            dot.className = 'openclaw-status-dot checking';
            text.textContent = 'Checking...';
            text.style.color = '#fbbf24';

            try {
                const res = await fetch('/ping-openclaw', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        openclawUrl:   getOpenClawSetting('url'),
                        openclawToken: getOpenClawSetting('token')
                    })
                });
                const data = await res.json();

                if (data.reachable) {
                    dot.className = 'openclaw-status-dot online';
                    text.textContent = 'Agent connected';
                    text.style.color = '#4ade80';
                } else {
                    dot.className = 'openclaw-status-dot offline';
                    text.textContent = data.reason || 'Not reachable';
                    text.style.color = '#f87171';
                }
            } catch(e) {
                dot.className = 'openclaw-status-dot offline';
                text.textContent = 'Check failed';
                text.style.color = '#f87171';
            }
        }

        // Auto-recheck every 30s while in OpenClaw mode
        setInterval(() => { if (currentAIMode === 'openclaw') checkOpenClawStatus(); }, 30000);

        // ============================================
        // REQUEST MANAGEMENT
        // ============================================

        // AbortController for request cancellation
        let currentRequest = null;

        async function handleSend() {
            let thinkingMsg = null;
            try {
                const userInput = input.value.trim();
                if (!userInput) return;

                // Prevent double-submit immediately
                if (sendBtn.disabled) return;
                sendBtn.disabled = true;
                sendBtn.classList.add('thinking-state');

                // Cancel previous request if exists
                if (currentRequest) {
                    currentRequest.abort();
                }

                addMsg('user', userInput);
                input.value = '';

                thinkingMsg = addThinking();

                // Create new AbortController with 28s client-side timeout
                currentRequest = new AbortController();
                const clientTimeout = setTimeout(() => currentRequest.abort(), 28000);

                let data;
                try {
                    const res = await fetch('/chat', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': 'Bearer ' + (getAuthToken() || '')
                        },
                        body: JSON.stringify({
                            prompt: userInput,
                            ai: currentAIMode,
                            openclawUrl: getOpenClawSetting('url'),
                            openclawToken: getOpenClawSetting('token')
                        }),
                        signal: currentRequest.signal
                    });
                    clearTimeout(clientTimeout);
                    data = await res.json();

                    // Session expired — force re-login
                    if (res.status === 401) {
                        if (thinkingMsg) thinkingMsg.remove();
                        clearAuthToken();
                        return;
                    }

                    if (thinkingMsg) thinkingMsg.remove();

                    // Timeout response from server
                    if (data.timeout || res.status === 504) {
                        addTimeoutMsg(userInput);
                        return;
                    }

                    if (!res.ok) {
                        throw new Error(data.error || data.message || 'Service temporarily unavailable. Please try again.');
                    }

                    const routingInfo = data.routing ?
                        'Routed to ' + data.routing.ai.toUpperCase() + ' (confidence: ' + data.routing.confidence + ')' :
                        null;

                    addMsg('bot', data.response, data.ai, routingInfo);

                } catch (fetchErr) {
                    clearTimeout(clientTimeout);
                    if (thinkingMsg) thinkingMsg.remove();
                    if (fetchErr.name === 'AbortError') {
                        // Client-side timeout fired
                        addTimeoutMsg(userInput);
                    } else {
                        addMsg('error', fetchErr.message || 'Something went wrong. Please try again.');
                    }
                }

            } catch (error) {
                if (thinkingMsg) thinkingMsg.remove();
                if (error.name !== 'AbortError') {
                    addMsg('error', error.message || 'Something went wrong. Please try again.');
                }
            } finally {
                currentRequest = null;
                sendBtn.disabled = false;
                sendBtn.classList.remove('thinking-state');
                input.focus();
            }
        }

        // Keyboard shortcuts
        document.addEventListener('keydown', function(e) {
            // Ctrl/Cmd + K: New chat
            if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
                e.preventDefault();
                goHome();
            }
            // Escape: Clear input
            if (e.key === 'Escape') {
                input.value = '';
                input.focus();
            }
            // Ctrl/Cmd + /: Focus input
            if ((e.ctrlKey || e.metaKey) && e.key === '/') {
                e.preventDefault();
                input.focus();
            }
        });

        // Set up event listeners
        sendBtn.addEventListener('click', handleSend);
        input.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleSend();
            }
        });

        // Auto-focus input on load
        input.focus();

        // ============================================
        // ACCOUNT & SETTINGS MANAGEMENT
        // ============================================

        function getDisplayName() {
            return localStorage.getItem('account_name') || 'User';
        }

        function getDisplayPlan() {
            return localStorage.getItem('account_plan') || 'Free Plan';
        }

        function getAvatarInitials(name) {
            const parts = (name || 'U').trim().split(/\s+/).filter(Boolean);
            if (parts.length === 0) return 'U';
            if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
            return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
        }

        function refreshAccountUI() {
            const name     = getDisplayName();
            const plan     = getDisplayPlan();
            const initials = getAvatarInitials(name);
            const el = id => document.getElementById(id);
            if (el('account-avatar'))          el('account-avatar').textContent = initials;
            if (el('account-name'))            el('account-name').textContent   = name;
            const planEl = document.querySelector('.account-plan');
            if (planEl) planEl.textContent = plan;
            if (el('settings-header-avatar'))  el('settings-header-avatar').textContent = initials;
            if (el('settings-header-name'))    el('settings-header-name').textContent   = name;
            if (el('profile-big-avatar'))      el('profile-big-avatar').textContent     = initials;
            // Show logout button only when authenticated
            const logoutBtn = el('logout-btn');
            if (logoutBtn) logoutBtn.style.display = isAuthenticated() ? 'flex' : 'none';
        }

        function switchSettingsTab(tab) {
            document.querySelectorAll('.stab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
            document.querySelectorAll('.stab-content').forEach(c => c.classList.toggle('active', c.id === 'stab-content-' + tab));
        }

        function updateConnectorStatus(id, connected, onLabel, offLabel) {
            const dot  = document.getElementById(id + '-dot');
            const text = document.getElementById(id + '-status-text');
            if (dot)  dot.classList.toggle('connected', connected);
            if (text) text.textContent = connected ? onLabel : offLabel;
        }

        function updateProfilePreview() {
            const val = document.getElementById('settings-name-input')?.value || 'User';
            const el = document.getElementById('profile-big-avatar');
            if (el) el.textContent = getAvatarInitials(val);
        }

        function saveProfile() {
            const nameInput = document.getElementById('settings-name-input');
            const planSelect = document.getElementById('settings-plan-select');
            const newName = nameInput?.value.trim() || 'User';
            const newPlan = planSelect?.value || 'free';
            const planLabels = { free: 'Free Plan', pro: 'Pro Plan', team: 'Team Plan' };
            localStorage.setItem('account_name', newName);
            localStorage.setItem('account_plan', planLabels[newPlan] || 'Free Plan');
            refreshAccountUI();
            showSettingsToast('Profile saved');
        }

        function clearAllHistory() {
            if (!confirm('Clear all chat history? This cannot be undone.')) return;
            localStorage.setItem('chatHistory', '[]');
            chatHistory = [];
            renderHistory();
            goHome();
            showSettingsToast('Chat history cleared');
        }

        function resetAccount() {
            if (!confirm('Reset all settings? This will clear your profile, settings and API keys.')) return;
            ['account_name','account_plan','system_prompt','chat_temperature','chat_language',
             'gemini_api_key','gemini_model','notion_api_key','webhook_url','webhook_secret',
             'openclaw_url','openclaw_token','aiMode',
             'invoice_system_prompt','adjuster_system_prompt'].forEach(k => localStorage.removeItem(k));
            refreshAccountUI();
            closeSettings();
            showSettingsToast('Account reset');
        }

        function saveSystemSettings() {
            const prompt = document.getElementById('settings-system-prompt')?.value || '';
            const temp   = document.getElementById('settings-temperature')?.value || '0.7';
            const lang   = document.getElementById('settings-language')?.value || 'en';
            localStorage.setItem('system_prompt', prompt);
            localStorage.setItem('chat_temperature', temp);
            localStorage.setItem('chat_language', lang);
            showSettingsToast('System settings saved');
        }

        function saveGeminiSettings() {
            const key   = document.getElementById('gemini-api-key-input')?.value.trim() || '';
            const model = document.getElementById('gemini-model-select')?.value || 'gemini-2.0-flash';
            localStorage.setItem('gemini_api_key', key);
            localStorage.setItem('gemini_model', model);
            updateConnectorStatus('gemini', !!key, 'Connected', 'Not connected');
            showSettingsToast('Gemini settings saved');
        }

        function saveNotionSettings() {
            const token = document.getElementById('notion-token-input')?.value.trim() || '';
            localStorage.setItem('notion_api_key', token);
            updateConnectorStatus('notion', !!token, 'Connected', 'Not connected');
            showSettingsToast('Notion settings saved');
        }

        function saveWebhookSettings() {
            const url    = document.getElementById('webhook-url-input')?.value.trim() || '';
            const secret = document.getElementById('webhook-secret-input')?.value.trim() || '';
            localStorage.setItem('webhook_url', url);
            localStorage.setItem('webhook_secret', secret);
            updateConnectorStatus('webhook', !!url, 'Connected', 'Not configured');
            showSettingsToast('Webhook settings saved');
        }

        function showSettingsToast(msg) {
            let toast = document.getElementById('settings-toast');
            if (!toast) {
                toast = document.createElement('div');
                toast.id = 'settings-toast';
                toast.style.cssText = 'position:fixed;bottom:28px;left:50%;transform:translateX(-50%);' +
                    'background:#10a37f;color:#fff;padding:10px 22px;border-radius:8px;font-size:14px;' +
                    'font-weight:500;z-index:9999;opacity:0;transition:opacity 0.25s;pointer-events:none;';
                document.body.appendChild(toast);
            }
            toast.textContent = msg;
            toast.style.opacity = '1';
            clearTimeout(toast._t);
            toast._t = setTimeout(() => { toast.style.opacity = '0'; }, 2200);
        }

        // Temperature slider live update
        document.addEventListener('input', function(e) {
            if (e.target && e.target.id === 'settings-temperature') {
                const val = document.getElementById('settings-temperature-val');
                if (val) val.textContent = e.target.value;
            }
        });

        // Initialize account UI on load
        refreshAccountUI();

        // ============================================
        // TOOL VIEW MANAGEMENT
        // ============================================

        function showToolView(viewId) {
            const mainContent = document.querySelector('.main-content');
            if (mainContent) mainContent.style.display = viewId === 'chat' ? '' : 'none';

            document.querySelectorAll('.tool-view').forEach(v => v.classList.remove('active'));

            if (viewId !== 'chat') {
                const target = document.getElementById('tool-view-' + viewId);
                if (target) target.classList.add('active');
            }

            document.querySelectorAll('.tool-nav-btn').forEach(b => {
                b.classList.toggle('active', b.id === 'tool-nav-' + viewId);
            });
        }

        // ============================================
        // INVOICE FOLLOW-UP TOOL
        // ============================================

        let invoiceFileContent = '';
        let invoiceFileName = '';

        const ESCALATION_LEVELS = [
            { maxDays: 30,  label: 'Friendly Reminder',   cls: 'friendly', tone: 'friendly reminder: polite, assume it was an oversight, no pressure' },
            { maxDays: 60,  label: 'Firm / Professional', cls: 'firm',     tone: 'firm and professional: acknowledge prior contact, set a clear payment deadline' },
            { maxDays: 90,  label: 'Urgent / Serious',    cls: 'urgent',   tone: 'urgent and serious: express concern, mention potential suspension of services' },
            { maxDays: 9999,label: 'Final Notice / Legal',cls: 'final',    tone: 'final notice: state this is the last attempt before referring to collections or legal action' }
        ];

        function getEscalationLevel(days) {
            return ESCALATION_LEVELS.find(l => days <= l.maxDays) || ESCALATION_LEVELS[3];
        }

        function updateEscalationBadge() {
            const days = parseInt(document.getElementById('invoice-days-input')?.value, 10);
            const wrap = document.getElementById('escalation-badge-wrap');
            if (!wrap) return;
            if (isNaN(days) || days < 0) { wrap.innerHTML = ''; return; }
            const level = getEscalationLevel(days);
            wrap.innerHTML = '<span class="escalation-badge ' + level.cls + '">' + level.label + '</span>';
            const btn = document.getElementById('invoice-generate-btn');
            if (btn && invoiceFileContent) btn.disabled = false;
        }

        function handleInvoiceDragOver(e) {
            e.preventDefault();
            document.getElementById('invoice-drop-zone')?.classList.add('drag-over');
        }

        function handleInvoiceDragLeave(e) {
            document.getElementById('invoice-drop-zone')?.classList.remove('drag-over');
        }

        function handleInvoiceFileDrop(e) {
            e.preventDefault();
            document.getElementById('invoice-drop-zone')?.classList.remove('drag-over');
            const file = e.dataTransfer?.files?.[0];
            if (file) processInvoiceFile(file);
        }

        function handleInvoiceFileSelect(e) {
            const file = e.target?.files?.[0];
            if (file) processInvoiceFile(file);
        }

        function processInvoiceFile(file) {
            invoiceFileName = file.name;
            const nameEl = document.getElementById('invoice-file-name');
            const generateBtn = document.getElementById('invoice-generate-btn');
            if (nameEl) nameEl.textContent = 'Loaded: ' + file.name;

            const ext = file.name.split('.').pop().toLowerCase();
            const isImage = ['png','jpg','jpeg','webp'].includes(ext);

            const reader = new FileReader();
            reader.onload = function(ev) {
                if (isImage) {
                    invoiceFileContent = '[IMAGE INVOICE: ' + file.name + ' (' + Math.round(file.size/1024) + ' KB) - user uploaded an invoice image from their billing software. Generate the follow-up email based on the escalation level and any context provided.]';
                } else if (ext === 'pdf') {
                    invoiceFileContent = '[PDF INVOICE: ' + file.name + '] ' + (ev.target.result || '').substring(0, 8000);
                } else {
                    invoiceFileContent = '[INVOICE FILE: ' + file.name + '] ' + (ev.target.result || '').substring(0, 12000);
                }
                if (generateBtn) generateBtn.disabled = false;
            };
            reader.onerror = function() {
                if (nameEl) nameEl.textContent = 'Error reading file. Try a CSV or TXT export.';
            };
            if (isImage) {
                reader.readAsDataURL(file);
            } else {
                reader.readAsText(file);
            }
        }

        async function generateInvoiceFollowup() {
            if (!invoiceFileContent) { alert('Please upload an invoice file first.'); return; }

            const days = parseInt(document.getElementById('invoice-days-input')?.value, 10);
            const notes = document.getElementById('invoice-notes-input')?.value.trim() || '';
            const outputEl = document.getElementById('invoice-output');
            const outputBody = document.getElementById('invoice-output-body');
            const generateBtn = document.getElementById('invoice-generate-btn');

            const level = isNaN(days) ? ESCALATION_LEVELS[0] : getEscalationLevel(days);

            if (outputEl) outputEl.classList.add('visible');
            if (outputBody) { outputBody.style.display = 'none'; outputBody.textContent = ''; }

            // Show thinking
            let thinkingEl = document.getElementById('invoice-thinking');
            if (!thinkingEl) {
                thinkingEl = document.createElement('div');
                thinkingEl.className = 'tool-output-thinking';
                thinkingEl.id = 'invoice-thinking';
                thinkingEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Generating email...';
                outputEl.appendChild(thinkingEl);
            } else { thinkingEl.style.display = 'flex'; }

            if (generateBtn) generateBtn.disabled = true;

            try {
                const customPrompt = localStorage.getItem('invoice_system_prompt') || '';
                const res = await fetch('/generate-invoice-followup', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (getAuthToken() || '') },
                    body: JSON.stringify({ invoiceContent: invoiceFileContent, fileName: invoiceFileName, daysOverdue: isNaN(days) ? 0 : days, escalationTone: level.tone, additionalNotes: notes, customSystemPrompt: customPrompt })
                });
                thinkingEl.style.display = 'none';
                if (outputBody) outputBody.style.display = '';
                if (res.status === 401) { clearAuthToken(); return; }
                const data = await res.json();
                if (!res.ok) throw new Error(data.message || data.error || 'Generation failed');
                if (outputBody) outputBody.textContent = data.response;
            } catch(err) {
                if (thinkingEl) thinkingEl.style.display = 'none';
                if (outputBody) { outputBody.style.display = ''; outputBody.innerHTML = '<span style="color:var(--red)">Error: ' + (err.message || 'Unknown error') + '</span>'; }
            } finally {
                if (generateBtn) generateBtn.disabled = false;
            }
        }

        function saveInvoicePrompt() {
            const prompt = document.getElementById('invoice-system-prompt')?.value || '';
            localStorage.setItem('invoice_system_prompt', prompt);
            showSettingsToast('Invoice prompt saved');
        }

        // ============================================
        // ADJUSTER FOLLOW-UP TOOL
        // ============================================

        async function generateAdjusterFollowup() {
            const name        = document.getElementById('adj-name-input')?.value.trim() || '';
            const company     = document.getElementById('adj-company-input')?.value.trim() || '';
            const claim       = document.getElementById('adj-claim-input')?.value.trim() || '';
            const lastContact = document.getElementById('adj-lastcontact-input')?.value || '';
            const status      = document.getElementById('adj-status-input')?.value.trim() || '';

            if (!name && !claim) { alert('Please enter at least the adjuster name or claim number.'); return; }

            const outputEl   = document.getElementById('adjuster-output');
            const outputBody = document.getElementById('adjuster-output-body');
            const generateBtn= document.getElementById('adj-generate-btn');

            if (outputEl) outputEl.classList.add('visible');
            if (outputBody) { outputBody.style.display = 'none'; outputBody.textContent = ''; }

            let thinkingEl = document.getElementById('adj-thinking');
            if (!thinkingEl) {
                thinkingEl = document.createElement('div');
                thinkingEl.className = 'tool-output-thinking';
                thinkingEl.id = 'adj-thinking';
                thinkingEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Generating email...';
                outputEl.appendChild(thinkingEl);
            } else { thinkingEl.style.display = 'flex'; }

            if (generateBtn) generateBtn.disabled = true;

            try {
                const customPrompt = localStorage.getItem('adjuster_system_prompt') || '';
                const res = await fetch('/generate-adjuster-followup', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (getAuthToken() || '') },
                    body: JSON.stringify({ adjusterName: name, company, claimNumber: claim, lastContactDate: lastContact, statusNotes: status, customSystemPrompt: customPrompt })
                });
                thinkingEl.style.display = 'none';
                if (outputBody) outputBody.style.display = '';
                if (res.status === 401) { clearAuthToken(); return; }
                const data = await res.json();
                if (!res.ok) throw new Error(data.message || data.error || 'Generation failed');
                if (outputBody) outputBody.textContent = data.response;
            } catch(err) {
                if (thinkingEl) thinkingEl.style.display = 'none';
                if (outputBody) { outputBody.style.display = ''; outputBody.innerHTML = '<span style="color:var(--red)">Error: ' + (err.message || 'Unknown error') + '</span>'; }
            } finally {
                if (generateBtn) generateBtn.disabled = false;
            }
        }

        function saveAdjusterPrompt() {
            const prompt = document.getElementById('adjuster-system-prompt')?.value || '';
            localStorage.setItem('adjuster_system_prompt', prompt);
            showSettingsToast('Adjuster prompt saved');
        }

        // ============================================
        // SHARED TOOL UTILITIES
        // ============================================

        // ============================================
        // ESTIMATE GENERATOR
        // ============================================
        var estimateRows = [];

        function addEstimateRow(desc, qty, price) {
            var id = Date.now() + Math.random();
            estimateRows.push({ id: id, desc: desc || '', qty: qty || 1, price: price || 0 });
            renderEstimateRows();
        }

        function renderEstimateRows() {
            var tbody = document.getElementById('est-line-body');
            if (!tbody) return;
            tbody.innerHTML = '';
            estimateRows.forEach(function(row) {
                var total = (parseFloat(row.qty) || 0) * (parseFloat(row.price) || 0);
                var tr = document.createElement('tr');
                tr.innerHTML = '<td><input type="text" value="' + escapeAttr(row.desc) + '" placeholder="Item description" oninput="updateEstimateRow(' + row.id + ', \'desc\', this.value)"></td>' +
                    '<td><input type="number" value="' + row.qty + '" min="0" step="0.01" style="width:60px" oninput="updateEstimateRow(' + row.id + ', \'qty\', this.value)"></td>' +
                    '<td><input type="number" value="' + row.price + '" min="0" step="0.01" style="width:80px" oninput="updateEstimateRow(' + row.id + ', \'price\', this.value)"></td>' +
                    '<td style="font-family:var(--mono)">$' + total.toFixed(2) + '</td>' +
                    '<td><button class="del-row-btn" onclick="deleteEstimateRow(' + row.id + ')">x</button></td>';
                tbody.appendChild(tr);
            });
            updateEstimateTotal();
        }

        function updateEstimateRow(id, field, value) {
            var row = estimateRows.find(function(r) { return r.id === id; });
            if (row) { row[field] = value; }
            updateEstimateTotal();
            var tbody = document.getElementById('est-line-body');
            if (!tbody) return;
            var rows = tbody.querySelectorAll('tr');
            var idx = estimateRows.findIndex(function(r) { return r.id === id; });
            if (rows[idx]) {
                var total = (parseFloat(row.qty) || 0) * (parseFloat(row.price) || 0);
                var cells = rows[idx].querySelectorAll('td');
                if (cells[3]) cells[3].textContent = '$' + total.toFixed(2);
            }
        }

        function deleteEstimateRow(id) {
            estimateRows = estimateRows.filter(function(r) { return r.id !== id; });
            renderEstimateRows();
        }

        function updateEstimateTotal() {
            var subtotal = estimateRows.reduce(function(sum, r) {
                return sum + (parseFloat(r.qty) || 0) * (parseFloat(r.price) || 0);
            }, 0);
            var taxPct = parseFloat(document.getElementById('est-tax-pct') && document.getElementById('est-tax-pct').value) || 0;
            var taxAmt = subtotal * taxPct / 100;
            var grand = subtotal + taxAmt;
            if (document.getElementById('est-subtotal')) document.getElementById('est-subtotal').textContent = '$' + subtotal.toFixed(2);
            if (document.getElementById('est-tax-amt')) document.getElementById('est-tax-amt').textContent = '$' + taxAmt.toFixed(2);
            if (document.getElementById('est-grand-total')) document.getElementById('est-grand-total').textContent = '$' + grand.toFixed(2);
        }

        function escapeAttr(str) {
            return String(str || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        }

        async function generateEstimate() {
            var client = (document.getElementById('est-client') || {}).value || '';
            var project = (document.getElementById('est-project') || {}).value || '';
            var address = (document.getElementById('est-address') || {}).value || '';
            var startDate = (document.getElementById('est-start') || {}).value || '';
            var scope = (document.getElementById('est-scope') || {}).value || '';
            var notes = (document.getElementById('est-notes') || {}).value || '';
            var taxPct = (document.getElementById('est-tax-pct') || {}).value || '0';
            var lineItems = estimateRows.map(function(r) {
                var total = (parseFloat(r.qty) || 0) * (parseFloat(r.price) || 0);
                return r.desc + ' | Qty: ' + r.qty + ' | Unit: $' + parseFloat(r.price).toFixed(2) + ' | Total: $' + total.toFixed(2);
            }).join('\n');
            var subtotal = estimateRows.reduce(function(s,r){ return s + (parseFloat(r.qty)||0)*(parseFloat(r.price)||0); }, 0);
            var taxAmt = subtotal * parseFloat(taxPct) / 100;
            var customPrompt = localStorage.getItem('estimate_system_prompt') || '';
            var token = getAuthToken();
            if (!token) { alert('Please log in first.'); return; }
            var outDiv = document.getElementById('est-output');
            var outBody = document.getElementById('est-output-body');
            if (outDiv) outDiv.style.display = '';
            if (outBody) outBody.innerHTML = '<div class="tool-output-thinking"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4"/></svg> Generating estimate...</div>';
            try {
                var resp = await fetch('/generate-estimate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ clientName: client, projectName: project, address: address, startDate: startDate, scope: scope, lineItems: lineItems, subtotal: subtotal.toFixed(2), taxPct: taxPct, taxAmount: taxAmt.toFixed(2), grandTotal: (subtotal + taxAmt).toFixed(2), additionalNotes: notes, customSystemPrompt: customPrompt })
                });
                var data = await resp.json();
                if (outBody) outBody.textContent = data.response || data.error || 'Unknown error';
            } catch(e) {
                if (outBody) outBody.textContent = 'Error: ' + e.message;
            }
        }

        function saveEstimatePrompt() {
            var val = (document.getElementById('estimate-system-prompt') || {}).value || '';
            localStorage.setItem('estimate_system_prompt', val);
            if (typeof showSettingsToast === 'function') showSettingsToast('Estimate prompt saved');
        }

        // ============================================
        // CHANGE ORDER
        // ============================================
        async function generateChangeOrder() {
            var client = (document.getElementById('co-client') || {}).value || '';
            var contract = (document.getElementById('co-contract') || {}).value || '';
            var number = (document.getElementById('co-number') || {}).value || '';
            var status = (document.getElementById('co-status') || {}).value || 'pending';
            var reason = (document.getElementById('co-reason') || {}).value || '';
            var scope = (document.getElementById('co-scope') || {}).value || '';
            var cost = (document.getElementById('co-cost') || {}).value || '0';
            var days = (document.getElementById('co-days') || {}).value || '0';
            var customPrompt = localStorage.getItem('changeorder_system_prompt') || '';
            var token = getAuthToken();
            if (!token) { alert('Please log in first.'); return; }
            var outDiv = document.getElementById('co-output');
            var outBody = document.getElementById('co-output-body');
            if (outDiv) outDiv.style.display = '';
            if (outBody) outBody.innerHTML = '<div class="tool-output-thinking"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4"/></svg> Generating change order...</div>';
            try {
                var resp = await fetch('/generate-change-order', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ clientName: client, contractNumber: contract, changeOrderNumber: number, status: status, reason: reason, scopeChanges: scope, costImpact: cost, scheduleDays: days, customSystemPrompt: customPrompt })
                });
                var data = await resp.json();
                if (outBody) outBody.textContent = data.response || data.error || 'Unknown error';
            } catch(e) {
                if (outBody) outBody.textContent = 'Error: ' + e.message;
            }
        }

        function saveChangeOrderPrompt() {
            var val = (document.getElementById('changeorder-system-prompt') || {}).value || '';
            localStorage.setItem('changeorder_system_prompt', val);
            if (typeof showSettingsToast === 'function') showSettingsToast('Change order prompt saved');
        }

        // ============================================
        // SUBCONTRACTOR MANAGEMENT
        // ============================================
        var subList = [];

        function loadSubs() {
            try { subList = JSON.parse(localStorage.getItem('sub_list') || '[]'); } catch(e) { subList = []; }
            renderSubTable();
        }

        function saveSubs() {
            localStorage.setItem('sub_list', JSON.stringify(subList));
        }

        function toggleSubAddForm() {
            var form = document.getElementById('sub-add-form');
            if (!form) return;
            if (form.classList.contains('visible')) {
                form.classList.remove('visible');
            } else {
                form.classList.add('visible');
                ['sub-name','sub-trade','sub-phone','sub-email','sub-license','sub-ins-exp','sub-rate','sub-notes'].forEach(function(id) {
                    var el = document.getElementById(id);
                    if (el) el.value = '';
                });
            }
        }

        function saveSub() {
            var name = (document.getElementById('sub-name') || {}).value || '';
            if (!name.trim()) { alert('Name is required'); return; }
            var sub = {
                id: Date.now(),
                name: name,
                trade: (document.getElementById('sub-trade') || {}).value || '',
                phone: (document.getElementById('sub-phone') || {}).value || '',
                email: (document.getElementById('sub-email') || {}).value || '',
                license: (document.getElementById('sub-license') || {}).value || '',
                insExp: (document.getElementById('sub-ins-exp') || {}).value || '',
                rate: (document.getElementById('sub-rate') || {}).value || '',
                notes: (document.getElementById('sub-notes') || {}).value || '',
                active: true
            };
            subList.push(sub);
            saveSubs();
            renderSubTable();
            toggleSubAddForm();
        }

        function deleteSub(id) {
            if (!confirm('Remove this subcontractor?')) return;
            subList = subList.filter(function(s) { return s.id !== id; });
            saveSubs();
            renderSubTable();
        }

        function toggleSubStatus(id) {
            var sub = subList.find(function(s) { return s.id === id; });
            if (sub) { sub.active = !sub.active; saveSubs(); renderSubTable(); }
        }

        function renderSubTable() {
            var tbody = document.getElementById('sub-table-body');
            var counter = document.getElementById('sub-count');
            if (!tbody) return;
            if (counter) counter.textContent = subList.length;
            if (subList.length === 0) {
                tbody.innerHTML = '<tr id="sub-empty-row"><td colspan="7" style="text-align:center;color:var(--text-dim);font-family:var(--mono);font-size:12px;padding:28px;">No subcontractors added yet</td></tr>';
                return;
            }
            tbody.innerHTML = '';
            subList.forEach(function(sub) {
                var insExpired = sub.insExp && new Date(sub.insExp) < new Date();
                var tr = document.createElement('tr');
                tr.innerHTML = '<td><strong style="color:var(--text)">' + escapeAttr(sub.name) + '</strong>' + (sub.notes ? '<br><span style="font-size:11px;color:var(--text-dim)">' + escapeAttr(sub.notes) + '</span>' : '') + '</td>' +
                    '<td style="font-family:var(--mono);font-size:12px;">' + escapeAttr(sub.trade) + '</td>' +
                    '<td style="font-family:var(--mono);font-size:12px;white-space:nowrap;">' + escapeAttr(sub.phone) + '</td>' +
                    '<td style="font-family:var(--mono);font-size:12px;' + (insExpired ? 'color:var(--red)' : '') + '">' + (sub.insExp || '-') + (insExpired ? ' &#9888;' : '') + '</td>' +
                    '<td style="font-family:var(--mono);font-size:12px;">' + (sub.rate ? '$' + sub.rate + '/hr' : '-') + '</td>' +
                    '<td><span class="sub-status ' + (sub.active ? 'sub-status-active' : 'sub-status-inactive') + '">' + (sub.active ? 'Active' : 'Inactive') + '</span></td>' +
                    '<td><button class="sub-action-btn" onclick="toggleSubStatus(' + sub.id + ')">' + (sub.active ? 'Deactivate' : 'Activate') + '</button><button class="sub-action-btn danger" onclick="deleteSub(' + sub.id + ')">Delete</button></td>';
                tbody.appendChild(tr);
            });
        }

        // ============================================
        // MATERIALS CHECKLIST
        // ============================================
        var matList = [];

        function loadMaterials() {
            try { matList = JSON.parse(localStorage.getItem('mat_list') || '[]'); } catch(e) { matList = []; }
            renderMatList();
        }

        function saveMaterials() {
            localStorage.setItem('mat_list', JSON.stringify(matList));
        }

        function addMaterialItem() {
            var input = document.getElementById('mat-item-input');
            var catSel = document.getElementById('mat-cat-select');
            if (!input) return;
            var name = input.value.trim();
            if (!name) return;
            matList.push({ id: Date.now(), name: name, cat: catSel ? catSel.value : 'Other', checked: false });
            input.value = '';
            saveMaterials();
            renderMatList();
        }

        function toggleMaterialItem(id) {
            var item = matList.find(function(m) { return m.id === id; });
            if (item) { item.checked = !item.checked; saveMaterials(); renderMatList(); }
        }

        function deleteMaterialItem(id) {
            matList = matList.filter(function(m) { return m.id !== id; });
            saveMaterials();
            renderMatList();
        }

        function clearCheckedMaterials() {
            matList = matList.filter(function(m) { return !m.checked; });
            saveMaterials();
            renderMatList();
        }

        function clearAllMaterials() {
            if (!confirm('Clear all items?')) return;
            matList = [];
            saveMaterials();
            renderMatList();
        }

        function renderMatList() {
            var listEl = document.getElementById('mat-list');
            if (!listEl) return;
            var checked = matList.filter(function(m) { return m.checked; }).length;
            var total = matList.length;
            var pct = total > 0 ? Math.round(checked / total * 100) : 0;
            var lbl = document.getElementById('mat-progress-label');
            var fill = document.getElementById('mat-progress-fill');
            if (lbl) lbl.textContent = checked + ' of ' + total + ' items checked';
            if (fill) fill.style.width = pct + '%';
            listEl.innerHTML = '';
            if (matList.length === 0) {
                listEl.innerHTML = '<div style="color:var(--text-dim);font-family:var(--mono);font-size:12px;text-align:center;padding:28px;">No items yet</div>';
                return;
            }
            matList.forEach(function(item) {
                var div = document.createElement('div');
                div.className = 'mat-item' + (item.checked ? ' checked' : '');
                div.innerHTML = '<input type="checkbox"' + (item.checked ? ' checked' : '') + ' onchange="toggleMaterialItem(' + item.id + ')">' +
                    '<span class="mat-item-name">' + escapeAttr(item.name) + '</span>' +
                    '<span class="mat-item-cat">' + escapeAttr(item.cat) + '</span>' +
                    '<button class="mat-item-del" onclick="deleteMaterialItem(' + item.id + ')">x</button>';
                listEl.appendChild(div);
            });
        }

        // ============================================
        // PHOTO LOG
        // ============================================
        var photoLog = [];

        function photoHandleDragOver(e) {
            e.preventDefault();
            var dz = document.getElementById('photo-drop-zone');
            if (dz) dz.classList.add('drag-over');
        }

        function photoHandleDragLeave(e) {
            var dz = document.getElementById('photo-drop-zone');
            if (dz) dz.classList.remove('drag-over');
        }

        function photoHandleDrop(e) {
            e.preventDefault();
            var dz = document.getElementById('photo-drop-zone');
            if (dz) dz.classList.remove('drag-over');
            var files = Array.from(e.dataTransfer.files).filter(function(f) { return f.type.startsWith('image/'); });
            files.forEach(addPhotoToLog);
        }

        function photoHandleFileSelect(e) {
            Array.from(e.target.files).forEach(addPhotoToLog);
            e.target.value = '';
        }

        function addPhotoToLog(file) {
            var url = URL.createObjectURL(file);
            var tag = (document.getElementById('photo-job-tag') || {}).value || '';
            photoLog.push({ id: Date.now() + Math.random(), url: url, name: file.name, tag: tag, time: new Date().toLocaleString() });
            renderPhotoGrid();
        }

        function clearAllPhotos() {
            if (photoLog.length === 0) return;
            if (!confirm('Clear all photos from this session?')) return;
            photoLog.forEach(function(p) { try { URL.revokeObjectURL(p.url); } catch(e) {} });
            photoLog = [];
            renderPhotoGrid();
        }

        function renderPhotoGrid() {
            var grid = document.getElementById('photo-grid');
            var empty = document.getElementById('photo-empty');
            var counter = document.getElementById('photo-count');
            if (!grid) return;
            if (counter) counter.textContent = photoLog.length;
            if (photoLog.length === 0) {
                grid.innerHTML = '<div class="photo-empty" id="photo-empty" style="grid-column:1/-1;">No photos added yet</div>';
                return;
            }
            grid.innerHTML = '';
            photoLog.forEach(function(photo) {
                var card = document.createElement('div');
                card.className = 'photo-card';
                card.onclick = function() { openPhotoLightbox(photo); };
                card.innerHTML = '<img src="' + photo.url + '" alt="' + escapeAttr(photo.name) + '" loading="lazy"><div class="photo-card-label">' + escapeAttr(photo.name) + '</div>';
                grid.appendChild(card);
            });
        }

        function openPhotoLightbox(photo) {
            var existing = document.getElementById('photo-lightbox-overlay');
            if (existing) existing.remove();
            var lb = document.createElement('div');
            lb.className = 'photo-lightbox';
            lb.id = 'photo-lightbox-overlay';
            lb.innerHTML = '<button class="photo-lightbox-close" onclick="this.closest(\'.photo-lightbox\').remove()">&times;</button>' +
                '<img src="' + photo.url + '" alt="' + escapeAttr(photo.name) + '">' +
                '<div class="photo-lightbox-caption">' + escapeAttr(photo.name) + (photo.tag ? ' &bull; ' + escapeAttr(photo.tag) : '') + ' &bull; ' + escapeAttr(photo.time) + '</div>';
            lb.onclick = function(e) { if (e.target === lb) lb.remove(); };
            document.body.appendChild(lb);
        }

        // ============================================
        // SAFETY CHECKLIST
        // ============================================
        var safetyData = {
            categories: [
                { id: 'ppe', title: 'PPE & Personal Safety', open: true, items: [
                    'Hard hats worn by all personnel on site',
                    'Safety vests / high-visibility clothing worn',
                    'Safety glasses or goggles in use where required',
                    'Gloves appropriate for the task being performed',
                    'Steel-toed boots worn by all workers',
                    'Hearing protection available and used near loud equipment',
                    'Fall protection harnesses inspected and in use above 6 ft'
                ]},
                { id: 'tools', title: 'Tools & Equipment', open: false, items: [
                    'All power tools inspected before use',
                    'Guards in place on grinders, saws, and rotating equipment',
                    'Extension cords in good condition (no frays or exposed wire)',
                    'GFCI protection used for all electrical equipment outdoors',
                    'Ladders in good condition and properly secured',
                    'Scaffolding erected and inspected by competent person',
                    'Heavy equipment (excavators, lifts) operated by trained personnel only'
                ]},
                { id: 'site', title: 'Site Conditions', open: false, items: [
                    'Site is clean and free of unnecessary clutter and debris',
                    'Walkways and access routes clear of obstructions',
                    'Adequate lighting in all work areas',
                    'Barricades / signage in place around hazard zones',
                    'Trenches and excavations properly shored or sloped',
                    'Materials stacked and stored safely',
                    'Spill containment in place for fuels and chemicals'
                ]},
                { id: 'fire', title: 'Fire & Emergency', open: false, items: [
                    'Fire extinguishers accessible and inspected',
                    'Hot work permit obtained for welding / cutting',
                    'Emergency contact list posted on site',
                    'First aid kit stocked and accessible',
                    'Emergency evacuation route identified and communicated',
                    'No smoking policy enforced in designated areas'
                ]},
                { id: 'hazmat', title: 'Hazardous Materials', open: false, items: [
                    'SDS (Safety Data Sheets) available for all chemicals on site',
                    'Chemicals stored in labeled, sealed containers',
                    'Asbestos / lead paint survey completed before demolition',
                    'Silica dust controls in place for cutting concrete or masonry',
                    'Waste disposed of per local regulations'
                ]},
                { id: 'admin', title: 'Administrative', open: false, items: [
                    'Daily toolbox talk / safety briefing conducted',
                    'OSHA 10/30 certifications current for required personnel',
                    'Incident log up to date',
                    'Subcontractor safety plans reviewed',
                    'Building permits posted and visible',
                    'Competent person designated for site safety'
                ]}
            ],
            checks: {}
        };

        function initSafetyChecklist() {
            var dateEl = document.getElementById('safety-date');
            if (dateEl && !dateEl.value) dateEl.value = new Date().toISOString().slice(0,10);
            renderSafetyCategories();
            updateSafetyProgress();
        }

        function renderSafetyCategories() {
            var container = document.getElementById('safety-categories');
            if (!container) return;
            container.innerHTML = '';
            safetyData.categories.forEach(function(cat) {
                var checkedCount = cat.items.filter(function(item, idx) { return safetyData.checks[cat.id + '_' + idx]; }).length;
                var div = document.createElement('div');
                div.className = 'safety-category' + (cat.open ? ' open' : '');
                div.id = 'safety-cat-' + cat.id;
                var itemsHtml = cat.items.map(function(item, idx) {
                    var key = cat.id + '_' + idx;
                    var isChecked = !!safetyData.checks[key];
                    return '<div class="safety-item' + (isChecked ? ' checked' : '') + '" id="safety-item-' + key + '">' +
                        '<input type="checkbox"' + (isChecked ? ' checked' : '') + ' onchange="toggleSafetyItem(\'' + cat.id + '\',' + idx + ',this.checked)">' +
                        '<span class="safety-item-text">' + escapeAttr(item) + '</span></div>';
                }).join('');
                div.innerHTML = '<div class="safety-category-header" onclick="toggleSafetyCat(\'' + cat.id + '\')">' +
                    '<span class="safety-cat-title">' + escapeAttr(cat.title) + '</span>' +
                    '<span class="safety-cat-count">' + checkedCount + '/' + cat.items.length + '</span>' +
                    '<span class="safety-cat-chevron">&#9660;</span></div>' +
                    '<div class="safety-items">' + itemsHtml + '</div>';
                container.appendChild(div);
            });
        }

        function toggleSafetyCat(catId) {
            var el = document.getElementById('safety-cat-' + catId);
            if (el) el.classList.toggle('open');
            var cat = safetyData.categories.find(function(c) { return c.id === catId; });
            if (cat) cat.open = el ? el.classList.contains('open') : false;
        }

        function toggleSafetyItem(catId, idx, checked) {
            var key = catId + '_' + idx;
            safetyData.checks[key] = checked;
            var itemEl = document.getElementById('safety-item-' + key);
            if (itemEl) { if (checked) itemEl.classList.add('checked'); else itemEl.classList.remove('checked'); }
            var cat = safetyData.categories.find(function(c) { return c.id === catId; });
            if (cat) {
                var catEl = document.getElementById('safety-cat-' + catId);
                if (catEl) {
                    var countEl = catEl.querySelector('.safety-cat-count');
                    if (countEl) {
                        var checkedCount = cat.items.filter(function(item, i) { return safetyData.checks[catId + '_' + i]; }).length;
                        countEl.textContent = checkedCount + '/' + cat.items.length;
                    }
                }
            }
            updateSafetyProgress();
        }

        function updateSafetyProgress() {
            var total = 0, checked = 0;
            safetyData.categories.forEach(function(cat) {
                total += cat.items.length;
                cat.items.forEach(function(item, idx) { if (safetyData.checks[cat.id + '_' + idx]) checked++; });
            });
            var pct = total > 0 ? Math.round(checked / total * 100) : 0;
            var lbl = document.getElementById('safety-progress-label');
            var fill = document.getElementById('safety-progress-fill');
            if (lbl) lbl.textContent = checked + ' of ' + total + ' items checked (' + pct + '%)';
            if (fill) fill.style.width = pct + '%';
        }

        function resetSafetyChecklist() {
            if (!confirm('Reset all checklist items?')) return;
            safetyData.checks = {};
            renderSafetyCategories();
            updateSafetyProgress();
        }

        function saveSafetyLog() {
            var date = (document.getElementById('safety-date') || {}).value || new Date().toISOString().slice(0,10);
            var site = (document.getElementById('safety-site') || {}).value || '';
            var inspector = (document.getElementById('safety-inspector') || {}).value || '';
            var total = 0, checked = 0;
            safetyData.categories.forEach(function(cat) {
                total += cat.items.length;
                cat.items.forEach(function(item, idx) { if (safetyData.checks[cat.id + '_' + idx]) checked++; });
            });
            var pct = total > 0 ? Math.round(checked / total * 100) : 0;
            var logs = [];
            try { logs = JSON.parse(localStorage.getItem('safety_logs') || '[]'); } catch(e) { logs = []; }
            logs.unshift({ date: date, site: site, inspector: inspector, score: pct, checked: checked, total: total, savedAt: new Date().toLocaleString() });
            if (logs.length > 50) logs = logs.slice(0, 50);
            localStorage.setItem('safety_logs', JSON.stringify(logs));
            if (typeof showSettingsToast === 'function') showSettingsToast('Inspection log saved (' + pct + '% complete)');
            renderSafetyLogs();
        }

        function toggleSafetyLogs() {
            var panel = document.getElementById('safety-logs-panel');
            if (!panel) return;
            if (panel.style.display === 'none') {
                panel.style.display = '';
                renderSafetyLogs();
            } else {
                panel.style.display = 'none';
            }
        }

        function renderSafetyLogs() {
            var list = document.getElementById('safety-logs-list');
            if (!list) return;
            var logs = [];
            try { logs = JSON.parse(localStorage.getItem('safety_logs') || '[]'); } catch(e) { logs = []; }
            if (logs.length === 0) {
                list.innerHTML = '<div style="color:var(--text-dim);font-family:var(--mono);font-size:12px;padding:12px 0;">No saved logs yet</div>';
                return;
            }
            list.innerHTML = logs.map(function(log) {
                var color = log.score >= 90 ? 'var(--green)' : log.score >= 70 ? 'var(--orange)' : 'var(--red)';
                return '<div class="safety-log-entry"><span class="safety-log-date">' + escapeAttr(log.date) + '</span>' +
                    '<span style="color:var(--text-mid)">' + escapeAttr(log.site || 'No site') + '</span>' +
                    '<span style="color:var(--text-dim)">' + escapeAttr(log.inspector || '') + '</span>' +
                    '<span class="safety-log-score" style="color:' + color + ';font-weight:700">' + log.score + '% (' + log.checked + '/' + log.total + ')</span>' +
                    '<span style="color:var(--text-dim);font-size:10px;">' + escapeAttr(log.savedAt || '') + '</span></div>';
            }).join('');
        }

        // ============================================
        // HOOK INTO EXISTING showToolView + openSettings
        // ============================================
        var _origShowToolView = typeof showToolView === 'function' ? showToolView : null;
        // Initialize tool-specific state when tool is opened
        var _toolInitDone = {};
        function _onToolViewShown(viewId) {
            if (viewId === 'subs' && !_toolInitDone.subs) { _toolInitDone.subs = true; loadSubs(); }
            if (viewId === 'materials' && !_toolInitDone.materials) { _toolInitDone.materials = true; loadMaterials(); }
            if (viewId === 'photos' && !_toolInitDone.photos) { _toolInitDone.photos = true; renderPhotoGrid(); }
            if (viewId === 'safety' && !_toolInitDone.safety) { _toolInitDone.safety = true; initSafetyChecklist(); }
            if (viewId === 'estimate' && !_toolInitDone.estimate) { _toolInitDone.estimate = true; if (estimateRows.length === 0) addEstimateRow('', 1, 0); }
        }

        // Patch showToolView to call _onToolViewShown after showing
        (function() {
            var orig = showToolView;
            showToolView = function(viewId) {
                orig(viewId);
                if (viewId) _onToolViewShown(viewId);
            };
        })();

        // Patch openSettings to populate new prompts from localStorage
        (function() {
            var origOpen = openSettings;
            openSettings = function() {
                origOpen.apply(this, arguments);
                var estEl = document.getElementById('estimate-system-prompt');
                if (estEl) estEl.value = localStorage.getItem('estimate_system_prompt') || '';
                var coEl = document.getElementById('changeorder-system-prompt');
                if (coEl) coEl.value = localStorage.getItem('changeorder_system_prompt') || '';
            };
        })();

        function copyToolOutput(elementId) {
            const el = document.getElementById(elementId);
            if (!el) return;
            const text = el.textContent || '';
            if (navigator.clipboard) {
                navigator.clipboard.writeText(text).then(() => showSettingsToast('Copied to clipboard')).catch(() => fallbackCopy(text));
            } else { fallbackCopy(text); }
        }

        function fallbackCopy(text) {
            const ta = document.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); showSettingsToast('Copied to clipboard'); } catch(e) {}
            ta.remove();
        }
    </script>
</body>
</html>`);
});

/**
 * Public chat endpoint for frontend (no auth required)
 * POST /chat
 * Body: { prompt: string, ai?: 'gemini'|'openclaw', openclawUrl?: string, openclawToken?: string }
 */
// ============================================
// LOGIN ENDPOINT
// ============================================

app.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  const user = username.trim().toLowerCase();

  // 1. Check file-based approved users (scrypt hashed)
  const fileUser = userStore.users.find(u => u.username === user);
  if (fileUser) {
    if (!verifyPassword(password, fileUser.passwordHash)) {
      log('WARN', `Failed login for: ${user}`, req.id, { ip: req.ip });
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const token = createLoginToken(user);
    log('INFO', `Successful login (file): ${user}`, req.id);
    return res.json({ success: true, token, username: user });
  }

  // 2. Check pending requests — tell them to wait for admin approval
  if (userStore.pending.some(u => u.username === user)) {
    return res.status(403).json({ error: 'Your account is pending admin approval. Please wait.' });
  }

  // 3. Fallback: USERS_MAP (env var accounts)
  let authenticated = false;
  if (USERS_MAP.has('__fallback__')) {
    // Fallback mode: any username, password must equal API_KEY
    authenticated = (password === USERS_MAP.get('__fallback__'));
  } else {
    const storedPass = USERS_MAP.get(user);
    if (storedPass !== undefined) {
      try {
        authenticated = crypto.timingSafeEqual(Buffer.from(password), Buffer.from(storedPass));
      } catch { authenticated = false; }
    }
  }
  if (!authenticated) {
    log('WARN', `Failed login attempt for: ${user}`, req.id, { ip: req.ip });
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const token = createLoginToken(user);
  log('INFO', `Successful login (env): ${user}`, req.id);
  res.json({ success: true, token, username: user });
});

// ============================================
// SIGNUP ENDPOINT
// ============================================

app.post('/signup', signupLimiter, (req, res) => {
  const { username, password, email } = req.body || {};
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  const user = username.trim().toLowerCase();

  if (!/^[a-z0-9_]{3,20}$/.test(user)) {
    return res.status(400).json({ error: 'Username must be 3–20 characters: letters, numbers, underscores only' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  // Reject duplicate usernames across all stores
  if (userStore.users.some(u => u.username === user) ||
      userStore.pending.some(u => u.username === user) ||
      USERS_MAP.has(user)) {
    return res.status(409).json({ error: 'Username is already taken or pending review' });
  }

  const entry = { username: user, passwordHash: hashPassword(password), createdAt: Date.now(), role: 'user' };
  if (email && typeof email === 'string') entry.email = email.trim().toLowerCase().slice(0, 200);

  userStore.users.push(entry);
  saveUserStore();
  log('INFO', `Signup: new account created: ${user}`, req.id);
  res.json({ success: true, message: 'Account created! You can now sign in.' });
});

// ============================================
// ADMIN ENDPOINTS (X-Admin-Key: <API_KEY>)
// ============================================

function requireAdminKey(req, res, next) {
  const key = req.get('X-Admin-Key') || req.query.key;
  if (!key || key !== API_KEY) return res.status(401).json({ error: 'Admin access required' });
  next();
}

// List pending signup requests
app.get('/admin/pending', requireAdminKey, (req, res) => {
  res.json({ pending: userStore.pending.map(u => ({
    username: u.username, email: u.email || null, requestedAt: u.requestedAt
  }))});
});

// Approve a pending user
app.post('/admin/approve', requireAdminKey, (req, res) => {
  const user = (req.body?.username || '').trim().toLowerCase();
  if (!user) return res.status(400).json({ error: 'Username required' });
  const idx = userStore.pending.findIndex(u => u.username === user);
  if (idx === -1) return res.status(404).json({ error: 'No pending request for that username' });
  const [entry] = userStore.pending.splice(idx, 1);
  userStore.users.push({ username: entry.username, passwordHash: entry.passwordHash, createdAt: Date.now() });
  saveUserStore();
  log('INFO', `Admin approved: ${user}`, req.id);
  res.json({ success: true, message: `${user} approved` });
});

// Reject a pending user
app.post('/admin/reject', requireAdminKey, (req, res) => {
  const user = (req.body?.username || '').trim().toLowerCase();
  if (!user) return res.status(400).json({ error: 'Username required' });
  const idx = userStore.pending.findIndex(u => u.username === user);
  if (idx === -1) return res.status(404).json({ error: 'No pending request for that username' });
  userStore.pending.splice(idx, 1);
  saveUserStore();
  log('INFO', `Admin rejected: ${user}`, req.id);
  res.json({ success: true, message: `${user} rejected` });
});

// Delete an approved user
app.post('/admin/delete-user', requireAdminKey, (req, res) => {
  const user = (req.body?.username || '').trim().toLowerCase();
  if (!user) return res.status(400).json({ error: 'Username required' });
  const idx = userStore.users.findIndex(u => u.username === user);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  userStore.users.splice(idx, 1);
  saveUserStore();
  log('INFO', `Admin deleted user: ${user}`, req.id);
  res.json({ success: true, message: `${user} deleted` });
});

// ============================================
// CHAT ENDPOINT (login-protected)
// ============================================

app.post('/chat', requireLogin, async (req, res) => {
  const requestId = req.id;

  try {
    const { prompt, ai: forceAI, openclawUrl, openclawToken } = req.body;

    // Input validation
    if (!prompt || typeof prompt !== 'string') {
      log('WARN', 'Invalid prompt', requestId);
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Prompt must be a non-empty string'
      });
    }

    if (prompt.length > 50000) {
      log('WARN', 'Prompt too long', requestId);
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Prompt must be less than 50,000 characters'
      });
    }

    // Route to appropriate AI (allow frontend to force a specific AI)
    const routing = chooseAI(prompt);
    if (forceAI === 'gemini' || forceAI === 'openclaw') {
      routing.ai = forceAI;
      routing.confidence = 100; // manual override
    }
    log('INFO', `Routing decision: ${routing.ai.toUpperCase()}`, requestId, routing);

    // Synchronous processing only for public endpoint
    let response;
    let actualAI = routing.ai;

    const isAdmin = USERS_MAP.has(req.authenticatedUser) || USERS_MAP.has('__fallback__');

    try {
      if (routing.ai === 'gemini') {
        response = await callGemini(prompt);
      } else {
        response = await callOpenClaw(prompt, openclawUrl, openclawToken, 25000, isAdmin);
      }
    } catch (error) {
      if (error.message === 'OPENCLAW_CREDENTIALS_REQUIRED') {
        return res.status(403).json({
          error: 'Agent credentials required',
          message: 'Please configure your own Agent URL and Bearer Token in Settings → Agent Connection.'
        });
      }
      // Intelligent fallback: if OpenClaw is unreachable, try Gemini
      if (error.message === 'OPENCLAW_UNREACHABLE' && routing.ai === 'openclaw') {
        log('WARN', 'OpenClaw unreachable, trying Gemini fallback', requestId);
        try {
          response = await callGemini(prompt);
          actualAI = 'gemini';
          response = `⚠️ Note: OpenClaw is not reachable. Using Gemini as fallback.\n\n${response}`;
        } catch (geminiError) {
          if (geminiError.message === 'GEMINI_QUOTA_EXCEEDED') {
            throw new Error('BOTH_APIS_EXHAUSTED');
          }
          throw geminiError;
        }
      } else {
        throw error;
      }
    }

    log('INFO', 'Chat response generated successfully', requestId);

    res.json({
      response,
      ai: actualAI,
      routing: {
        ai: routing.ai,
        confidence: routing.confidence,
        scores: routing.scores
      }
    });

  } catch (error) {
    log('ERROR', `Chat error: ${error.message}`, requestId, { stack: error.stack });

    if (error.message === 'OPENCLAW_TIMEOUT') {
      return res.status(504).json({
        error: 'OPENCLAW_TIMEOUT',
        timeout: true,
        requestId
      });
    }

    const { status, userMessage } = formatError(error);

    res.status(status).json({
      error: userMessage,
      requestId,
      debugInfo: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Main chat endpoint (authenticated - for API users)
 * POST /api/chat
 * Body: { prompt: string, async?: boolean }
 * Headers: X-API-Key (required)
 */
app.post('/api/chat', requireApiKey, async (req, res) => {
  const requestId = req.id;

  try {
    const { prompt, async = false } = req.body;

    // Input validation
    if (!prompt || typeof prompt !== 'string') {
      log('WARN', 'Invalid prompt', requestId);
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Prompt must be a non-empty string'
      });
    }

    if (prompt.length > 50000) {
      log('WARN', 'Prompt too long', requestId);
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Prompt must be less than 50,000 characters'
      });
    }

    // Route to appropriate AI
    const routing = chooseAI(prompt);
    log('INFO', `Routing decision: ${routing.ai.toUpperCase()}`, requestId, routing);

    // Handle async requests
    if (async) {
      const taskId = createTask(prompt);
      log('INFO', `Created async task: ${taskId}`, requestId);

      // Process in background
      processTaskAsync(taskId, prompt, routing.ai, requestId);

      return res.json({
        taskId,
        status: 'processing',
        message: 'Task created successfully',
        checkStatusUrl: `/api/task/${taskId}`
      });
    }

    // Synchronous processing
    let response;
    let actualAI = routing.ai;

    try {
      if (routing.ai === 'gemini') {
        response = await callGemini(prompt);
      } else {
        response = await callOpenClaw(prompt, req.body.openclawUrl, req.body.openclawToken);
      }
    } catch (error) {
      // Intelligent fallback: if OpenClaw is unreachable, try Gemini
      if (error.message === 'OPENCLAW_UNREACHABLE' && routing.ai === 'openclaw') {
        log('WARN', 'OpenClaw unreachable, trying Gemini fallback', requestId);
        try {
          response = await callGemini(prompt);
          actualAI = 'gemini';
          response = `⚠️ Note: OpenClaw is not reachable. Using Gemini as fallback.\n\n${response}`;
        } catch (geminiError) {
          if (geminiError.message === 'GEMINI_QUOTA_EXCEEDED') {
            throw new Error('BOTH_APIS_EXHAUSTED');
          }
          throw geminiError;
        }
      } else {
        throw error;
      }
    }

    log('INFO', 'Chat response generated successfully', requestId);

    res.json({
      response,
      ai: actualAI,
      routing: {
        ai: routing.ai,
        confidence: routing.confidence,
        scores: routing.scores
      }
    });

  } catch (error) {
    log('ERROR', `Chat error: ${error.message}`, requestId);

    const { status, userMessage } = formatError(error);

    res.status(status).json({
      error: userMessage,
      requestId
    });
  }
});

/**
 * Check task status endpoint
 * GET /api/task/:id
 * Headers: X-API-Key (required)
 */
app.get('/api/task/:id', requireApiKey, (req, res) => {
  const requestId = req.id;
  const taskId = req.params.id;

  log('INFO', `Task status check: ${taskId}`, requestId);

  const task = getTask(taskId);

  if (!task) {
    log('WARN', `Task not found: ${taskId}`, requestId);
    return res.status(404).json({
      error: 'Task not found',
      message: 'The requested task does not exist or has expired'
    });
  }

  // Return task status (sanitize internal fields)
  res.json({
    id: task.id,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    response: task.response,
    error: task.error,
    ai: task.ai
  });
});

/**
 * Health check endpoint (protected)
 * GET /health
 * Headers: X-API-Key (required)
 */
app.get('/health', requireApiKey, (req, res) => {
  log('INFO', 'Health check', req.id);

  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {
      gemini: !!GEMINI_API_KEY,
      openclaw: !!OPENCLAW_TOKEN,
      render: !!RENDER_API_KEY,
      notion: !!NOTION_API_KEY
    },
    version: '4.0.0'
  });
});

/**
 * Ping OpenClaw to check if it's reachable
 * POST /ping-openclaw
 * Body: { openclawUrl?: string, openclawToken?: string }
 */
app.post('/ping-openclaw', requireLogin, async (req, res) => {
  const { openclawUrl, openclawToken } = req.body || {};
  const isAdmin = USERS_MAP.has(req.authenticatedUser) || USERS_MAP.has('__fallback__');
  const url   = openclawUrl   || (isAdmin ? OPENCLAW_URL   : '');
  const token = openclawToken || (isAdmin ? OPENCLAW_TOKEN : '');

  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return res.json({ reachable: false, reason: 'No Agent URL configured. Add your own in Settings → Agent Connection.' });
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const headers = {
      'Content-Type': 'application/json',
      'x-openclaw-agent-id': 'main'
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const response = await fetch(`${url.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'openclaw',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    // 200 = success, 400 = bad request but server is up - both mean OpenClaw is reachable
    if (response.ok || response.status === 400) {
      return res.json({ reachable: true });
    }

    return res.json({ reachable: false, reason: `HTTP ${response.status}` });

  } catch (err) {
    const reason = err.name === 'AbortError' ? 'Timeout (5s)' : 'Connection refused';
    return res.json({ reachable: false, reason });
  }
});

// ============================================
// INVOICE FOLLOW-UP ENDPOINT
// ============================================

const DEFAULT_INVOICE_SYSTEM_PROMPT = `You are a professional accounts receivable specialist for a construction company.
Generate a follow-up email for an overdue invoice based on the invoice data provided.
Adjust the tone based on the escalation level specified.
Be concise, professional, and include a clear call to action.
Format as a ready-to-send email with: Subject line, greeting, body paragraphs, and a professional sign-off.`;

app.post('/generate-invoice-followup', requireLogin, async (req, res) => {
  const requestId = req.id;
  try {
    const { invoiceContent, fileName, daysOverdue, escalationTone, additionalNotes, customSystemPrompt } = req.body || {};
    if (!invoiceContent || typeof invoiceContent !== 'string') {
      return res.status(400).json({ error: 'Invoice content is required' });
    }
    const systemPrompt = (customSystemPrompt && customSystemPrompt.trim()) ? customSystemPrompt.trim() : DEFAULT_INVOICE_SYSTEM_PROMPT;
    const daysStr = (typeof daysOverdue === 'number' && daysOverdue > 0) ? `${daysOverdue} days past due` : 'overdue (exact days not provided)';
    const prompt = [
      systemPrompt,
      '',
      '---',
      `ESCALATION LEVEL: ${escalationTone || 'professional'}`,
      `DAYS OVERDUE: ${daysStr}`,
      `FILE: ${fileName || 'invoice'}`,
      '---',
      'INVOICE DATA:',
      invoiceContent.substring(0, 15000),
      additionalNotes ? `\nADDITIONAL CONTEXT:\n${additionalNotes}` : '',
      '---',
      'Generate the follow-up email now:'
    ].filter(Boolean).join('\n');

    log('INFO', `Invoice follow-up: ${daysStr}, tone: ${escalationTone}`, requestId);
    const response = await callGemini(prompt, 45000);
    res.json({ response, ai: 'gemini' });
  } catch (error) {
    log('ERROR', `Invoice follow-up error: ${error.message}`, requestId);
    const { status, userMessage } = formatError(error);
    res.status(status).json({ error: userMessage, requestId });
  }
});

// ============================================
// ADJUSTER FOLLOW-UP ENDPOINT
// ============================================

const DEFAULT_ADJUSTER_SYSTEM_PROMPT = `You are a professional claims coordinator for a construction company.
Generate a polite but persistent follow-up email to an insurance adjuster.
Reference the claim number and the date of last contact.
Request a clear status update and a specific timeline for resolution.
Mention the impact the delay is having on the construction project if appropriate.
Keep the tone professional but firm.
Format as a ready-to-send email with: Subject line, greeting, body paragraphs, and a professional sign-off.`;

app.post('/generate-adjuster-followup', requireLogin, async (req, res) => {
  const requestId = req.id;
  try {
    const { adjusterName, company, claimNumber, lastContactDate, statusNotes, customSystemPrompt } = req.body || {};
    if (!adjusterName && !claimNumber) {
      return res.status(400).json({ error: 'Adjuster name or claim number is required' });
    }
    const systemPrompt = (customSystemPrompt && customSystemPrompt.trim()) ? customSystemPrompt.trim() : DEFAULT_ADJUSTER_SYSTEM_PROMPT;
    const daysSince = lastContactDate ? Math.floor((Date.now() - new Date(lastContactDate).getTime()) / 86400000) : null;
    const prompt = [
      systemPrompt,
      '',
      '---',
      'CLAIM DETAILS:',
      adjusterName    ? `Adjuster Name: ${adjusterName}` : '',
      company         ? `Insurance Company: ${company}` : '',
      claimNumber     ? `Claim Number: ${claimNumber}` : '',
      lastContactDate ? `Last Contact: ${lastContactDate}${daysSince !== null ? ` (${daysSince} days ago)` : ''}` : '',
      statusNotes     ? `Status / Notes: ${statusNotes}` : '',
      '---',
      'Generate the follow-up email now:'
    ].filter(Boolean).join('\n');

    log('INFO', `Adjuster follow-up: claim ${claimNumber || 'N/A'}`, requestId);
    const response = await callGemini(prompt, 30000);
    res.json({ response, ai: 'gemini' });
  } catch (error) {
    log('ERROR', `Adjuster follow-up error: ${error.message}`, requestId);
    const { status, userMessage } = formatError(error);
    res.status(status).json({ error: userMessage, requestId });
  }
});

/**
 * POST /generate-estimate
 * Generate a professional construction estimate / quote document
 */
app.post('/generate-estimate', requireLogin, async (req, res) => {
  const requestId = req.id;
  try {
    const {
      clientName, projectName, address, startDate,
      scope, lineItems, subtotal, taxPct, taxAmount, grandTotal,
      additionalNotes, customSystemPrompt
    } = req.body;

    const defaultSystemPrompt = `You are a professional construction estimator. Generate a detailed, professional estimate document based on the project information and line items provided. Include a clear scope summary, itemized cost breakdown, totals, and professional terms. Format as a ready-to-present estimate document with all necessary sections clearly labeled.`;

    const systemPrompt = (customSystemPrompt && customSystemPrompt.trim()) ? customSystemPrompt.trim() : defaultSystemPrompt;

    const prompt = `${systemPrompt}

PROJECT INFORMATION:
Client: ${clientName || 'N/A'}
Project: ${projectName || 'N/A'}
Address: ${address || 'N/A'}
Estimated Start: ${startDate || 'TBD'}

PROJECT SCOPE / DESCRIPTION:
${scope || 'No description provided.'}

LINE ITEMS:
${lineItems || 'No line items provided.'}

FINANCIALS:
Subtotal: $${subtotal || '0.00'}
Tax (${taxPct || '0'}%): $${taxAmount || '0.00'}
GRAND TOTAL: $${grandTotal || '0.00'}

ADDITIONAL NOTES / TERMS:
${additionalNotes || 'None'}

Generate a complete, professional estimate document.`;

    const response = await callGemini(prompt, 45000);
    log('INFO', 'Estimate generated successfully', requestId);
    res.json({ response, ai: 'gemini' });
  } catch (error) {
    log('ERROR', `Estimate generation error: ${error.message}`, requestId);
    const { status, userMessage } = formatError(error);
    res.status(status).json({ error: userMessage, requestId });
  }
});

/**
 * POST /generate-change-order
 * Generate a formal change order document
 */
app.post('/generate-change-order', requireLogin, async (req, res) => {
  const requestId = req.id;
  try {
    const {
      clientName, contractNumber, changeOrderNumber, status,
      reason, scopeChanges, costImpact, scheduleDays,
      customSystemPrompt
    } = req.body;

    const defaultSystemPrompt = `You are a professional construction project manager. Generate a formal change order document based on the information provided. Include reason for change, detailed scope changes, cost impact breakdown, schedule impact, and require client sign-off language. Format as a professional, legally clear change order document.`;

    const systemPrompt = (customSystemPrompt && customSystemPrompt.trim()) ? customSystemPrompt.trim() : defaultSystemPrompt;

    const costNum = parseFloat(costImpact) || 0;
    const daysNum = parseInt(scheduleDays) || 0;
    const statusLabel = status === 'approved' ? 'APPROVED' : status === 'rejected' ? 'REJECTED' : 'PENDING APPROVAL';

    const prompt = `${systemPrompt}

CHANGE ORDER DETAILS:
Client: ${clientName || 'N/A'}
Contract / Project: ${contractNumber || 'N/A'}
Change Order #: ${changeOrderNumber || 'CO-001'}
Status: ${statusLabel}
Date: ${new Date().toLocaleDateString()}

REASON FOR CHANGE:
${reason || 'No reason provided.'}

SCOPE CHANGES:
${scopeChanges || 'No scope changes described.'}

FINANCIAL IMPACT:
Cost Impact: ${costNum >= 0 ? '+' : ''}$${Math.abs(costNum).toFixed(2)} ${costNum >= 0 ? '(addition to contract)' : '(deduction from contract)'}

SCHEDULE IMPACT:
${daysNum === 0 ? 'No schedule change.' : (daysNum > 0 ? '+' + daysNum + ' calendar days added to project timeline.' : Math.abs(daysNum) + ' calendar days reduced from project timeline.')}

Generate a complete, professional change order document.`;

    const response = await callGemini(prompt, 35000);
    log('INFO', 'Change order generated successfully', requestId);
    res.json({ response, ai: 'gemini' });
  } catch (error) {
    log('ERROR', `Change order generation error: ${error.message}`, requestId);
    const { status, userMessage } = formatError(error);
    res.status(status).json({ error: userMessage, requestId });
  }
});

/**
 * 404 handler
 */
app.use((req, res) => {
  log('WARN', `404 - Route not found: ${req.path}`, req.id);
  res.status(404).json({
    error: 'Not found',
    message: 'The requested endpoint does not exist'
  });
});

/**
 * Global error handler
 */
app.use((err, req, res, next) => {
  log('ERROR', `Unhandled error: ${err.message}`, req.id, { stack: err.stack });

  res.status(500).json({
    error: 'Internal server error',
    message: 'An unexpected error occurred',
    requestId: req.id
  });
});

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Sleep utility
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Process task asynchronously
 * @param {string} taskId - Task ID
 * @param {string} prompt - User prompt
 * @param {string} ai - AI to use ('gemini' or 'openclaw')
 * @param {string} requestId - Request ID for logging
 */
async function processTaskAsync(taskId, prompt, ai, requestId) {
  updateTask(taskId, { status: TaskStatus.PROCESSING });
  log('INFO', `Processing async task: ${taskId}`, requestId);

  try {
    let response;

    if (ai === 'gemini') {
      response = await callGemini(prompt);
    } else {
      response = await callOpenClaw(prompt, OPENCLAW_URL, OPENCLAW_TOKEN);
    }

    updateTask(taskId, {
      status: TaskStatus.COMPLETED,
      response,
      ai
    });

    log('INFO', `Async task completed: ${taskId}`, requestId);

  } catch (error) {
    log('ERROR', `Async task failed: ${taskId} - ${error.message}`, requestId);

    updateTask(taskId, {
      status: TaskStatus.FAILED,
      error: error.message
    });
  }
}

/**
 * Formats errors for user-friendly responses
 * @param {Error} error - Error object
 * @returns {Object} { status: number, userMessage: string }
 */
function formatError(error) {
  const errorMap = {
    'GEMINI_NOT_CONFIGURED': {
      status: 503,
      message: 'Gemini AI is not configured. Please contact the administrator.'
    },
    'GEMINI_API_KEY_LEAKED': {
      status: 403,
      message: '🔒 Security Alert: The Gemini API key has been flagged as leaked by Google and has been disabled.\n\nTO FIX:\n1. Go to https://ai.google.dev/\n2. Delete the old API key\n3. Create a new API key\n4. Update it in Render environment variables\n5. Redeploy the service\n\nThis happens when API keys are exposed in public repositories or logs.'
    },
    'OPENCLAW_NOT_CONFIGURED': {
      status: 503,
      message: '🟠 OpenClaw URL is not configured. Please click ⚙ Settings in the sidebar and enter your OpenClaw VPS URL.'
    },
    'OPENCLAW_UNREACHABLE': {
      status: 503,
      message: '🟠 OpenClaw is not reachable. Please make sure OpenClaw is running on your server and check the URL in ⚙ Settings.'
    },
    'OPENCLAW_TIMEOUT': {
      status: 504,
      message: 'OPENCLAW_TIMEOUT'
    },
    'OPENCLAW_AUTH_FAILED': {
      status: 403,
      message: '🟠 OpenClaw authentication failed. Please check your Bearer token in ⚙ Settings.'
    },
    'GEMINI_QUOTA_EXCEEDED': {
      status: 503,
      message: 'Gemini API quota exceeded. The service quota resets daily. Please try again later or contact support.'
    },
    'BOTH_APIS_EXHAUSTED': {
      status: 503,
      message: 'All AI services are temporarily unavailable. Please try again later.'
    },
    'GEMINI_FAILED': {
      status: 503,
      message: '⚠️ Gemini AI is temporarily unavailable. Please try again in a moment.'
    }
  };

  // Check if error message starts with a known error code
  for (const [code, config] of Object.entries(errorMap)) {
    if (error.message.includes(code)) {
      return { status: config.status, userMessage: config.message };
    }
  }

  // Default error (don't expose technical details)
  return {
    status: 500,
    userMessage: 'An error occurred while processing your request. Please try again later.'
  };
}

/**
 * Calculate hours until midnight Pacific Time
 * @returns {number} Hours until midnight PT
 */
function getHoursUntilMidnightPT() {
  const now = new Date();
  const pacificTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const midnight = new Date(pacificTime);
  midnight.setHours(24, 0, 0, 0);
  const hoursUntil = Math.ceil((midnight - pacificTime) / (1000 * 60 * 60));
  return hoursUntil;
}

// ============================================
// SERVER STARTUP
// ============================================

app.listen(PORT, () => {
  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('🚀 AI AUTOMATION ASSISTANT - PRODUCTION SERVER v4.0.0');
  console.log('═══════════════════════════════════════════════════════');
  console.log('');
  console.log(`📍 Server running on port: ${PORT}`);
  console.log(`🌐 Access: http://localhost:${PORT}`);
  console.log('');
  console.log('🔐 Security Features:');
  console.log('   ✅ X-API-Key authentication');
  console.log('   ✅ Rate limiting (100 req/15min)');
  console.log('   ✅ Helmet security headers');
  console.log('   ✅ CORS whitelist protection');
  console.log('   ✅ Request size limits (10MB)');
  console.log('   ✅ Request timeouts with AbortController');
  console.log('');
  console.log('🤖 AI Services Status:');
  console.log(`   ${GEMINI_API_KEY ? '🟢' : '🔴'} Gemini: ${GEMINI_API_KEY ? 'Ready' : 'Not Configured'}`);
  console.log(`   🟠 OpenClaw: Proxy target → ${OPENCLAW_URL}`);
  console.log(`   ${RENDER_API_KEY ? '🟢' : '🔴'} Render: ${RENDER_API_KEY ? 'Ready' : 'Not Configured'}`);
  console.log(`   ${NOTION_API_KEY ? '🟢' : '🔴'} Notion: ${NOTION_API_KEY ? 'Ready' : 'Not Configured'}`);
  console.log('');
  console.log('🎯 Routing System:');
  console.log('   📊 Score-based routing (not keyword matching)');
  console.log('   🔵 Gemini: Fast Q&A, explanations');
  console.log('   🟠 OpenClaw: Execution tasks, automation, complex analysis');
  console.log('   ⚡ Execution verbs ALWAYS route to OpenClaw');
  console.log('');
  console.log('📡 API Endpoints:');
  console.log('   POST /chat - Public chat endpoint');
  console.log('   POST /ping-openclaw - OpenClaw connection check');
  console.log('   GET /health - Health check (requires auth)');
  console.log('');
  console.log('⏱️  Timeouts:');
  console.log('   Gemini: 30 seconds');
  console.log('   OpenClaw: 60 seconds');
  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('INFO', 'SIGTERM signal received: closing HTTP server');
  process.exit(0);
});

process.on('SIGINT', () => {
  log('INFO', 'SIGINT signal received: closing HTTP server');
  process.exit(0);
});
