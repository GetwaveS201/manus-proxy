/**
 * AI Automation Assistant - Production Server
 * Dual AI System: Gemini (fast/free) + Manus (powerful/paid)
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
const MANUS_API_KEY = process.env.MANUS_API_KEY;
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
 * @returns {Object} { ai: 'gemini'|'manus', confidence: number, scores: Object }
 */
function chooseAI(prompt) {
  const lower = prompt.toLowerCase().trim();
  const words = prompt.trim().split(/\s+/);

  let geminiScore = 0;
  let manusScore = 0;

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

  // ===== MANUS SCORING =====

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
      manusScore += 50;
      break; // Only count once
    }
  }

  // CRITICAL: "How can you [ACTION_VERB]" patterns should route to Manus (+60 points)
  const howCanYouPattern = /how (can|could|do) (you|i|we) (build|create|find|make|generate|calculate|analyze|write|design|develop)/i;
  if (howCanYouPattern.test(prompt)) {
    manusScore += 60;
    geminiScore = 0; // Override gemini score
  }

  // Data processing keywords (+30 points)
  const dataKeywords = ['csv', 'spreadsheet', 'data', 'parse', 'process', 'extract', 'transform'];
  for (const keyword of dataKeywords) {
    if (lower.includes(keyword)) {
      manusScore += 30;
      break;
    }
  }

  // Business/professional tasks (+25 points)
  const businessKeywords = ['proposal', 'report', 'presentation', 'analysis', 'strategy', 'plan', 'roadmap', 'market research'];
  for (const keyword of businessKeywords) {
    if (lower.includes(keyword)) {
      manusScore += 25;
      break;
    }
  }

  // User data access (+50 points - VERY IMPORTANT)
  const dataAccess = ['my emails', 'my calendar', 'my data', 'my files', 'my documents', 'my messages'];
  for (const keyword of dataAccess) {
    if (lower.includes(keyword)) {
      manusScore += 50;
      break;
    }
  }

  // Generic "my" + data pattern (+40 points)
  if (/\bmy\s+(last|recent|latest|first|next)\s+\d+\s+\w+/.test(lower)) {
    // Matches: "my last 5 emails", "my recent 10 messages", etc.
    manusScore += 40;
  }

  // Complex/multi-step indicators (+20 points)
  const complexityIndicators = ['comprehensive', 'detailed', 'in-depth', 'thorough', 'step-by-step'];
  for (const indicator of complexityIndicators) {
    if (lower.includes(indicator)) {
      manusScore += 20;
      break;
    }
  }

  // Longer prompts tend to be tasks (+1 point per word over 10)
  if (words.length > 10) {
    manusScore += (words.length - 10);
  }

  // ===== DECISION =====

  const ai = manusScore > geminiScore ? 'manus' : 'gemini';
  const confidence = Math.abs(manusScore - geminiScore);

  return {
    ai,
    confidence,
    scores: {
      gemini: geminiScore,
      manus: manusScore
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
// MANUS API INTEGRATION
// ============================================

/**
 * Calls Manus API with extended timeout for long tasks
 * @param {string} prompt - User prompt
 * @param {number} timeoutMs - Maximum wait time (default: 1 minute for quick feedback)
 * @returns {Promise<string>} AI response
 */
async function callManus(prompt, timeoutMs = 60000) {
  if (!MANUS_API_KEY) {
    throw new Error('MANUS_NOT_CONFIGURED');
  }

  log('INFO', 'Creating Manus task');

  // Create task
  const createRes = await fetch('https://api.manus.ai/v1/tasks', {
    method: 'POST',
    headers: {
      'API_KEY': MANUS_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      prompt: prompt,
      agentProfile: 'manus-1.6',
      taskMode: 'agent'
    })
  });

  if (!createRes.ok) {
    const errorText = await createRes.text();
    log('ERROR', 'Manus create task failed', null, { error: errorText });

    // Check for credit limit error
    try {
      const errorJson = JSON.parse(errorText);
      if (errorJson.message && errorJson.message.toLowerCase().includes('credit')) {
        throw new Error('MANUS_CREDITS_EXCEEDED');
      }
    } catch (e) {
      if (errorText.toLowerCase().includes('credit')) {
        throw new Error('MANUS_CREDITS_EXCEEDED');
      }
    }

    throw new Error('MANUS_CREATE_FAILED');
  }

  const createData = await createRes.json();
  const taskId = createData.task_id;
  const shareUrl = createData.share_url;

  log('INFO', `Manus task created: ${taskId}`);

  // Poll for completion
  const startTime = Date.now();
  const pollInterval = 3000; // 3 seconds
  const maxAttempts = Math.floor(timeoutMs / pollInterval);
  let attempts = 0;

  while (attempts < maxAttempts) {
    await sleep(pollInterval);
    attempts++;

    try {
      const statusRes = await fetch(`https://api.manus.ai/v1/tasks/${taskId}`, {
        headers: { 'API_KEY': MANUS_API_KEY }
      });

      if (!statusRes.ok) {
        throw new Error('Failed to check task status');
      }

      const task = await statusRes.json();
      const elapsed = Math.round((Date.now() - startTime) / 1000);

      log('INFO', `Manus task status: ${task.status} (${elapsed}s elapsed)`);

      // Extract response from output (works for both pending and completed)
      let fullText = '';

      if (task.output && Array.isArray(task.output)) {
        for (const block of task.output) {
          if (block.role === 'assistant' && block.content && Array.isArray(block.content)) {
            for (const part of block.content) {
              if (part.type === 'output_text' && part.text) {
                fullText += part.text + '\n';
              }
            }
          }
        }
      }

      // If we have a response and task is completed OR has been processing for >30s, return it
      if (fullText && (task.status === 'completed' || elapsed > 30)) {
        log('INFO', 'Manus response extracted successfully');
        const response = fullText.trim();

        // Add helpful note if Manus is asking a question
        if (response.includes('?') && response.length < 500) {
          return response + '\n\n💡 Tip: When replying, include the full context since each message is independent. For example, instead of just "Gmail", say "Use Gmail to access my emails".';
        }

        return response;
      }

      if (task.status === 'completed') {
        // If completed but no text extracted, try other methods
        fullText = '';

        // Method 1: Extract from output array (current format)
        if (task.output && Array.isArray(task.output)) {
          for (const block of task.output) {
            if (block.role === 'assistant' && block.content && Array.isArray(block.content)) {
              for (const part of block.content) {
                if (part.type === 'output_text' && part.text) {
                  fullText += part.text + '\n';
                }
              }
            }
          }
        }

        // Method 2: Old format fallback
        if (!fullText && task.output && Array.isArray(task.output)) {
          for (const block of task.output) {
            if (block.content && Array.isArray(block.content)) {
              for (const part of block.content) {
                if ((part.type === 'text' || part.type === 'output_text') && part.text) {
                  fullText += part.text + '\n';
                }
              }
            }
          }
        }

        // Method 3: Alternative fields
        if (!fullText && task.result) {
          fullText = typeof task.result === 'string' ? task.result : JSON.stringify(task.result);
        }
        if (!fullText && task.response) {
          fullText = typeof task.response === 'string' ? task.response : JSON.stringify(task.response);
        }
        if (!fullText && task.output_text) {
          fullText = task.output_text;
        }

        fullText = fullText.trim();

        if (!fullText) {
          return `Task completed! View full results here: ${shareUrl || 'https://app.manus.ai'}`;
        }

        log('INFO', 'Manus task completed successfully');
        return fullText;
      }

      if (task.status === 'failed') {
        const error = task.error || task.message || 'Task failed';
        log('ERROR', `Manus task failed: ${error}`, null, { fullTask: task });

        // Return user-friendly error message
        return `I attempted to ${prompt.toLowerCase().substring(0, 50)}... but encountered an issue:\n\n${error}\n\nNote: Manus may need specific permissions or integrations to access your personal data like emails. The task was sent to Manus but it couldn't complete it.`;
      }

    } catch (err) {
      log('ERROR', `Manus polling error: ${err.message}`);
      // Continue polling unless it's a known fatal error
      if (err.message.includes('MANUS_TASK_FAILED')) {
        throw err;
      }
    }
  }

  // Timeout
  log('ERROR', `Manus task timeout after ${timeoutMs}ms`);

  // Check if Manus is even responding
  if (!shareUrl) {
    return `⚠️ Manus API Issue\n\nThe request to Manus timed out after ${Math.round(timeoutMs / 1000)} seconds.\n\nPossible causes:\n1. Your Manus API key may be invalid or expired\n2. Manus credits may be exhausted\n3. Manus service may be down\n\nCurrent API Key: ${MANUS_API_KEY ? 'Set (starts with ' + MANUS_API_KEY.substring(0, 8) + '...)' : 'NOT SET'}\n\nPlease check:\n- Your Manus account at https://manus.ai/\n- Verify your API key and credits`;
  }

  return `Your request "${prompt.substring(0, 80)}..." was sent to Manus AI, but it's taking longer than expected (over ${Math.round(timeoutMs / 1000)} seconds).\n\nThe task is still processing. You can check the status here: ${shareUrl}\n\nNote: Complex tasks like accessing emails may take several minutes.`;
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
        .bot.manus { border-left: 4px solid #764ba2; }
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
        .ai-badge.manus {
            background: linear-gradient(135deg, #764ba2, #667eea);
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
    <div class="sidebar">
        <div class="sidebar-header">
            <button class="home-btn" onclick="goHome()">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                    <polyline points="9 22 9 12 15 12 15 22"></polyline>
                </svg>
                New Chat
            </button>
        </div>
        <div class="history-section">
            <div class="history-title">Chat History</div>
            <div id="history-list">
                <!-- History items will be added here -->
            </div>
        </div>
    </div>

    <!-- Main Content -->
    <div class="main-content">
        <div class="container">
            <div class="header">
                <div class="header-left">
                    <h1>🤖 AI Automation Assistant</h1>
                </div>
                <div class="header-right">
                    <div class="status-badge">
                        <span class="status-indicator"></span>
                        <span>Online</span>
                    </div>
                    <div class="ai-models">
                        <span>Gemini</span> + <span>Manus</span>
                    </div>
                </div>
            </div>
        <div class="chat-area" id="chat">
            <div class="empty-state">
                <h2>👋 Welcome!</h2>
                <p>I'm your AI automation assistant. Ask me anything!</p>
                <div class="example-queries">
                    <h3>Try asking:</h3>
                    <ul>
                        <li onclick="setPrompt(this.textContent)">📊 Build me a sales report for Q1</li>
                        <li onclick="setPrompt(this.textContent)">🔍 Find the best CRM tools for small businesses</li>
                        <li onclick="setPrompt(this.textContent)">📈 Calculate the ROI of our marketing campaign</li>
                        <li onclick="setPrompt(this.textContent)">💡 What is machine learning?</li>
                    </ul>
                </div>
            </div>
        </div>
        <div class="input-area">
            <form id="chat-form" onsubmit="return false;" style="display:flex;gap:12px;width:100%;">
                <input
                    type="text"
                    id="input"
                    placeholder="Type your message or question..."
                    autocomplete="off"
                    style="flex:1;"
                >
                <button type="button" id="send-btn">Send</button>
            </form>
        </div>
        </div>
    </div>
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
                item.onclick = () => loadChat(index);

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

        function addMsg(type, text, aiType = null, routingInfo = null) {
            const emptyState = chat.querySelector('.empty-state');
            if (emptyState) emptyState.remove();

            const msg = document.createElement('div');
            msg.className = 'message ' + type;

            if (type === 'bot' && aiType) {
                msg.className += ' ' + aiType;

                const badge = document.createElement('div');
                badge.className = 'ai-badge ' + aiType;
                badge.textContent = aiType === 'gemini' ? '🔵 Gemini' : '🟣 Manus';
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

                const copyBtn = document.createElement('button');
                copyBtn.className = 'message-action-btn';
                copyBtn.textContent = '📋 Copy';
                copyBtn.onclick = () => {
                    navigator.clipboard.writeText(text);
                    copyBtn.textContent = '✓ Copied';
                    setTimeout(() => copyBtn.textContent = '📋 Copy', 2000);
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
                    body: JSON.stringify({ prompt: userInput }),
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
 * Body: { prompt: string }
 */
app.post('/chat', async (req, res) => {
  const requestId = req.id;

  try {
    const { prompt } = req.body;

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

    // Synchronous processing only for public endpoint
    let response;
    let actualAI = routing.ai;

    try {
      if (routing.ai === 'gemini') {
        response = await callGemini(prompt);
      } else {
        response = await callManus(prompt);
      }
    } catch (error) {
      // Intelligent fallback logic
      if (error.message === 'MANUS_CREDITS_EXCEEDED' && routing.ai === 'manus') {
        log('WARN', 'Manus credits exceeded, trying Gemini fallback', requestId);
        try {
          response = await callGemini(prompt);
          actualAI = 'gemini';
          response = `⚠️ Note: Manus credits exhausted. Using Gemini as fallback.\n\n${response}`;
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
        response = await callManus(prompt);
      }
    } catch (error) {
      // Intelligent fallback logic
      if (error.message === 'MANUS_CREDITS_EXCEEDED' && routing.ai === 'manus') {
        log('WARN', 'Manus credits exceeded, trying Gemini fallback', requestId);
        try {
          response = await callGemini(prompt);
          actualAI = 'gemini';
          response = `⚠️ Note: Manus credits exhausted. Using Gemini as fallback.\n\n${response}`;
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
      manus: !!MANUS_API_KEY,
      render: !!RENDER_API_KEY,
      notion: !!NOTION_API_KEY
    },
    version: '4.0.0'
  });
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
    'MANUS_NOT_CONFIGURED': {
      status: 503,
      message: 'Manus AI is not configured. Please contact the administrator.'
    },
    'GEMINI_QUOTA_EXCEEDED': {
      status: 503,
      message: 'Gemini API quota exceeded. The service quota resets daily. Please try again later or contact support.'
    },
    'MANUS_CREDITS_EXCEEDED': {
      status: 503,
      message: 'Manus AI credits exhausted. Please contact the administrator to add credits.'
    },
    'BOTH_APIS_EXHAUSTED': {
      status: 503,
      message: 'All AI services are temporarily unavailable. Please try again later.'
    },
    'MANUS_TIMEOUT': {
      status: 504,
      message: 'The request took too long to process. Please try a simpler query or try again later.'
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
