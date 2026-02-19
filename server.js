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
async function callOpenClaw(prompt, openclawUrl, openclawToken, timeoutMs = 25000) {
  const url = openclawUrl || OPENCLAW_URL;
  const token = openclawToken || OPENCLAW_TOKEN;

  if (!url) {
    throw new Error('OPENCLAW_NOT_CONFIGURED');
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
    <link href="https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500;1,400&family=Playfair+Display:ital,wght@0,700;0,800;1,600&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,300&display=swap" rel="stylesheet">

    <!-- Markdown and syntax highlighting -->
    <script src="https://cdn.jsdelivr.net/npm/marked@11.1.1/marked.min.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>

    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }

        /* ============================================
           DESIGN SYSTEM
           Aesthetic: Industrial-luxury terminal
           Fonts: DM Mono (UI chrome) + Playfair Display (headings) + DM Sans (body)
           Palette: Near-black bg, amber accent, cold white text
           ============================================ */

        :root {
            --bg:          #0e0e0f;
            --bg-mid:      #141416;
            --bg-panel:    #111113;
            --bg-raised:   #1a1a1d;
            --bg-hover:    #1f1f23;
            --border:      #222226;
            --border-mid:  #2a2a30;
            --border-hi:   #38383f;
            --text:        #e8e8ec;
            --text-mid:    #9999aa;
            --text-dim:    #55555f;
            --accent:      #d4962a;
            --accent-lo:   rgba(212,150,42,.12);
            --accent-glow: rgba(212,150,42,.25);
            --green:       #2db87d;
            --green-lo:    rgba(45,184,125,.1);
            --orange:      #e07033;
            --orange-lo:   rgba(224,112,51,.12);
            --red:         #e05555;
            --red-lo:      rgba(224,85,85,.1);
            --mono:        'DM Mono', 'JetBrains Mono', 'Fira Code', monospace;
            --serif:       'Playfair Display', 'Georgia', serif;
            --sans:        'DM Sans', ui-sans-serif, system-ui, -apple-system, sans-serif;
            --radius-sm:   4px;
            --radius:      8px;
            --radius-lg:   12px;
            --shadow:      0 4px 24px rgba(0,0,0,.6);
            --shadow-lg:   0 12px 60px rgba(0,0,0,.8);
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
            background: var(--bg);
            min-height: 100vh;
            display: flex;
            overflow: hidden;
            color: var(--text);
        }

        /* Scanline texture on body */
        body::before {
            content: '';
            position: fixed;
            inset: 0;
            background: repeating-linear-gradient(
                0deg,
                transparent,
                transparent 2px,
                rgba(255,255,255,0.012) 2px,
                rgba(255,255,255,0.012) 4px
            );
            pointer-events: none;
            z-index: 0;
        }

        /* ===== SIDEBAR ===== */
        .sidebar {
            width: 252px;
            background: var(--bg-panel);
            border-right: 1px solid var(--border);
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
            background: linear-gradient(135deg, var(--accent) 0%, #b07820 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            font-weight: 700;
            color: #0e0e0f;
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
            background: var(--accent);
            color: #0a0a0b;
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
            background: linear-gradient(135deg, var(--accent) 0%, #8a5a10 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 18px;
            font-weight: 700;
            color: #0a0a0b;
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
            background: linear-gradient(135deg, var(--accent) 0%, #7a4e10 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 11px;
            font-weight: 700;
            color: #0a0a0b;
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
            background: var(--bg-panel);
            color: var(--text);
            padding: 11px 20px;
            border-bottom: 1px solid var(--border);
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
            background: linear-gradient(135deg, var(--accent) 0%, #8a5a10 100%);
            border-radius: var(--radius-sm);
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            box-shadow: 0 2px 10px var(--accent-glow);
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
            background: linear-gradient(135deg, var(--accent) 0%, #7a4e10 100%);
            border-radius: var(--radius-sm);
            display: flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 22px;
            box-shadow: 0 6px 24px var(--accent-glow);
        }
        .empty-state h2 {
            font-family: var(--serif);
            font-size: 2rem;
            font-style: italic;
            margin-bottom: 10px;
            color: var(--text);
            font-weight: 700;
            letter-spacing: -0.01em;
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
            background: linear-gradient(135deg, var(--accent) 0%, #7a4e10 100%);
            color: #0a0a0b;
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
            background: var(--bg-raised);
            color: var(--text);
            margin-left: auto;
            border: 1px solid var(--border-mid);
        }
        .bot {
            background: var(--bg-panel);
            border: 1px solid var(--border);
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
            background: var(--bg-panel);
            border-top: 1px solid var(--border);
            flex-shrink: 0;
        }
        .input-wrap {
            max-width: 700px;
            margin: 0 auto;
            display: flex;
            align-items: center;
            gap: 0;
            background: var(--bg-raised);
            border: 1px solid var(--border-mid);
            border-radius: var(--radius);
            transition: border-color 0.15s, box-shadow 0.15s;
            padding: 4px 6px 4px 14px;
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
            width: 33px;
            height: 33px;
            min-width: 33px;
            padding: 0;
            background: var(--accent);
            color: #0a0a0b;
            border: none;
            border-radius: var(--radius-sm);
            cursor: pointer;
            transition: opacity 0.15s, transform 0.1s;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            font-family: var(--mono);
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
            background: var(--bg);
            display: flex; align-items: center; justify-content: center;
            font-family: var(--sans);
        }
        .login-overlay::before {
            content: '';
            position: absolute;
            inset: 0;
            background: radial-gradient(ellipse 60% 50% at 50% 40%, rgba(212,150,42,.06) 0%, transparent 70%);
            pointer-events: none;
        }
        .login-card {
            width: 100%;
            max-width: 340px;
            background: var(--bg-panel);
            border: 1px solid var(--border-mid);
            border-radius: var(--radius);
            padding: 36px 30px 30px;
            box-shadow: var(--shadow-lg), 0 0 0 1px rgba(212,150,42,.06) inset;
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
        .login-logo {
            width: 44px; height: 44px;
            background: linear-gradient(135deg, var(--accent) 0%, #8a5a10 100%);
            border-radius: var(--radius-sm);
            display: flex; align-items: center; justify-content: center;
            margin-bottom: 16px;
            flex-shrink: 0;
            box-shadow: 0 4px 20px var(--accent-glow);
        }
        .login-card h1 {
            font-family: var(--mono);
            font-size: 13px;
            font-weight: 500;
            color: var(--text-mid);
            text-align: center;
            margin-bottom: 6px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
        }
        .login-card-tagline {
            font-family: var(--serif);
            font-size: 22px;
            font-style: italic;
            color: var(--text);
            text-align: center;
            margin-bottom: 28px;
            letter-spacing: -0.01em;
            line-height: 1.2;
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
            width: 100%; padding: 11px;
            background: var(--accent);
            color: #0a0a0b;
            border: none;
            border-radius: var(--radius-sm);
            font-size: 12px; font-weight: 700;
            cursor: pointer;
            font-family: var(--mono);
            transition: opacity .15s, box-shadow .15s;
            margin-top: 6px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            box-shadow: 0 4px 16px var(--accent-glow);
        }
        .login-submit-btn:hover:not(:disabled) { opacity: 0.88; }
        .login-submit-btn:disabled { opacity: .5; cursor: not-allowed; box-shadow: none; }
        .login-card-hint { font-size: 10px; color: var(--text-dim); text-align: center; margin-top: 10px; width: 100%; font-family: var(--mono); letter-spacing: 0.04em; }
        /* login tab bar */
        .login-tab-bar { display: flex; width: 100%; gap: 0; margin-bottom: 20px; border-radius: var(--radius-sm); overflow: hidden; border: 1px solid var(--border-mid); }
        .login-tab { flex: 1; padding: 9px 0; background: var(--bg-raised); color: var(--text-dim); border: none; cursor: pointer; font-size: 11px; font-family: var(--mono); text-transform: uppercase; letter-spacing: 0.08em; transition: background .15s, color .15s; }
        .login-tab.active { background: var(--accent); color: #0a0a0b; font-weight: 600; }
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
            <button class="stab active" id="stab-profile"    onclick="switchSettingsTab('profile')">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
                Profile
            </button>
            <button class="stab" id="stab-system"   onclick="switchSettingsTab('system')">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                System
            </button>
            <button class="stab" id="stab-agent"    onclick="switchSettingsTab('agent')">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                Agent
            </button>
            <button class="stab" id="stab-connectors" onclick="switchSettingsTab('connectors')">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                Connectors
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
             'openclaw_url','openclaw_token','aiMode'].forEach(k => localStorage.removeItem(k));
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

  const entry = { username: user, passwordHash: hashPassword(password), requestedAt: Date.now() };
  if (email && typeof email === 'string') entry.email = email.trim().toLowerCase().slice(0, 200);

  userStore.pending.push(entry);
  saveUserStore();
  log('INFO', `Signup request: ${user}`, req.id);
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

    try {
      if (routing.ai === 'gemini') {
        response = await callGemini(prompt);
      } else {
        response = await callOpenClaw(prompt, openclawUrl, openclawToken);
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
app.post('/ping-openclaw', async (req, res) => {
  const { openclawUrl, openclawToken } = req.body || {};
  const url   = openclawUrl   || OPENCLAW_URL;
  const token = openclawToken || OPENCLAW_TOKEN;

  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return res.json({ reachable: false, reason: 'No valid URL configured' });
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
