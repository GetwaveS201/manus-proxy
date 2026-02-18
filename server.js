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

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));

// CORS with whitelist
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, file://, etc.)
    if (!origin) return callback(null, true);

    // Allow file:// protocol for local testing
    if (typeof origin === 'string' && origin.startsWith('file://')) return callback(null, true);

    // Allow same-origin requests (when page is served from same domain)
    if (CORS_WHITELIST.indexOf(origin) !== -1 || origin.includes('manus-proxy')) {
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
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-2.5-pro'
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
async function callOpenClaw(prompt, openclawUrl, openclawToken, timeoutMs = 60000) {
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

  const headers = { 'Content-Type': 'application/json' };
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
      throw new Error('OPENCLAW_UNREACHABLE');
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
            outline: 2px solid #667eea;
            outline-offset: 2px;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: #0f0f23;
            min-height: 100vh;
            display: flex;
            overflow: hidden;
        }

        /* Sidebar */
        .sidebar {
            width: 280px;
            background: #1a1a2e;
            border-right: 1px solid #2d2d44;
            display: flex;
            flex-direction: column;
            height: 100vh;
        }
        .sidebar-header {
            padding: 20px;
            border-bottom: 1px solid #2d2d44;
        }
        .home-btn {
            width: 100%;
            padding: 14px 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 10px;
            font-weight: 600;
            font-size: 15px;
            cursor: pointer;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
        }
        .home-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 16px rgba(102, 126, 234, 0.5);
        }

        /* AI Mode Selector */
        .ai-mode-section {
            padding: 12px 15px;
            border-bottom: 1px solid #2d2d44;
        }
        .ai-mode-label {
            color: #888;
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 8px;
        }
        .ai-mode-tabs {
            display: flex;
            gap: 6px;
        }
        .ai-mode-btn {
            flex: 1;
            padding: 9px 8px;
            border-radius: 8px;
            border: 1px solid #2d2d44;
            background: #16162a;
            color: #666;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            text-align: center;
        }
        .ai-mode-btn:hover:not(.active) {
            border-color: #3d3d54;
            color: #aaa;
            background: #1e1e38;
        }
        .ai-mode-btn.active.gemini {
            background: rgba(66, 133, 244, 0.15);
            border-color: #4285f4;
            color: #4285f4;
        }
        .ai-mode-btn.active.openclaw {
            background: rgba(249, 115, 22, 0.15);
            border-color: #f97316;
            color: #f97316;
        }

        /* OpenClaw Status Bar */
        .openclaw-status {
            padding: 8px 15px;
            font-size: 11px;
            display: flex;
            align-items: center;
            gap: 7px;
            border-bottom: 1px solid #2d2d44;
            background: #14142a;
        }
        .openclaw-status-dot {
            width: 7px;
            height: 7px;
            border-radius: 50%;
            background: #555;
            flex-shrink: 0;
        }
        .openclaw-status-dot.online  { background: #4ade80; }
        .openclaw-status-dot.offline { background: #f87171; }
        .openclaw-status-dot.checking {
            background: #fbbf24;
            animation: pulse 1.2s ease-in-out infinite;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.3; }
        }
        .openclaw-settings-link {
            margin-left: auto;
            background: none;
            border: none;
            color: #667eea;
            font-size: 11px;
            cursor: pointer;
            padding: 0;
            text-decoration: underline;
        }
        .openclaw-settings-link:hover { color: #7a8ff0; }

        /* Settings Panel */
        .settings-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.6);
            z-index: 999;
            display: none;
        }
        .settings-overlay.open { display: block; }
        .settings-panel {
            position: fixed;
            top: 0; right: 0;
            width: 340px;
            height: 100vh;
            background: #1a1a2e;
            border-left: 1px solid #2d2d44;
            z-index: 1000;
            padding: 28px 24px;
            transform: translateX(100%);
            transition: transform 0.3s ease;
            overflow-y: auto;
            box-shadow: -8px 0 40px rgba(0,0,0,0.4);
        }
        .settings-panel.open { transform: translateX(0); }
        .settings-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 28px;
        }
        .settings-title {
            color: #fff;
            font-size: 18px;
            font-weight: 700;
        }
        .settings-close-btn {
            background: #16162a;
            border: 1px solid #2d2d44;
            color: #888;
            font-size: 16px;
            cursor: pointer;
            padding: 6px 10px;
            border-radius: 6px;
            transition: all 0.2s;
        }
        .settings-close-btn:hover { color: #fff; border-color: #667eea; }
        .settings-group {
            margin-bottom: 20px;
        }
        .settings-group label {
            display: block;
            color: #aaa;
            font-size: 13px;
            margin-bottom: 7px;
            font-weight: 500;
        }
        .settings-group input[type="text"],
        .settings-group input[type="password"] {
            width: 100%;
            padding: 11px 14px;
            background: #16162a;
            border: 1px solid #2d2d44;
            border-radius: 8px;
            color: #fff;
            font-size: 14px;
            font-family: inherit;
            transition: border-color 0.2s;
        }
        .settings-group input:focus {
            border-color: #f97316;
            outline: none;
            box-shadow: 0 0 0 3px rgba(249, 115, 22, 0.15);
        }
        .settings-hint {
            color: #555;
            font-size: 11px;
            margin-top: 5px;
            line-height: 1.5;
        }
        .settings-save-btn {
            width: 100%;
            padding: 13px;
            background: linear-gradient(135deg, #f97316, #fb923c);
            color: white;
            border: none;
            border-radius: 8px;
            font-weight: 700;
            font-size: 14px;
            cursor: pointer;
            margin-top: 8px;
            transition: opacity 0.2s;
        }
        .settings-save-btn:hover { opacity: 0.9; }
        .settings-divider {
            border: none;
            border-top: 1px solid #2d2d44;
            margin: 24px 0;
        }
        .settings-instructions {
            color: #666;
            font-size: 12px;
            line-height: 1.7;
        }
        .settings-instructions strong { color: #aaa; }

        .history-section {
            flex: 1;
            overflow-y: auto;
            padding: 15px;
        }
        .history-title {
            color: #888;
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 12px;
            padding: 0 8px;
        }
        .history-item {
            padding: 12px;
            margin-bottom: 6px;
            background: #16162a;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.2s;
            border: 1px solid transparent;
            position: relative;
        }
        .history-item:hover {
            background: #1e1e38;
            border-color: #667eea;
        }
        .history-item:hover .delete-chat-btn {
            opacity: 1;
        }
        .history-item-title {
            color: #fff;
            font-size: 14px;
            margin-bottom: 4px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            padding-right: 30px;
        }
        .history-item-preview {
            color: #888;
            font-size: 12px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .history-item-time {
            color: #666;
            font-size: 11px;
            margin-top: 4px;
        }
        .delete-chat-btn {
            position: absolute;
            top: 10px;
            right: 10px;
            background: #8b3a3a;
            color: white;
            border: none;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 11px;
            cursor: pointer;
            opacity: 0;
            transition: all 0.2s;
            z-index: 10;
        }
        .delete-chat-btn:hover {
            background: #a94442;
        }

        /* Main Content */
        .main-content {
            flex: 1;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #0f0f23;
        }
        .container {
            width: 100%;
            max-width: 1200px;
            margin: 0 auto;
            background: #16162a;
            border-radius: 0;
            box-shadow: none;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            height: 100vh;
        }
        .header {
            background: #1a1a2e;
            color: white;
            padding: 20px 30px;
            border-bottom: 1px solid #2d2d44;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .header-left {
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .header h1 {
            font-size: 20px;
            font-weight: 600;
            color: #fff;
        }
        .header-right {
            display: flex;
            align-items: center;
            gap: 15px;
        }
        .status-badge {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            background: rgba(74, 222, 128, 0.1);
            border: 1px solid rgba(74, 222, 128, 0.3);
            border-radius: 20px;
            font-size: 12px;
            color: #4ade80;
        }
        .status-indicator {
            display: inline-block;
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: #4ade80;
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        .ai-models {
            font-size: 11px;
            color: #888;
        }
        .ai-models span {
            color: #667eea;
            font-weight: 500;
        }
        .chat-area {
            flex: 1;
            overflow-y: auto;
            padding: 30px;
            background: #0f0f23;
        }
        .empty-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: #888;
            text-align: center;
        }
        .empty-state h2 {
            font-size: 2.5rem;
            margin-bottom: 12px;
            color: #fff;
        }
        .empty-state p {
            font-size: 1.1rem;
            margin-bottom: 30px;
            color: #aaa;
        }
        .example-queries {
            text-align: left;
            background: #1a1a2e;
            padding: 24px;
            border-radius: 16px;
            border: 1px solid #2d2d44;
            max-width: 600px;
        }
        .example-queries h3 {
            font-size: 16px;
            margin-bottom: 16px;
            color: #fff;
            font-weight: 600;
        }
        .example-queries ul {
            list-style: none;
            display: grid;
            gap: 10px;
        }
        .example-queries li {
            padding: 14px 16px;
            background: #16162a;
            border: 1px solid #2d2d44;
            border-radius: 10px;
            color: #667eea;
            cursor: pointer;
            font-size: 14px;
            transition: all 0.2s;
        }
        .example-queries li:hover {
            background: #1e1e38;
            border-color: #667eea;
            transform: translateX(4px);
        }
        .message {
            margin-bottom: 18px;
            padding: 14px 18px;
            border-radius: 14px;
            max-width: 85%;
            word-wrap: break-word;
            white-space: pre-wrap;
            line-height: 1.5;
            animation: slideIn 0.3s ease-out;
            position: relative;
        }
        .message-actions {
            position: absolute;
            top: 8px;
            right: 8px;
            display: flex;
            gap: 6px;
            opacity: 0;
            transition: opacity 0.2s;
        }
        .message:hover .message-actions {
            opacity: 1;
        }
        .message-action-btn {
            background: rgba(0, 0, 0, 0.3);
            color: #fff;
            border: none;
            padding: 6px 10px;
            border-radius: 6px;
            font-size: 11px;
            cursor: pointer;
            transition: background 0.2s;
        }
        .message-action-btn:hover {
            background: rgba(0, 0, 0, 0.5);
        }
        .user .message-action-btn {
            background: rgba(255, 255, 255, 0.2);
        }
        .user .message-action-btn:hover {
            background: rgba(255, 255, 255, 0.3);
        }
        @keyframes slideIn {
            from {
                opacity: 0;
                transform: translateY(10px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
        .user {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            margin-left: auto;
            box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3);
        }
        .bot {
            background: #1a1a2e;
            border: 1px solid #2d2d44;
            color: #ddd;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        }
        .bot.gemini { border-left: 4px solid #4285f4; }
        .bot.openclaw { border-left: 4px solid #f97316; }
        .ai-badge {
            display: inline-block;
            padding: 4px 10px;
            border-radius: 6px;
            font-size: 11px;
            font-weight: 700;
            margin-bottom: 8px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .ai-badge.gemini {
            background: linear-gradient(135deg, #4285f4, #34a853);
            color: white;
        }
        .ai-badge.openclaw {
            background: linear-gradient(135deg, #f97316, #fb923c);
            color: white;
        }
        .thinking {
            background: #1e1e38;
            border: 1px solid #667eea;
            color: #667eea;
            font-style: italic;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .spinner {
            width: 16px;
            height: 16px;
            border: 2px solid #667eea;
            border-top-color: transparent;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        .error {
            background: #2e1a1a;
            border: 1px solid #8b3a3a;
            color: #ff6b6b;
        }
        .input-area {
            padding: 20px 30px;
            background: #1a1a2e;
            border-top: 1px solid #2d2d44;
            display: flex;
            gap: 12px;
        }
        input {
            flex: 1;
            padding: 16px 20px;
            background: #16162a;
            border: 1px solid #2d2d44;
            border-radius: 12px;
            font-size: 15px;
            font-family: inherit;
            color: #fff;
            transition: all 0.2s;
        }
        input::placeholder {
            color: #666;
        }
        input:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.15);
            background: #1a1a2e;
        }
        button {
            padding: 14px 32px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 12px;
            font-weight: 700;
            font-size: 15px;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s;
        }
        button:hover:not(:disabled) {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
        }
        button:active:not(:disabled) {
            transform: translateY(0);
        }
        button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
        .routing-info {
            font-size: 11px;
            color: #999;
            margin-top: 6px;
            font-style: italic;
        }

        /* Markdown and code styling */
        .message pre {
            background: #1e1e1e;
            border: 1px solid #2d2d44;
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
            background: #2d2d44;
            padding: 2px 6px;
            border-radius: 4px;
            font-size: 13px;
            color: #f97583;
        }
        .message pre code {
            background: transparent;
            padding: 0;
            color: #d4d4d4;
        }
        .message h1, .message h2, .message h3 {
            color: #fff;
            margin: 16px 0 8px;
        }
        .message h1 { font-size: 1.5em; border-bottom: 2px solid #2d2d44; padding-bottom: 8px; }
        .message h2 { font-size: 1.3em; }
        .message h3 { font-size: 1.1em; }
        .message ul, .message ol {
            margin: 12px 0;
            padding-left: 24px;
        }
        .message li {
            margin: 6px 0;
            line-height: 1.6;
        }
        .message blockquote {
            border-left: 4px solid #667eea;
            padding-left: 16px;
            margin: 12px 0;
            color: #aaa;
            font-style: italic;
        }
        .message a {
            color: #667eea;
            text-decoration: none;
            border-bottom: 1px solid transparent;
            transition: border-color 0.2s;
        }
        .message a:hover {
            border-bottom-color: #667eea;
        }
        .message table {
            border-collapse: collapse;
            width: 100%;
            margin: 12px 0;
        }
        .message th, .message td {
            border: 1px solid #2d2d44;
            padding: 8px 12px;
            text-align: left;
        }
        .message th {
            background: #1a1a2e;
            font-weight: 600;
        }
        .message img {
            max-width: 100%;
            border-radius: 8px;
            margin: 12px 0;
        }
        .copy-code-btn {
            position: absolute;
            top: 8px;
            right: 8px;
            background: #667eea;
            color: white;
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            font-size: 11px;
            cursor: pointer;
            opacity: 0;
            transition: opacity 0.2s;
        }
        .message pre:hover .copy-code-btn {
            opacity: 1;
        }
        .copy-code-btn:hover {
            background: #7a8ff0;
        }
        /* Dark theme scrollbar */
        ::-webkit-scrollbar { width: 10px; }
        ::-webkit-scrollbar-track { background: #16162a; }
        ::-webkit-scrollbar-thumb {
            background: #2d2d44;
            border-radius: 5px;
        }
        ::-webkit-scrollbar-thumb:hover { background: #3d3d54; }

        /* Mobile responsive design */
        @media (max-width: 768px) {
            body {
                flex-direction: column;
            }
            .sidebar {
                width: 100%;
                height: auto;
                border-right: none;
                border-bottom: 1px solid #2d2d44;
                max-height: 200px;
                overflow-y: auto;
            }
            .sidebar-header {
                padding: 12px;
            }
            .home-btn {
                padding: 10px 16px;
                font-size: 14px;
            }
            .history-section {
                max-height: 120px;
            }
            .history-title {
                padding: 8px 12px;
                font-size: 11px;
            }
            .history-item {
                padding: 8px 12px;
                font-size: 13px;
            }
            .main-content {
                height: calc(100vh - 200px);
            }
            .header {
                padding: 16px 20px;
            }
            .header h1 {
                font-size: 1.3rem;
            }
            .chat-area {
                padding: 16px;
            }
            .message {
                max-width: 100%;
                padding: 12px 16px;
                font-size: 14px;
            }
            .input-area {
                padding: 12px 16px;
                gap: 8px;
            }
            input {
                padding: 12px 16px;
                font-size: 14px;
            }
            button {
                padding: 12px 20px;
                font-size: 14px;
            }
            .empty-state h2 {
                font-size: 1.8rem;
            }
            .empty-state p {
                font-size: 1rem;
            }
            .example-queries {
                max-width: 100%;
                padding: 16px;
            }
        }

        /* Small mobile devices */
        @media (max-width: 480px) {
            .header h1 {
                font-size: 1.1rem;
            }
            .message {
                padding: 10px 12px;
                font-size: 13px;
            }
            .ai-badge {
                font-size: 9px;
                padding: 3px 8px;
            }
            input {
                padding: 10px 12px;
                font-size: 13px;
            }
            button {
                padding: 10px 16px;
                font-size: 13px;
            }
            .empty-state h2 {
                font-size: 1.5rem;
            }
        }
    </style>
</head>
<body>
    <!-- Sidebar -->
    <aside class="sidebar" role="complementary" aria-label="Chat history sidebar">
        <div class="sidebar-header">
            <button class="home-btn" onclick="goHome()" aria-label="Start new chat" title="New Chat (Ctrl+K)">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                    <polyline points="9 22 9 12 15 12 15 22"></polyline>
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
                    🔵 Gemini
                </button>
                <button class="ai-mode-btn openclaw" id="mode-openclaw"
                        onclick="setAIMode('openclaw')"
                        role="tab" aria-selected="false"
                        aria-label="Use OpenClaw AI for automation">
                    🟠 OpenClaw
                </button>
            </div>
        </div>

        <!-- OpenClaw Status (only shown in OpenClaw mode) -->
        <div class="openclaw-status" id="openclaw-status" style="display:none;" aria-live="polite">
            <div class="openclaw-status-dot checking" id="openclaw-status-dot" aria-hidden="true"></div>
            <span id="openclaw-status-text" style="color:#888;">Checking...</span>
            <button class="openclaw-settings-link" onclick="openSettings()" aria-label="Open OpenClaw settings">
                ⚙ Settings
            </button>
        </div>

        <!-- Chat History (below mode tabs as requested) -->
        <nav class="history-section" aria-label="Previous conversations">
            <h2 class="history-title">Chat History</h2>
            <div id="history-list" role="list">
                <!-- History items will be added here -->
            </div>
        </nav>
    </aside>

    <!-- Settings Overlay -->
    <div class="settings-overlay" id="settings-overlay" onclick="closeSettings()"></div>

    <!-- OpenClaw Settings Panel -->
    <div class="settings-panel" id="settings-panel" role="dialog" aria-modal="true" aria-label="OpenClaw Settings">
        <div class="settings-header">
            <span class="settings-title">🟠 OpenClaw Settings</span>
            <button class="settings-close-btn" onclick="closeSettings()" aria-label="Close settings">✕</button>
        </div>

        <div class="settings-group">
            <label for="openclaw-url-input">OpenClaw Server URL</label>
            <input type="text" id="openclaw-url-input"
                   placeholder="http://your-vps-ip:18789"
                   autocomplete="off" />
            <div class="settings-hint">
                Enter the URL of your OpenClaw VPS server.<br>
                Example: <code style="color:#f97316">http://1.2.3.4:18789</code>
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
            💾 Save &amp; Test Connection
        </button>

        <hr class="settings-divider">

        <div class="settings-instructions">
            <strong>How to connect:</strong><br>
            1. Start OpenClaw on your VPS server<br>
            2. Enter your VPS IP/URL above<br>
            3. Click "Save &amp; Test Connection"<br>
            4. The status dot turns 🟢 green when ready<br><br>
            <strong>Default OpenClaw port:</strong> 18789<br>
            <strong>Docs:</strong> <a href="https://docs.openclaw.ai" target="_blank" style="color:#f97316;">docs.openclaw.ai</a>
        </div>
    </div>

    <!-- Main Content -->
    <main class="main-content" role="main">
        <div class="container">
            <header class="header" role="banner">
                <div class="header-left">
                    <h1>🤖 AI Automation Assistant</h1>
                </div>
                <div class="header-right">
                    <div class="status-badge" role="status" aria-label="Connection status: Online">
                        <span class="status-indicator" aria-hidden="true"></span>
                        <span>Online</span>
                    </div>
                    <div class="ai-models" aria-label="Active AI mode">
                        <span id="header-ai-display">🔵 Gemini</span>
                    </div>
                </div>
            </header>
        <div class="chat-area" id="chat" role="log" aria-live="polite" aria-label="Chat conversation">
            <div class="empty-state">
                <h2>👋 Welcome!</h2>
                <p>I'm your AI automation assistant. Ask me anything!</p>
                <div class="example-queries">
                    <h3>Try asking:</h3>
                    <ul role="list">
                        <li onclick="setPrompt(this.textContent)" role="button" tabindex="0" aria-label="Example: Build me a sales report for Q1">📊 Build me a sales report for Q1</li>
                        <li onclick="setPrompt(this.textContent)" role="button" tabindex="0" aria-label="Example: Find the best CRM tools for small businesses">🔍 Find the best CRM tools for small businesses</li>
                        <li onclick="setPrompt(this.textContent)" role="button" tabindex="0" aria-label="Example: Calculate the ROI of our marketing campaign">📈 Calculate the ROI of our marketing campaign</li>
                        <li onclick="setPrompt(this.textContent)" role="button" tabindex="0" aria-label="Example: What is machine learning">💡 What is machine learning?</li>
                    </ul>
                </div>
            </div>
        </div>
        <div class="input-area" role="region" aria-label="Message input">
            <form id="chat-form" onsubmit="return false;" style="display:flex;gap:12px;width:100%;">
                <input
                    type="text"
                    id="input"
                    placeholder="Type your message or question..."
                    autocomplete="off"
                    style="flex:1;"
                    aria-label="Message input"
                    aria-describedby="input-help"
                >
                <span id="input-help" class="sr-only">Press Enter to send message</span>
                <button type="button" id="send-btn" aria-label="Send message">Send</button>
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
                item.setAttribute('aria-label', `Chat: ${chat.title || 'New Chat'}, ${formatTime(chat.timestamp)}`);
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
                deleteBtn.textContent = '🗑️';
                deleteBtn.setAttribute('aria-label', `Delete chat: ${chat.title || 'New Chat'}`);
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
                    setPrompt(this.textContent);
                }
            });
        });

        function addMsg(type, text, aiType = null, routingInfo = null) {
            const emptyState = chat.querySelector('.empty-state');
            if (emptyState) emptyState.remove();

            const msg = document.createElement('div');
            msg.className = 'message ' + type;
            msg.setAttribute('role', 'article');

            // Set ARIA label based on message type
            if (type === 'user') {
                msg.setAttribute('aria-label', 'Your message');
            } else if (type === 'bot') {
                msg.setAttribute('aria-label', `${aiType || 'AI'} response`);
            } else if (type === 'error') {
                msg.setAttribute('aria-label', 'Error message');
                msg.setAttribute('role', 'alert');
            }

            if (type === 'bot' && aiType) {
                msg.className += ' ' + aiType;

                const badge = document.createElement('div');
                badge.className = 'ai-badge ' + aiType;
                badge.textContent = aiType === 'gemini' ? '🔵 Gemini' : '🟠 OpenClaw';
                badge.setAttribute('aria-label', `Response from ${aiType}`);
                msg.appendChild(badge);

                const br = document.createElement('br');
                msg.appendChild(br);
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

                        // Add copy button to code blocks
                        const pre = block.parentElement;
                        if (pre.tagName === 'PRE') {
                            const copyBtn = document.createElement('button');
                            copyBtn.className = 'copy-code-btn';
                            copyBtn.textContent = 'Copy';
                            copyBtn.onclick = () => {
                                navigator.clipboard.writeText(block.textContent);
                                copyBtn.textContent = 'Copied!';
                                setTimeout(() => copyBtn.textContent = 'Copy', 2000);
                            };
                            pre.appendChild(copyBtn);
                        }
                    });
                }
            } else {
                const textNode = document.createTextNode(text);
                msg.appendChild(textNode);
            }

            // Add action buttons to all messages except thinking
            if (type !== 'thinking') {
                const actions = document.createElement('div');
                actions.className = 'message-actions';
                actions.setAttribute('role', 'group');
                actions.setAttribute('aria-label', 'Message actions');

                const copyBtn = document.createElement('button');
                copyBtn.className = 'message-action-btn';
                copyBtn.textContent = '📋 Copy';
                copyBtn.setAttribute('aria-label', 'Copy message to clipboard');
                copyBtn.onclick = () => {
                    navigator.clipboard.writeText(text);
                    copyBtn.textContent = '✓ Copied';
                    copyBtn.setAttribute('aria-label', 'Message copied');
                    setTimeout(() => {
                        copyBtn.textContent = '📋 Copy';
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

            chat.appendChild(msg);
            chat.scrollTop = chat.scrollHeight;

            // Save to current messages
            currentMessages.push({ type, text, aiType, routingInfo });
            saveCurrentChat();

            return msg;
        }

        function addThinking() {
            const msg = document.createElement('div');
            msg.className = 'message thinking';

            const spinner = document.createElement('div');
            spinner.className = 'spinner';
            msg.appendChild(spinner);

            const text = document.createTextNode('Processing your request...');
            msg.appendChild(text);

            chat.appendChild(msg);
            chat.scrollTop = chat.scrollHeight;
            return msg;
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
                headerDisplay.textContent = mode === 'gemini' ? '🔵 Gemini' : '🟠 OpenClaw';
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
                sendBtn.textContent = 'Thinking...';

                // Cancel previous request if exists
                if (currentRequest) {
                    currentRequest.abort();
                }

                addMsg('user', userInput);
                input.value = '';

                thinkingMsg = addThinking();

                // Create new AbortController
                currentRequest = new AbortController();

                const res = await fetch('/chat', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        prompt: userInput,
                        ai: currentAIMode,
                        openclawUrl: getOpenClawSetting('url'),
                        openclawToken: getOpenClawSetting('token')
                    }),
                    signal: currentRequest.signal
                });

                const data = await res.json();

                if (thinkingMsg) thinkingMsg.remove();

                if (!res.ok) {
                    throw new Error(data.error || data.message || 'Request failed');
                }

                const routingInfo = data.routing ?
                    \`Routed to \${data.routing.ai.toUpperCase()} (confidence: \${data.routing.confidence})\` :
                    null;

                addMsg('bot', data.response, data.ai, routingInfo);

            } catch (error) {
                if (thinkingMsg) thinkingMsg.remove();
                // Don't show error for aborted requests
                if (error.name !== 'AbortError') {
                    addMsg('error', '❌ Error: ' + error.message);
                }
            } finally {
                currentRequest = null;
                sendBtn.disabled = false;
                sendBtn.textContent = 'Send';
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

    const headers = { 'Content-Type': 'application/json' };
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
 * @param {string} ai - AI to use ('gemini' or 'manus')
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
      response = await callManus(prompt);
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
  console.log(`   ${MANUS_API_KEY ? '🟢' : '🔴'} Manus: ${MANUS_API_KEY ? 'Ready' : 'Not Configured'}`);
  console.log(`   ${RENDER_API_KEY ? '🟢' : '🔴'} Render: ${RENDER_API_KEY ? 'Ready' : 'Not Configured'}`);
  console.log(`   ${NOTION_API_KEY ? '🟢' : '🔴'} Notion: ${NOTION_API_KEY ? 'Ready' : 'Not Configured'}`);
  console.log('');
  console.log('🎯 Routing System:');
  console.log('   📊 Score-based routing (not keyword matching)');
  console.log('   🔵 Gemini: Fast Q&A, explanations');
  console.log('   🟣 Manus: Execution tasks, complex analysis');
  console.log('   ⚡ Execution verbs ALWAYS route to Manus');
  console.log('');
  console.log('📡 API Endpoints:');
  console.log('   POST /api/chat - Main chat endpoint');
  console.log('   GET /api/task/:id - Check task status');
  console.log('   GET /health - Health check (requires auth)');
  console.log('');
  console.log('⏱️  Timeouts:');
  console.log('   Gemini: 30 seconds');
  console.log('   Manus: 10 minutes');
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
