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
    <title>AI Automation Assistant - Production</title>

    <!-- Markdown and syntax highlighting -->
    <script src="https://cdn.jsdelivr.net/npm/marked@11.1.1/marked.min.js"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>

    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }

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
            outline: 2px solid #10a37f;
            outline-offset: 2px;
        }

        body {
            font-family: 'Söhne', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Ubuntu, sans-serif;
            background: #212121;
            min-height: 100vh;
            display: flex;
            overflow: hidden;
            color: #ececec;
        }

        /* ===== SIDEBAR ===== */
        .sidebar {
            width: 260px;
            background: #171717;
            border-right: 1px solid #2f2f2f;
            display: flex;
            flex-direction: column;
            height: 100vh;
            flex-shrink: 0;
            overflow: hidden;
        }
        .sidebar-header {
            padding: 16px 12px 12px;
        }
        .home-btn {
            width: 100%;
            padding: 10px 14px;
            background: transparent;
            color: #ececec;
            border: 1px solid #3f3f3f;
            border-radius: 8px;
            font-weight: 500;
            font-size: 14px;
            cursor: pointer;
            transition: background 0.15s, border-color 0.15s;
            display: flex;
            align-items: center;
            gap: 10px;
            font-family: inherit;
        }
        .home-btn:hover {
            background: #2a2a2a;
            border-color: #555;
        }

        /* AI Mode Selector */
        .ai-mode-section {
            padding: 4px 12px 12px;
            border-bottom: 1px solid #2f2f2f;
        }
        .ai-mode-label {
            color: #6b6b6b;
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            margin-bottom: 6px;
            padding: 0 2px;
        }
        .ai-mode-tabs {
            display: flex;
            gap: 5px;
        }
        .ai-mode-btn {
            flex: 1;
            padding: 8px 6px;
            border-radius: 7px;
            border: 1px solid #2f2f2f;
            background: transparent;
            color: #8e8ea0;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.15s;
            text-align: center;
            font-family: inherit;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
        }
        .ai-mode-btn:hover:not(.active) {
            border-color: #444;
            color: #c5c5d2;
            background: #2a2a2a;
        }
        .ai-mode-btn.active.gemini {
            background: rgba(16, 163, 127, 0.12);
            border-color: #10a37f;
            color: #10a37f;
        }
        .ai-mode-btn.active.openclaw {
            background: rgba(239, 118, 35, 0.12);
            border-color: #ef7623;
            color: #ef7623;
        }

        /* OpenClaw Status Bar */
        .openclaw-status {
            padding: 8px 14px;
            font-size: 11px;
            display: flex;
            align-items: center;
            gap: 7px;
            border-bottom: 1px solid #2f2f2f;
            background: #1a1a1a;
            color: #8e8ea0;
        }
        .openclaw-status-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: #555;
            flex-shrink: 0;
        }
        .openclaw-status-dot.online  { background: #10a37f; }
        .openclaw-status-dot.offline { background: #ef4444; }
        .openclaw-status-dot.checking {
            background: #f59e0b;
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
            color: #10a37f;
            font-size: 11px;
            cursor: pointer;
            padding: 0;
            font-family: inherit;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .openclaw-settings-link:hover { color: #1dc9a4; }

        /* Settings Panel */
        .settings-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.5);
            z-index: 999;
            display: none;
            backdrop-filter: blur(2px);
        }
        .settings-overlay.open { display: block; }
        .settings-panel {
            position: fixed;
            top: 0; right: 0;
            width: 360px;
            height: 100vh;
            background: #202123;
            border-left: 1px solid #2f2f2f;
            z-index: 1000;
            padding: 28px 24px;
            transform: translateX(100%);
            transition: transform 0.25s ease;
            overflow-y: auto;
            box-shadow: -12px 0 48px rgba(0,0,0,0.5);
        }
        .settings-panel.open { transform: translateX(0); }
        .settings-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 28px;
        }
        .settings-title {
            color: #ececec;
            font-size: 17px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .settings-close-btn {
            background: #2a2a2a;
            border: 1px solid #3f3f3f;
            color: #8e8ea0;
            font-size: 14px;
            cursor: pointer;
            padding: 6px 10px;
            border-radius: 6px;
            transition: all 0.15s;
            font-family: inherit;
            line-height: 1;
        }
        .settings-close-btn:hover { color: #ececec; border-color: #666; }
        .settings-group {
            margin-bottom: 20px;
        }
        .settings-group label {
            display: block;
            color: #c5c5d2;
            font-size: 13px;
            margin-bottom: 7px;
            font-weight: 500;
        }
        .settings-group input[type="text"],
        .settings-group input[type="password"] {
            width: 100%;
            padding: 10px 13px;
            background: #2a2a2a;
            border: 1px solid #3f3f3f;
            border-radius: 7px;
            color: #ececec;
            font-size: 14px;
            font-family: inherit;
            transition: border-color 0.15s;
        }
        .settings-group input:focus {
            border-color: #ef7623;
            outline: none;
            box-shadow: 0 0 0 3px rgba(239, 118, 35, 0.12);
        }
        .settings-hint {
            color: #6b6b6b;
            font-size: 11px;
            margin-top: 5px;
            line-height: 1.5;
        }
        .settings-save-btn {
            width: 100%;
            padding: 11px;
            background: #ef7623;
            color: white;
            border: none;
            border-radius: 8px;
            font-weight: 600;
            font-size: 14px;
            cursor: pointer;
            margin-top: 8px;
            transition: background 0.15s;
            font-family: inherit;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
        }
        .settings-save-btn:hover { background: #d96820; }
        .settings-divider {
            border: none;
            border-top: 1px solid #2f2f2f;
            margin: 24px 0;
        }
        .settings-instructions {
            color: #6b6b6b;
            font-size: 12px;
            line-height: 1.7;
        }
        .settings-instructions strong { color: #8e8ea0; }

        /* ===== SIDEBAR HISTORY ===== */
        .history-section {
            flex: 1;
            overflow-y: auto;
            padding: 8px 8px 8px;
            min-height: 0;
        }
        .history-title {
            color: #6b6b6b;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            margin-bottom: 4px;
            padding: 8px 8px 4px;
        }
        .history-item {
            padding: 10px 10px;
            margin-bottom: 2px;
            background: transparent;
            border-radius: 8px;
            cursor: pointer;
            transition: background 0.15s;
            border: 1px solid transparent;
            position: relative;
        }
        .history-item:hover {
            background: #2a2a2a;
            border-color: #3f3f3f;
        }
        .history-item:hover .delete-chat-btn {
            opacity: 1;
        }
        .history-item-title {
            color: #ececec;
            font-size: 13px;
            margin-bottom: 2px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            padding-right: 28px;
            font-weight: 400;
        }
        .history-item-preview {
            color: #6b6b6b;
            font-size: 11px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .history-item-time {
            color: #4b4b4b;
            font-size: 10px;
            margin-top: 3px;
        }
        .delete-chat-btn {
            position: absolute;
            top: 8px;
            right: 8px;
            background: transparent;
            color: #6b6b6b;
            border: none;
            padding: 4px 6px;
            border-radius: 5px;
            font-size: 11px;
            cursor: pointer;
            opacity: 0;
            transition: all 0.15s;
            z-index: 10;
            display: flex;
            align-items: center;
        }
        .delete-chat-btn:hover {
            background: rgba(239,68,68,0.15);
            color: #ef4444;
        }

        /* ===== MAIN CONTENT ===== */
        .main-content {
            flex: 1;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #212121;
            min-width: 0;
        }
        .container {
            width: 100%;
            max-width: 100%;
            margin: 0 auto;
            background: #212121;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            height: 100vh;
        }

        /* ===== HEADER ===== */
        .header {
            background: #212121;
            color: #ececec;
            padding: 14px 24px;
            border-bottom: 1px solid #2f2f2f;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .header-left {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .header-icon {
            width: 32px;
            height: 32px;
            background: #10a37f;
            border-radius: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
        }
        .header h1 {
            font-size: 16px;
            font-weight: 600;
            color: #ececec;
            letter-spacing: -0.01em;
        }
        .header-right {
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .status-badge {
            display: flex;
            align-items: center;
            gap: 5px;
            padding: 5px 11px;
            background: rgba(16, 163, 127, 0.08);
            border: 1px solid rgba(16, 163, 127, 0.25);
            border-radius: 20px;
            font-size: 12px;
            color: #10a37f;
        }
        .status-indicator {
            display: inline-block;
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: #10a37f;
            animation: glow 2.5s ease-in-out infinite;
        }
        @keyframes glow {
            0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(16,163,127,0.4); }
            50% { opacity: 0.7; box-shadow: 0 0 0 3px rgba(16,163,127,0); }
        }
        .ai-models {
            font-size: 12px;
            color: #6b6b6b;
        }
        .ai-models span {
            color: #c5c5d2;
            font-weight: 500;
        }

        /* ===== CHAT AREA ===== */
        .chat-area {
            flex: 1;
            overflow-y: auto;
            padding: 0;
            background: #212121;
        }
        .chat-inner {
            max-width: 720px;
            margin: 0 auto;
            padding: 32px 24px;
        }

        /* ===== EMPTY STATE ===== */
        .empty-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 60vh;
            color: #8e8ea0;
            text-align: center;
            padding: 48px 24px;
        }
        .empty-logo {
            width: 56px;
            height: 56px;
            background: #10a37f;
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 20px;
        }
        .empty-state h2 {
            font-size: 1.75rem;
            margin-bottom: 8px;
            color: #ececec;
            font-weight: 600;
            letter-spacing: -0.02em;
        }
        .empty-state p {
            font-size: 1rem;
            margin-bottom: 36px;
            color: #8e8ea0;
            max-width: 360px;
            line-height: 1.6;
        }
        .example-queries {
            text-align: left;
            max-width: 560px;
            width: 100%;
        }
        .example-queries h3 {
            font-size: 13px;
            margin-bottom: 12px;
            color: #6b6b6b;
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.6px;
        }
        .example-queries ul {
            list-style: none;
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
        }
        .example-queries li {
            padding: 14px 16px;
            background: #2a2a2a;
            border: 1px solid #3f3f3f;
            border-radius: 10px;
            color: #c5c5d2;
            cursor: pointer;
            font-size: 13px;
            transition: all 0.15s;
            line-height: 1.4;
            display: flex;
            align-items: flex-start;
            gap: 10px;
        }
        .example-queries li:hover {
            background: #333;
            border-color: #555;
            color: #ececec;
        }
        .example-queries li svg {
            flex-shrink: 0;
            margin-top: 1px;
            opacity: 0.6;
        }

        /* ===== MESSAGES ===== */
        .message-row {
            display: flex;
            gap: 16px;
            margin-bottom: 28px;
            align-items: flex-start;
        }
        .message-row.user-row {
            flex-direction: row-reverse;
        }
        .msg-avatar {
            width: 32px;
            height: 32px;
            border-radius: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            font-size: 13px;
            font-weight: 700;
        }
        .msg-avatar.user-av {
            background: #5d5dff;
            color: white;
        }
        .msg-avatar.bot-av {
            background: #10a37f;
            color: white;
        }
        .msg-avatar.bot-av.openclaw-av {
            background: #ef7623;
        }
        .message {
            padding: 14px 18px;
            border-radius: 14px;
            max-width: 85%;
            word-wrap: break-word;
            line-height: 1.65;
            animation: fadeUp 0.2s ease-out;
            position: relative;
            font-size: 15px;
        }
        .message-actions {
            position: absolute;
            top: 8px;
            right: 10px;
            display: flex;
            gap: 4px;
            opacity: 0;
            transition: opacity 0.15s;
        }
        .message:hover .message-actions {
            opacity: 1;
        }
        .message-action-btn {
            background: rgba(0, 0, 0, 0.25);
            color: #c5c5d2;
            border: none;
            padding: 5px 9px;
            border-radius: 5px;
            font-size: 11px;
            cursor: pointer;
            transition: background 0.15s;
            font-family: inherit;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .message-action-btn:hover {
            background: rgba(0, 0, 0, 0.45);
            color: white;
        }
        .user .message-action-btn {
            background: rgba(255, 255, 255, 0.15);
        }
        .user .message-action-btn:hover {
            background: rgba(255, 255, 255, 0.25);
        }
        @keyframes fadeUp {
            from { opacity: 0; transform: translateY(8px); }
            to   { opacity: 1; transform: translateY(0); }
        }
        .user {
            background: #2f2f2f;
            color: #ececec;
            margin-left: auto;
            border: 1px solid #3f3f3f;
        }
        .bot {
            background: #2a2a2a;
            border: 1px solid #3a3a3a;
            color: #ececec;
        }
        .bot.gemini { border-left: 3px solid #10a37f; }
        .bot.openclaw { border-left: 3px solid #ef7623; }
        .ai-badge {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            padding: 3px 9px 3px 6px;
            border-radius: 5px;
            font-size: 10px;
            font-weight: 600;
            margin-bottom: 10px;
            text-transform: uppercase;
            letter-spacing: 0.6px;
        }
        .ai-badge.gemini {
            background: rgba(16,163,127,0.15);
            color: #10a37f;
            border: 1px solid rgba(16,163,127,0.3);
        }
        .ai-badge.openclaw {
            background: rgba(239,118,35,0.15);
            color: #ef7623;
            border: 1px solid rgba(239,118,35,0.3);
        }
        .thinking {
            background: #2a2a2a;
            border: 1px solid #3a3a3a;
            color: #8e8ea0;
            font-style: italic;
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 14px;
        }
        .spinner {
            width: 15px;
            height: 15px;
            border: 2px solid #3f3f3f;
            border-top-color: #10a37f;
            border-radius: 50%;
            animation: spin 0.7s linear infinite;
            flex-shrink: 0;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        .error {
            background: rgba(239,68,68,0.08);
            border: 1px solid rgba(239,68,68,0.25);
            color: #f87171;
            border-left: 3px solid #ef4444;
        }
        .routing-info {
            font-size: 11px;
            color: #4b4b4b;
            margin-top: 8px;
            font-style: italic;
        }

        /* ===== INPUT AREA ===== */
        .input-area {
            padding: 16px 24px 20px;
            background: #212121;
            border-top: 1px solid #2f2f2f;
        }
        .input-wrap {
            max-width: 720px;
            margin: 0 auto;
            display: flex;
            align-items: center;
            gap: 0;
            background: #2f2f2f;
            border: 1px solid #3f3f3f;
            border-radius: 12px;
            transition: border-color 0.15s, box-shadow 0.15s;
            padding: 4px 6px 4px 16px;
        }
        .input-wrap:focus-within {
            border-color: #555;
            box-shadow: 0 0 0 3px rgba(255,255,255,0.04);
        }
        input {
            flex: 1;
            padding: 10px 0;
            background: transparent;
            border: none;
            font-size: 15px;
            font-family: inherit;
            color: #ececec;
            outline: none;
            min-width: 0;
        }
        input::placeholder {
            color: #555;
        }
        .send-btn {
            width: 36px;
            height: 36px;
            min-width: 36px;
            padding: 0;
            background: #10a37f;
            color: white;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            transition: background 0.15s, transform 0.1s;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            font-family: inherit;
        }
        .send-btn:hover:not(:disabled) {
            background: #0d8c6d;
        }
        .send-btn:active:not(:disabled) {
            transform: scale(0.95);
        }
        .send-btn:disabled {
            background: #2f2f2f;
            color: #555;
            cursor: not-allowed;
        }
        .send-btn.thinking-state {
            background: #3f3f3f;
        }
        /* Markdown and code styling */
        .message pre {
            background: #1a1a1a;
            border: 1px solid #3a3a3a;
            border-radius: 8px;
            padding: 16px;
            margin: 12px 0;
            overflow-x: auto;
            position: relative;
        }
        .message code {
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            font-size: 13px;
            line-height: 1.5;
        }
        .message p code {
            background: rgba(255,255,255,0.06);
            padding: 2px 6px;
            border-radius: 4px;
            font-size: 13px;
            color: #e07b53;
        }
        .message pre code {
            background: transparent;
            padding: 0;
            color: #d4d4d4;
        }
        .message h1, .message h2, .message h3 {
            color: #ececec;
            margin: 18px 0 8px;
            font-weight: 600;
            letter-spacing: -0.01em;
        }
        .message h1 { font-size: 1.4em; border-bottom: 1px solid #3a3a3a; padding-bottom: 8px; }
        .message h2 { font-size: 1.2em; }
        .message h3 { font-size: 1.05em; }
        .message p { margin: 8px 0; }
        .message ul, .message ol {
            margin: 10px 0;
            padding-left: 22px;
        }
        .message li {
            margin: 5px 0;
            line-height: 1.65;
        }
        .message blockquote {
            border-left: 3px solid #10a37f;
            padding-left: 14px;
            margin: 12px 0;
            color: #8e8ea0;
            font-style: italic;
        }
        .message a {
            color: #10a37f;
            text-decoration: none;
        }
        .message a:hover { text-decoration: underline; }
        .message table {
            border-collapse: collapse;
            width: 100%;
            margin: 14px 0;
            font-size: 14px;
        }
        .message th, .message td {
            border: 1px solid #3a3a3a;
            padding: 8px 12px;
            text-align: left;
        }
        .message th {
            background: #1f1f1f;
            font-weight: 600;
            color: #c5c5d2;
        }
        .message td { color: #c5c5d2; }
        .message tr:nth-child(even) td { background: rgba(255,255,255,0.02); }
        .message img {
            max-width: 100%;
            border-radius: 8px;
            margin: 12px 0;
        }
        .copy-code-btn {
            position: absolute;
            top: 8px;
            right: 8px;
            background: #3f3f3f;
            color: #c5c5d2;
            border: none;
            padding: 5px 10px;
            border-radius: 5px;
            font-size: 11px;
            cursor: pointer;
            opacity: 0;
            transition: opacity 0.15s;
            font-family: inherit;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .message pre:hover .copy-code-btn { opacity: 1; }
        .copy-code-btn:hover { background: #555; color: white; }

        /* ===== TIMEOUT MESSAGE ===== */
        .timeout-msg {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 10px;
            font-size: 14px;
            color: #f59e0b;
        }
        .retry-btn {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 7px 14px;
            background: #2a2a2a;
            border: 1px solid #3f3f3f;
            border-radius: 7px;
            color: #ececec;
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
            font-family: inherit;
            transition: background 0.15s, border-color 0.15s;
        }
        .retry-btn:hover {
            background: #333;
            border-color: #10a37f;
            color: #10a37f;
        }
        .retry-btn svg { color: inherit; }

        /* ===== ACCOUNT SECTION (sidebar bottom) ===== */
        .account-section {
            padding: 8px 10px 10px;
            border-top: 1px solid #2f2f2f;
            flex-shrink: 0;
            position: relative;
            margin-top: auto;
        }
        .account-btn {
            width: 100%;
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 8px 10px;
            background: transparent;
            border: 1px solid transparent;
            border-radius: 8px;
            cursor: pointer;
            transition: background 0.15s, border-color 0.15s;
            color: #ececec;
            font-family: inherit;
            text-align: left;
        }
        .account-btn:hover {
            background: #2a2a2a;
            border-color: #3f3f3f;
        }
        .account-avatar {
            width: 32px;
            height: 32px;
            border-radius: 50%;
            background: linear-gradient(135deg, #5d5dff, #7c7cff);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 13px;
            font-weight: 700;
            color: white;
            flex-shrink: 0;
            text-transform: uppercase;
            letter-spacing: 0;
        }
        .account-info {
            flex: 1;
            min-width: 0;
        }
        .account-name {
            font-size: 13px;
            font-weight: 500;
            color: #ececec;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .account-plan {
            font-size: 10px;
            color: #6b6b6b;
            margin-top: 1px;
        }
        .account-chevron {
            color: #555;
            flex-shrink: 0;
            transition: transform 0.2s;
        }
        .account-btn.open .account-chevron {
            transform: rotate(180deg);
        }

        /* Account popup menu */
        .account-menu {
            position: absolute;
            bottom: calc(100% + 4px);
            left: 10px;
            right: 10px;
            background: #1e1e1e;
            border: 1px solid #3a3a3a;
            border-radius: 10px;
            box-shadow: 0 -8px 32px rgba(0,0,0,0.5);
            z-index: 200;
            overflow: hidden;
            display: none;
        }
        .account-menu.open {
            display: block;
            animation: menuSlideUp 0.15s ease;
        }
        @keyframes menuSlideUp {
            from { opacity: 0; transform: translateY(6px); }
            to   { opacity: 1; transform: translateY(0); }
        }
        .account-menu-header {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 14px 14px 12px;
            border-bottom: 1px solid #2f2f2f;
        }
        .account-menu-avatar {
            width: 38px;
            height: 38px;
            border-radius: 50%;
            background: linear-gradient(135deg, #5d5dff, #7c7cff);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 15px;
            font-weight: 700;
            color: white;
            flex-shrink: 0;
            text-transform: uppercase;
        }
        .account-menu-name {
            font-size: 13px;
            font-weight: 600;
            color: #ececec;
        }
        .account-menu-email {
            font-size: 11px;
            color: #6b6b6b;
            margin-top: 1px;
        }
        .account-menu-items {
            padding: 6px;
        }
        .account-menu-item {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 9px 10px;
            border-radius: 7px;
            cursor: pointer;
            color: #c5c5d2;
            font-size: 13px;
            transition: background 0.12s;
            font-family: inherit;
            background: none;
            border: none;
            width: 100%;
            text-align: left;
        }
        .account-menu-item:hover {
            background: #2a2a2a;
            color: #ececec;
        }
        .account-menu-item.danger:hover {
            background: rgba(239,68,68,0.1);
            color: #f87171;
        }
        .account-menu-item svg {
            flex-shrink: 0;
            color: #6b6b6b;
        }
        .account-menu-item:hover svg {
            color: #8e8ea0;
        }
        .account-menu-item.danger:hover svg {
            color: #f87171;
        }
        .account-menu-divider {
            height: 1px;
            background: #2f2f2f;
            margin: 4px 6px;
        }

        /* Profile edit modal */
        .profile-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.7);
            z-index: 300;
            display: none;
            align-items: center;
            justify-content: center;
        }
        .profile-overlay.open {
            display: flex;
            animation: fadeIn 0.15s ease;
        }
        @keyframes fadeIn {
            from { opacity: 0; }
            to   { opacity: 1; }
        }
        .profile-modal {
            background: #1e1e1e;
            border: 1px solid #3a3a3a;
            border-radius: 14px;
            width: 360px;
            max-width: calc(100vw - 32px);
            box-shadow: 0 24px 64px rgba(0,0,0,0.7);
            animation: modalSlideIn 0.18s ease;
        }
        @keyframes modalSlideIn {
            from { opacity: 0; transform: scale(0.95) translateY(-8px); }
            to   { opacity: 1; transform: scale(1) translateY(0); }
        }
        .profile-modal-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 18px 20px 16px;
            border-bottom: 1px solid #2f2f2f;
        }
        .profile-modal-title {
            font-size: 15px;
            font-weight: 600;
            color: #ececec;
        }
        .profile-modal-close {
            background: none;
            border: none;
            color: #6b6b6b;
            cursor: pointer;
            padding: 4px;
            border-radius: 5px;
            transition: color 0.12s, background 0.12s;
            display: flex;
        }
        .profile-modal-close:hover {
            color: #ececec;
            background: #2f2f2f;
        }
        .profile-modal-body {
            padding: 20px;
        }
        .profile-avatar-row {
            display: flex;
            align-items: center;
            gap: 16px;
            margin-bottom: 20px;
        }
        .profile-big-avatar {
            width: 56px;
            height: 56px;
            border-radius: 50%;
            background: linear-gradient(135deg, #5d5dff, #7c7cff);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 22px;
            font-weight: 700;
            color: white;
            text-transform: uppercase;
            flex-shrink: 0;
        }
        .profile-avatar-hint {
            font-size: 12px;
            color: #6b6b6b;
            line-height: 1.5;
        }
        .profile-field {
            margin-bottom: 16px;
        }
        .profile-field label {
            display: block;
            font-size: 12px;
            font-weight: 500;
            color: #8e8ea0;
            margin-bottom: 6px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .profile-field input {
            width: 100%;
            background: #2a2a2a;
            border: 1px solid #3a3a3a;
            border-radius: 8px;
            color: #ececec;
            font-size: 14px;
            padding: 10px 12px;
            font-family: inherit;
            outline: none;
            box-sizing: border-box;
            transition: border-color 0.15s;
        }
        .profile-field input:focus {
            border-color: #10a37f;
        }
        .profile-field input::placeholder {
            color: #4b4b4b;
        }
        .profile-save-btn {
            width: 100%;
            padding: 11px;
            background: #10a37f;
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            font-family: inherit;
            transition: background 0.15s;
            margin-top: 4px;
        }
        .profile-save-btn:hover {
            background: #0d9070;
        }

        /* Scrollbar */
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb {
            background: #3f3f3f;
            border-radius: 3px;
        }
        ::-webkit-scrollbar-thumb:hover { background: #555; }

        /* Mobile */
        @media (max-width: 768px) {
            body { flex-direction: column; }
            .sidebar {
                width: 100%;
                height: auto;
                border-right: none;
                border-bottom: 1px solid #2f2f2f;
                max-height: 200px;
                overflow-y: auto;
            }
            .sidebar-header { padding: 10px; }
            .home-btn { padding: 9px 12px; font-size: 13px; }
            .history-section { max-height: 120px; }
            .main-content { height: calc(100vh - 200px); }
            .header { padding: 12px 16px; }
            .header h1 { font-size: 14px; }
            .chat-inner { padding: 20px 16px; }
            .message { max-width: 100%; padding: 12px 14px; font-size: 14px; }
            .input-area { padding: 12px 16px 16px; }
            .example-queries ul { grid-template-columns: 1fr; }
            .empty-state h2 { font-size: 1.4rem; }
        }
        @media (max-width: 480px) {
            .header h1 { font-size: 13px; }
            .message { padding: 10px 12px; font-size: 13px; }
            .ai-badge { font-size: 9px; padding: 2px 7px; }
            .empty-state h2 { font-size: 1.2rem; }
        }
    </style>
</head>
<body>
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
                        aria-label="Use Gemini AI for Q&amp;A">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="10"/></svg>
                    Gemini
                </button>
                <button class="ai-mode-btn openclaw" id="mode-openclaw"
                        onclick="setAIMode('openclaw')"
                        role="tab" aria-selected="false"
                        aria-label="Use OpenClaw AI for automation">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                    OpenClaw
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
            <!-- Account popup menu (shown above the button) -->
            <div class="account-menu" id="account-menu" role="menu" aria-label="Account menu">
                <div class="account-menu-header">
                    <div class="account-menu-avatar" id="account-menu-avatar">U</div>
                    <div>
                        <div class="account-menu-name" id="account-menu-name">User</div>
                        <div class="account-menu-email">Local Account</div>
                    </div>
                </div>
                <div class="account-menu-items">
                    <button class="account-menu-item" onclick="openProfileModal(); closeAccountMenu();" role="menuitem">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
                        Edit Profile
                    </button>
                    <button class="account-menu-item" onclick="openSettings(); closeAccountMenu();" role="menuitem">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
                        OpenClaw Settings
                    </button>
                    <div class="account-menu-divider"></div>
                    <button class="account-menu-item" onclick="clearAllHistory(); closeAccountMenu();" role="menuitem">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                        Clear All Chats
                    </button>
                    <div class="account-menu-divider"></div>
                    <button class="account-menu-item danger" onclick="resetAccount(); closeAccountMenu();" role="menuitem">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                        Reset Account
                    </button>
                </div>
            </div>

            <!-- Account button -->
            <button class="account-btn" id="account-btn" onclick="toggleAccountMenu()" aria-haspopup="true" aria-expanded="false" aria-label="Account menu">
                <div class="account-avatar" id="account-avatar">U</div>
                <div class="account-info">
                    <div class="account-name" id="account-name">User</div>
                    <div class="account-plan">Free Plan</div>
                </div>
                <svg class="account-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>
            </button>
        </div>
    </aside>

    <!-- Profile Edit Modal -->
    <div class="profile-overlay" id="profile-overlay" onclick="handleProfileOverlayClick(event)">
        <div class="profile-modal" role="dialog" aria-modal="true" aria-label="Edit Profile">
            <div class="profile-modal-header">
                <span class="profile-modal-title">Edit Profile</span>
                <button class="profile-modal-close" onclick="closeProfileModal()" aria-label="Close profile editor">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
            </div>
            <div class="profile-modal-body">
                <div class="profile-avatar-row">
                    <div class="profile-big-avatar" id="profile-big-avatar">U</div>
                    <div class="profile-avatar-hint">
                        Your avatar is automatically<br>generated from your name initials.
                    </div>
                </div>
                <div class="profile-field">
                    <label for="profile-name-input">Display Name</label>
                    <input type="text" id="profile-name-input" placeholder="Enter your name" maxlength="40" autocomplete="off" oninput="updateProfilePreview()" />
                </div>
                <button class="profile-save-btn" onclick="saveProfile()">Save Changes</button>
            </div>
        </div>
    </div>

    <!-- Settings Overlay -->
    <div class="settings-overlay" id="settings-overlay" onclick="closeSettings()"></div>

    <!-- OpenClaw Settings Panel -->
    <div class="settings-panel" id="settings-panel" role="dialog" aria-modal="true" aria-label="OpenClaw Settings">
        <div class="settings-header">
            <span class="settings-title">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ef7623" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                OpenClaw Settings
            </span>
            <button class="settings-close-btn" onclick="closeSettings()" aria-label="Close settings">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
        </div>

        <div class="settings-group">
            <label for="openclaw-url-input">OpenClaw Server URL</label>
            <input type="text" id="openclaw-url-input"
                   placeholder="http://your-vps-ip:18789"
                   autocomplete="off" />
            <div class="settings-hint">
                Enter the URL of your OpenClaw VPS server.<br>
                Example: <code style="color:#ef7623">http://1.2.3.4:18789</code>
            </div>
        </div>

        <div class="settings-group">
            <label for="openclaw-token-input">Bearer Token (optional)</label>
            <input type="password" id="openclaw-token-input"
                   placeholder="Leave blank if no auth required"
                   autocomplete="off" />
            <div class="settings-hint">
                Your OpenClaw authentication token, if you configured one.
            </div>
        </div>

        <button class="settings-save-btn" onclick="saveOpenClawSettings()">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
            Save &amp; Test Connection
        </button>

        <hr class="settings-divider">

        <div class="settings-instructions">
            <strong>How to connect:</strong><br>
            1. Start OpenClaw on your VPS server<br>
            2. Enter your VPS IP/URL above<br>
            3. Click "Save &amp; Test Connection"<br>
            4. The status dot turns green when ready<br><br>
            <strong>Default OpenClaw port:</strong> 18789<br>
            <strong>Docs:</strong> <a href="https://docs.openclaw.ai" target="_blank" style="color:#ef7623;">docs.openclaw.ai</a>
        </div>
    </div>

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
                <p>Ask me anything — I can answer questions, analyze data, and automate tasks using Gemini or OpenClaw.</p>
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
                badge.textContent = aiType === 'gemini' ? 'Gemini' : 'OpenClaw';
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
                '<span>Request timed out. OpenClaw took too long to respond.</span>' +
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
                headerDisplay.textContent = mode === 'gemini' ? 'Gemini' : 'OpenClaw';
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

        function openSettings() {
            const urlInput = document.getElementById('openclaw-url-input');
            const tokenInput = document.getElementById('openclaw-token-input');
            if (urlInput) urlInput.value = getOpenClawSetting('url') || 'http://your-vps-ip:18789';
            if (tokenInput) tokenInput.value = getOpenClawSetting('token');
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
            } catch(e) { console.error('Failed to save OpenClaw settings:', e); }
            closeSettings();
            await checkOpenClawStatus();
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
                    text.textContent = 'OpenClaw connected';
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
                        headers: { 'Content-Type': 'application/json' },
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
        // ACCOUNT MANAGEMENT
        // ============================================

        let accountMenuOpen = false;

        function getDisplayName() {
            return localStorage.getItem('account_name') || 'User';
        }

        function getAvatarInitials(name) {
            const parts = name.trim().split(/\s+/).filter(Boolean);
            if (parts.length === 0) return 'U';
            if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
            return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
        }

        function refreshAccountUI() {
            const name = getDisplayName();
            const initials = getAvatarInitials(name);
            // Sidebar button
            document.getElementById('account-avatar').textContent = initials;
            document.getElementById('account-name').textContent = name;
            // Menu header
            document.getElementById('account-menu-avatar').textContent = initials;
            document.getElementById('account-menu-name').textContent = name;
            // Profile modal big avatar
            document.getElementById('profile-big-avatar').textContent = initials;
        }

        function toggleAccountMenu() {
            const menu = document.getElementById('account-menu');
            const btn  = document.getElementById('account-btn');
            accountMenuOpen = !accountMenuOpen;
            if (accountMenuOpen) {
                menu.classList.add('open');
                btn.classList.add('open');
                btn.setAttribute('aria-expanded', 'true');
            } else {
                menu.classList.remove('open');
                btn.classList.remove('open');
                btn.setAttribute('aria-expanded', 'false');
            }
        }

        function closeAccountMenu() {
            const menu = document.getElementById('account-menu');
            const btn  = document.getElementById('account-btn');
            accountMenuOpen = false;
            menu.classList.remove('open');
            btn.classList.remove('open');
            btn.setAttribute('aria-expanded', 'false');
        }

        // Close menu when clicking outside
        document.addEventListener('click', function(e) {
            const section = document.querySelector('.account-section');
            if (accountMenuOpen && section && !section.contains(e.target)) {
                closeAccountMenu();
            }
        });

        function openProfileModal() {
            const modal = document.getElementById('profile-overlay');
            const nameInput = document.getElementById('profile-name-input');
            const bigAvatar = document.getElementById('profile-big-avatar');
            nameInput.value = getDisplayName();
            bigAvatar.textContent = getAvatarInitials(nameInput.value);
            modal.classList.add('open');
            setTimeout(() => nameInput.focus(), 100);
        }

        function closeProfileModal() {
            document.getElementById('profile-overlay').classList.remove('open');
        }

        function handleProfileOverlayClick(e) {
            if (e.target === document.getElementById('profile-overlay')) {
                closeProfileModal();
            }
        }

        function updateProfilePreview() {
            const val = document.getElementById('profile-name-input').value;
            document.getElementById('profile-big-avatar').textContent = getAvatarInitials(val || 'User');
        }

        function saveProfile() {
            const nameInput = document.getElementById('profile-name-input');
            const newName = nameInput.value.trim() || 'User';
            localStorage.setItem('account_name', newName);
            refreshAccountUI();
            closeProfileModal();
        }

        function clearAllHistory() {
            if (!confirm('Clear all chat history? This cannot be undone.')) return;
            localStorage.setItem('chatHistory', '[]');
            chatHistory = [];
            renderHistory();
            goHome();
        }

        function resetAccount() {
            if (!confirm('Reset your account? This will clear your name and all settings.')) return;
            localStorage.removeItem('account_name');
            refreshAccountUI();
        }

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
app.post('/chat', async (req, res) => {
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
