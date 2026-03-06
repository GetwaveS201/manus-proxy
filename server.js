/**
 * AI Automation Assistant - Production Server
 * AI System: Gemini
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
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const https = require('https');
const http  = require('http');

// ============================================
// CONFIGURATION & ENVIRONMENT
// ============================================

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const RENDER_API_KEY = process.env.RENDER_API_KEY;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const API_KEY = process.env.API_KEY || 'your-secure-api-key-here';

// Email (SMTP) config from env vars
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587');
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;

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

// ============================================
// INVOICE DATA STORE
// ============================================

const INVOICES_FILE = process.env.INVOICES_FILE || path.join('/data', 'invoices.json');
let invoiceStore = [];

function loadInvoiceStore() {
  try {
    if (fs.existsSync(INVOICES_FILE)) {
      invoiceStore = JSON.parse(fs.readFileSync(INVOICES_FILE, 'utf8')) || [];
    }
  } catch (e) { log('WARN', `Could not load invoices file: ${e.message}`); }
}

function saveInvoiceStore() {
  try {
    const dir = path.dirname(INVOICES_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(INVOICES_FILE, JSON.stringify(invoiceStore, null, 2), 'utf8');
  } catch (e) { log('ERROR', `Could not save invoices file: ${e.message}`); }
}

// ============================================
// AUTOMATIONS CONFIG STORE
// ============================================

const AUTOMATIONS_FILE = process.env.AUTOMATIONS_FILE || path.join('/data', 'automations.json');
let automationsConfig = {
  overdueFollowup: { enabled: false, hour: 9, minute: 0, ccEmail: '' }
};

function loadAutomationsConfig() {
  try {
    if (fs.existsSync(AUTOMATIONS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(AUTOMATIONS_FILE, 'utf8'));
      automationsConfig = Object.assign(automationsConfig, parsed);
    }
  } catch (e) { log('WARN', `Could not load automations config: ${e.message}`); }
}

function saveAutomationsConfig() {
  try {
    const dir = path.dirname(AUTOMATIONS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(AUTOMATIONS_FILE, JSON.stringify(automationsConfig, null, 2), 'utf8');
  } catch (e) { log('ERROR', `Could not save automations config: ${e.message}`); }
}

// ============================================
// SMTP CONFIG STORE (UI-configurable fallback)
// ============================================

const SMTP_CONFIG_FILE = process.env.SMTP_CONFIG_FILE || path.join('/data', 'smtp.json');
let smtpFileConfig = { host: '', port: 587, user: '', pass: '', from: '' };

function loadSmtpConfig() {
  try {
    if (fs.existsSync(SMTP_CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SMTP_CONFIG_FILE, 'utf8'));
      smtpFileConfig = Object.assign(smtpFileConfig, parsed);
    }
  } catch (e) { log('WARN', `Could not load smtp config: ${e.message}`); }
}

function saveSmtpConfig() {
  try {
    const dir = path.dirname(SMTP_CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SMTP_CONFIG_FILE, JSON.stringify(smtpFileConfig, null, 2), 'utf8');
  } catch (e) { log('ERROR', `Could not save smtp config: ${e.message}`); }
}

loadSmtpConfig();

// ============================================
// CUSTOM AUTOMATIONS STORE
// ============================================

const CUSTOM_AUTOMATIONS_FILE = process.env.CUSTOM_AUTOMATIONS_FILE || path.join('/data', 'custom_automations.json');
let customAutomations = [];

function loadCustomAutomations() {
  try {
    if (fs.existsSync(CUSTOM_AUTOMATIONS_FILE)) {
      customAutomations = JSON.parse(fs.readFileSync(CUSTOM_AUTOMATIONS_FILE, 'utf8')) || [];
    }
  } catch (e) { log('WARN', `Could not load custom automations: ${e.message}`); }
}

function saveCustomAutomations() {
  try {
    const dir = path.dirname(CUSTOM_AUTOMATIONS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CUSTOM_AUTOMATIONS_FILE, JSON.stringify(customAutomations, null, 2), 'utf8');
  } catch (e) { log('ERROR', `Could not save custom automations: ${e.message}`); }
}

loadCustomAutomations();

function getEffectiveSmtp() {
  const host = SMTP_HOST || smtpFileConfig.host || '';
  const port = (SMTP_HOST ? SMTP_PORT : smtpFileConfig.port) || 587;
  const user = SMTP_USER || smtpFileConfig.user || '';
  const pass = SMTP_PASS || smtpFileConfig.pass || '';
  const from = SMTP_FROM || smtpFileConfig.from || user;
  return { host, port, user, pass, from, configured: !!(host && user && pass) };
}

// ============================================
// EMAIL HELPER
// ============================================

function createTransporter() {
  const smtp = getEffectiveSmtp();
  if (!smtp.configured) return null;
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.pass }
  });
}

async function sendMail({ to, subject, text, html }) {
  const transporter = createTransporter();
  if (!transporter) throw new Error('EMAIL_NOT_CONFIGURED');
  const smtp = getEffectiveSmtp();
  const info = await transporter.sendMail({
    from: `"Legend Construction Services" <${smtp.from}>`,
    to, subject,
    text: text || '',
    html: html || text || ''
  });
  log('INFO', `Email sent to ${to}: ${info.messageId}`);
  return info;
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
loadInvoiceStore();
loadAutomationsConfig();

// ============================================
// TOKEN HELPERS (HMAC-SHA256, no JWT library)
// ============================================

const TOKEN_SECRET = API_KEY;

// ============================================
// CONNECTOR STORE (AES-256-GCM encrypted keys)
// ============================================

const CONNECTORS_FILE = process.env.CONNECTORS_FILE || path.join('/data', 'connectors.json');
let connectorStore = [];

function deriveEncKey() {
  return crypto.scryptSync(TOKEN_SECRET + 'conn', 'connector-salt-v1', 32);
}

function encryptConnectorKey(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveEncKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + enc.toString('hex') + ':' + cipher.getAuthTag().toString('hex');
}

function decryptConnectorKey(stored) {
  const [ivHex, encHex, tagHex] = stored.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveEncKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
}

function loadConnectorStore() {
  try {
    if (fs.existsSync(CONNECTORS_FILE)) connectorStore = JSON.parse(fs.readFileSync(CONNECTORS_FILE, 'utf8'));
  } catch (e) { log('WARN', `Could not load connectors file: ${e.message}`); connectorStore = []; }
}

function saveConnectorStore() {
  try {
    const dir = path.dirname(CONNECTORS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONNECTORS_FILE, JSON.stringify(connectorStore, null, 2), 'utf8');
  } catch (e) { log('ERROR', `Could not save connectors file: ${e.message}`); }
}

loadConnectorStore();

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
// GEMINI API INTEGRATION
// ============================================

/**
 * Calls Gemini API with timeout and AbortController
 * @param {string} prompt - User prompt
 * @param {number} timeoutMs - Timeout in milliseconds (default: 30s)
 * @returns {Promise<string>} AI response
 */
async function callGemini(prompt, timeoutMs = 30000, systemPrompt = '') {
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
            ...(systemPrompt ? { system_instruction: { parts: [{ text: systemPrompt }] } } : {}),
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
// CONNECTOR TEMPLATES (50 pre-built connectors)
// ============================================

const CONNECTOR_TEMPLATES = [
  // Productivity
  { id: 'notion', name: 'Notion', emoji: '📝', category: 'Productivity', baseUrl: 'https://api.notion.com/v1', apiKeyLabel: 'Integration Token', capabilities: 'Search pages, create and update pages and database entries. Use Notion-Version: 2022-06-28 header and Bearer auth.' },
  { id: 'airtable', name: 'Airtable', emoji: '📊', category: 'Productivity', baseUrl: 'https://api.airtable.com/v0', apiKeyLabel: 'API Key', capabilities: 'List, create, update, and delete records in Airtable bases. Base ID and table name go in URL path. Use Bearer auth.' },
  { id: 'trello', name: 'Trello', emoji: '🃏', category: 'Productivity', baseUrl: 'https://api.trello.com/1', apiKeyLabel: 'API Key:Token', capabilities: 'Manage Trello boards, lists, and cards. Split key/token on colon. Both go as query params key= and token=.' },
  { id: 'asana', name: 'Asana', emoji: '✅', category: 'Productivity', baseUrl: 'https://app.asana.com/api/1.0', apiKeyLabel: 'Personal Access Token', capabilities: 'Create, update, and list tasks, projects, and workspaces. Use Bearer auth.' },
  { id: 'clickup', name: 'ClickUp', emoji: '🖱️', category: 'Productivity', baseUrl: 'https://api.clickup.com/api/v2', apiKeyLabel: 'API Token', capabilities: 'Create and list tasks, spaces, and lists. Put token directly in Authorization header.' },
  { id: 'todoist', name: 'Todoist', emoji: '✔️', category: 'Productivity', baseUrl: 'https://api.todoist.com/rest/v2', apiKeyLabel: 'API Token', capabilities: 'List, create, update, and close tasks and projects. Use Bearer auth.' },
  { id: 'linear', name: 'Linear', emoji: '🔷', category: 'Productivity', baseUrl: 'https://api.linear.app/graphql', apiKeyLabel: 'API Key', capabilities: 'Query and mutate Linear issues, projects, and teams via GraphQL POST. Use Authorization header with key.' },
  { id: 'monday', name: 'Monday.com', emoji: '📅', category: 'Productivity', baseUrl: 'https://api.monday.com/v2', apiKeyLabel: 'API Token', capabilities: 'Read and update boards and items via GraphQL POST. Use Authorization Bearer.' },
  // Communication
  { id: 'slack', name: 'Slack', emoji: '💬', category: 'Communication', baseUrl: 'https://slack.com/api', apiKeyLabel: 'Bot Token (xoxb-...)', capabilities: 'Post messages to channels, list channels, read channel history. Use Bearer auth with bot token.' },
  { id: 'discord', name: 'Discord', emoji: '🎮', category: 'Communication', baseUrl: 'https://discord.com/api/v10', apiKeyLabel: 'Bot Token', capabilities: 'Send messages to channels, read guild info, list channels. Authorization header value: "Bot TOKEN".' },
  { id: 'telegram', name: 'Telegram Bot', emoji: '✈️', category: 'Communication', baseUrl: 'https://api.telegram.org', apiKeyLabel: 'Bot Token', capabilities: 'Send messages via Telegram Bot API. URL: /bot{TOKEN}/sendMessage. No extra auth header needed - token is in URL.' },
  { id: 'twilio', name: 'Twilio SMS', emoji: '📱', category: 'Communication', baseUrl: 'https://api.twilio.com/2010-04-01', apiKeyLabel: 'AccountSID:AuthToken', capabilities: 'Send SMS via Twilio. Split on colon to get AccountSID and AuthToken. Use Basic auth. URL: /Accounts/{SID}/Messages.' },
  { id: 'mailgun', name: 'Mailgun', emoji: '📧', category: 'Communication', baseUrl: 'https://api.mailgun.net/v3', apiKeyLabel: 'API Key', capabilities: 'Send emails and check email stats. Use Basic auth with username "api" and API key as password.' },
  { id: 'sendgrid', name: 'SendGrid', emoji: '📨', category: 'Communication', baseUrl: 'https://api.sendgrid.com/v3', apiKeyLabel: 'API Key', capabilities: 'Send transactional emails and manage contacts. Use Bearer auth.' },
  { id: 'postmark', name: 'Postmark', emoji: '📮', category: 'Communication', baseUrl: 'https://api.postmarkapp.com', apiKeyLabel: 'Server API Token', capabilities: 'Send emails and check delivery stats. Use X-Postmark-Server-Token header.' },
  // Data/Storage
  { id: 'supabase', name: 'Supabase', emoji: '⚡', category: 'Data/Storage', baseUrl: 'https://xyzproject.supabase.co', apiKeyLabel: 'Project URL + Service Key (URL|KEY)', capabilities: 'Query Supabase database tables via REST. Split key on pipe - first part is project URL, second is service_role key. Use apikey and Authorization Bearer headers.' },
  { id: 'upstash', name: 'Upstash Redis', emoji: '🔴', category: 'Data/Storage', baseUrl: 'https://redis.upstash.io', apiKeyLabel: 'REST URL + Token (URL|TOKEN)', capabilities: 'Get and set Redis keys via Upstash REST. Split on pipe - first part is endpoint URL, second is token. Use Authorization Bearer.' },
  { id: 'planetscale', name: 'PlanetScale', emoji: '🪐', category: 'Data/Storage', baseUrl: 'https://api.planetscale.com/v1', apiKeyLabel: 'Service Token', capabilities: 'Manage databases, branches, and deploy requests. Use Authorization Bearer.' },
  { id: 'neon', name: 'Neon', emoji: '🌿', category: 'Data/Storage', baseUrl: 'https://console.neon.tech/api/v2', apiKeyLabel: 'API Key', capabilities: 'Manage Postgres projects, branches, and endpoints. Use Authorization Bearer.' },
  { id: 'cloudflare-kv', name: 'Cloudflare KV', emoji: '☁️', category: 'Data/Storage', baseUrl: 'https://api.cloudflare.com/client/v4', apiKeyLabel: 'Account ID:API Token (ID:TOKEN)', capabilities: 'Read and write KV namespace values. Split on colon for account ID and token. Use Authorization Bearer. URL: /accounts/{accountId}/storage/kv/namespaces.' },
  // Dev Tools
  { id: 'github', name: 'GitHub', emoji: '🐙', category: 'Dev Tools', baseUrl: 'https://api.github.com', apiKeyLabel: 'Personal Access Token', capabilities: 'List repos, issues, PRs, commits. Create issues. Use Bearer auth. Set Accept: application/vnd.github+json header.' },
  { id: 'gitlab', name: 'GitLab', emoji: '🦊', category: 'Dev Tools', baseUrl: 'https://gitlab.com/api/v4', apiKeyLabel: 'Personal Access Token', capabilities: 'List projects, issues, merge requests, pipelines. Use PRIVATE-TOKEN header.' },
  { id: 'vercel', name: 'Vercel', emoji: '▲', category: 'Dev Tools', baseUrl: 'https://api.vercel.com', apiKeyLabel: 'API Token', capabilities: 'List deployments, projects, domains. Trigger redeploys. Use Bearer auth.' },
  { id: 'netlify', name: 'Netlify', emoji: '🌐', category: 'Dev Tools', baseUrl: 'https://api.netlify.com/api/v1', apiKeyLabel: 'Personal Access Token', capabilities: 'List sites, deploys. Trigger deploys. Use Authorization Bearer.' },
  { id: 'railway', name: 'Railway', emoji: '🚂', category: 'Dev Tools', baseUrl: 'https://backboard.railway.app/graphql/v2', apiKeyLabel: 'API Token', capabilities: 'Query projects, services, deployments via GraphQL POST. Use Bearer auth.' },
  { id: 'cloudflare', name: 'Cloudflare', emoji: '🛡️', category: 'Dev Tools', baseUrl: 'https://api.cloudflare.com/client/v4', apiKeyLabel: 'API Token', capabilities: 'Manage DNS records, zones, pages deployments, workers. Use Authorization Bearer.' },
  { id: 'render', name: 'Render', emoji: '🎨', category: 'Dev Tools', baseUrl: 'https://api.render.com/v1', apiKeyLabel: 'API Key', capabilities: 'List services, deployments, environment variables. Trigger deploys. Use Authorization Bearer.' },
  // AI/ML
  { id: 'openai', name: 'OpenAI', emoji: '🤖', category: 'AI/ML', baseUrl: 'https://api.openai.com/v1', apiKeyLabel: 'API Key', capabilities: 'Call GPT models for chat completions, generate embeddings, create images. Use Bearer auth.' },
  { id: 'anthropic', name: 'Anthropic', emoji: '🧠', category: 'AI/ML', baseUrl: 'https://api.anthropic.com/v1', apiKeyLabel: 'API Key', capabilities: 'Call Claude models for messages. Use x-api-key header and anthropic-version: 2023-06-01 header.' },
  { id: 'replicate', name: 'Replicate', emoji: '🔁', category: 'AI/ML', baseUrl: 'https://api.replicate.com/v1', apiKeyLabel: 'API Token', capabilities: 'Run and list AI model predictions for images, audio, text. Use Bearer auth.' },
  { id: 'stability', name: 'Stability AI', emoji: '🖼️', category: 'AI/ML', baseUrl: 'https://api.stability.ai/v1', apiKeyLabel: 'API Key', capabilities: 'Generate images with Stable Diffusion. Use Bearer auth.' },
  { id: 'elevenlabs', name: 'ElevenLabs', emoji: '🔊', category: 'AI/ML', baseUrl: 'https://api.elevenlabs.io/v1', apiKeyLabel: 'API Key', capabilities: 'Generate speech from text, list voices. Use xi-api-key header.' },
  { id: 'deepgram', name: 'Deepgram', emoji: '🎤', category: 'AI/ML', baseUrl: 'https://api.deepgram.com/v1', apiKeyLabel: 'API Key', capabilities: 'Transcribe audio, get usage stats. Use Token auth in Authorization header.' },
  { id: 'assemblyai', name: 'AssemblyAI', emoji: '🎧', category: 'AI/ML', baseUrl: 'https://api.assemblyai.com/v2', apiKeyLabel: 'API Key', capabilities: 'Submit audio for transcription, retrieve transcripts. Use authorization header with API key.' },
  // Finance/Business
  { id: 'stripe', name: 'Stripe', emoji: '💳', category: 'Finance', baseUrl: 'https://api.stripe.com/v1', apiKeyLabel: 'Secret Key (sk_...)', capabilities: 'List customers, charges, invoices, subscriptions. Create payment intents. Use Bearer auth with secret key.' },
  { id: 'hubspot', name: 'HubSpot', emoji: '🧡', category: 'Finance', baseUrl: 'https://api.hubapi.com', apiKeyLabel: 'Private App Token', capabilities: 'Manage CRM contacts, companies, deals, and tickets. Use Bearer auth.' },
  { id: 'salesforce', name: 'Salesforce', emoji: '☁️', category: 'Finance', baseUrl: 'https://login.salesforce.com', apiKeyLabel: 'Access Token + Instance URL (TOKEN|URL)', capabilities: 'Query Salesforce records via SOQL and REST. Split on pipe for token and instance URL. Use Bearer auth against instance URL.' },
  { id: 'quickbooks', name: 'QuickBooks', emoji: '📚', category: 'Finance', baseUrl: 'https://quickbooks.api.intuit.com/v3', apiKeyLabel: 'OAuth Token + Company ID (TOKEN|CID)', capabilities: 'Read invoices, customers, expenses. Split on pipe for token and company ID. Use Bearer auth. URL: /company/{companyId}/...' },
  { id: 'freshbooks', name: 'FreshBooks', emoji: '💼', category: 'Finance', baseUrl: 'https://api.freshbooks.com', apiKeyLabel: 'OAuth Access Token', capabilities: 'Manage invoices, clients, expenses. Use Bearer auth.' },
  // Maps/Weather
  { id: 'googlemaps', name: 'Google Maps', emoji: '🗺️', category: 'Maps/Weather', baseUrl: 'https://maps.googleapis.com/maps/api', apiKeyLabel: 'API Key', capabilities: 'Geocode addresses, get directions, find nearby places. API key goes in query param as key=.' },
  { id: 'mapbox', name: 'Mapbox', emoji: '🧭', category: 'Maps/Weather', baseUrl: 'https://api.mapbox.com', apiKeyLabel: 'Access Token', capabilities: 'Geocode addresses, get directions, static maps. Access token goes in query param as access_token=.' },
  { id: 'openweather', name: 'OpenWeatherMap', emoji: '🌤️', category: 'Maps/Weather', baseUrl: 'https://api.openweathermap.org/data/2.5', apiKeyLabel: 'API Key', capabilities: 'Get current weather, forecasts for any city. API key goes in query param as appid=.' },
  // Social/Media
  { id: 'twitter', name: 'Twitter/X', emoji: '🐦', category: 'Social/Media', baseUrl: 'https://api.twitter.com/2', apiKeyLabel: 'Bearer Token', capabilities: 'Search tweets, get user info and timelines. Use Bearer auth.' },
  { id: 'youtube', name: 'YouTube Data', emoji: '▶️', category: 'Social/Media', baseUrl: 'https://www.googleapis.com/youtube/v3', apiKeyLabel: 'API Key', capabilities: 'Search videos, get video and channel info, list comments. API key goes in query param as key=.' },
  { id: 'spotify', name: 'Spotify', emoji: '🎵', category: 'Social/Media', baseUrl: 'https://api.spotify.com/v1', apiKeyLabel: 'Access Token', capabilities: 'Get user playlists, recently played tracks, search. Use Bearer auth.' },
  // File Storage
  { id: 'dropbox', name: 'Dropbox', emoji: '📦', category: 'File Storage', baseUrl: 'https://api.dropboxapi.com/2', apiKeyLabel: 'Access Token', capabilities: 'List files and folders, get metadata, search files. Use Bearer auth.' },
  { id: 'box', name: 'Box', emoji: '📭', category: 'File Storage', baseUrl: 'https://api.box.com/2.0', apiKeyLabel: 'Access Token', capabilities: 'List items in folders, get file info, search. Use Bearer auth.' },
  // Construction
  { id: 'procore', name: 'Procore', emoji: '🏗️', category: 'Construction', baseUrl: 'https://api.procore.com/rest/v1.0', apiKeyLabel: 'Access Token', capabilities: 'Access construction projects, RFIs, submittals, daily logs, budgets. Use Bearer auth.' },
  { id: 'buildertrend', name: 'Buildertrend', emoji: '🔨', category: 'Construction', baseUrl: 'https://api.buildertrend.net', apiKeyLabel: 'API Key', capabilities: 'Access construction job data, schedules, client communications, and change orders. Use Authorization header.' },
  // Custom
  { id: 'custom', name: 'Custom Connector', emoji: '🔧', category: 'Custom', baseUrl: '', apiKeyLabel: 'API Key / Token', capabilities: 'Custom REST API connector. You provide the base URL and describe what the API can do.' }
];

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
    <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>

    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }

        /* ============================================
           DESIGN SYSTEM
           Aesthetic: Modern dark dashboard
           Font: Inter
           Palette: Deep purple/navy bg, violet accent, white text
           ============================================ */

        :root {
            /* Sidebar */
            --sidebar-bg:     #0f172a;
            --sidebar-hover:  #1e293b;
            --sidebar-active: rgba(124,58,237,0.18);
            --sidebar-text:   rgba(255,255,255,0.65);
            --sidebar-text-hi: #ffffff;
            --sidebar-dim:    rgba(255,255,255,0.32);
            /* Main content */
            --bg:          #f1f5f9;
            --bg-card:     #ffffff;
            --bg-raised:   #f8fafc;
            --bg-hover:    #f1f5f9;
            --bg-input:    #f8fafc;
            --bg-mid:      #f1f5f9;
            --bg-panel:    #f8fafc;
            /* Borders */
            --border:      #e2e8f0;
            --border-mid:  #cbd5e1;
            --border-hi:   #94a3b8;
            /* Text */
            --text:        #0f172a;
            --text-mid:    #475569;
            --text-dim:    #94a3b8;
            /* Accent */
            --accent:      #7c3aed;
            --accent-lo:   rgba(124,58,237,0.08);
            --accent-glow: rgba(124,58,237,0.25);
            /* Status colors */
            --green:       #059669;
            --green-lo:    rgba(5,150,105,0.10);
            --orange:      #d97706;
            --orange-lo:   rgba(217,119,6,0.10);
            --red:         #dc2626;
            --red-lo:      rgba(220,38,38,0.08);
            /* Typography */
            --mono:        'Inter', ui-monospace, 'JetBrains Mono', monospace;
            --serif:       'Inter', ui-sans-serif, system-ui, sans-serif;
            --sans:        'Inter', ui-sans-serif, system-ui, sans-serif;
            /* Radii */
            --radius-sm:   8px;
            --radius:      12px;
            --radius-lg:   16px;
            /* Shadows */
            --shadow-sm:   0 1px 2px rgba(0,0,0,0.05);
            --shadow:      0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
            --shadow-md:   0 4px 6px rgba(0,0,0,0.05), 0 2px 4px rgba(0,0,0,0.06);
            --shadow-lg:   0 10px 25px rgba(0,0,0,0.12), 0 4px 6px rgba(0,0,0,0.06);
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

        /* ===== SIDEBAR ===== */
        .sidebar {
            width: 224px;
            background: var(--sidebar-bg);
            display: flex;
            flex-direction: column;
            height: 100vh;
            flex-shrink: 0;
            overflow: hidden;
            position: relative;
            z-index: 10;
        }
        /* Sidebar brand/logo area */
        .sidebar-brand {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 18px 16px 14px;
            border-bottom: 1px solid rgba(255,255,255,0.07);
            flex-shrink: 0;
            cursor: pointer;
            transition: background 0.15s;
        }
        .sidebar-brand:hover { background: rgba(255,255,255,0.04); }
        .sidebar-brand-icon {
            width: 32px;
            height: 32px;
            background: linear-gradient(135deg, #7c3aed 0%, #5b21b6 100%);
            border-radius: var(--radius-sm);
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            box-shadow: 0 2px 8px rgba(124,58,237,0.4);
        }
        .sidebar-brand-name {
            font-size: 14px;
            font-weight: 700;
            color: #ffffff;
            letter-spacing: -0.01em;
        }
        .sidebar-brand-sub {
            font-size: 10px;
            color: rgba(255,255,255,0.38);
            margin-top: 1px;
        }
        .sidebar-header {
            padding: 10px 12px 10px;
            border-bottom: 1px solid rgba(255,255,255,0.07);
        }
        .home-btn {
            width: 100%;
            padding: 8px 12px;
            background: rgba(255,255,255,0.07);
            color: rgba(255,255,255,0.75);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: var(--radius-sm);
            font-weight: 500;
            font-size: 12px;
            cursor: pointer;
            transition: all 0.15s;
            display: flex;
            align-items: center;
            gap: 8px;
            font-family: var(--sans);
        }
        .home-btn:hover {
            background: rgba(255,255,255,0.12);
            color: #ffffff;
            border-color: rgba(255,255,255,0.2);
        }

        /* AI Mode Selector */
        .ai-mode-section {
            padding: 10px 12px;
            border-bottom: 1px solid rgba(255,255,255,0.07);
        }
        .ai-mode-label {
            color: rgba(255,255,255,0.32);
            font-size: 9px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.1em;
            margin-bottom: 7px;
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
            border: 1px solid rgba(255,255,255,0.08);
            background: transparent;
            color: rgba(255,255,255,0.45);
            font-size: 11px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.15s;
            text-align: center;
            font-family: var(--sans);
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 5px;
        }
        .ai-mode-btn:hover:not(.active) {
            background: rgba(255,255,255,0.08);
            color: rgba(255,255,255,0.75);
        }
        .ai-mode-btn.active.gemini {
            background: rgba(5,150,105,0.2);
            border-color: rgba(5,150,105,0.5);
            color: #34d399;
        }

        /* ===== FULL SETTINGS PANEL ===== */
        .settings-overlay {
            position: fixed;
            inset: 0;
            background: rgba(15,23,42,0.45);
            z-index: 999;
            display: none;
            backdrop-filter: blur(4px);
        }
        .settings-overlay.open { display: block; }
        .settings-panel {
            position: fixed;
            top: 0; right: 0;
            width: min(600px, 100vw);
            height: 100vh;
            background: var(--bg-card);
            border-left: 1px solid var(--border);
            z-index: 1000;
            padding: 0;
            transform: translateX(100%);
            transition: transform 0.22s cubic-bezier(0.4,0,0.2,1);
            overflow: hidden;
            display: flex;
            flex-direction: column;
            box-shadow: var(--shadow-lg);
        }
        .settings-panel.open { transform: translateX(0); }

        /* Header */
        .settings-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 14px 18px;
            border-bottom: 1px solid var(--border);
            flex-shrink: 0;
            background: var(--bg-card);
        }
        .settings-header-user {
            display: flex;
            align-items: center;
            gap: 11px;
        }
        .settings-header-avatar {
            width: 34px;
            height: 34px;
            border-radius: var(--radius-sm);
            background: linear-gradient(135deg, #7c3aed 0%, #5b21b6 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 13px;
            font-weight: 700;
            color: #ffffff;
            flex-shrink: 0;
            text-transform: uppercase;
            font-family: var(--mono);
        }
        .settings-header-name {
            font-size: 13px;
            font-weight: 600;
            color: var(--text);
        }
        .settings-header-sub {
            font-size: 11px;
            color: var(--text-dim);
            margin-top: 1px;
        }
        .settings-close-btn {
            background: var(--bg-raised);
            border: 1px solid var(--border);
            color: var(--text-mid);
            cursor: pointer;
            padding: 6px 9px;
            border-radius: var(--radius-sm);
            transition: all 0.15s;
            line-height: 1;
            display: flex;
            align-items: center;
        }
        .settings-close-btn:hover { color: var(--text); border-color: var(--border-mid); background: var(--bg-hover); }

        /* Two-column layout: sidebar nav + content */
        .settings-body {
            display: flex;
            flex: 1;
            overflow: hidden;
        }

        /* Vertical tab nav sidebar */
        .stabs {
            display: flex;
            flex-direction: column;
            gap: 1px;
            padding: 12px 8px;
            width: 148px;
            flex-shrink: 0;
            background: var(--bg-raised);
            border-right: 1px solid var(--border);
            overflow-y: auto;
        }
        .stabs-group-label {
            font-family: var(--mono);
            font-size: 9px;
            font-weight: 600;
            letter-spacing: 0.1em;
            text-transform: uppercase;
            color: var(--text-dim);
            padding: 10px 8px 4px;
        }
        .stab {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 10px;
            background: transparent;
            border: none;
            border-radius: var(--radius-sm);
            color: var(--text-mid);
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            font-family: var(--sans);
            transition: all 0.12s;
            white-space: nowrap;
            text-align: left;
            width: 100%;
        }
        .stab:hover { background: var(--bg-hover); color: var(--text); }
        .stab.active {
            background: var(--accent-lo);
            color: var(--accent);
            font-weight: 600;
        }
        .stab svg { flex-shrink: 0; opacity: 0.6; }
        .stab.active svg { opacity: 1; }

        /* Tab content area */
        .stab-content {
            display: none;
            padding: 18px 20px;
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
            color: #ffffff;
            border: none;
            border-radius: var(--radius-sm);
            font-weight: 600;
            font-size: 12px;
            cursor: pointer;
            margin-top: 4px;
            transition: opacity 0.15s, box-shadow 0.15s;
            font-family: var(--sans);
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 7px;
            box-shadow: var(--shadow-md);
        }
        .settings-save-btn:hover { opacity: 0.9; box-shadow: var(--shadow-lg); }
        .settings-save-btn-sm {
            padding: 7px 12px;
            background: var(--bg-raised);
            color: var(--text-mid);
            border: 1px solid var(--border);
            border-radius: var(--radius-sm);
            font-size: 11px;
            font-weight: 500;
            cursor: pointer;
            font-family: var(--sans);
            transition: all 0.15s;
            display: inline-flex;
            align-items: center;
            gap: 6px;
        }
        .settings-save-btn-sm:hover { background: var(--bg-hover); color: var(--text); border-color: var(--border-mid); }
        .settings-danger-btn {
            width: 100%;
            padding: 8px 12px;
            background: transparent;
            color: var(--red);
            border: 1px solid rgba(220,38,38,0.2);
            border-radius: var(--radius-sm);
            font-size: 11px;
            font-weight: 500;
            cursor: pointer;
            font-family: var(--sans);
            transition: all 0.15s;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .settings-danger-btn:hover { background: var(--red-lo); border-color: rgba(220,38,38,0.4); }

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
            color: rgba(255,255,255,0.30);
            font-size: 9px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.1em;
            margin-bottom: 4px;
            padding: 8px 6px 4px;
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
            background: rgba(255,255,255,0.07);
            border-color: rgba(255,255,255,0.08);
        }
        .history-item:hover .delete-chat-btn {
            opacity: 1;
        }
        .history-item-title {
            color: rgba(255,255,255,0.70);
            font-size: 12px;
            margin-bottom: 2px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            padding-right: 26px;
            font-weight: 400;
        }
        .history-item-preview {
            color: rgba(255,255,255,0.30);
            font-size: 10px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .history-item-time {
            color: rgba(255,255,255,0.22);
            font-size: 9px;
            margin-top: 3px;
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
            padding: 8px 10px 10px;
            border-top: 1px solid rgba(255,255,255,0.07);
            flex-shrink: 0;
            display: flex;
            align-items: center;
            gap: 5px;
        }
        .account-btn {
            flex: 1;
            display: flex;
            align-items: center;
            gap: 9px;
            padding: 8px 9px;
            border-radius: var(--radius-sm);
            border: none;
            background: transparent;
            cursor: pointer;
            transition: all 0.12s;
            text-align: left;
            font-family: var(--sans);
            min-width: 0;
        }
        .account-btn:hover {
            background: rgba(255,255,255,0.08);
        }
        .account-avatar {
            width: 30px;
            height: 30px;
            border-radius: var(--radius-sm);
            background: linear-gradient(135deg, #7c3aed 0%, #5b21b6 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
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
            color: rgba(255,255,255,0.85);
            font-size: 12px;
            font-weight: 500;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .account-plan {
            color: rgba(255,255,255,0.35);
            font-size: 10px;
        }
        .logout-btn {
            background: none;
            border: none;
            color: rgba(255,255,255,0.35);
            cursor: pointer;
            padding: 5px 6px;
            border-radius: var(--radius-sm);
            display: flex;
            align-items: center;
            flex-shrink: 0;
            transition: all 0.12s;
        }
        .logout-btn:hover { color: #fc8181; background: rgba(220,38,38,0.15); }

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
            background: var(--bg-card);
            color: var(--text);
            padding: 12px 20px;
            border-bottom: 1px solid var(--border);
            box-shadow: var(--shadow-sm);
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-shrink: 0;
        }
        .header-left {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .header-icon {
            width: 30px;
            height: 30px;
            background: linear-gradient(135deg, #7c3aed 0%, #5b21b6 100%);
            border-radius: var(--radius-sm);
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            box-shadow: 0 2px 8px rgba(124,58,237,0.3);
        }
        .header h1 {
            font-size: 14px;
            font-weight: 600;
            color: var(--text);
            letter-spacing: -0.01em;
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
            padding: 4px 10px;
            background: var(--green-lo);
            border: 1px solid rgba(5,150,105,0.2);
            border-radius: 20px;
            font-size: 11px;
            color: var(--green);
            font-weight: 500;
        }
        .status-indicator {
            display: inline-block;
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--green);
            animation: glow 2.5s ease-in-out infinite;
        }
        @keyframes glow {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        .ai-models {
            font-size: 11px;
            color: var(--text-mid);
            background: var(--bg-raised);
            border: 1px solid var(--border);
            border-radius: 20px;
            padding: 4px 10px;
            font-weight: 500;
        }
        .ai-models span {
            color: var(--accent);
            font-weight: 600;
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

        /* ===== EMPTY STATE (fallback if dashboard not shown) ===== */
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
            background: linear-gradient(135deg, #7c3aed 0%, #5b21b6 100%);
            border-radius: var(--radius);
            display: flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 22px;
            box-shadow: 0 4px 16px rgba(124,58,237,0.25);
        }
        .empty-state h2 {
            font-size: 1.8rem;
            font-style: normal;
            margin-bottom: 8px;
            color: var(--text);
            font-weight: 700;
            letter-spacing: -0.02em;
        }
        .empty-state p {
            font-size: 13px;
            margin-bottom: 32px;
            color: var(--text-mid);
            max-width: 340px;
            line-height: 1.7;
        }
        .example-queries {
            text-align: left;
            max-width: 540px;
            width: 100%;
        }
        .example-queries h3 {
            font-size: 10px;
            margin-bottom: 10px;
            color: var(--text-dim);
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.1em;
        }
        .example-queries ul {
            list-style: none;
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
        }
        .example-queries li {
            padding: 13px 14px;
            background: var(--bg-card);
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
            box-shadow: var(--shadow-sm);
        }
        .example-queries li:hover {
            background: var(--bg-hover);
            border-color: var(--accent);
            color: var(--text);
            box-shadow: var(--shadow);
        }
        .example-queries li svg {
            flex-shrink: 0;
            margin-top: 1px;
            opacity: 0.5;
            color: var(--accent);
        }
        .example-queries li:hover svg { opacity: 1; }

        /* ===== MESSAGES ===== */
        .message-row {
            display: flex;
            gap: 12px;
            margin-bottom: 20px;
            align-items: flex-start;
        }
        .message-row.user-row {
            flex-direction: row-reverse;
        }
        .msg-avatar {
            width: 30px;
            height: 30px;
            border-radius: var(--radius-sm);
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            font-size: 11px;
            font-weight: 700;
        }
        .msg-avatar.user-av {
            background: linear-gradient(135deg, #7c3aed 0%, #5b21b6 100%);
            color: #ffffff;
        }
        .msg-avatar.bot-av {
            background: var(--green-lo);
            color: var(--green);
            border: 1px solid rgba(5,150,105,0.25);
        }
        .msg-avatar.bot-av.gemini-av {
            background: var(--orange-lo);
            color: var(--orange);
            border: 1px solid rgba(217,119,6,0.25);
        }
        .message {
            padding: 12px 16px;
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
            background: rgba(0,0,0,0.06);
            color: var(--text-mid);
            border: 1px solid var(--border);
            padding: 3px 7px;
            border-radius: 4px;
            font-size: 10px;
            cursor: pointer;
            transition: all 0.15s;
            display: flex;
            align-items: center;
            gap: 3px;
        }
        .message-action-btn:hover { background: var(--bg-hover); color: var(--text); }
        .user .message-action-btn { background: rgba(255,255,255,0.2); border-color: rgba(255,255,255,0.3); color: rgba(255,255,255,0.85); }
        .user .message-action-btn:hover { background: rgba(255,255,255,0.3); }
        @keyframes fadeUp {
            from { opacity: 0; transform: translateY(6px); }
            to   { opacity: 1; transform: translateY(0); }
        }
        .user {
            background: var(--accent);
            color: #ffffff;
            margin-left: auto;
            border: none;
            box-shadow: 0 2px 8px rgba(124,58,237,0.25);
        }
        .bot {
            background: var(--bg-card);
            border: 1px solid var(--border);
            color: var(--text);
            box-shadow: var(--shadow-sm);
        }
        .bot.gemini { border-left: 3px solid var(--green); }
        .ai-badge {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 2px 8px 2px 6px;
            border-radius: 20px;
            font-size: 10px;
            font-weight: 600;
            margin-bottom: 8px;
            letter-spacing: 0.02em;
        }
        .ai-badge.gemini {
            background: var(--green-lo);
            color: var(--green);
            border: 1px solid rgba(5,150,105,0.2);
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
            padding: 12px 20px 16px;
            background: var(--bg-card);
            border-top: 1px solid var(--border);
            flex-shrink: 0;
            box-shadow: 0 -1px 0 var(--border);
        }
        .input-wrap {
            max-width: 700px;
            margin: 0 auto;
            display: flex;
            align-items: center;
            gap: 8px;
            background: var(--bg-raised);
            border: 1.5px solid var(--border-mid);
            border-radius: var(--radius-lg);
            transition: border-color 0.15s, box-shadow 0.15s;
            padding: 4px 6px 4px 10px;
        }
        .input-wrap:focus-within {
            border-color: var(--accent);
            box-shadow: 0 0 0 3px var(--accent-lo);
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
            background: var(--accent);
            color: #ffffff;
            border: none;
            border-radius: var(--radius);
            cursor: pointer;
            transition: opacity 0.15s, transform 0.1s, box-shadow 0.15s;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            box-shadow: 0 2px 8px rgba(124,58,237,0.3);
        }
        .send-btn:hover:not(:disabled) { opacity: 0.9; box-shadow: 0 4px 12px rgba(124,58,237,0.4); }
        .send-btn:active:not(:disabled) { transform: scale(0.94); }
        .send-btn:disabled { background: var(--bg-hover); color: var(--text-dim); cursor: not-allowed; box-shadow: none; }
        .send-btn.thinking-state { background: var(--bg-hover); }

        /* Markdown and code styling */
        .message pre {
            background: var(--bg-raised);
            border: 1px solid var(--border);
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
            background: var(--bg-raised);
            border: 1px solid var(--border);
            padding: 2px 5px;
            border-radius: 4px;
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
            background:
                radial-gradient(ellipse 70% 60% at 30% 30%, rgba(139,92,246,0.2) 0%, transparent 60%),
                radial-gradient(ellipse 50% 50% at 70% 70%, rgba(59,130,246,0.12) 0%, transparent 60%);
            pointer-events: none;
        }
        .login-card {
            width: 100%;
            max-width: 380px;
            background: var(--bg-card);
            border: 1px solid var(--border);
            border-radius: var(--radius-lg);
            padding: 40px 36px 32px;
            box-shadow: var(--shadow-lg);
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
            width: 54px; height: 54px;
            background: linear-gradient(135deg, #7c3aed 0%, #5b21b6 100%);
            border-radius: var(--radius);
            display: flex; align-items: center; justify-content: center;
            margin-bottom: 18px;
            flex-shrink: 0;
            box-shadow: 0 4px 16px rgba(124,58,237,0.3);
        }
        .login-card h1 {
            font-size: 20px;
            font-weight: 700;
            color: var(--text);
            text-align: center;
            margin-bottom: 6px;
            letter-spacing: -0.02em;
        }
        .login-card-tagline {
            font-size: 13px;
            color: var(--text-mid);
            text-align: center;
            margin-bottom: 28px;
            line-height: 1.5;
        }
        .login-error {
            width: 100%; font-size: 11px; color: var(--red);
            background: var(--red-lo);
            border: 1px solid rgba(220,38,38,0.2);
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
            background: var(--accent);
            color: #ffffff;
            border: none;
            border-radius: var(--radius-sm);
            font-size: 14px; font-weight: 600;
            cursor: pointer;
            font-family: var(--sans);
            transition: opacity .15s, box-shadow .15s;
            margin-top: 6px;
            box-shadow: var(--shadow-md);
        }
        .login-submit-btn:hover:not(:disabled) { opacity: 0.9; box-shadow: var(--shadow-lg); }
        .login-submit-btn:disabled { opacity: .5; cursor: not-allowed; box-shadow: none; }
        .login-card-hint { font-size: 11px; color: var(--text-dim); text-align: center; margin-top: 10px; width: 100%; }
        /* login tab bar */
        .login-tab-bar { display: flex; width: 100%; gap: 0; margin-bottom: 20px; border-radius: var(--radius-sm); overflow: hidden; border: 1px solid var(--border); background: var(--bg-raised); }
        .login-tab { flex: 1; padding: 9px 0; background: transparent; color: var(--text-mid); border: none; cursor: pointer; font-size: 12px; font-family: var(--sans); font-weight: 500; transition: all .15s; }
        .login-tab.active { background: var(--bg-card); color: var(--accent); font-weight: 600; box-shadow: var(--shadow-sm); border-radius: var(--radius-sm); }

        /* ===== SIDEBAR TOOL NAV ===== */
        .sidebar-tools-section { padding: 8px 10px 6px; border-bottom: 1px solid rgba(255,255,255,0.07); flex-shrink: 0; }
        .sidebar-tools-label { color: rgba(255,255,255,0.32); font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; padding: 4px 4px 6px; }
        .tool-nav-btn { width: 100%; display: flex; align-items: center; gap: 9px; padding: 8px 10px; margin-bottom: 2px; background: transparent; border: none; border-radius: var(--radius-sm); color: var(--sidebar-text); font-size: 12px; font-weight: 500; font-family: var(--sans); cursor: pointer; transition: all 0.12s; text-align: left; }
        .tool-nav-btn:hover { background: rgba(255,255,255,0.08); color: var(--sidebar-text-hi); }
        .tool-nav-btn.active { background: var(--sidebar-active); color: #c4b5fd; }
        .tool-nav-btn svg { flex-shrink: 0; opacity: 0.7; }
        .tool-nav-btn.active svg { opacity: 1; }
        .tool-nav-btn:hover svg { opacity: 1; }

        /* ===== TOOL VIEWS ===== */
        .tool-view { display: none; flex: 1; flex-direction: column; height: 100vh; background: var(--bg); min-width: 0; overflow: hidden; }
        .tool-view.active { display: flex; }
        .tool-header { background: var(--bg-card); border-bottom: 1px solid var(--border); padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; box-shadow: var(--shadow-sm); }
        .tool-header-left { display: flex; align-items: center; gap: 10px; }
        .tool-header-icon { width: 30px; height: 30px; background: linear-gradient(135deg, #7c3aed 0%, #5b21b6 100%); border-radius: var(--radius-sm); display: flex; align-items: center; justify-content: center; flex-shrink: 0; box-shadow: 0 2px 8px rgba(124,58,237,0.25); }
        .tool-header h1 { font-size: 14px; font-weight: 600; color: var(--text); letter-spacing: -0.01em; }
        .tool-body { flex: 1; overflow-y: auto; padding: 24px; display: flex; flex-direction: column; gap: 18px; max-width: 780px; width: 100%; margin: 0 auto; box-sizing: border-box; }

        /* Drop zone */
        .drop-zone { border: 2px dashed var(--border-mid); border-radius: var(--radius); padding: 36px 24px; text-align: center; cursor: pointer; transition: all 0.2s; background: var(--bg-card); position: relative; }
        .drop-zone:hover, .drop-zone.drag-over { border-color: var(--accent); background: var(--accent-lo); }
        .drop-zone-icon { margin: 0 auto 10px; width: 38px; height: 38px; background: var(--bg-raised); border-radius: var(--radius); display: flex; align-items: center; justify-content: center; color: var(--text-dim); }
        .drop-zone-title { font-size: 13px; font-weight: 500; color: var(--text-mid); margin-bottom: 4px; }
        .drop-zone-hint { font-size: 12px; color: var(--text-dim); }
        .drop-zone-filename { margin-top: 10px; font-size: 12px; color: var(--accent); font-weight: 500; }
        .drop-zone input[type="file"] { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }

        /* Tool form fields */
        .tool-field-group { display: flex; flex-direction: column; gap: 14px; }
        .tool-field { display: flex; flex-direction: column; gap: 5px; }
        .tool-field label { font-size: 11px; font-weight: 600; color: var(--text-mid); letter-spacing: 0; }
        .tool-field input[type="text"],
        .tool-field input[type="number"],
        .tool-field input[type="date"],
        .tool-field textarea { width: 100%; padding: 9px 12px; background: var(--bg-raised); border: 1px solid var(--border-mid); border-radius: var(--radius-sm); color: var(--text); font-size: 13px; font-family: var(--sans); transition: border-color 0.15s; box-sizing: border-box; }
        .tool-field input:focus, .tool-field textarea:focus { border-color: var(--accent); outline: none; box-shadow: 0 0 0 3px var(--accent-lo); }
        .tool-field textarea { resize: vertical; min-height: 90px; font-family: var(--sans); line-height: 1.5; }
        .tool-field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }

        /* Escalation badge */
        .escalation-badge { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; }
        .escalation-badge.friendly { background: var(--green-lo); color: var(--green); border: 1px solid rgba(5,150,105,0.2); }
        .escalation-badge.firm { background: var(--accent-lo); color: var(--accent); border: 1px solid rgba(124,58,237,0.2); }
        .escalation-badge.urgent { background: var(--orange-lo); color: var(--orange); border: 1px solid rgba(217,119,6,0.2); }
        .escalation-badge.final { background: var(--red-lo); color: var(--red); border: 1px solid rgba(220,38,38,0.2); }

        /* Generate button */
        .tool-generate-btn { width: 100%; padding: 12px; background: var(--accent); color: #ffffff; border: none; border-radius: var(--radius-sm); font-weight: 600; font-size: 13px; font-family: var(--sans); cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; transition: opacity 0.15s, box-shadow 0.15s; box-shadow: var(--shadow-md); }
        .tool-generate-btn:hover:not(:disabled) { opacity: 0.9; box-shadow: var(--shadow-lg); }
        .tool-generate-btn:disabled { opacity: 0.4; cursor: not-allowed; }

        /* Output area */
        .tool-output { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; display: none; box-shadow: var(--shadow); }
        .tool-output.visible { display: block; }
        .tool-output-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--bg-raised); }
        .tool-output-label { font-size: 11px; font-weight: 600; color: var(--text-mid); }
        .tool-copy-btn { background: var(--bg-hover); border: 1px solid var(--border); color: var(--text-mid); font-size: 11px; font-weight: 500; padding: 5px 10px; border-radius: var(--radius-sm); cursor: pointer; display: flex; align-items: center; gap: 5px; transition: all 0.12s; }
        .tool-copy-btn:hover { color: var(--text); border-color: var(--border-mid); background: var(--bg-card); }
        .tool-output-body { padding: 16px 18px; font-family: var(--sans); font-size: 14px; color: var(--text); line-height: 1.7; white-space: pre-wrap; word-break: break-word; max-height: 500px; overflow-y: auto; }
        .tool-output-thinking { padding: 18px; font-size: 13px; color: var(--text-dim); display: flex; align-items: center; gap: 10px; }

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

        /* ===== AGENT ACTION BAR (send email / download PDF) ===== */
        .agent-action-bar { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
        .agent-action-btn { display: flex; align-items: center; gap: 7px; padding: 8px 14px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-mid); font-size: 12px; font-weight: 500; cursor: pointer; transition: all 0.15s; box-shadow: var(--shadow-sm); }
        .agent-action-btn:hover { background: var(--bg-raised); border-color: var(--border-mid); color: var(--text); box-shadow: var(--shadow); }
        .agent-action-btn.primary { background: var(--green-lo); border-color: rgba(5,150,105,0.2); color: var(--green); }
        .agent-action-btn.primary:hover { background: var(--green); color: #fff; border-color: var(--green); }
        .agent-action-btn.pdf { background: var(--accent-lo); border-color: rgba(124,58,237,0.2); color: var(--accent); }
        .agent-action-btn.pdf:hover { background: var(--accent); color: #fff; border-color: var(--accent); }
        .agent-action-btn:disabled { opacity: 0.4; cursor: not-allowed; }

        /* Send email inline form */
        .send-email-form { background: var(--bg-raised); border: 1px solid var(--border-mid); border-radius: var(--radius-sm); padding: 14px 16px; margin-top: 10px; display: none; }
        .send-email-form.visible { display: block; }
        .send-email-form label { font-family: var(--mono); font-size: 10px; color: var(--text-mid); letter-spacing: 0.07em; text-transform: uppercase; display: block; margin-bottom: 5px; }
        .send-email-form input { width: 100%; padding: 8px 11px; background: var(--bg-hover); border: 1px solid var(--border-mid); border-radius: var(--radius-sm); color: var(--text); font-size: 13px; font-family: var(--sans); box-sizing: border-box; margin-bottom: 10px; }
        .send-email-form input:focus { border-color: var(--accent); outline: none; }
        .send-email-row { display: flex; gap: 8px; }

        /* Invoice tracker */
        .invoice-tracker { margin-bottom: 18px; }
        .invoice-tracker-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
        .invoice-tracker-title { font-family: var(--mono); font-size: 11px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: var(--text-mid); }
        .invoice-list { display: flex; flex-direction: column; gap: 6px; max-height: 240px; overflow-y: auto; }
        .invoice-item { display: flex; align-items: center; gap: 10px; background: var(--bg-raised); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 9px 12px; font-family: var(--mono); font-size: 12px; cursor: pointer; transition: border-color 0.12s; }
        .invoice-item:hover { border-color: var(--border-hi); background: var(--bg-hover); }
        .invoice-item.selected { border-color: var(--accent); background: var(--accent-lo); }
        .inv-number { color: var(--accent); font-weight: 600; min-width: 80px; }
        .inv-client { color: var(--text); flex: 1; }
        .inv-amount { color: var(--text-mid); min-width: 70px; text-align: right; }
        .inv-status { font-size: 10px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; padding: 2px 7px; border-radius: 3px; }
        .inv-status.overdue { background: var(--red-lo); color: var(--red); }
        .inv-status.pending { background: var(--orange-lo); color: var(--orange); }
        .inv-status.paid { background: var(--green-lo); color: var(--green); }
        .inv-status.draft { background: var(--bg-hover); color: var(--text-dim); }
        .inv-del-btn { background: none; border: none; color: var(--text-dim); cursor: pointer; padding: 2px 5px; border-radius: 3px; font-size: 13px; flex-shrink: 0; }
        .inv-del-btn:hover { color: var(--red); background: var(--red-lo); }

        /* Add invoice form */
        .add-invoice-form { background: var(--bg-raised); border: 1px solid var(--border-mid); border-radius: var(--radius-sm); padding: 14px 16px; margin-bottom: 14px; }
        .form-row-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
        .sub-add-form { background: var(--bg-raised); border: 1px solid var(--border-mid); border-radius: var(--radius-sm); padding: 14px 16px; margin-bottom: 14px; display: none; }
        .sub-add-form.visible { display: block; }

        /* Automations settings */
        .automation-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; margin-bottom: 12px; box-shadow: var(--shadow); }
        .automation-card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
        .automation-card-title { font-size: 13px; font-weight: 600; color: var(--text); }
        .automation-card-status { font-family: var(--mono); font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; padding: 3px 8px; border-radius: 3px; }
        .automation-card-status.on { background: var(--green-lo); color: var(--green); }
        .automation-card-status.off { background: var(--bg-hover); color: var(--text-dim); }
        .toggle-switch { position: relative; display: inline-block; width: 36px; height: 20px; cursor: pointer; }
        .toggle-switch input { opacity: 0; width: 0; height: 0; }
        .toggle-slider { position: absolute; inset: 0; background: var(--bg-hover); border-radius: 20px; transition: 0.2s; }
        .toggle-slider:before { content: ''; position: absolute; width: 14px; height: 14px; left: 3px; bottom: 3px; background: var(--text-dim); border-radius: 50%; transition: 0.2s; }
        .toggle-switch input:checked + .toggle-slider { background: var(--green); }
        .toggle-switch input:checked + .toggle-slider:before { transform: translateX(16px); background: #fff; }
        .email-status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
        .email-status-dot.ok { background: var(--green); }
        .email-status-dot.err { background: var(--red); }

        /* ── Dashboard Home ── */
        .dashboard-home { display: none; flex-direction: column; padding: 28px 32px; width: 100%; max-width: 1100px; overflow-y: auto; box-sizing: border-box; }
        .dash-welcome { margin-bottom: 24px; }
        .dash-welcome h2 { font-size: 1.45rem; font-weight: 700; color: var(--text); letter-spacing: -0.02em; margin: 0 0 4px; }
        .dash-welcome p { color: var(--text-mid); font-size: 13px; margin: 0; }
        .dash-stats-row { display: grid; grid-template-columns: repeat(3,1fr); gap: 16px; margin-bottom: 28px; }
        .dash-stat-card { background: var(--bg-card); border-radius: var(--radius); padding: 20px 22px; box-shadow: var(--shadow); border: 1px solid var(--border); }
        .dash-stat-label { font-size: 11px; color: var(--text-mid); margin-bottom: 8px; font-weight: 500; }
        .dash-stat-value { font-size: 1.75rem; font-weight: 700; color: var(--text); letter-spacing: -0.02em; line-height: 1; }
        .dash-stat-sub { font-size: 11px; color: var(--text-dim); margin-top: 6px; }
        .dash-stat-card.green .dash-stat-value { color: var(--green); }
        .dash-stat-card.red .dash-stat-value { color: var(--red); }
        .dash-section-label { font-size: 10px; font-weight: 600; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 12px; }
        .dash-tools-grid { display: grid; grid-template-columns: repeat(4,1fr); gap: 12px; margin-bottom: 28px; }
        .dash-tool-card { background: var(--bg-card); border-radius: var(--radius); padding: 18px 16px 14px; box-shadow: var(--shadow); border: 1px solid var(--border); cursor: pointer; transition: box-shadow 0.15s, transform 0.15s, border-color 0.15s; text-align: left; width: 100%; font-family: var(--sans); }
        .dash-tool-card:hover { box-shadow: var(--shadow-md); transform: translateY(-2px); border-color: var(--border-mid); }
        .dash-tool-icon { width: 38px; height: 38px; border-radius: var(--radius-sm); display: flex; align-items: center; justify-content: center; margin-bottom: 10px; flex-shrink: 0; }
        .dash-tool-name { font-size: 12px; font-weight: 600; color: var(--text); margin-bottom: 3px; }
        .dash-tool-desc { font-size: 11px; color: var(--text-dim); line-height: 1.4; }
        .dash-chat-btn { width: 100%; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 18px; display: flex; align-items: center; gap: 12px; cursor: pointer; transition: box-shadow 0.15s, border-color 0.15s; box-shadow: var(--shadow); text-align: left; font-family: var(--sans); }
        .dash-chat-btn:hover { box-shadow: var(--shadow-md); border-color: var(--accent); }
        .dash-chat-icon { width: 34px; height: 34px; background: var(--accent-lo); border-radius: var(--radius-sm); display: flex; align-items: center; justify-content: center; color: var(--accent); flex-shrink: 0; }
        .dash-chat-label { font-size: 13px; font-weight: 600; color: var(--text); }
        .dash-chat-sub { font-size: 11px; color: var(--text-dim); margin-top: 2px; }

        /* ---- Connectors ---- */
        .connector-plus-btn { flex-shrink: 0; width: 32px; height: 32px; border-radius: 8px; background: var(--bg-raised); border: 1px solid var(--border); color: var(--text-mid); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background 0.15s, border-color 0.15s; }
        .connector-plus-btn:hover { background: var(--accent-lo); border-color: var(--accent); color: var(--accent); }
        .active-connectors-bar { padding: 6px 16px 0; display: flex; gap: 6px; flex-wrap: wrap; }
        .active-connector-chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px 3px 8px; background: var(--accent-lo); border: 1px solid rgba(124,58,237,0.25); border-radius: 20px; font-size: 11px; color: var(--accent); cursor: pointer; transition: background 0.15s; }
        .active-connector-chip:hover { background: rgba(124,58,237,0.15); }
        .active-connector-chip .chip-remove { margin-left: 4px; opacity: 0.6; font-size: 12px; line-height: 1; }
        .connector-overlay { position: fixed; inset: 0; background: rgba(15,23,42,0.55); z-index: 1000; display: flex; align-items: center; justify-content: center; }
        .connector-panel { background: var(--bg-card); border-radius: 16px; box-shadow: var(--shadow-lg); width: 640px; max-width: 94vw; max-height: 82vh; display: flex; flex-direction: column; overflow: hidden; }
        .connector-panel-header { padding: 18px 20px 14px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
        .connector-panel-title { font-size: 16px; font-weight: 700; color: var(--text); }
        .connector-panel-close { background: none; border: none; color: var(--text-dim); cursor: pointer; padding: 4px; border-radius: 6px; font-size: 18px; line-height: 1; display: flex; align-items: center; }
        .connector-panel-close:hover { color: var(--text); background: var(--bg-raised); }
        .connector-search { margin: 12px 16px 0; padding: 8px 12px; border: 1px solid var(--border-mid); border-radius: 8px; background: var(--bg-raised); color: var(--text); font-size: 13px; font-family: var(--sans); outline: none; width: calc(100% - 32px); }
        .connector-search:focus { border-color: var(--accent); }
        .connector-cat-tabs { padding: 10px 16px 0; display: flex; gap: 6px; flex-wrap: wrap; flex-shrink: 0; }
        .connector-cat-tab { padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 500; cursor: pointer; border: 1px solid var(--border); background: var(--bg-raised); color: var(--text-mid); transition: all 0.12s; }
        .connector-cat-tab:hover, .connector-cat-tab.active { background: var(--accent-lo); border-color: rgba(124,58,237,0.3); color: var(--accent); }
        .connector-list-scroll { flex: 1; overflow-y: auto; padding: 12px 16px 16px; }
        .connector-section-label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; color: var(--text-dim); margin: 12px 0 8px; }
        .connector-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
        .connector-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; padding: 12px 12px 10px; display: flex; flex-direction: column; gap: 4px; cursor: pointer; transition: all 0.12s; position: relative; }
        .connector-card:hover { border-color: var(--accent); box-shadow: var(--shadow); }
        .connector-card.connected { border-color: rgba(5,150,105,0.4); background: rgba(5,150,105,0.04); }
        .connector-card-emoji { font-size: 20px; line-height: 1; margin-bottom: 2px; }
        .connector-card-name { font-size: 12px; font-weight: 600; color: var(--text); }
        .connector-card-cat { font-size: 10px; color: var(--text-dim); }
        .connector-card-badge { position: absolute; top: 8px; right: 8px; font-size: 10px; background: rgba(5,150,105,0.12); color: #059669; border-radius: 4px; padding: 1px 5px; font-weight: 600; }
        .connector-add-drawer { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border); display: none; }
        .connector-add-drawer.open { display: block; }
        .connector-add-drawer-title { font-size: 13px; font-weight: 600; color: var(--text); margin-bottom: 10px; }
        .connector-field-label { font-size: 11px; color: var(--text-mid); font-weight: 500; margin-bottom: 4px; }
        .connector-field-input { width: 100%; padding: 8px 10px; border: 1px solid var(--border-mid); border-radius: 8px; background: var(--bg-raised); color: var(--text); font-size: 13px; font-family: var(--sans); outline: none; box-sizing: border-box; margin-bottom: 8px; }
        .connector-field-input:focus { border-color: var(--accent); }
        .connector-add-row { display: flex; gap: 8px; align-items: center; margin-top: 4px; }
        .connector-add-btn { background: var(--accent); color: #fff; border: none; border-radius: 8px; padding: 7px 16px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: var(--sans); transition: opacity 0.15s; }
        .connector-add-btn:hover { opacity: 0.9; }
        .connector-add-btn:disabled { opacity: 0.5; cursor: default; }
        .connector-cancel-btn { background: var(--bg-raised); color: var(--text-mid); border: 1px solid var(--border); border-radius: 8px; padding: 7px 14px; font-size: 13px; cursor: pointer; font-family: var(--sans); }
        .connector-err { font-size: 11px; color: var(--red); margin-top: 4px; }
        .connector-remove-btn { font-size: 11px; color: var(--red); background: var(--red-lo); border: 1px solid rgba(220,38,38,0.2); border-radius: 6px; padding: 3px 8px; cursor: pointer; font-family: var(--sans); margin-top: 6px; display: inline-block; }
        .connector-remove-btn:hover { background: rgba(220,38,38,0.15); }
        .connector-show-key-btn { font-size: 11px; color: var(--text-mid); background: var(--bg-raised); border: 1px solid var(--border); border-radius: 6px; padding: 3px 8px; cursor: pointer; font-family: var(--sans); margin-top: 6px; display: inline-block; }
        .connector-key-reveal { font-size: 11px; color: var(--text-mid); background: var(--bg-raised); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; margin-top: 6px; word-break: break-all; display: none; }
        .connector-key-reveal.visible { display: block; }
        .conn-pwd-modal { position: fixed; inset: 0; background: rgba(15,23,42,0.6); z-index: 1100; display: flex; align-items: center; justify-content: center; }
        .conn-pwd-card { background: var(--bg-card); border-radius: 12px; box-shadow: var(--shadow-lg); padding: 24px; width: 340px; max-width: 94vw; }
        .conn-pwd-title { font-size: 15px; font-weight: 700; color: var(--text); margin-bottom: 6px; }
        .conn-pwd-desc { font-size: 12px; color: var(--text-mid); margin-bottom: 14px; }
        .conn-pwd-input { width: 100%; padding: 9px 12px; border: 1px solid var(--border-mid); border-radius: 8px; background: var(--bg-raised); color: var(--text); font-size: 14px; outline: none; box-sizing: border-box; font-family: var(--sans); margin-bottom: 10px; }
        .conn-pwd-input:focus { border-color: var(--accent); }
        .conn-pwd-row { display: flex; gap: 8px; justify-content: flex-end; }
        .conn-pwd-ok { background: var(--accent); color: #fff; border: none; border-radius: 8px; padding: 8px 18px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: var(--sans); }
        .conn-pwd-cancel { background: var(--bg-raised); color: var(--text-mid); border: 1px solid var(--border); border-radius: 8px; padding: 8px 14px; font-size: 13px; cursor: pointer; font-family: var(--sans); }
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
        <div class="sidebar-brand" onclick="goHome()" role="button" tabindex="0" aria-label="Go to dashboard">
            <div class="sidebar-brand-icon" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
            </div>
            <div>
                <div class="sidebar-brand-name">Legend</div>
                <div class="sidebar-brand-sub">Construction AI</div>
            </div>
        </div>
        <div class="sidebar-header">
            <button class="home-btn" onclick="newChat()" aria-label="Start new chat" title="New Chat (Ctrl+K)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M12 5v14M5 12h14"/>
                </svg>
                New Chat
            </button>
        </div>

        <!-- AI Mode Selector -->

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

        <!-- Two-column: sidebar nav + content -->
        <div class="settings-body">

        <!-- Vertical Tab Nav -->
        <div class="stabs">
            <div class="stabs-group-label">Account</div>
            <button class="stab active" id="stab-profile" data-tab="profile" onclick="switchSettingsTab('profile')">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
                Profile
            </button>
            <div class="stabs-group-label">AI Config</div>
            <button class="stab" id="stab-system" data-tab="system" onclick="switchSettingsTab('system')">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                System
            </button>
            <button class="stab" id="stab-connectors" data-tab="connectors" onclick="switchSettingsTab('connectors')">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                Connectors
            </button>
            <div class="stabs-group-label">Tools</div>
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
            <div class="stabs-group-label">Automation</div>
            <button class="stab" id="stab-automations" data-tab="automations" onclick="switchSettingsTab('automations')">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93l-1.41 1.41M5.34 18.66l-1.41 1.41M21 12h-2M5 12H3M19.07 19.07l-1.41-1.41M5.34 5.34L3.93 3.93M12 3V1M12 23v-2"/></svg>
                Automations
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

        <!-- TAB: Automations -->
        <div class="stab-content" id="stab-content-automations">
            <div class="stab-section-title">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93l-1.41 1.41M5.34 18.66l-1.41 1.41M21 12h-2M5 12H3"/></svg>
                AI Workflow Automations
            </div>

            <!-- Email SMTP wizard -->
            <div class="automation-card">
                <div class="automation-card-header">
                    <span class="automation-card-title">Email Connection (SMTP)</span>
                    <span id="email-status-badge" class="automation-card-status off">Not Configured</span>
                </div>
                <p style="font-family:var(--mono);font-size:11px;color:var(--text-dim);line-height:1.6;margin:0 0 12px;">Configure SMTP to send emails from automations and tool outputs. Gmail: use App Password with smtp.gmail.com:587. Outlook: smtp.office365.com:587.</p>
                <div id="smtp-env-notice" style="display:none;font-family:var(--mono);font-size:10px;color:var(--text-dim);background:var(--bg-hover);border:1px solid var(--border-mid);border-radius:var(--radius-sm);padding:8px 10px;margin-bottom:10px;">
                    <strong style="color:var(--accent);">Note:</strong> SMTP is configured via environment variables on this server. Settings below are read-only.
                </div>
                <div class="tool-field-row" style="margin-bottom:8px;">
                    <div class="tool-field">
                        <label for="smtp-host-input">SMTP Host</label>
                        <input type="text" id="smtp-host-input" placeholder="smtp.gmail.com" style="background:var(--bg-hover);border:1px solid var(--border-mid);border-radius:var(--radius-sm);padding:8px 11px;color:var(--text);font-size:13px;width:100%;box-sizing:border-box;">
                    </div>
                    <div class="tool-field" style="max-width:100px;">
                        <label for="smtp-port-input">Port</label>
                        <input type="number" id="smtp-port-input" placeholder="587" min="1" max="65535" value="587" style="background:var(--bg-hover);border:1px solid var(--border-mid);border-radius:var(--radius-sm);padding:8px 11px;color:var(--text);font-size:13px;width:100%;box-sizing:border-box;">
                    </div>
                </div>
                <div class="tool-field-row" style="margin-bottom:8px;">
                    <div class="tool-field">
                        <label for="smtp-user-input">Username / Email</label>
                        <input type="email" id="smtp-user-input" placeholder="you@gmail.com" style="background:var(--bg-hover);border:1px solid var(--border-mid);border-radius:var(--radius-sm);padding:8px 11px;color:var(--text);font-size:13px;width:100%;box-sizing:border-box;">
                    </div>
                    <div class="tool-field">
                        <label for="smtp-pass-input">Password / App Password</label>
                        <input type="password" id="smtp-pass-input" placeholder="••••••••••••" style="background:var(--bg-hover);border:1px solid var(--border-mid);border-radius:var(--radius-sm);padding:8px 11px;color:var(--text);font-size:13px;width:100%;box-sizing:border-box;">
                    </div>
                </div>
                <div class="tool-field" style="margin-bottom:12px;">
                    <label for="smtp-from-input">From Name / Email (optional)</label>
                    <input type="text" id="smtp-from-input" placeholder="Legend Construction Services &lt;invoices@legendconstruction.com&gt;" style="background:var(--bg-hover);border:1px solid var(--border-mid);border-radius:var(--radius-sm);padding:8px 11px;color:var(--text);font-size:13px;width:100%;box-sizing:border-box;">
                </div>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                    <button class="settings-save-btn" onclick="saveSmtpConfigUI()" style="width:auto;padding:9px 20px;">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/></svg>
                        Save
                    </button>
                    <button class="agent-action-btn" id="smtp-test-btn" onclick="testSmtpConnection()" style="padding:9px 16px;">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                        Test Connection
                    </button>
                </div>
                <div id="smtp-save-status" style="font-family:var(--mono);font-size:11px;margin-top:8px;display:none;"></div>
                <p style="font-family:var(--mono);font-size:11px;color:var(--text-dim);margin:10px 0 0;">Sending as: <span id="email-from-display" style="color:var(--accent);">Not set</span></p>
            </div>

            <!-- Overdue invoice auto follow-up -->
            <div class="automation-card">
                <div class="automation-card-header">
                    <span class="automation-card-title">Daily Overdue Invoice Follow-Up</span>
                    <div style="display:flex;align-items:center;gap:10px;">
                        <span id="overdue-followup-status" class="automation-card-status off">OFF</span>
                        <label class="toggle-switch">
                            <input type="checkbox" id="overdue-followup-toggle" onchange="saveAutomationConfig()">
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                </div>
                <p style="font-family:var(--mono);font-size:11px;color:var(--text-dim);line-height:1.6;margin:0 0 12px;">AI automatically generates and sends follow-up emails to clients with overdue invoices (from your Invoice Tracker). Runs once daily at the scheduled time.</p>
                <div class="tool-field-row" style="margin-bottom:12px;">
                    <div class="tool-field">
                        <label>Run Time (Hour, 24h)</label>
                        <input type="number" id="auto-hour" placeholder="9" min="0" max="23" value="9" style="background:var(--bg-hover);border:1px solid var(--border-mid);border-radius:var(--radius-sm);padding:8px 11px;color:var(--text);font-size:13px;width:100%;box-sizing:border-box;">
                    </div>
                    <div class="tool-field">
                        <label>CC Email (optional)</label>
                        <input type="email" id="auto-cc-email" placeholder="you@yourcompany.com" style="background:var(--bg-hover);border:1px solid var(--border-mid);border-radius:var(--radius-sm);padding:8px 11px;color:var(--text);font-size:13px;width:100%;box-sizing:border-box;">
                    </div>
                </div>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                    <button class="settings-save-btn" onclick="saveAutomationConfig()" style="width:auto;padding:9px 20px;">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/></svg>
                        Save
                    </button>
                    <button class="agent-action-btn" id="auto-run-now-btn" onclick="runAutomationNow()" style="padding:9px 16px;">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                        Run Now
                    </button>
                </div>
                <div id="auto-last-run" style="font-family:var(--mono);font-size:11px;color:var(--text-dim);margin-top:6px;display:none;"></div>
                <div id="auto-save-status" style="font-family:var(--mono);font-size:11px;margin-top:8px;display:none;"></div>
            </div>

            <!-- Custom Automations Builder -->
            <div class="automation-card" style="border-color:var(--accent);padding-bottom:0;">
                <div class="automation-card-header" style="margin-bottom:6px;">
                    <span class="automation-card-title" style="font-size:14px;">Custom Automations</span>
                    <button class="agent-action-btn" onclick="openCustomAutomationForm()" style="padding:7px 14px;font-size:11px;">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                        New Automation
                    </button>
                </div>
                <p style="font-family:var(--mono);font-size:11px;color:var(--text-dim);line-height:1.6;margin:0 0 12px;">Build automations that can do almost anything — send emails, post to Zapier / Slack / Make, generate reports. Use <code style="background:var(--bg-hover);padding:1px 4px;border-radius:3px;">{{variable}}</code> tokens in your prompts.</p>

                <!-- Inline create/edit form (hidden by default) -->
                <div id="custom-auto-form" style="display:none;background:var(--bg);border:1px solid var(--border-mid);border-radius:var(--radius-sm);padding:14px 16px;margin-bottom:12px;">
                    <input type="hidden" id="ca-edit-id">
                    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
                        <div style="flex:1;min-width:160px;">
                            <label style="font-family:var(--mono);font-size:10px;color:var(--text-dim);display:block;margin-bottom:4px;">Automation Name *</label>
                            <input type="text" id="ca-name" placeholder="Weekly Revenue Report" style="width:100%;box-sizing:border-box;background:var(--bg-hover);border:1px solid var(--border-mid);border-radius:var(--radius-sm);padding:8px 10px;color:var(--text);font-size:12px;">
                        </div>
                        <div style="min-width:140px;">
                            <label style="font-family:var(--mono);font-size:10px;color:var(--text-dim);display:block;margin-bottom:4px;">Trigger</label>
                            <select id="ca-trigger" onchange="updateCustomAutoFormFields()" style="width:100%;background:var(--bg-hover);border:1px solid var(--border-mid);border-radius:var(--radius-sm);padding:8px 10px;color:var(--text);font-size:12px;">
                                <option value="manual">Manual only</option>
                                <option value="daily">Daily (cron)</option>
                                <option value="weekly">Weekly (cron)</option>
                                <option value="webhook">Incoming Webhook</option>
                            </select>
                        </div>
                    </div>
                    <div id="ca-trigger-fields" style="display:none;display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
                        <div id="ca-hour-wrap" style="min-width:100px;">
                            <label style="font-family:var(--mono);font-size:10px;color:var(--text-dim);display:block;margin-bottom:4px;">Hour (0-23)</label>
                            <input type="number" id="ca-hour" min="0" max="23" value="8" style="width:100%;box-sizing:border-box;background:var(--bg-hover);border:1px solid var(--border-mid);border-radius:var(--radius-sm);padding:8px 10px;color:var(--text);font-size:12px;">
                        </div>
                        <div id="ca-dow-wrap" style="display:none;min-width:120px;">
                            <label style="font-family:var(--mono);font-size:10px;color:var(--text-dim);display:block;margin-bottom:4px;">Day of Week</label>
                            <select id="ca-dow" style="width:100%;background:var(--bg-hover);border:1px solid var(--border-mid);border-radius:var(--radius-sm);padding:8px 10px;color:var(--text);font-size:12px;">
                                <option value="0">Sunday</option>
                                <option value="1">Monday</option>
                                <option value="2">Tuesday</option>
                                <option value="3">Wednesday</option>
                                <option value="4">Thursday</option>
                                <option value="5">Friday</option>
                                <option value="6">Saturday</option>
                            </select>
                        </div>
                    </div>
                    <div style="margin-bottom:10px;">
                        <label style="font-family:var(--mono);font-size:10px;color:var(--text-dim);display:block;margin-bottom:4px;">AI Prompt * <span style="color:var(--accent);font-size:9px;">Available: {{date}} {{time}} {{month}} {{overdue_count}} {{pending_count}} {{outstanding_total}} {{overdue_total}} {{overdue_invoices}} {{pending_invoices}}</span></label>
                        <textarea id="ca-prompt" rows="5" placeholder="Generate a professional weekly summary of outstanding invoices as of {{date}}. Include overdue count ({{overdue_count}}) and total outstanding ({{outstanding_total}}). List all overdue invoices:&#10;{{overdue_invoices}}" style="width:100%;box-sizing:border-box;background:var(--bg-hover);border:1px solid var(--border-mid);border-radius:var(--radius-sm);padding:8px 10px;color:var(--text);font-size:12px;font-family:var(--mono);resize:vertical;"></textarea>
                    </div>
                    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
                        <div style="min-width:140px;">
                            <label style="font-family:var(--mono);font-size:10px;color:var(--text-dim);display:block;margin-bottom:4px;">Action</label>
                            <select id="ca-action" onchange="updateCustomAutoFormFields()" style="width:100%;background:var(--bg-hover);border:1px solid var(--border-mid);border-radius:var(--radius-sm);padding:8px 10px;color:var(--text);font-size:12px;">
                                <option value="log">Log Only</option>
                                <option value="email">Send Email</option>
                                <option value="webhook">Post to Webhook</option>
                            </select>
                        </div>
                    </div>
                    <div id="ca-email-fields" style="display:none;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
                        <div style="flex:1;min-width:160px;">
                            <label style="font-family:var(--mono);font-size:10px;color:var(--text-dim);display:block;margin-bottom:4px;">Send To (email)</label>
                            <input type="email" id="ca-email-to" placeholder="boss@company.com" style="width:100%;box-sizing:border-box;background:var(--bg-hover);border:1px solid var(--border-mid);border-radius:var(--radius-sm);padding:8px 10px;color:var(--text);font-size:12px;">
                        </div>
                        <div style="flex:1;min-width:160px;">
                            <label style="font-family:var(--mono);font-size:10px;color:var(--text-dim);display:block;margin-bottom:4px;">Subject</label>
                            <input type="text" id="ca-email-subject" placeholder="Weekly Report - {{date}}" style="width:100%;box-sizing:border-box;background:var(--bg-hover);border:1px solid var(--border-mid);border-radius:var(--radius-sm);padding:8px 10px;color:var(--text);font-size:12px;">
                        </div>
                    </div>
                    <div id="ca-outwebhook-fields" style="display:none;margin-bottom:10px;">
                        <label style="font-family:var(--mono);font-size:10px;color:var(--text-dim);display:block;margin-bottom:4px;">Outbound Webhook URL (Zapier, Slack, Make, etc.)</label>
                        <input type="url" id="ca-webhook-url" placeholder="https://hooks.zapier.com/hooks/catch/..." style="width:100%;box-sizing:border-box;background:var(--bg-hover);border:1px solid var(--border-mid);border-radius:var(--radius-sm);padding:8px 10px;color:var(--text);font-size:12px;">
                    </div>
                    <div style="display:flex;gap:8px;align-items:center;padding:10px 0 14px;">
                        <button class="settings-save-btn" onclick="saveCustomAutomation()" style="width:auto;padding:8px 18px;font-size:12px;">Save</button>
                        <button class="agent-action-btn" onclick="cancelCustomAutomationForm()" style="padding:8px 14px;font-size:12px;">Cancel</button>
                        <span id="ca-form-status" style="font-family:var(--mono);font-size:11px;display:none;margin-left:8px;"></span>
                    </div>
                </div>

                <!-- List of custom automations -->
                <div id="custom-auto-list" style="padding-bottom:16px;">
                    <p style="font-family:var(--mono);font-size:11px;color:var(--text-dim);text-align:center;padding:20px 0;" id="custom-auto-empty">No custom automations yet. Click <strong>New Automation</strong> to create one.</p>
                </div>
            </div>

        </div><!-- /automations -->

        </div><!-- /settings-body -->

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
            <!-- Dashboard Home -->
            <div id="dashboard-home" class="dashboard-home">
                <div class="dash-welcome">
                    <h2 id="dash-greeting">Good morning</h2>
                    <p>Here's your construction business overview.</p>
                </div>
                <div class="dash-stats-row">
                    <div class="dash-stat-card">
                        <div class="dash-stat-label">Outstanding Invoices</div>
                        <div class="dash-stat-value" id="dash-outstanding">—</div>
                        <div class="dash-stat-sub">unpaid</div>
                    </div>
                    <div class="dash-stat-card red">
                        <div class="dash-stat-label">Overdue</div>
                        <div class="dash-stat-value" id="dash-overdue">—</div>
                        <div class="dash-stat-sub">past due date</div>
                    </div>
                    <div class="dash-stat-card green">
                        <div class="dash-stat-label">Paid This Month</div>
                        <div class="dash-stat-value" id="dash-paid">—</div>
                        <div class="dash-stat-sub">collected</div>
                    </div>
                </div>
                <div class="dash-section-label">Quick Access</div>
                <div class="dash-tools-grid">
                    <button class="dash-tool-card" onclick="showToolView('invoices')">
                        <div class="dash-tool-icon" style="background:rgba(37,99,235,0.1);color:#2563eb">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                        </div>
                        <div class="dash-tool-name">Invoice Follow-up</div>
                        <div class="dash-tool-desc">Track and collect on unpaid invoices</div>
                    </button>
                    <button class="dash-tool-card" onclick="showToolView('adjusters')">
                        <div class="dash-tool-icon" style="background:rgba(8,145,178,0.1);color:#0891b2">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.64 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.55 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9.91a16 16 0 0 0 6 6l.91-.91a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 21.73 17z"/></svg>
                        </div>
                        <div class="dash-tool-name">Adjuster Follow-up</div>
                        <div class="dash-tool-desc">Follow up with insurance adjusters</div>
                    </button>
                    <button class="dash-tool-card" onclick="showToolView('estimate')">
                        <div class="dash-tool-icon" style="background:rgba(5,150,105,0.1);color:#059669">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                        </div>
                        <div class="dash-tool-name">Estimate Generator</div>
                        <div class="dash-tool-desc">Create professional project estimates</div>
                    </button>
                    <button class="dash-tool-card" onclick="showToolView('changeorder')">
                        <div class="dash-tool-icon" style="background:rgba(217,119,6,0.1);color:#d97706">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                        </div>
                        <div class="dash-tool-name">Change Order</div>
                        <div class="dash-tool-desc">Generate change order documents</div>
                    </button>
                    <button class="dash-tool-card" onclick="showToolView('subs')">
                        <div class="dash-tool-icon" style="background:rgba(124,58,237,0.1);color:#7c3aed">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                        </div>
                        <div class="dash-tool-name">Subcontractors</div>
                        <div class="dash-tool-desc">Manage subcontractor agreements</div>
                    </button>
                    <button class="dash-tool-card" onclick="showToolView('materials')">
                        <div class="dash-tool-icon" style="background:rgba(202,138,4,0.1);color:#ca8a04">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
                        </div>
                        <div class="dash-tool-name">Materials List</div>
                        <div class="dash-tool-desc">Create and manage material orders</div>
                    </button>
                    <button class="dash-tool-card" onclick="showToolView('photos')">
                        <div class="dash-tool-icon" style="background:rgba(219,39,119,0.1);color:#db2777">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                        </div>
                        <div class="dash-tool-name">Photo Log</div>
                        <div class="dash-tool-desc">Document job site with photos</div>
                    </button>
                    <button class="dash-tool-card" onclick="showToolView('safety')">
                        <div class="dash-tool-icon" style="background:rgba(220,38,38,0.1);color:#dc2626">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                        </div>
                        <div class="dash-tool-name">Safety Checklist</div>
                        <div class="dash-tool-desc">OSHA compliance and site safety</div>
                    </button>
                </div>
                <div class="dash-section-label">AI Assistant</div>
                <button class="dash-chat-btn" onclick="document.getElementById('input').focus()">
                    <div class="dash-chat-icon">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                    </div>
                    <div>
                        <div class="dash-chat-label">Ask the AI Assistant</div>
                        <div class="dash-chat-sub">Type a question about invoices, estimates, safety, or anything else</div>
                    </div>
                </button>
            </div>
            </div>
        </div>
        <div id="active-connectors-bar" class="active-connectors-bar" style="display:none"></div>
        <div class="input-area" role="region" aria-label="Message input">
            <form id="chat-form" onsubmit="return false;">
                <div class="input-wrap">
                    <button type="button" id="connector-plus-btn" class="connector-plus-btn" onclick="openConnectorOverlay()" title="Connectors" aria-label="Open connectors">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    </button>
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

    <!-- Connector Overlay -->
    <div id="connector-overlay" class="connector-overlay" style="display:none" onclick="connectorOverlayBgClick(event)">
        <div class="connector-panel" id="connector-panel-inner">
            <div class="connector-panel-header">
                <span class="connector-panel-title">Connectors</span>
                <button class="connector-panel-close" onclick="closeConnectorOverlay()" aria-label="Close">&#x2715;</button>
            </div>
            <input id="connector-search" class="connector-search" type="text" placeholder="Search connectors..." oninput="filterConnectors()" autocomplete="off">
            <div id="connector-cat-tabs" class="connector-cat-tabs"></div>
            <div class="connector-list-scroll" id="connector-list-scroll">
                <div id="connector-grid-my"></div>
                <div id="connector-grid-all"></div>
            </div>
        </div>
    </div>

    <!-- Connector password modal -->
    <div id="conn-pwd-modal" class="conn-pwd-modal" style="display:none">
        <div class="conn-pwd-card">
            <div class="conn-pwd-title" id="conn-pwd-title">Confirm with Password</div>
            <div class="conn-pwd-desc" id="conn-pwd-desc">Enter your account password to continue.</div>
            <input type="password" class="conn-pwd-input" id="conn-pwd-input" placeholder="Password" autocomplete="current-password">
            <div class="connector-err" id="conn-pwd-err" style="margin-bottom:6px"></div>
            <div class="conn-pwd-row">
                <button class="conn-pwd-cancel" onclick="connPwdCancel()">Cancel</button>
                <button class="conn-pwd-ok" onclick="connPwdConfirm()">Confirm</button>
            </div>
        </div>
    </div>

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

            <!-- Saved Invoice Tracker -->
            <div class="invoice-tracker">
                <div class="invoice-tracker-header">
                    <span class="invoice-tracker-title">Saved Invoices (<span id="inv-list-count">0</span>)</span>
                    <div style="display:flex;gap:8px;flex-wrap:wrap;">
                        <button class="add-line-btn" onclick="toggleAddInvoiceForm()" style="padding:5px 12px;font-size:10px;">+ Add Invoice</button>
                        <button class="add-line-btn" onclick="exportInvoicesCSV()" style="padding:5px 12px;font-size:10px;" title="Export all invoices to CSV">&#8595; CSV</button>
                        <button class="add-line-btn" onclick="loadInvoiceList()" style="padding:5px 12px;font-size:10px;">&#8635; Refresh</button>
                    </div>
                </div>
                <!-- Outstanding summary banner -->
                <div id="inv-summary-bar" style="display:none;font-family:var(--mono);font-size:11px;background:var(--bg-raised);border:1px solid var(--border-mid);border-radius:var(--radius-sm);padding:8px 12px;margin-bottom:8px;display:flex;gap:16px;flex-wrap:wrap;">
                    <span>Outstanding: <strong id="inv-summary-outstanding" style="color:var(--accent);">$0</strong></span>
                    <span>Overdue: <strong id="inv-summary-overdue" style="color:var(--red);">$0</strong></span>
                    <span>Paid: <strong id="inv-summary-paid" style="color:var(--green);">$0</strong></span>
                </div>
                <!-- Search + filter bar -->
                <div style="display:flex;gap:8px;margin-bottom:8px;">
                    <input type="text" id="inv-search" placeholder="Search client, invoice #..." oninput="renderInvoiceList()" style="flex:1;padding:7px 10px;background:var(--bg-hover);border:1px solid var(--border-mid);border-radius:var(--radius-sm);color:var(--text);font-size:12px;font-family:var(--mono);">
                    <select id="inv-filter-status" onchange="renderInvoiceList()" style="padding:7px 10px;background:var(--bg-hover);border:1px solid var(--border-mid);border-radius:var(--radius-sm);color:var(--text);font-size:12px;font-family:var(--mono);">
                        <option value="">All Status</option>
                        <option value="overdue">Overdue</option>
                        <option value="pending">Pending</option>
                        <option value="paid">Paid</option>
                        <option value="draft">Draft</option>
                    </select>
                </div>
                <!-- Add / Edit invoice inline form -->
                <div class="add-invoice-form" id="add-invoice-form" style="display:none;">
                    <input type="hidden" id="inv-edit-id">
                    <div id="inv-form-title" style="font-family:var(--mono);font-size:11px;color:var(--accent);font-weight:600;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.06em;">Add Invoice</div>
                    <div class="tool-field-row" style="margin-bottom:10px;">
                        <div class="tool-field"><label>Client Name</label><input type="text" id="inv-new-client" placeholder="Mike Johnson"></div>
                        <div class="tool-field"><label>Client Email</label><input type="email" id="inv-new-email" placeholder="mike@example.com"></div>
                    </div>
                    <div class="tool-field-row" style="margin-bottom:10px;">
                        <div class="tool-field"><label>Invoice #</label><input type="text" id="inv-new-number" placeholder="INV-001"></div>
                        <div class="tool-field"><label>Amount ($)</label><input type="number" id="inv-new-amount" placeholder="5000" min="0"></div>
                    </div>
                    <div class="tool-field-row" style="margin-bottom:10px;">
                        <div class="tool-field"><label>Due Date</label><input type="date" id="inv-new-due"></div>
                        <div class="tool-field"><label>Status</label>
                            <select id="inv-new-status" style="padding:9px 12px;background:var(--bg-raised);border:1px solid var(--border-mid);border-radius:var(--radius-sm);color:var(--text);font-size:13px;">
                                <option value="pending">Pending</option>
                                <option value="overdue">Overdue</option>
                                <option value="paid">Paid</option>
                                <option value="draft">Draft</option>
                            </select>
                        </div>
                    </div>
                    <div style="display:flex;gap:8px;">
                        <button class="tool-generate-btn" id="inv-save-btn" style="padding:8px 16px;font-size:12px;width:auto;" onclick="saveInvoiceEntry()">Save Invoice</button>
                        <button class="add-line-btn" onclick="cancelInvoiceForm()">Cancel</button>
                    </div>
                </div>
                <!-- Invoice list -->
                <div class="invoice-list" id="inv-list">
                    <div style="color:var(--text-dim);font-family:var(--mono);font-size:12px;padding:10px 0;">No saved invoices yet. Add one above.</div>
                </div>
            </div>

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
                <div class="drop-zone-title">Drop invoice file here or select a saved invoice above</div>
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
            <div class="tool-output" id="invoice-output" style="display:none;">
                <div class="tool-output-header">
                    <span class="tool-output-label">Generated Email</span>
                    <button class="tool-copy-btn" onclick="copyToolOutput('invoice-output-body')" aria-label="Copy to clipboard">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                        Copy
                    </button>
                </div>
                <div class="tool-output-body" id="invoice-output-body"></div>
                <!-- Agent action bar -->
                <div class="agent-action-bar" style="padding:0 18px 14px;">
                    <button class="agent-action-btn primary" onclick="toggleSendEmailForm('invoice')">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                        Send Email
                    </button>
                    <button class="agent-action-btn pdf" onclick="downloadPDF('invoice-output-body', 'Invoice Follow-up Email')">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                        Download PDF
                    </button>
                </div>
                <!-- Send email form -->
                <div class="send-email-form" id="invoice-send-form" style="margin:0 18px 14px;">
                    <label>Recipient Email</label>
                    <input type="email" id="invoice-email-to" placeholder="client@example.com">
                    <label>Subject</label>
                    <input type="text" id="invoice-email-subject" placeholder="Invoice Follow-Up">
                    <div class="send-email-row">
                        <button class="agent-action-btn primary" style="flex:1;" onclick="sendEmailFromTool('invoice')">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                            <span id="invoice-send-btn-label">Send Now</span>
                        </button>
                        <button class="agent-action-btn" onclick="toggleSendEmailForm('invoice')">Cancel</button>
                    </div>
                    <div id="invoice-send-status" style="margin-top:8px;font-family:var(--mono);font-size:11px;display:none;"></div>
                </div>
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

            <div class="tool-output" id="adjuster-output" style="display:none;">
                <div class="tool-output-header">
                    <span class="tool-output-label">Generated Email</span>
                    <button class="tool-copy-btn" onclick="copyToolOutput('adjuster-output-body')" aria-label="Copy to clipboard">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                        Copy
                    </button>
                </div>
                <div class="tool-output-body" id="adjuster-output-body"></div>
                <div class="agent-action-bar" style="padding:0 18px 14px;">
                    <button class="agent-action-btn primary" onclick="toggleSendEmailForm('adjuster')">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                        Send Email
                    </button>
                    <button class="agent-action-btn pdf" onclick="downloadPDF('adjuster-output-body', 'Adjuster Follow-up Email')">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                        Download PDF
                    </button>
                </div>
                <div class="send-email-form" id="adjuster-send-form" style="margin:0 18px 14px;">
                    <label>Adjuster Email</label>
                    <input type="email" id="adjuster-email-to" placeholder="adjuster@insurance.com">
                    <label>Subject</label>
                    <input type="text" id="adjuster-email-subject" placeholder="Claim Follow-Up">
                    <div class="send-email-row">
                        <button class="agent-action-btn primary" style="flex:1;" onclick="sendEmailFromTool('adjuster')">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                            <span id="adjuster-send-btn-label">Send Now</span>
                        </button>
                        <button class="agent-action-btn" onclick="toggleSendEmailForm('adjuster')">Cancel</button>
                    </div>
                    <div id="adjuster-send-status" style="margin-top:8px;font-family:var(--mono);font-size:11px;display:none;"></div>
                </div>
            </div>

        </div>
    </div>

    <!-- ===== TOOL VIEW: Estimate Generator ===== -->
    <div class="tool-view" id="tool-view-estimate" role="main" aria-label="Estimate Generator Tool">
        <div class="tool-header">
            <div class="tool-header-left">
                <button class="tool-back-btn" onclick="goHome()" aria-label="Back to chat">
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
                <div class="agent-action-bar" style="padding:0 18px 14px;">
                    <button class="agent-action-btn pdf" onclick="downloadPDF('est-output-body', 'Estimate')">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                        Download PDF
                    </button>
                </div>
            </div>
        </div>
    </div>

    <!-- ===== TOOL VIEW: Change Order ===== -->
    <div class="tool-view" id="tool-view-changeorder" role="main" aria-label="Change Order Tool">
        <div class="tool-header">
            <div class="tool-header-left">
                <button class="tool-back-btn" onclick="goHome()" aria-label="Back to chat">
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
                <div class="agent-action-bar" style="padding:0 18px 14px;">
                    <button class="agent-action-btn pdf" onclick="downloadPDF('co-output-body', 'Change Order')">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                        Download PDF
                    </button>
                </div>
            </div>
        </div>
    </div>

    <!-- ===== TOOL VIEW: Subcontractor Management ===== -->
    <div class="tool-view" id="tool-view-subs" role="main" aria-label="Subcontractor Management Tool">
        <div class="tool-header">
            <div class="tool-header-left">
                <button class="tool-back-btn" onclick="goHome()" aria-label="Back to chat">
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
                <button class="tool-back-btn" onclick="goHome()" aria-label="Back to chat">
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
                <button class="add-line-btn" onclick="exportMaterialsText()" title="Export as text file">&#8595; Export</button>
            </div>
        </div>
    </div>

    <!-- ===== TOOL VIEW: Job Site Photo Log ===== -->
    <div class="tool-view" id="tool-view-photos" role="main" aria-label="Photo Log Tool">
        <div class="tool-header">
            <div class="tool-header-left">
                <button class="tool-back-btn" onclick="goHome()" aria-label="Back to chat">
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
                <button class="tool-back-btn" onclick="goHome()" aria-label="Back to chat">
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
            const dash = document.getElementById('dashboard-home');
            if (dash) { dash.style.display = 'flex'; buildDashboardHome(); }
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
            showToolView('chat');
            saveCurrentChat();
            currentChatId = generateChatId();
            currentMessages = [];
            localStorage.setItem('currentChatId', currentChatId);
            // Clear chat messages
            const inner = getChatInner();
            inner.querySelectorAll('.message-row').forEach(r => r.remove());
            // Show dashboard
            const dash = document.getElementById('dashboard-home');
            if (dash) { dash.style.display = 'flex'; buildDashboardHome(); }
            loadHistoryUI();
        }

        function newChat() {
            showToolView('chat');
            saveCurrentChat();
            currentChatId = generateChatId();
            currentMessages = [];
            localStorage.setItem('currentChatId', currentChatId);
            // Clear chat messages
            const inner = getChatInner();
            inner.querySelectorAll('.message-row').forEach(r => r.remove());
            // Hide dashboard, focus input
            const dash = document.getElementById('dashboard-home');
            if (dash) dash.style.display = 'none';
            loadHistoryUI();
            const inp = document.getElementById('input');
            if (inp) inp.focus();
        }

        async function buildDashboardHome() {
            const hour = new Date().getHours();
            const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
            const nameEl = document.getElementById('account-name');
            const name = nameEl ? nameEl.textContent.trim() : '';
            const greetEl = document.getElementById('dash-greeting');
            if (greetEl) greetEl.textContent = name ? greeting + ', ' + name : greeting;
            // Load invoice stats
            try {
                const token = getAuthToken();
                if (!token) return;
                const resp = await fetch('/api/invoices', { headers: { 'Authorization': 'Bearer ' + token } });
                if (!resp.ok) return;
                const data = await resp.json();
                const invoices = data.invoices || [];
                const now = new Date();
                const thisMonth = now.getMonth(), thisYear = now.getFullYear();
                let outstanding = 0, overdueCount = 0, paidMonth = 0;
                invoices.forEach(function(inv) {
                    if (inv.status === 'paid') {
                        const d = new Date(inv.paidDate || inv.createdAt || inv.date || 0);
                        if (d.getMonth() === thisMonth && d.getFullYear() === thisYear)
                            paidMonth += parseFloat(inv.amount) || 0;
                    } else {
                        outstanding++;
                        if (inv.dueDate && new Date(inv.dueDate) < now) overdueCount++;
                    }
                });
                const fmt = function(n) { return '$' + n.toLocaleString('en-US', {minimumFractionDigits: 0, maximumFractionDigits: 0}); };
                const el = function(id) { return document.getElementById(id); };
                if (el('dash-outstanding')) el('dash-outstanding').textContent = outstanding;
                if (el('dash-overdue')) el('dash-overdue').textContent = overdueCount;
                if (el('dash-paid')) el('dash-paid').textContent = fmt(paidMonth);
            } catch(e) { /* stats unavailable */ }
        }

        function setPrompt(text) {
            input.value = text;
            input.focus();
        }

        // Load history on startup
        loadHistoryUI();

        // Show dashboard on startup if already authenticated
        if (isAuthenticated()) {
            const dash = document.getElementById('dashboard-home');
            if (dash) { dash.style.display = 'flex'; buildDashboardHome(); }
        }

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
            const dash = document.getElementById('dashboard-home');
            if (dash) dash.style.display = 'none';

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
                avatar.className = 'msg-avatar bot-av';
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
            const DEFAULT_CONSTRUCTION_PROMPT = 'You are an AI assistant for a construction business. Help with invoices, estimates, change orders, client follow-ups, subcontractors, materials, safety, and project management. Be professional, concise, and focused on construction industry needs.';
            if (el('system-prompt-input')) el('system-prompt-input').value = localStorage.getItem('system_prompt') || DEFAULT_CONSTRUCTION_PROMPT;
            if (el('chat-temp-input')) {
                const temp = localStorage.getItem('chat_temperature') || '0.7';
                el('chat-temp-input').value = temp;
                if (el('chat-temp-val')) el('chat-temp-val').textContent = temp;
            }
            if (el('chat-lang-input')) el('chat-lang-input').value = localStorage.getItem('chat_language') || 'en';

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
                            systemPrompt: localStorage.getItem('system_prompt') || ''
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

                    addMsg('bot', data.response, data.ai, null);

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
                newChat();
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
             'invoice_system_prompt','adjuster_system_prompt'].forEach(k => localStorage.removeItem(k));
            refreshAccountUI();
            closeSettings();
            showSettingsToast('Account reset');
        }

        function saveSystemSettings() {
            const prompt = document.getElementById('system-prompt-input')?.value || '';
            const temp   = document.getElementById('chat-temp-input')?.value || '0.7';
            const lang   = document.getElementById('chat-lang-input')?.value || 'en';
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
            const hasContext = invoiceFileContent || (document.getElementById('invoice-notes-input')?.value?.trim());
            if (btn && hasContext) btn.disabled = false;
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

                var tdDesc = document.createElement('td');
                var inDesc = document.createElement('input');
                inDesc.type = 'text'; inDesc.value = row.desc || ''; inDesc.placeholder = 'Item description';
                (function(rid) { inDesc.addEventListener('input', function() { updateEstimateRow(rid, 'desc', this.value); }); })(row.id);
                tdDesc.appendChild(inDesc);

                var tdQty = document.createElement('td');
                var inQty = document.createElement('input');
                inQty.type = 'number'; inQty.value = row.qty; inQty.min = '0'; inQty.step = '0.01'; inQty.style.width = '60px';
                (function(rid) { inQty.addEventListener('input', function() { updateEstimateRow(rid, 'qty', this.value); }); })(row.id);
                tdQty.appendChild(inQty);

                var tdPrice = document.createElement('td');
                var inPrice = document.createElement('input');
                inPrice.type = 'number'; inPrice.value = row.price; inPrice.min = '0'; inPrice.step = '0.01'; inPrice.style.width = '80px';
                (function(rid) { inPrice.addEventListener('input', function() { updateEstimateRow(rid, 'price', this.value); }); })(row.id);
                tdPrice.appendChild(inPrice);

                var tdTotal = document.createElement('td');
                tdTotal.style.fontFamily = 'var(--mono)';
                tdTotal.id = 'est-row-total-' + row.id;
                tdTotal.textContent = '$' + total.toFixed(2);

                var tdDel = document.createElement('td');
                var btnDel = document.createElement('button');
                btnDel.className = 'del-row-btn'; btnDel.textContent = 'x';
                (function(rid) { btnDel.addEventListener('click', function() { deleteEstimateRow(rid); }); })(row.id);
                tdDel.appendChild(btnDel);

                tr.appendChild(tdDesc); tr.appendChild(tdQty); tr.appendChild(tdPrice);
                tr.appendChild(tdTotal); tr.appendChild(tdDel);
                tbody.appendChild(tr);
            });
            updateEstimateTotal();
        }

        function updateEstimateRow(id, field, value) {
            var row = estimateRows.find(function(r) { return r.id === id; });
            if (row) { row[field] = value; }
            var total = row ? (parseFloat(row.qty) || 0) * (parseFloat(row.price) || 0) : 0;
            var totalCell = document.getElementById('est-row-total-' + id);
            if (totalCell) totalCell.textContent = '$' + total.toFixed(2);
            updateEstimateTotal();
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
            }).join(String.fromCharCode(10));
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
            var now = new Date();
            var in30 = new Date(now.getTime() + 30 * 86400000);
            subList.forEach(function(sub) {
                var insExpired = sub.insExp && new Date(sub.insExp) < now;
                var insExpiringSoon = !insExpired && sub.insExp && new Date(sub.insExp) < in30;
                var insColor = insExpired ? 'color:var(--red)' : insExpiringSoon ? 'color:var(--orange)' : '';
                var insIcon = insExpired ? ' <span title="Insurance expired">&#9888;</span>' : insExpiringSoon ? ' <span title="Expiring within 30 days">&#9201;</span>' : '';
                var tr = document.createElement('tr');
                tr.innerHTML = '<td><strong style="color:var(--text)">' + escapeAttr(sub.name) + '</strong>' + (sub.notes ? '<br><span style="font-size:11px;color:var(--text-dim)">' + escapeAttr(sub.notes) + '</span>' : '') + '</td>' +
                    '<td style="font-family:var(--mono);font-size:12px;">' + escapeAttr(sub.trade) + '</td>' +
                    '<td style="font-family:var(--mono);font-size:12px;white-space:nowrap;">' + escapeAttr(sub.phone) + '</td>' +
                    '<td style="font-family:var(--mono);font-size:12px;' + insColor + '">' + (sub.insExp || '-') + insIcon + '</td>' +
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

        function exportMaterialsText() {
            if (!matList.length) { showSettingsToast('No items to export'); return; }
            var categories = {};
            matList.forEach(function(m) {
                if (!categories[m.cat]) categories[m.cat] = [];
                categories[m.cat].push((m.checked ? '[x] ' : '[ ] ') + m.name);
            });
            var lines = ['MATERIALS & SUPPLY CHECKLIST', 'Generated: ' + new Date().toLocaleString(), ''];
            Object.keys(categories).sort().forEach(function(cat) {
                lines.push('--- ' + cat.toUpperCase() + ' ---');
                categories[cat].forEach(function(l) { lines.push('  ' + l); });
                lines.push('');
            });
            var checked = matList.filter(function(m) { return m.checked; }).length;
            lines.push('TOTAL: ' + checked + ' of ' + matList.length + ' items checked');
            var blob = new Blob([lines.join('\\n')], { type: 'text/plain' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url; a.download = 'materials-' + new Date().toISOString().slice(0,10) + '.txt';
            document.body.appendChild(a); a.click();
            document.body.removeChild(a); URL.revokeObjectURL(url);
            showSettingsToast('Materials list exported');
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
            var closeBtn = document.createElement('button');
            closeBtn.className = 'photo-lightbox-close'; closeBtn.textContent = '\u00D7';
            closeBtn.addEventListener('click', function() { lb.remove(); });
            var lbImg = document.createElement('img');
            lbImg.src = photo.url; lbImg.alt = photo.name || '';
            var lbCap = document.createElement('div');
            lbCap.className = 'photo-lightbox-caption';
            lbCap.textContent = (photo.name || '') + (photo.tag ? ' \u2022 ' + photo.tag : '') + ' \u2022 ' + (photo.time || '');
            lb.appendChild(closeBtn); lb.appendChild(lbImg); lb.appendChild(lbCap);
            lb.addEventListener('click', function(e) { if (e.target === lb) lb.remove(); });
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

                var header = document.createElement('div');
                header.className = 'safety-category-header';
                var titleSpan = document.createElement('span'); titleSpan.className = 'safety-cat-title'; titleSpan.textContent = cat.title;
                var countSpan = document.createElement('span'); countSpan.className = 'safety-cat-count'; countSpan.textContent = checkedCount + '/' + cat.items.length;
                var chevron = document.createElement('span'); chevron.className = 'safety-cat-chevron'; chevron.textContent = '\u25BC';
                header.appendChild(titleSpan); header.appendChild(countSpan); header.appendChild(chevron);
                (function(catId) { header.addEventListener('click', function() { toggleSafetyCat(catId); }); })(cat.id);

                var itemsDiv = document.createElement('div');
                itemsDiv.className = 'safety-items';

                cat.items.forEach(function(itemText, idx) {
                    var key = cat.id + '_' + idx;
                    var isChecked = !!safetyData.checks[key];
                    var itemDiv = document.createElement('div');
                    itemDiv.className = 'safety-item' + (isChecked ? ' checked' : '');
                    itemDiv.id = 'safety-item-' + key;
                    var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = isChecked;
                    (function(catId, itemIdx) { cb.addEventListener('change', function() { toggleSafetyItem(catId, itemIdx, this.checked); }); })(cat.id, idx);
                    var span = document.createElement('span'); span.className = 'safety-item-text'; span.textContent = itemText;
                    itemDiv.appendChild(cb); itemDiv.appendChild(span);
                    itemsDiv.appendChild(itemDiv);
                });

                div.appendChild(header); div.appendChild(itemsDiv);
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

        // ============================================
        // PDF DOWNLOAD
        // ============================================
        function downloadPDF(elementId, title) {
            var el = document.getElementById(elementId);
            if (!el) return;
            var text = el.textContent || el.innerText || '';
            if (!text.trim()) { showSettingsToast('Nothing to download yet'); return; }
            try {
                var jsPDF = window.jspdf && window.jspdf.jsPDF;
                if (!jsPDF) { showSettingsToast('PDF library not loaded'); return; }
                var doc = new jsPDF({ unit: 'mm', format: 'a4' });
                var margin = 20;
                var pageWidth = doc.internal.pageSize.getWidth() - margin * 2;
                var pageHeight = doc.internal.pageSize.getHeight() - margin * 2;
                var y = margin;
                doc.setFont('helvetica', 'bold');
                doc.setFontSize(16);
                doc.setTextColor(40, 40, 40);
                doc.text(title, margin, y);
                y += 8;
                doc.setDrawColor(139, 92, 246);
                doc.setLineWidth(0.5);
                doc.line(margin, y, margin + pageWidth, y);
                y += 7;
                doc.setFont('helvetica', 'normal');
                doc.setFontSize(10);
                doc.setTextColor(60, 60, 60);
                var lines = doc.splitTextToSize(text, pageWidth);
                var lineH = 5;
                lines.forEach(function(line) {
                    if (y + lineH > margin + pageHeight) { doc.addPage(); y = margin; }
                    doc.text(line, margin, y);
                    y += lineH;
                });
                var stamp = new Date().toLocaleDateString('en-US', {year:'numeric',month:'short',day:'numeric'});
                doc.setFontSize(8);
                doc.setTextColor(160, 160, 160);
                doc.text('Generated by AI Work Agent ' + stamp, margin, doc.internal.pageSize.getHeight() - 8);
                var filename = title.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '_' + Date.now() + '.pdf';
                doc.save(filename);
                showSettingsToast('PDF downloaded');
            } catch(e) {
                showSettingsToast('PDF error: ' + e.message);
            }
        }

        // ============================================
        // SEND EMAIL (from tool output)
        // ============================================
        function toggleSendEmailForm(tool) {
            var form = document.getElementById(tool + '-send-form');
            if (!form) return;
            form.classList.toggle('visible');
        }

        async function sendEmailFromTool(tool) {
            var to = (document.getElementById(tool + '-email-to') || {}).value || '';
            var subject = (document.getElementById(tool + '-email-subject') || {}).value || '';
            var bodyEl = document.getElementById(tool + '-output-body');
            var body = bodyEl ? (bodyEl.textContent || bodyEl.innerText || '') : '';
            var btnLabel = document.getElementById(tool + '-send-btn-label');
            var statusEl = document.getElementById(tool + '-send-status');

            if (!to || !subject || !body.trim()) {
                showSettingsToast('Fill in recipient email and subject');
                return;
            }
            if (btnLabel) btnLabel.textContent = 'Sending...';
            if (statusEl) { statusEl.style.display = ''; statusEl.textContent = 'Sending...'; statusEl.style.color = 'var(--text-dim)'; }

            var token = getAuthToken();
            try {
                var resp = await fetch('/send-email', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ to: to, subject: subject, body: body })
                });
                var data = await resp.json();
                if (resp.ok && data.success) {
                    if (statusEl) { statusEl.textContent = 'Email sent to ' + to; statusEl.style.color = 'var(--green)'; }
                    showSettingsToast('Email sent to ' + to);
                    if (btnLabel) btnLabel.textContent = 'Sent!';
                    setTimeout(function() { if (btnLabel) btnLabel.textContent = 'Send Now'; }, 3000);
                } else {
                    var msg = data.error || 'Failed to send';
                    if (statusEl) { statusEl.textContent = msg; statusEl.style.color = 'var(--red)'; }
                    showSettingsToast(msg);
                    if (btnLabel) btnLabel.textContent = 'Send Now';
                }
            } catch(e) {
                if (statusEl) { statusEl.textContent = 'Error: ' + e.message; statusEl.style.color = 'var(--red)'; }
                if (btnLabel) btnLabel.textContent = 'Send Now';
            }
        }

        // ============================================
        // INVOICE TRACKER (persistent, server-side)
        // ============================================
        var savedInvoices = [];

        function loadInvoiceList() {
            var token = getAuthToken();
            if (!token) return;
            fetch('/api/invoices', { headers: { 'Authorization': 'Bearer ' + token } })
                .then(function(r) { return r.json(); })
                .then(function(data) {
                    savedInvoices = data.invoices || [];
                    renderInvoiceList();
                }).catch(function() {});
        }

        function renderInvoiceList() {
            var list = document.getElementById('inv-list');
            var count = document.getElementById('inv-list-count');
            if (!list) return;
            if (count) count.textContent = savedInvoices.length;

            // Summary banner
            var outstanding = 0, overdueAmt = 0, paidAmt = 0;
            savedInvoices.forEach(function(inv) {
                var amt = inv.amount || 0;
                if (inv.status === 'paid') paidAmt += amt;
                else if (inv.status !== 'draft') outstanding += amt;
                if (inv.status === 'overdue') overdueAmt += amt;
            });
            var summaryBar = document.getElementById('inv-summary-bar');
            if (summaryBar && savedInvoices.length > 0) {
                summaryBar.style.display = 'flex';
                var fmtAmt = function(n) { return '$' + n.toLocaleString(); };
                var el = document.getElementById('inv-summary-outstanding');
                if (el) el.textContent = fmtAmt(outstanding);
                el = document.getElementById('inv-summary-overdue');
                if (el) el.textContent = fmtAmt(overdueAmt);
                el = document.getElementById('inv-summary-paid');
                if (el) el.textContent = fmtAmt(paidAmt);
            } else if (summaryBar) { summaryBar.style.display = 'none'; }

            if (savedInvoices.length === 0) {
                list.innerHTML = '<div style="color:var(--text-dim);font-family:var(--mono);font-size:12px;padding:10px 0;">No saved invoices yet. Add one above.</div>';
                return;
            }

            // Apply search + filter
            var searchTerm = ((document.getElementById('inv-search') || {}).value || '').toLowerCase();
            var filterStatus = (document.getElementById('inv-filter-status') || {}).value || '';
            var filtered = savedInvoices.filter(function(inv) {
                if (filterStatus && inv.status !== filterStatus) return false;
                if (searchTerm) {
                    var haystack = (inv.clientName + ' ' + inv.invoiceNumber + ' ' + (inv.clientEmail || '')).toLowerCase();
                    if (haystack.indexOf(searchTerm) === -1) return false;
                }
                return true;
            });

            var today = Date.now();
            list.innerHTML = '';
            if (filtered.length === 0) {
                list.innerHTML = '<div style="color:var(--text-dim);font-family:var(--mono);font-size:12px;padding:10px 0;">No invoices match your search.</div>';
                return;
            }
            filtered.forEach(function(inv) {
                var daysOverdue = inv.dueDate ? Math.floor((today - new Date(inv.dueDate).getTime()) / 86400000) : 0;
                var item = document.createElement('div');
                item.className = 'invoice-item';
                item.dataset.id = inv.id;
                var statusClass = inv.status === 'overdue' ? 'overdue' : inv.status === 'paid' ? 'paid' : inv.status === 'draft' ? 'draft' : 'pending';
                var daysLabel = inv.status === 'overdue' && daysOverdue > 0 ? ' (' + daysOverdue + 'd)' : '';
                var followUpLabel = inv.lastFollowUp ? '<span style="font-size:10px;color:var(--text-dim);margin-left:6px;" title="Last follow-up sent">&#9993; ' + Math.floor((today - inv.lastFollowUp) / 86400000) + 'd ago</span>' : '';
                item.innerHTML =
                    '<span class="inv-number">' + inv.invoiceNumber + '</span>' +
                    '<span class="inv-client">' + inv.clientName + followUpLabel + '</span>' +
                    '<span class="inv-amount">$' + (inv.amount || 0).toLocaleString() + '</span>' +
                    '<span class="inv-status ' + statusClass + '">' + inv.status + daysLabel + '</span>' +
                    '<button class="inv-del-btn" title="Edit" style="margin-right:2px;">&#9998;</button>' +
                    '<button class="inv-del-btn" title="Delete">&#10005;</button>';
                var btns = item.querySelectorAll('.inv-del-btn');
                btns[0].addEventListener('click', function(e) { e.stopPropagation(); editInvoiceEntry(inv); });
                btns[1].addEventListener('click', function(e) { e.stopPropagation(); deleteInvoiceEntry(inv.id); });
                item.addEventListener('click', function() { selectInvoiceForFollowup(inv, daysOverdue); });
                list.appendChild(item);
            });
        }

        function toggleAddInvoiceForm() {
            var form = document.getElementById('add-invoice-form');
            if (!form) return;
            if (form.style.display !== 'none') { cancelInvoiceForm(); return; }
            // Reset to "Add" mode
            var idEl = document.getElementById('inv-edit-id');
            if (idEl) idEl.value = '';
            var title = document.getElementById('inv-form-title');
            if (title) title.textContent = 'Add Invoice';
            var btn = document.getElementById('inv-save-btn');
            if (btn) btn.textContent = 'Save Invoice';
            form.style.display = '';
        }

        function cancelInvoiceForm() {
            var form = document.getElementById('add-invoice-form');
            if (form) form.style.display = 'none';
            var idEl = document.getElementById('inv-edit-id');
            if (idEl) idEl.value = '';
            ['inv-new-client','inv-new-email','inv-new-number','inv-new-amount','inv-new-due'].forEach(function(id) {
                var el = document.getElementById(id);
                if (el) el.value = '';
            });
            var statusSel = document.getElementById('inv-new-status');
            if (statusSel) statusSel.value = 'pending';
        }

        function editInvoiceEntry(inv) {
            var form = document.getElementById('add-invoice-form');
            if (!form) return;
            var idEl = document.getElementById('inv-edit-id');
            if (idEl) idEl.value = inv.id;
            var title = document.getElementById('inv-form-title');
            if (title) title.textContent = 'Edit Invoice';
            var btn = document.getElementById('inv-save-btn');
            if (btn) btn.textContent = 'Update Invoice';
            var set = function(id, val) { var el = document.getElementById(id); if (el) el.value = val || ''; };
            set('inv-new-client', inv.clientName);
            set('inv-new-email', inv.clientEmail);
            set('inv-new-number', inv.invoiceNumber);
            set('inv-new-amount', inv.amount);
            set('inv-new-due', inv.dueDate);
            var statusSel = document.getElementById('inv-new-status');
            if (statusSel) statusSel.value = inv.status || 'pending';
            form.style.display = '';
            form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        function exportInvoicesCSV() {
            if (!savedInvoices.length) { showSettingsToast('No invoices to export'); return; }
            var headers = ['Invoice #','Client Name','Client Email','Amount','Due Date','Status','Last Follow-Up'];
            var rows = savedInvoices.map(function(inv) {
                var followUp = inv.lastFollowUp ? new Date(inv.lastFollowUp).toLocaleDateString() : '';
                return [inv.invoiceNumber, inv.clientName, inv.clientEmail || '', inv.amount || 0, inv.dueDate || '', inv.status, followUp]
                    .map(function(v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(',');
            });
            var csv = [headers.join(',')].concat(rows).join('\\n');
            var blob = new Blob([csv], { type: 'text/csv' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url; a.download = 'invoices-' + new Date().toISOString().slice(0,10) + '.csv';
            document.body.appendChild(a); a.click();
            document.body.removeChild(a); URL.revokeObjectURL(url);
            showSettingsToast('Exported ' + savedInvoices.length + ' invoices');
        }

        async function saveInvoiceEntry() {
            var token = getAuthToken();
            if (!token) return;
            var editId = (document.getElementById('inv-edit-id') || {}).value || '';
            var clientName = (document.getElementById('inv-new-client') || {}).value || '';
            var clientEmail = (document.getElementById('inv-new-email') || {}).value || '';
            var invoiceNumber = (document.getElementById('inv-new-number') || {}).value || '';
            var amount = (document.getElementById('inv-new-amount') || {}).value || 0;
            var dueDate = (document.getElementById('inv-new-due') || {}).value || '';
            var status = (document.getElementById('inv-new-status') || {}).value || 'pending';
            if (!clientName || !invoiceNumber) { showSettingsToast('Client name and invoice # required'); return; }
            try {
                var payload = { clientName: clientName, clientEmail: clientEmail, invoiceNumber: invoiceNumber, amount: amount, dueDate: dueDate, status: status };
                if (editId) payload.id = editId;
                var resp = await fetch('/api/invoices', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify(payload)
                });
                if (resp.ok) {
                    showSettingsToast(editId ? 'Invoice updated' : 'Invoice saved');
                    cancelInvoiceForm();
                    loadInvoiceList();
                } else {
                    var d = await resp.json();
                    showSettingsToast(d.error || 'Save failed');
                }
            } catch(e) { showSettingsToast('Error: ' + e.message); }
        }

        async function deleteInvoiceEntry(id) {
            var token = getAuthToken();
            if (!token) return;
            try {
                var resp = await fetch('/api/invoices/' + id, {
                    method: 'DELETE',
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                if (resp.ok) { loadInvoiceList(); showSettingsToast('Invoice removed'); }
            } catch(e) {}
        }

        function selectInvoiceForFollowup(inv, daysOverdue) {
            document.querySelectorAll('.invoice-item').forEach(function(el) { el.classList.remove('selected'); });
            var item = document.querySelector('[data-id="' + inv.id + '"]');
            if (item) item.classList.add('selected');
            var daysInput = document.getElementById('invoice-days-input');
            if (daysInput && daysOverdue > 0) { daysInput.value = daysOverdue; updateEscalationBadge(); }
            var notes = document.getElementById('invoice-notes-input');
            if (notes) notes.value = 'Invoice: ' + inv.invoiceNumber + ' | Client: ' + inv.clientName + ' | Amount: $' + (inv.amount || 0).toLocaleString() + (inv.clientEmail ? ' | Email: ' + inv.clientEmail : '') + (inv.dueDate ? ' | Due: ' + inv.dueDate : '');
            var genBtn = document.getElementById('invoice-generate-btn');
            if (genBtn) genBtn.disabled = false;
            var emailToInput = document.getElementById('invoice-email-to');
            if (emailToInput && inv.clientEmail) emailToInput.value = inv.clientEmail;
            var subjectInput = document.getElementById('invoice-email-subject');
            if (subjectInput) subjectInput.value = 'Invoice Follow-Up: ' + inv.invoiceNumber;
            showSettingsToast('Invoice selected — click Generate to draft email');
        }

        // ============================================
        // AUTOMATIONS SETTINGS
        // ============================================
        async function loadAutomationsSettings() {
            var token = getAuthToken();
            if (!token) return;
            try {
                var [autoResp, smtpResp] = await Promise.all([
                    fetch('/api/automations', { headers: { 'Authorization': 'Bearer ' + token } }),
                    fetch('/api/smtp-config', { headers: { 'Authorization': 'Bearer ' + token } })
                ]);
                var data = await autoResp.json();
                var smtpData = await smtpResp.json();

                // Populate SMTP form
                var hostEl = document.getElementById('smtp-host-input');
                var portEl = document.getElementById('smtp-port-input');
                var userEl = document.getElementById('smtp-user-input');
                var fromEl2 = document.getElementById('smtp-from-input');
                if (hostEl) hostEl.value = smtpData.host || '';
                if (portEl) portEl.value = smtpData.port || 587;
                if (userEl) userEl.value = smtpData.user || '';
                if (fromEl2) fromEl2.value = smtpData.from || '';
                if (smtpData.fromEnv) {
                    var notice = document.getElementById('smtp-env-notice');
                    if (notice) notice.style.display = '';
                    ['smtp-host-input','smtp-port-input','smtp-user-input','smtp-pass-input','smtp-from-input'].forEach(function(id) {
                        var el = document.getElementById(id);
                        if (el) { el.readOnly = true; el.style.opacity = '0.6'; }
                    });
                }

                var badge = document.getElementById('email-status-badge');
                var fromEl = document.getElementById('email-from-display');
                if (badge) {
                    badge.textContent = smtpData.configured ? 'Configured' : 'Not Configured';
                    badge.className = 'automation-card-status ' + (smtpData.configured ? 'on' : 'off');
                }
                if (fromEl) fromEl.textContent = smtpData.from || 'Not set';

                var cfg = data.automations && data.automations.overdueFollowup;
                if (cfg) {
                    var toggle = document.getElementById('overdue-followup-toggle');
                    var statusBadge = document.getElementById('overdue-followup-status');
                    var hourInput = document.getElementById('auto-hour');
                    var ccInput = document.getElementById('auto-cc-email');
                    if (toggle) toggle.checked = !!cfg.enabled;
                    if (statusBadge) { statusBadge.textContent = cfg.enabled ? 'ON' : 'OFF'; statusBadge.className = 'automation-card-status ' + (cfg.enabled ? 'on' : 'off'); }
                    if (hourInput) hourInput.value = cfg.hour || 9;
                    if (ccInput) ccInput.value = cfg.ccEmail || '';
                }
                if (data.lastRun) {
                    var lastRunEl = document.getElementById('auto-last-run');
                    if (lastRunEl) {
                        lastRunEl.textContent = 'Last run: ' + new Date(data.lastRun).toLocaleString();
                        lastRunEl.style.display = '';
                    }
                }
            } catch(e) {}
        }

        async function saveSmtpConfigUI() {
            var token = getAuthToken();
            if (!token) return;
            var host = (document.getElementById('smtp-host-input') || {}).value || '';
            var port = (document.getElementById('smtp-port-input') || {}).value || '587';
            var user = (document.getElementById('smtp-user-input') || {}).value || '';
            var pass = (document.getElementById('smtp-pass-input') || {}).value || '';
            var from = (document.getElementById('smtp-from-input') || {}).value || '';
            if (!host || !user) { showSmtpStatus('Host and username are required', 'error'); return; }
            try {
                var resp = await fetch('/api/smtp-config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ host: host, port: port, user: user, pass: pass, from: from })
                });
                var data = await resp.json();
                if (resp.ok) {
                    showSmtpStatus('Saved! ' + (data.configured ? 'Email is now configured.' : 'Fill in all fields to enable email.'), 'ok');
                    loadAutomationsSettings();
                } else {
                    showSmtpStatus(data.error || 'Save failed', 'error');
                }
            } catch(e) { showSmtpStatus('Save failed: ' + e.message, 'error'); }
        }

        async function testSmtpConnection() {
            var token = getAuthToken();
            if (!token) return;
            var btn = document.getElementById('smtp-test-btn');
            var origLabel = btn ? btn.innerHTML : '';
            if (btn) { btn.disabled = true; btn.innerHTML = '<span style="opacity:0.6">Testing...</span>'; }
            try {
                var resp = await fetch('/api/smtp-test', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }
                });
                var data = await resp.json();
                if (resp.ok) {
                    showSmtpStatus('\u2713 ' + data.message, 'ok');
                } else {
                    showSmtpStatus('\u2717 ' + (data.error || 'Test failed'), 'error');
                }
            } catch(e) { showSmtpStatus('\u2717 ' + e.message, 'error'); }
            finally { if (btn) { btn.disabled = false; btn.innerHTML = origLabel; } }
        }

        function showSmtpStatus(msg, type) {
            var el = document.getElementById('smtp-save-status');
            if (!el) return;
            el.textContent = msg;
            el.style.display = '';
            el.style.color = type === 'error' ? 'var(--red)' : 'var(--green)';
            clearTimeout(el._t);
            el._t = setTimeout(function() { el.style.display = 'none'; }, 4000);
        }

        async function saveAutomationConfig() {
            var token = getAuthToken();
            if (!token) return;
            var enabled = (document.getElementById('overdue-followup-toggle') || {}).checked || false;
            var hour = parseInt((document.getElementById('auto-hour') || {}).value) || 9;
            var ccEmail = (document.getElementById('auto-cc-email') || {}).value || '';
            var statusEl = document.getElementById('auto-save-status');
            var statusBadge = document.getElementById('overdue-followup-status');
            if (statusBadge) { statusBadge.textContent = enabled ? 'ON' : 'OFF'; statusBadge.className = 'automation-card-status ' + (enabled ? 'on' : 'off'); }
            try {
                var resp = await fetch('/api/automations', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ overdueFollowup: { enabled: enabled, hour: hour, ccEmail: ccEmail } })
                });
                var data = await resp.json();
                if (resp.ok && data.success) {
                    if (statusEl) { statusEl.style.display = ''; statusEl.textContent = 'Saved. Automation ' + (enabled ? 'active — runs daily at ' + hour + ':00.' : 'disabled.'); statusEl.style.color = 'var(--green)'; }
                    showSettingsToast('Automation settings saved');
                } else {
                    if (statusEl) { statusEl.style.display = ''; statusEl.textContent = data.error || 'Save failed'; statusEl.style.color = 'var(--red)'; }
                }
            } catch(e) {
                if (statusEl) { statusEl.style.display = ''; statusEl.textContent = 'Error: ' + e.message; statusEl.style.color = 'var(--red)'; }
            }
        }

        async function runAutomationNow() {
            var token = getAuthToken();
            if (!token) return;
            var btn = document.getElementById('auto-run-now-btn');
            var statusEl = document.getElementById('auto-save-status');
            if (btn) { btn.disabled = true; btn.innerHTML = '<span style="opacity:0.6">Running...</span>'; }
            try {
                var resp = await fetch('/api/run-automation', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }
                });
                var data = await resp.json();
                if (resp.ok) {
                    if (statusEl) { statusEl.style.display = ''; statusEl.textContent = data.message || 'Run complete.'; statusEl.style.color = 'var(--green)'; }
                    var lastRunEl = document.getElementById('auto-last-run');
                    if (lastRunEl) { lastRunEl.textContent = 'Last run: ' + new Date().toLocaleString(); lastRunEl.style.display = ''; }
                    showSettingsToast('Automation ran: ' + (data.sent || 0) + ' email(s) sent');
                } else {
                    if (statusEl) { statusEl.style.display = ''; statusEl.textContent = data.error || 'Run failed'; statusEl.style.color = 'var(--red)'; }
                }
            } catch(e) {
                if (statusEl) { statusEl.style.display = ''; statusEl.textContent = 'Error: ' + e.message; statusEl.style.color = 'var(--red)'; }
            }
            finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Run Now';
                }
            }
        }

        // ============================================
        // CUSTOM AUTOMATIONS UI
        // ============================================

        var _customAutomations = [];

        async function loadCustomAutomationsUI() {
            var token = getAuthToken();
            if (!token) return;
            try {
                var resp = await fetch('/api/custom-automations', { headers: { 'Authorization': 'Bearer ' + token } });
                if (!resp.ok) return;
                var data = await resp.json();
                _customAutomations = data.automations || [];
                renderCustomAutomationsList();
            } catch(e) {}
        }

        function renderCustomAutomationsList() {
            var list = document.getElementById('custom-auto-list');
            var empty = document.getElementById('custom-auto-empty');
            if (!list) return;
            if (!_customAutomations.length) {
                if (empty) empty.style.display = '';
                list.querySelectorAll('.ca-card').forEach(function(el) { el.remove(); });
                return;
            }
            if (empty) empty.style.display = 'none';
            list.querySelectorAll('.ca-card').forEach(function(el) { el.remove(); });

            var triggerLabels = { manual: 'Manual', daily: 'Daily', weekly: 'Weekly', webhook: 'Webhook' };
            var actionLabels  = { log: 'Log Only', email: 'Send Email', webhook: 'Post to Webhook' };
            var dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

            _customAutomations.forEach(function(a) {
                var card = document.createElement('div');
                card.className = 'ca-card';
                card.dataset.id = a.id;
                card.style.cssText = 'background:var(--bg);border:1px solid var(--border-mid);border-radius:var(--radius-sm);padding:12px 14px;margin-bottom:8px;';

                var trigDesc = triggerLabels[a.trigger] || a.trigger;
                if (a.trigger === 'daily') trigDesc += ' at ' + String(a.triggerHour || 8).padStart(2,'0') + ':00';
                if (a.trigger === 'weekly') trigDesc += ' ' + (dayNames[a.triggerDayOfWeek] || 'Mon') + ' at ' + String(a.triggerHour || 8).padStart(2,'0') + ':00';

                var webhookInfo = '';
                if (a.trigger === 'webhook' && a.webhookToken) {
                    webhookInfo = '<div style="font-family:var(--mono);font-size:10px;color:var(--text-dim);margin-top:4px;word-break:break-all;">Webhook URL: <span style="color:var(--accent);">' + window.location.origin + '/webhooks/' + a.webhookToken + '</span></div>';
                }

                var lastRunText = a.lastRun ? 'Last run: ' + new Date(a.lastRun).toLocaleString() + (a.lastResult ? ' — ' + a.lastResult : '') : 'Never run';
                var previewText = a.lastResultPreview ? '<div style="font-family:var(--mono);font-size:10px;color:var(--text-dim);margin-top:4px;white-space:pre-wrap;max-height:60px;overflow:hidden;">' + escapeHtml(a.lastResultPreview) + (a.lastResultPreview.length >= 300 ? '...' : '') + '</div>' : '';

                card.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">' +
                    '<div style="display:flex;align-items:center;gap:8px;">' +
                    '<label class="toggle-switch" style="margin:0;flex-shrink:0;"><input type="checkbox" ' + (a.enabled ? 'checked' : '') + ' onchange="toggleCustomAutomation(\\'' + a.id + '\\',this.checked)"><span class="toggle-slider"></span></label>' +
                    '<div><div style="font-family:var(--mono);font-size:12px;color:var(--text);font-weight:600;">' + escapeHtml(a.name) + '</div>' +
                    '<div style="font-family:var(--mono);font-size:10px;color:var(--text-dim);">' + trigDesc + ' &bull; ' + (actionLabels[a.action] || a.action) + '</div></div>' +
                    '</div>' +
                    '<div style="display:flex;gap:6px;flex-shrink:0;">' +
                    '<button class="agent-action-btn" onclick="runCustomAutomationNow(\\'' + a.id + '\\')" style="padding:5px 10px;font-size:10px;" title="Run Now">&#9654; Run</button>' +
                    '<button class="agent-action-btn" onclick="openCustomAutomationForm(\\'' + a.id + '\\')" style="padding:5px 10px;font-size:10px;" title="Edit">&#9998; Edit</button>' +
                    '<button class="agent-action-btn" onclick="deleteCustomAutomation(\\'' + a.id + '\\')" style="padding:5px 10px;font-size:10px;color:var(--red);" title="Delete">&#10005;</button>' +
                    '</div></div>' +
                    webhookInfo +
                    '<div style="font-family:var(--mono);font-size:10px;color:var(--text-dim);margin-top:6px;" id="ca-status-' + a.id + '">' + escapeHtml(lastRunText) + '</div>' +
                    previewText;

                list.appendChild(card);
            });
        }

        function escapeHtml(str) {
            return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }

        function openCustomAutomationForm(id) {
            var form = document.getElementById('custom-auto-form');
            if (!form) return;
            form.style.display = '';

            // Scroll form into view
            setTimeout(function() { form.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 50);

            // Reset status
            var statusEl = document.getElementById('ca-form-status');
            if (statusEl) statusEl.style.display = 'none';

            if (!id) {
                // New form — clear fields
                document.getElementById('ca-edit-id').value = '';
                document.getElementById('ca-name').value = '';
                document.getElementById('ca-trigger').value = 'manual';
                document.getElementById('ca-hour').value = '8';
                document.getElementById('ca-dow').value = '1';
                document.getElementById('ca-prompt').value = '';
                document.getElementById('ca-action').value = 'log';
                document.getElementById('ca-email-to').value = '';
                document.getElementById('ca-email-subject').value = 'Automation Report - {{date}}';
                document.getElementById('ca-webhook-url').value = '';
                updateCustomAutoFormFields();
                return;
            }

            // Populate with existing automation
            var a = _customAutomations.find(function(x) { return x.id === id; });
            if (!a) return;
            document.getElementById('ca-edit-id').value = a.id;
            document.getElementById('ca-name').value = a.name || '';
            document.getElementById('ca-trigger').value = a.trigger || 'manual';
            document.getElementById('ca-hour').value = a.triggerHour !== undefined ? a.triggerHour : 8;
            document.getElementById('ca-dow').value = a.triggerDayOfWeek !== undefined ? a.triggerDayOfWeek : 1;
            document.getElementById('ca-prompt').value = a.prompt || '';
            document.getElementById('ca-action').value = a.action || 'log';
            document.getElementById('ca-email-to').value = a.emailTo || '';
            document.getElementById('ca-email-subject').value = a.emailSubject || 'Automation Report - {{date}}';
            document.getElementById('ca-webhook-url').value = a.webhookUrl || '';
            updateCustomAutoFormFields();
        }

        function cancelCustomAutomationForm() {
            var form = document.getElementById('custom-auto-form');
            if (form) form.style.display = 'none';
        }

        function updateCustomAutoFormFields() {
            var trigger = (document.getElementById('ca-trigger') || {}).value;
            var action  = (document.getElementById('ca-action')  || {}).value;

            var triggerFields   = document.getElementById('ca-trigger-fields');
            var hourWrap        = document.getElementById('ca-hour-wrap');
            var dowWrap         = document.getElementById('ca-dow-wrap');
            var emailFields     = document.getElementById('ca-email-fields');
            var webhookOutField = document.getElementById('ca-outwebhook-fields');

            if (triggerFields) triggerFields.style.display = (trigger === 'daily' || trigger === 'weekly') ? 'flex' : 'none';
            if (hourWrap) hourWrap.style.display = '';
            if (dowWrap) dowWrap.style.display = (trigger === 'weekly') ? '' : 'none';
            if (emailFields) emailFields.style.display = (action === 'email') ? 'flex' : 'none';
            if (webhookOutField) webhookOutField.style.display = (action === 'webhook') ? '' : 'none';
        }

        async function saveCustomAutomation() {
            var token = getAuthToken();
            if (!token) return;
            var id      = (document.getElementById('ca-edit-id') || {}).value || '';
            var name    = (document.getElementById('ca-name') || {}).value.trim();
            var trigger = (document.getElementById('ca-trigger') || {}).value;
            var hour    = parseInt((document.getElementById('ca-hour') || {}).value) || 8;
            var dow     = parseInt((document.getElementById('ca-dow') || {}).value) || 1;
            var prompt  = (document.getElementById('ca-prompt') || {}).value.trim();
            var action  = (document.getElementById('ca-action') || {}).value;
            var emailTo = (document.getElementById('ca-email-to') || {}).value.trim();
            var emailSubject = (document.getElementById('ca-email-subject') || {}).value.trim();
            var webhookUrl = (document.getElementById('ca-webhook-url') || {}).value.trim();

            if (!name || !prompt) {
                var statusEl = document.getElementById('ca-form-status');
                if (statusEl) { statusEl.style.display = ''; statusEl.style.color = 'var(--red)'; statusEl.textContent = 'Name and Prompt are required.'; }
                return;
            }

            var payload = { name: name, trigger: trigger, triggerHour: hour, triggerDayOfWeek: dow, prompt: prompt, action: action, emailTo: emailTo, emailSubject: emailSubject, webhookUrl: webhookUrl };

            try {
                var url    = id ? '/api/custom-automations/' + id : '/api/custom-automations';
                var method = id ? 'PUT' : 'POST';
                var resp = await fetch(url, {
                    method: method,
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify(payload)
                });
                var data = await resp.json();
                if (resp.ok) {
                    cancelCustomAutomationForm();
                    loadCustomAutomationsUI();
                    showSettingsToast(id ? 'Automation updated' : 'Automation created');
                } else {
                    var statusEl = document.getElementById('ca-form-status');
                    if (statusEl) { statusEl.style.display = ''; statusEl.style.color = 'var(--red)'; statusEl.textContent = data.error || 'Save failed'; }
                }
            } catch(e) {
                var statusEl = document.getElementById('ca-form-status');
                if (statusEl) { statusEl.style.display = ''; statusEl.style.color = 'var(--red)'; statusEl.textContent = 'Error: ' + e.message; }
            }
        }

        async function deleteCustomAutomation(id) {
            if (!confirm('Delete this automation? This cannot be undone.')) return;
            var token = getAuthToken();
            if (!token) return;
            try {
                var resp = await fetch('/api/custom-automations/' + id, {
                    method: 'DELETE',
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                if (resp.ok) { loadCustomAutomationsUI(); showSettingsToast('Automation deleted'); }
            } catch(e) {}
        }

        async function toggleCustomAutomation(id, enabled) {
            var token = getAuthToken();
            if (!token) return;
            try {
                await fetch('/api/custom-automations/' + id, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ enabled: enabled })
                });
                var a = _customAutomations.find(function(x) { return x.id === id; });
                if (a) a.enabled = enabled;
                showSettingsToast('Automation ' + (enabled ? 'enabled' : 'disabled'));
            } catch(e) {}
        }

        async function runCustomAutomationNow(id) {
            var token = getAuthToken();
            if (!token) return;
            var card = document.querySelector('.ca-card[data-id="' + id + '"]');
            var btn = card ? card.querySelector('button[onclick*="runCustomAutomationNow"]') : null;
            var statusEl = document.getElementById('ca-status-' + id);
            if (btn) { btn.disabled = true; btn.innerHTML = '&#9654; Running...'; }
            if (statusEl) { statusEl.textContent = 'Running...'; statusEl.style.color = 'var(--accent)'; }
            try {
                var resp = await fetch('/api/custom-automations/' + id + '/run', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }
                });
                var data = await resp.json();
                if (resp.ok) {
                    if (statusEl) { statusEl.style.color = 'var(--green)'; statusEl.textContent = 'Ran: ' + (data.actionResult || 'done'); }
                    var a = _customAutomations.find(function(x) { return x.id === id; });
                    if (a) { a.lastRun = Date.now(); a.lastResult = data.actionResult; a.lastResultPreview = data.result ? data.result.substring(0,300) : ''; }
                    showSettingsToast('Automation ran: ' + (data.actionResult || 'done'));
                    // Re-render to show preview
                    setTimeout(renderCustomAutomationsList, 300);
                } else {
                    if (statusEl) { statusEl.style.color = 'var(--red)'; statusEl.textContent = 'Error: ' + (data.error || 'Failed'); }
                }
            } catch(e) {
                if (statusEl) { statusEl.style.color = 'var(--red)'; statusEl.textContent = 'Error: ' + e.message; }
            }
            if (btn) { btn.disabled = false; btn.innerHTML = '&#9654; Run'; }
        }

        // Load invoice list and automations when tools are shown
        (function() {
            var origOnToolViewShown = _onToolViewShown;
            _onToolViewShown = function(viewId) {
                origOnToolViewShown(viewId);
                if (viewId === 'invoices') loadInvoiceList();
            };
        })();

        // Patch openSettings to also load automations tab data
        (function() {
            var origOpenSettings = openSettings;
            openSettings = function() {
                origOpenSettings.apply(this, arguments);
                loadAutomationsSettings();
                loadCustomAutomationsUI();
            };
        })();

        // ============================================================
        // CONNECTORS SYSTEM
        // ============================================================

        var connTemplates = [];      // 50 templates from server
        var myConnectors = [];       // user's added connectors
        var connFilterCat = 'All';
        var connSearchQ = '';
        var openDrawerId = null;     // templateId with drawer open

        // password modal state
        var connPwdResolve = null;
        var connPwdReject = null;

        function connPwdPrompt(title, desc) {
            return new Promise(function(resolve, reject) {
                connPwdResolve = resolve;
                connPwdReject = reject;
                document.getElementById('conn-pwd-title').textContent = title || 'Confirm with Password';
                document.getElementById('conn-pwd-desc').textContent = desc || 'Enter your account password to continue.';
                document.getElementById('conn-pwd-input').value = '';
                document.getElementById('conn-pwd-err').textContent = '';
                document.getElementById('conn-pwd-modal').style.display = 'flex';
                setTimeout(function() { document.getElementById('conn-pwd-input').focus(); }, 50);
            });
        }
        function connPwdConfirm() {
            var val = document.getElementById('conn-pwd-input').value;
            if (!val) { document.getElementById('conn-pwd-err').textContent = 'Password required'; return; }
            document.getElementById('conn-pwd-modal').style.display = 'none';
            if (connPwdResolve) { connPwdResolve(val); connPwdResolve = null; connPwdReject = null; }
        }
        function connPwdCancel() {
            document.getElementById('conn-pwd-modal').style.display = 'none';
            if (connPwdReject) { connPwdReject(new Error('cancelled')); connPwdResolve = null; connPwdReject = null; }
        }
        document.getElementById('conn-pwd-input').addEventListener('keydown', function(e) {
            if (e.key === 'Enter') connPwdConfirm();
            if (e.key === 'Escape') connPwdCancel();
        });

        async function loadConnectorTemplates() {
            try {
                var token = getAuthToken();
                var r = await fetch('/api/connector-templates', { headers: { 'Authorization': 'Bearer ' + token } });
                if (r.ok) { var d = await r.json(); connTemplates = d.templates || []; }
            } catch(e) {}
        }

        async function loadMyConnectors() {
            try {
                var token = getAuthToken();
                var r = await fetch('/api/connectors', { headers: { 'Authorization': 'Bearer ' + token } });
                if (r.ok) { var d = await r.json(); myConnectors = d.connectors || []; updateActiveConnectorsBar(); }
            } catch(e) {}
        }

        function openConnectorOverlay() {
            document.getElementById('connector-overlay').style.display = 'flex';
            document.getElementById('connector-search').value = '';
            connSearchQ = '';
            connFilterCat = 'All';
            openDrawerId = null;
            if (connTemplates.length === 0) {
                loadConnectorTemplates().then(function() { loadMyConnectors().then(renderConnectorOverlay); });
            } else {
                loadMyConnectors().then(renderConnectorOverlay);
            }
        }

        function closeConnectorOverlay() {
            document.getElementById('connector-overlay').style.display = 'none';
            openDrawerId = null;
        }

        function connectorOverlayBgClick(e) {
            if (e.target === document.getElementById('connector-overlay')) closeConnectorOverlay();
        }

        function filterConnectors() {
            connSearchQ = document.getElementById('connector-search').value.toLowerCase();
            renderConnectorOverlay();
        }

        function setCatFilter(cat) {
            connFilterCat = cat;
            connSearchQ = document.getElementById('connector-search').value.toLowerCase();
            renderConnectorOverlay();
        }

        function renderConnectorOverlay() {
            // Category tabs
            var allCats = ['All'];
            connTemplates.forEach(function(t) { if (allCats.indexOf(t.category) === -1) allCats.push(t.category); });
            var tabsEl = document.getElementById('connector-cat-tabs');
            tabsEl.innerHTML = '';
            allCats.forEach(function(cat) {
                var btn = document.createElement('button');
                btn.className = 'connector-cat-tab' + (connFilterCat === cat ? ' active' : '');
                btn.textContent = cat;
                btn.onclick = function() { setCatFilter(cat); };
                tabsEl.appendChild(btn);
            });

            // Filter templates
            var filtered = connTemplates.filter(function(t) {
                var matchCat = connFilterCat === 'All' || t.category === connFilterCat;
                var matchQ = !connSearchQ || t.name.toLowerCase().indexOf(connSearchQ) !== -1 || t.category.toLowerCase().indexOf(connSearchQ) !== -1;
                return matchCat && matchQ;
            });

            // My connectors section
            var myEl = document.getElementById('connector-grid-my');
            var myFiltered = myConnectors.filter(function(c) {
                return !connSearchQ || c.name.toLowerCase().indexOf(connSearchQ) !== -1;
            });
            if (myFiltered.length > 0 && (connFilterCat === 'All' || myFiltered.some(function(c){ return c.category === connFilterCat; }))) {
                var myLabel = document.createElement('div');
                myLabel.className = 'connector-section-label';
                myLabel.textContent = 'My Connectors';
                myEl.innerHTML = '';
                myEl.appendChild(myLabel);
                var myGrid = document.createElement('div');
                myGrid.className = 'connector-grid';
                myFiltered.forEach(function(conn) {
                    if (connFilterCat !== 'All' && conn.category !== connFilterCat) return;
                    myGrid.appendChild(buildConnectedCard(conn));
                });
                myEl.appendChild(myGrid);
            } else {
                myEl.innerHTML = '';
            }

            // All templates section
            var allEl = document.getElementById('connector-grid-all');
            allEl.innerHTML = '';
            if (filtered.length > 0) {
                var allLabel = document.createElement('div');
                allLabel.className = 'connector-section-label';
                allLabel.textContent = connFilterCat === 'All' ? 'All Connectors' : connFilterCat;
                allEl.appendChild(allLabel);
                var allGrid = document.createElement('div');
                allGrid.className = 'connector-grid';
                filtered.forEach(function(t) {
                    // skip if already connected (show in My Connectors)
                    var already = myConnectors.find(function(c) { return c.templateId === t.id; });
                    allGrid.appendChild(buildTemplateCard(t, !!already));
                });
                allEl.appendChild(allGrid);
            }
        }

        function buildTemplateCard(t, connected) {
            var card = document.createElement('div');
            card.className = 'connector-card' + (connected ? ' connected' : '');
            card.id = 'conn-tpl-' + t.id;
            var emojiEl = document.createElement('div');
            emojiEl.className = 'connector-card-emoji';
            emojiEl.textContent = t.emoji;
            var nameEl = document.createElement('div');
            nameEl.className = 'connector-card-name';
            nameEl.textContent = t.name;
            var catEl = document.createElement('div');
            catEl.className = 'connector-card-cat';
            catEl.textContent = t.category;
            card.appendChild(emojiEl);
            card.appendChild(nameEl);
            card.appendChild(catEl);
            if (connected) {
                var badge = document.createElement('div');
                badge.className = 'connector-card-badge';
                badge.textContent = 'Connected';
                card.appendChild(badge);
            } else {
                // Add drawer
                var drawer = document.createElement('div');
                drawer.className = 'connector-add-drawer' + (openDrawerId === t.id ? ' open' : '');
                drawer.id = 'drawer-' + t.id;
                drawer.innerHTML = buildAddDrawerHTML(t);
                card.appendChild(drawer);
                card.onclick = function(e) {
                    if (e.target.closest('.connector-add-drawer')) return;
                    toggleDrawer(t.id);
                };
            }
            return card;
        }

        function buildConnectedCard(conn) {
            var card = document.createElement('div');
            card.className = 'connector-card connected';
            card.id = 'conn-my-' + conn.id;
            var emojiEl = document.createElement('div');
            emojiEl.className = 'connector-card-emoji';
            emojiEl.textContent = conn.emoji;
            var nameEl = document.createElement('div');
            nameEl.className = 'connector-card-name';
            nameEl.textContent = conn.name;
            var catEl = document.createElement('div');
            catEl.className = 'connector-card-cat';
            catEl.textContent = conn.category;
            var badge = document.createElement('div');
            badge.className = 'connector-card-badge';
            badge.textContent = 'Connected';
            card.appendChild(emojiEl);
            card.appendChild(nameEl);
            card.appendChild(catEl);
            card.appendChild(badge);
            // Actions row
            var removeBtn = document.createElement('button');
            removeBtn.className = 'connector-remove-btn';
            removeBtn.textContent = 'Remove';
            removeBtn.onclick = function(e) { e.stopPropagation(); removeConnector(conn.id); };
            card.appendChild(removeBtn);
            var showKeyBtn = document.createElement('button');
            showKeyBtn.className = 'connector-show-key-btn';
            showKeyBtn.style.marginLeft = '6px';
            showKeyBtn.textContent = 'Show Key';
            var keyReveal = document.createElement('div');
            keyReveal.className = 'connector-key-reveal';
            keyReveal.id = 'keyreveal-' + conn.id;
            showKeyBtn.onclick = function(e) {
                e.stopPropagation();
                revealConnectorKey(conn.id, keyReveal, showKeyBtn);
            };
            card.appendChild(showKeyBtn);
            card.appendChild(keyReveal);
            return card;
        }

        function buildAddDrawerHTML(t) {
            var customFields = t.id === 'custom' ? '<div class="connector-field-label">Connector Name</div><input class="connector-field-input" id="cust-name-' + t.id + '" placeholder="e.g. My API" autocomplete="off"><div class="connector-field-label">Base URL</div><input class="connector-field-input" id="cust-url-' + t.id + '" placeholder="https://api.example.com/v1" autocomplete="off"><div class="connector-field-label">Capabilities (describe what it can do)</div><input class="connector-field-input" id="cust-cap-' + t.id + '" placeholder="List users, create records, etc." autocomplete="off">' : '';
            return '<div class="connector-add-drawer-title">Add ' + t.name + '</div>' + customFields + '<div class="connector-field-label">' + t.apiKeyLabel + '</div><input class="connector-field-input" id="apikey-' + t.id + '" type="password" placeholder="Paste your key here" autocomplete="off"><div class="connector-field-label">Your Password (to encrypt the key)</div><input class="connector-field-input" id="connpwd-' + t.id + '" type="password" placeholder="Your account password" autocomplete="off"><div class="connector-err" id="conn-err-' + t.id + '"></div><div class="connector-add-row"><button class="connector-add-btn" onclick="saveConnector(\\'' + t.id + '\\')">Save Connector</button><button class="connector-cancel-btn" onclick="toggleDrawer(\\'' + t.id + '\\')">Cancel</button></div>';
        }

        function toggleDrawer(templateId) {
            if (openDrawerId === templateId) {
                openDrawerId = null;
            } else {
                openDrawerId = templateId;
            }
            renderConnectorOverlay();
            // Scroll drawer into view
            setTimeout(function() {
                var d = document.getElementById('drawer-' + templateId);
                if (d && openDrawerId === templateId) d.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }, 50);
        }

        async function saveConnector(templateId) {
            var apiKey = document.getElementById('apikey-' + templateId);
            var pwd = document.getElementById('connpwd-' + templateId);
            var errEl = document.getElementById('conn-err-' + templateId);
            if (!apiKey || !apiKey.value.trim()) { errEl.textContent = 'API key is required'; return; }
            if (!pwd || !pwd.value.trim()) { errEl.textContent = 'Password is required'; return; }
            errEl.textContent = '';
            var body = { templateId: templateId, apiKey: apiKey.value.trim(), password: pwd.value };
            if (templateId === 'custom') {
                var custName = document.getElementById('cust-name-' + templateId);
                var custUrl = document.getElementById('cust-url-' + templateId);
                var custCap = document.getElementById('cust-cap-' + templateId);
                body.customName = custName ? custName.value.trim() : '';
                body.customBaseUrl = custUrl ? custUrl.value.trim() : '';
                body.customCapabilities = custCap ? custCap.value.trim() : '';
                if (!body.customBaseUrl) { errEl.textContent = 'Base URL is required for custom connectors'; return; }
                if (!body.customCapabilities) { errEl.textContent = 'Capabilities description is required'; return; }
            }
            var addBtn = document.querySelector('#drawer-' + templateId + ' .connector-add-btn');
            if (addBtn) { addBtn.disabled = true; addBtn.textContent = 'Saving...'; }
            try {
                var token = getAuthToken();
                var r = await fetch('/api/connectors', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify(body)
                });
                var d = await r.json();
                if (r.ok) {
                    openDrawerId = null;
                    await loadMyConnectors();
                    renderConnectorOverlay();
                } else {
                    errEl.textContent = d.error || 'Failed to save connector';
                    if (addBtn) { addBtn.disabled = false; addBtn.textContent = 'Save Connector'; }
                }
            } catch(e) {
                errEl.textContent = 'Network error';
                if (addBtn) { addBtn.disabled = false; addBtn.textContent = 'Save Connector'; }
            }
        }

        async function removeConnector(connId) {
            if (!confirm('Remove this connector? The API key will be deleted.')) return;
            try {
                var token = getAuthToken();
                await fetch('/api/connectors/' + connId, {
                    method: 'DELETE',
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                await loadMyConnectors();
                renderConnectorOverlay();
            } catch(e) {}
        }

        async function revealConnectorKey(connId, revealEl, btnEl) {
            if (revealEl.classList.contains('visible')) {
                revealEl.classList.remove('visible');
                btnEl.textContent = 'Show Key';
                return;
            }
            try {
                var pwd = await connPwdPrompt('Show API Key', 'Enter your password to reveal the stored API key.');
                var token = getAuthToken();
                var r = await fetch('/api/connectors/' + connId + '/key', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ password: pwd })
                });
                var d = await r.json();
                if (r.ok) {
                    revealEl.textContent = d.key;
                    revealEl.classList.add('visible');
                    btnEl.textContent = 'Hide Key';
                } else {
                    alert(d.error || 'Failed to retrieve key');
                }
            } catch(e) {
                if (e.message !== 'cancelled') alert('Error: ' + e.message);
            }
        }

        function updateActiveConnectorsBar() {
            var bar = document.getElementById('active-connectors-bar');
            if (!bar) return;
            if (myConnectors.length === 0) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
            bar.style.display = 'flex';
            bar.innerHTML = '';
            myConnectors.forEach(function(conn) {
                var chip = document.createElement('span');
                chip.className = 'active-connector-chip';
                chip.title = 'Use ' + conn.name;
                chip.innerHTML = conn.emoji + ' ' + conn.name + '<span class="chip-remove" onclick="event.stopPropagation();removeConnector(\\'' + conn.id + '\\')">&#x2715;</span>';
                chip.onclick = function() { triggerConnectorQuery(conn.id, conn.name); };
                bar.appendChild(chip);
            });
        }

        async function triggerConnectorQuery(connId, connName) {
            var userMsg = prompt('What do you want to do with ' + connName + '?\n\nExample: "list my 5 most recent items"');
            if (!userMsg || !userMsg.trim()) return;
            try {
                var pwd = await connPwdPrompt('Authorize API Call', 'Enter your password to let ' + connName + ' execute this request.');
                closeConnectorOverlay();
                // Show user message in chat
                addMessage(userMsg, 'user');
                // Show loading
                var loadingRow = addMessage('Connecting to ' + connName + '...', 'bot', 'gemini');
                var token = getAuthToken();
                var r = await fetch('/api/connector/execute', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({ connectorId: connId, userMessage: userMsg.trim(), password: pwd })
                });
                var d = await r.json();
                // Remove loading message
                if (loadingRow && loadingRow.parentNode) loadingRow.parentNode.removeChild(loadingRow);
                if (r.ok) {
                    addMessage(d.response, 'bot', 'gemini');
                } else {
                    addMessage('Connector error: ' + (d.error || 'Unknown error'), 'error');
                }
                // Show chat (hide dashboard)
                var dash = document.getElementById('dashboard-home');
                if (dash) dash.style.display = 'none';
            } catch(e) {
                if (e.message !== 'cancelled') addMessage('Connector error: ' + e.message, 'error');
            }
        }

        // Load connectors on startup (after login)
        var origLoadUI = typeof loadUI === 'function' ? loadUI : null;
        (function() {
            var origAfterLogin = typeof afterLogin === 'function' ? afterLogin : null;
            if (origAfterLogin) {
                afterLogin = function() {
                    origAfterLogin.apply(this, arguments);
                    loadConnectorTemplates();
                    loadMyConnectors();
                };
            }
            // Also try on DOMContentLoaded in case already logged in
            document.addEventListener('DOMContentLoaded', function() {
                if (getAuthToken()) { loadConnectorTemplates(); loadMyConnectors(); }
            });
            // Fallback: poll once after short delay
            setTimeout(function() { if (getAuthToken()) { loadConnectorTemplates(); loadMyConnectors(); } }, 2000);
        })();

    </script>
</body>
</html>`);
});

/**
 * Public chat endpoint for frontend (no auth required)
 * POST /chat
 * Body: { prompt: string }
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
// CONNECTOR ENDPOINTS
// ============================================

// GET /api/connectors - list user's connectors (no keys)
app.get('/api/connectors', requireLogin, (req, res) => {
  const username = req.authenticatedUser;
  const list = connectorStore
    .filter(c => c.addedBy === username)
    .map(c => ({
      id: c.id, templateId: c.templateId, name: c.name, emoji: c.emoji,
      category: c.category, apiKeyLabel: c.apiKeyLabel, addedAt: c.addedAt,
      hasKey: !!c.encryptedKey
    }));
  res.json({ connectors: list });
});

// GET /api/connector-templates - all 50 templates (no keys)
app.get('/api/connector-templates', requireLogin, (req, res) => {
  res.json({ templates: CONNECTOR_TEMPLATES.map(t => ({
    id: t.id, name: t.name, emoji: t.emoji, category: t.category, apiKeyLabel: t.apiKeyLabel
  }))});
});

// POST /api/connectors - add a connector
app.post('/api/connectors', requireLogin, async (req, res) => {
  const username = req.authenticatedUser;
  const { templateId, password, apiKey, customName, customBaseUrl, customCapabilities } = req.body;
  if (!templateId || !password || !apiKey) {
    return res.status(400).json({ error: 'templateId, password, and apiKey are required' });
  }
  const user = userStore.users.find(u => u.username === username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  const template = CONNECTOR_TEMPLATES.find(t => t.id === templateId);
  if (!template) return res.status(400).json({ error: 'Unknown template ID' });
  const existing = connectorStore.find(c => c.templateId === templateId && c.addedBy === username);
  if (existing) return res.status(409).json({ error: 'Connector already added' });
  const encryptedKey = encryptConnectorKey(apiKey);
  const entry = {
    id: crypto.randomBytes(16).toString('hex'),
    templateId,
    name: templateId === 'custom' ? (customName || 'Custom Connector') : template.name,
    emoji: template.emoji,
    category: template.category,
    apiKeyLabel: template.apiKeyLabel,
    baseUrl: templateId === 'custom' ? (customBaseUrl || '') : template.baseUrl,
    capabilities: templateId === 'custom' ? (customCapabilities || '') : template.capabilities,
    encryptedKey,
    addedBy: username,
    addedAt: Date.now()
  };
  connectorStore.push(entry);
  saveConnectorStore();
  log('INFO', `Connector added: ${entry.name} by ${username}`, req.id);
  res.json({ success: true, connector: { id: entry.id, templateId, name: entry.name, emoji: entry.emoji, category: entry.category, addedAt: entry.addedAt, hasKey: true } });
});

// DELETE /api/connectors/:id
app.delete('/api/connectors/:id', requireLogin, (req, res) => {
  const username = req.authenticatedUser;
  const idx = connectorStore.findIndex(c => c.id === req.params.id && c.addedBy === username);
  if (idx === -1) return res.status(404).json({ error: 'Connector not found' });
  connectorStore.splice(idx, 1);
  saveConnectorStore();
  res.json({ success: true });
});

// POST /api/connectors/:id/key - reveal key (password required)
app.post('/api/connectors/:id/key', requireLogin, (req, res) => {
  const username = req.authenticatedUser;
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  const user = userStore.users.find(u => u.username === username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  const conn = connectorStore.find(c => c.id === req.params.id && c.addedBy === username);
  if (!conn) return res.status(404).json({ error: 'Connector not found' });
  try {
    const key = decryptConnectorKey(conn.encryptedKey);
    res.json({ key });
  } catch (e) {
    res.status(500).json({ error: 'Could not decrypt key' });
  }
});

// POST /api/connector/execute - run a connector query
app.post('/api/connector/execute', requireLogin, async (req, res) => {
  const username = req.authenticatedUser;
  const { connectorId, userMessage, password } = req.body;
  if (!connectorId || !userMessage || !password) {
    return res.status(400).json({ error: 'connectorId, userMessage, and password are required' });
  }
  const user = userStore.users.find(u => u.username === username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  const conn = connectorStore.find(c => c.id === connectorId && c.addedBy === username);
  if (!conn) return res.status(404).json({ error: 'Connector not found' });
  let apiKey;
  try {
    apiKey = decryptConnectorKey(conn.encryptedKey);
  } catch (e) {
    return res.status(500).json({ error: 'Could not decrypt API key' });
  }
  // Step 1: Gemini generates the API call
  const genPrompt = 'You are an API agent for a construction business app. The user wants: "' + userMessage + '". API: ' + conn.name + ' at base URL: ' + (conn.baseUrl || 'user-defined') + '. Capabilities: ' + conn.capabilities + '. API key/token value: ' + apiKey + '. Generate ONE specific API call as a JSON object with fields: method (string), url (full URL), headers (object), body (object or null). Return ONLY the raw JSON object, no markdown fences, no explanation.';
  let apiCallJson;
  try {
    const raw = await callGemini(genPrompt, 20000);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in response');
    apiCallJson = JSON.parse(match[0]);
  } catch (e) {
    return res.status(500).json({ error: 'Failed to generate API call: ' + e.message });
  }
  // Security: validate URL starts with connector baseUrl (skip for dynamic URLs)
  if (conn.baseUrl && !conn.baseUrl.includes('YOUR-') && !conn.baseUrl.includes('xyzproject')) {
    if (!apiCallJson.url || !apiCallJson.url.startsWith(conn.baseUrl)) {
      return res.status(400).json({ error: 'Security: generated URL does not match connector base URL' });
    }
  }
  // Step 2: Execute the API call
  let apiResponse;
  try {
    const fetchOpts = {
      method: (apiCallJson.method || 'GET').toUpperCase(),
      headers: apiCallJson.headers || {}
    };
    if (apiCallJson.body && fetchOpts.method !== 'GET') {
      fetchOpts.body = JSON.stringify(apiCallJson.body);
      if (!fetchOpts.headers['Content-Type']) fetchOpts.headers['Content-Type'] = 'application/json';
    }
    const controller = new AbortController();
    const tmo = setTimeout(() => controller.abort(), 15000);
    fetchOpts.signal = controller.signal;
    const resp = await fetch(apiCallJson.url, fetchOpts);
    clearTimeout(tmo);
    const text = await resp.text();
    apiResponse = text.length > 8000 ? text.slice(0, 8000) + '... [truncated]' : text;
  } catch (e) {
    return res.status(500).json({ error: 'API request failed: ' + e.message });
  }
  // Step 3: Gemini formats the response
  const formatPrompt = 'The user asked: "' + userMessage + '". The ' + conn.name + ' API returned: ' + apiResponse + '. Summarize this clearly and helpfully. If there is an error, explain what went wrong. Focus on information relevant to the user\'s request.';
  let formatted;
  try {
    formatted = await callGemini(formatPrompt, 20000);
  } catch (e) {
    formatted = 'API call completed. Raw response: ' + apiResponse.slice(0, 500);
  }
  log('INFO', `Connector executed: ${conn.name} by ${username}`, req.id);
  res.json({ response: formatted, connectorName: conn.name });
});

// ============================================
// CHAT ENDPOINT (login-protected)
// ============================================

app.post('/chat', requireLogin, async (req, res) => {
  const requestId = req.id;

  try {
    const { prompt, systemPrompt } = req.body;

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Invalid request', message: 'Prompt must be a non-empty string' });
    }
    if (prompt.length > 50000) {
      return res.status(400).json({ error: 'Invalid request', message: 'Prompt must be less than 50,000 characters' });
    }

    log('INFO', 'Chat request received', requestId);
    const response = await callGemini(prompt, 30000, systemPrompt);
    log('INFO', 'Chat response generated successfully', requestId);

    res.json({ response, ai: 'gemini' });

  } catch (error) {
    log('ERROR', `Chat error: ${error.message}`, requestId, { stack: error.stack });
    const { status, userMessage } = formatError(error);
    res.status(status).json({ error: userMessage, requestId });
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

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Invalid request', message: 'Prompt must be a non-empty string' });
    }
    if (prompt.length > 50000) {
      return res.status(400).json({ error: 'Invalid request', message: 'Prompt must be less than 50,000 characters' });
    }

    if (async) {
      const taskId = createTask(prompt);
      processTaskAsync(taskId, prompt, requestId);
      return res.json({ taskId, status: 'processing', message: 'Task created successfully', checkStatusUrl: `/api/task/${taskId}` });
    }

    const response = await callGemini(prompt);
    log('INFO', 'Chat response generated successfully', requestId);
    res.json({ response, ai: 'gemini' });

  } catch (error) {
    log('ERROR', `Chat error: ${error.message}`, requestId);
    const { status, userMessage } = formatError(error);
    res.status(status).json({ error: userMessage, requestId });
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

      render: !!RENDER_API_KEY,
      notion: !!NOTION_API_KEY
    },
    version: '4.0.0'
  });
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

// ============================================
// SEND EMAIL ENDPOINT
// ============================================

app.post('/send-email', requireLogin, async (req, res) => {
  const requestId = req.id;
  try {
    const { to, subject, body } = req.body || {};
    if (!to || !subject || !body) {
      return res.status(400).json({ error: 'to, subject, and body are required' });
    }
    // Basic email validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return res.status(400).json({ error: 'Invalid recipient email address' });
    }
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
      return res.status(503).json({ error: 'Email not configured. Add SMTP_HOST, SMTP_USER, SMTP_PASS environment variables.' });
    }
    await sendMail({ to, subject, text: body, html: body.replace(/\n/g, '<br>') });
    log('INFO', `Email sent to ${to} by ${req.authenticatedUser}`, requestId);
    res.json({ success: true, message: `Email sent to ${to}` });
  } catch (err) {
    log('ERROR', `Send email error: ${err.message}`, requestId);
    if (err.message === 'EMAIL_NOT_CONFIGURED') {
      return res.status(503).json({ error: 'Email not configured on this server.' });
    }
    res.status(500).json({ error: 'Failed to send email: ' + err.message });
  }
});

// ============================================
// INVOICE TRACKER ENDPOINTS
// ============================================

app.get('/api/invoices', requireLogin, (req, res) => {
  const today = Date.now();
  let changed = false;
  invoiceStore.forEach(inv => {
    if (inv.status === 'pending' && inv.dueDate) {
      const due = new Date(inv.dueDate).getTime();
      if (!isNaN(due) && today > due) {
        inv.status = 'overdue';
        inv.updatedAt = Date.now();
        changed = true;
      }
    }
  });
  if (changed) saveInvoiceStore();
  res.json({ invoices: invoiceStore });
});

app.post('/api/invoices', requireLogin, (req, res) => {
  const { id, clientName, clientEmail, invoiceNumber, amount, dueDate, status, notes } = req.body || {};
  if (!clientName || !invoiceNumber) {
    return res.status(400).json({ error: 'clientName and invoiceNumber are required' });
  }
  const existing = id ? invoiceStore.findIndex(i => i.id === id) : -1;
  const entry = {
    id: id || crypto.randomUUID(),
    clientName: String(clientName).slice(0, 200),
    clientEmail: String(clientEmail || '').slice(0, 200),
    invoiceNumber: String(invoiceNumber).slice(0, 100),
    amount: parseFloat(amount) || 0,
    dueDate: dueDate || '',
    status: ['pending', 'overdue', 'paid', 'draft'].includes(status) ? status : 'pending',
    notes: String(notes || '').slice(0, 1000),
    createdAt: existing >= 0 ? (invoiceStore[existing].createdAt || Date.now()) : Date.now(),
    updatedAt: Date.now(),
    lastFollowUp: existing >= 0 ? invoiceStore[existing].lastFollowUp : null
  };
  if (existing >= 0) {
    invoiceStore[existing] = entry;
  } else {
    invoiceStore.push(entry);
  }
  saveInvoiceStore();
  res.json({ success: true, invoice: entry });
});

app.delete('/api/invoices/:id', requireLogin, (req, res) => {
  const { id } = req.params;
  const before = invoiceStore.length;
  invoiceStore = invoiceStore.filter(i => i.id !== id);
  if (invoiceStore.length === before) return res.status(404).json({ error: 'Invoice not found' });
  saveInvoiceStore();
  res.json({ success: true });
});

// ============================================
// AUTOMATIONS CONFIG ENDPOINTS
// ============================================

app.get('/api/automations', requireLogin, (req, res) => {
  res.json({
    automations: automationsConfig,
    emailConfigured: getEffectiveSmtp().configured,
    lastRun: automationsConfig.lastRun || null
  });
});

app.post('/api/automations', requireLogin, (req, res) => {
  const { overdueFollowup } = req.body || {};
  if (overdueFollowup) {
    automationsConfig.overdueFollowup = {
      enabled: !!overdueFollowup.enabled,
      hour: Math.min(23, Math.max(0, parseInt(overdueFollowup.hour) || 9)),
      minute: Math.min(59, Math.max(0, parseInt(overdueFollowup.minute) || 0)),
      ccEmail: String(overdueFollowup.ccEmail || '').slice(0, 200)
    };
  }
  saveAutomationsConfig();
  scheduleAutomations(); // reschedule with new config
  res.json({ success: true, automations: automationsConfig });
});

// ============================================
// EMAIL STATUS ENDPOINT
// ============================================

app.get('/api/email-status', requireLogin, (req, res) => {
  const smtp = getEffectiveSmtp();
  res.json({ configured: smtp.configured, from: smtp.from || '' });
});

// ============================================
// SMTP CONFIG ENDPOINTS
// ============================================

app.get('/api/smtp-config', requireLogin, (req, res) => {
  const smtp = getEffectiveSmtp();
  res.json({
    host: smtp.host,
    port: smtp.port,
    user: smtp.user,
    from: smtp.from,
    configured: smtp.configured,
    fromEnv: !!(SMTP_HOST || SMTP_USER || SMTP_PASS)
  });
});

app.post('/api/smtp-config', requireLogin, async (req, res) => {
  const { host, port, user, pass, from } = req.body || {};
  smtpFileConfig = {
    host: (host || '').trim(),
    port: parseInt(port) || 587,
    user: (user || '').trim(),
    pass: pass || '',
    from: (from || '').trim()
  };
  saveSmtpConfig();
  const smtp = getEffectiveSmtp();
  res.json({ success: true, configured: smtp.configured });
});

app.post('/api/smtp-test', requireLogin, async (req, res) => {
  try {
    const transporter = createTransporter();
    if (!transporter) return res.status(503).json({ error: 'SMTP not configured. Fill in all required fields first.' });
    await transporter.verify();
    res.json({ success: true, message: 'Connection verified successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Connection failed: ' + err.message });
  }
});

// ============================================
// MANUAL AUTOMATION TRIGGER
// ============================================

app.post('/api/run-automation', requireLogin, async (req, res) => {
  const requestId = req.id;
  try {
    const result = await runOverdueFollowup();
    automationsConfig.lastRun = Date.now();
    saveAutomationsConfig();
    res.json({ success: true, sent: result.sent || 0, skipped: result.skipped || 0, message: `Ran automation: ${result.sent || 0} email(s) sent, ${result.skipped || 0} skipped.` });
  } catch (err) {
    log('ERROR', `Manual automation run failed: ${err.message}`, requestId);
    res.status(500).json({ error: 'Automation failed: ' + err.message });
  }
});

// ============================================
// AUTOMATION ENGINE
// ============================================

let activeCronJobs = [];

async function runOverdueFollowup() {
  log('INFO', 'Running automated overdue invoice follow-up');
  const today = Date.now();
  const overdue = invoiceStore.filter(inv => {
    if (inv.status !== 'overdue') return false;
    if (!inv.clientEmail) return false;
    // Don't re-send if followed up in last 6 days
    if (inv.lastFollowUp && (today - inv.lastFollowUp) < 6 * 24 * 60 * 60 * 1000) return false;
    return true;
  });

  let sent = 0, skipped = 0;

  if (overdue.length === 0) {
    log('INFO', 'No overdue invoices needing follow-up');
    return { sent, skipped };
  }

  log('INFO', `Found ${overdue.length} overdue invoices to follow up`);

  for (const inv of overdue) {
    try {
      const daysPastDue = inv.dueDate
        ? Math.floor((today - new Date(inv.dueDate).getTime()) / 86400000)
        : 30;
      const tone = daysPastDue > 90 ? 'final notice with explicit reference to potential legal action'
        : daysPastDue > 60 ? 'urgent and serious'
        : daysPastDue > 30 ? 'firm but professional'
        : 'friendly reminder';

      const prompt = `You are a professional accounts receivable specialist for a construction company.
Generate a follow-up email for invoice ${inv.invoiceNumber} from ${inv.clientName} for $${inv.amount.toFixed(2)}.
The invoice is ${daysPastDue} days past due. Use a ${tone} tone.
Format as a ready-to-send email with Subject line, greeting, body, and professional sign-off.
Keep it concise and include a clear call to action to pay immediately.`;

      const emailBody = await callGemini(prompt, 30000);
      const subjectMatch = emailBody.match(/^Subject:\s*(.+)$/mi);
      const subject = subjectMatch ? subjectMatch[1].trim() : `Invoice Follow-Up: ${inv.invoiceNumber}`;
      const body = emailBody.replace(/^Subject:.*$/mi, '').trim();

      const toList = [inv.clientEmail];
      if (automationsConfig.overdueFollowup.ccEmail) toList.push(automationsConfig.overdueFollowup.ccEmail);

      await sendMail({ to: toList.join(','), subject, text: body, html: body.replace(/\n/g, '<br>') });

      // Update lastFollowUp
      const idx = invoiceStore.findIndex(i => i.id === inv.id);
      if (idx >= 0) invoiceStore[idx].lastFollowUp = today;
      log('INFO', `Auto follow-up sent for invoice ${inv.invoiceNumber} to ${inv.clientEmail}`);
      sent++;
    } catch (err) {
      log('ERROR', `Auto follow-up failed for invoice ${inv.invoiceNumber}: ${err.message}`);
      skipped++;
    }
  }
  saveInvoiceStore();
  return { sent, skipped };
}

function scheduleAutomations() {
  // Cancel existing jobs
  activeCronJobs.forEach(job => job.stop());
  activeCronJobs = [];

  const { overdueFollowup } = automationsConfig;
  if (overdueFollowup.enabled && getEffectiveSmtp().configured) {
    const pattern = `${overdueFollowup.minute} ${overdueFollowup.hour} * * *`;
    const job = cron.schedule(pattern, runOverdueFollowup, { timezone: 'America/New_York' });
    activeCronJobs.push(job);
    log('INFO', `Scheduled overdue follow-up cron: ${pattern}`);
  }
}

// Start automations after startup
setTimeout(scheduleAutomations, 3000);

// ============================================
// CUSTOM AUTOMATION ENGINE
// ============================================

function buildAutomationContext() {
  const now = new Date();
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const days   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const pending = invoiceStore.filter(i => i.status === 'pending');
  const overdue = invoiceStore.filter(i => i.status === 'overdue');
  const paid    = invoiceStore.filter(i => i.status === 'paid');
  const outstandingTotal = [...pending, ...overdue].reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const overdueTotal     = overdue.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const overdueLines  = overdue.map(i => `- ${i.clientName} | Invoice ${i.invoiceNumber} | $${Number(i.amount).toFixed(2)} | Due: ${i.dueDate || 'N/A'}`).join('\n');
  const pendingLines  = pending.map(i => `- ${i.clientName} | Invoice ${i.invoiceNumber} | $${Number(i.amount).toFixed(2)} | Due: ${i.dueDate || 'N/A'}`).join('\n');
  return {
    date:              now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    time:              now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    month:             months[now.getMonth()],
    day_of_week:       days[now.getDay()],
    overdue_count:     String(overdue.length),
    pending_count:     String(pending.length),
    paid_count:        String(paid.length),
    outstanding_total: '$' + outstandingTotal.toFixed(2),
    overdue_total:     '$' + overdueTotal.toFixed(2),
    overdue_invoices:  overdueLines  || 'None',
    pending_invoices:  pendingLines  || 'None',
  };
}

function applyContext(text, ctx) {
  return String(text || '').replace(/\{\{(\w+)\}\}/g, (_, key) => ctx[key] !== undefined ? ctx[key] : '{{' + key + '}}');
}

async function postWebhook(url, data) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(new Error('Invalid webhook URL')); }
    const body = JSON.stringify(data);
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ''),
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'LegendConstruction-Automation/1.0' }
    };
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(options, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Webhook request timed out')); });
    req.write(body);
    req.end();
  });
}

async function runCustomAutomation(automation) {
  log('INFO', 'Running custom automation: ' + automation.name + ' (' + automation.id + ')');
  const ctx    = buildAutomationContext();
  const prompt = applyContext(automation.prompt, ctx);
  let result;
  try { result = await callGemini(prompt, 60000); }
  catch (err) { throw new Error('AI generation failed: ' + err.message); }

  let actionResult = '';
  if (automation.action === 'email') {
    const to      = applyContext(automation.emailTo || '', ctx);
    const subject = applyContext(automation.emailSubject || 'Automation Report - {{date}}', ctx);
    if (!to) throw new Error('No email recipient configured');
    await sendMail({ to, subject, text: result, html: result.replace(/\n/g, '<br>') });
    actionResult = 'Email sent to ' + to;
  } else if (automation.action === 'webhook') {
    if (!automation.webhookUrl) throw new Error('No outbound webhook URL configured');
    const payload = { automation: automation.name, result, context: ctx, timestamp: new Date().toISOString() };
    const resp = await postWebhook(automation.webhookUrl, payload);
    actionResult = 'Posted to webhook (HTTP ' + resp.status + ')';
  } else {
    actionResult = 'Result logged (' + result.length + ' chars)';
  }

  log('INFO', 'Custom automation "' + automation.name + '" completed: ' + actionResult);
  return { result, actionResult };
}

let activeCustomCronJobs = {};

function scheduleCustomAutomation(automation) {
  if (activeCustomCronJobs[automation.id]) {
    activeCustomCronJobs[automation.id].stop();
    delete activeCustomCronJobs[automation.id];
  }
  if (!automation.enabled) return;
  let pattern;
  if (automation.trigger === 'daily') {
    pattern = '0 ' + (automation.triggerHour || 8) + ' * * *';
  } else if (automation.trigger === 'weekly') {
    const dow = automation.triggerDayOfWeek !== undefined ? automation.triggerDayOfWeek : 1;
    pattern = '0 ' + (automation.triggerHour || 8) + ' * * ' + dow;
  } else {
    return; // manual or webhook — no cron needed
  }
  const job = cron.schedule(pattern, async () => {
    try {
      const { result, actionResult } = await runCustomAutomation(automation);
      const idx = customAutomations.findIndex(a => a.id === automation.id);
      if (idx >= 0) {
        customAutomations[idx].lastRun = Date.now();
        customAutomations[idx].lastResult = actionResult;
        customAutomations[idx].lastResultPreview = result.substring(0, 300);
        saveCustomAutomations();
      }
    } catch (err) {
      log('ERROR', 'Custom automation "' + automation.name + '" cron failed: ' + err.message);
      const idx = customAutomations.findIndex(a => a.id === automation.id);
      if (idx >= 0) { customAutomations[idx].lastRun = Date.now(); customAutomations[idx].lastResult = 'Error: ' + err.message; saveCustomAutomations(); }
    }
  }, { timezone: 'America/New_York' });
  activeCustomCronJobs[automation.id] = job;
  log('INFO', 'Scheduled custom automation "' + automation.name + '": ' + pattern);
}

function scheduleAllCustomAutomations() {
  customAutomations.forEach(a => scheduleCustomAutomation(a));
}

setTimeout(scheduleAllCustomAutomations, 4000);

// ============================================
// CUSTOM AUTOMATIONS API
// ============================================

app.get('/api/custom-automations', requireLogin, (req, res) => {
  res.json({ automations: customAutomations });
});

app.post('/api/custom-automations', requireLogin, (req, res) => {
  const { name, trigger, triggerHour, triggerDayOfWeek, prompt, action, emailTo, emailSubject, webhookUrl } = req.body;
  if (!name || !prompt) return res.status(400).json({ error: 'name and prompt are required' });
  const automation = {
    id:                'auto_' + Date.now(),
    name:              name.trim(),
    enabled:           true,
    trigger:           trigger || 'manual',
    triggerHour:       parseInt(triggerHour) || 8,
    triggerDayOfWeek:  parseInt(triggerDayOfWeek) || 1,
    webhookToken:      trigger === 'webhook' ? crypto.randomBytes(24).toString('hex') : null,
    prompt:            prompt.trim(),
    action:            action || 'log',
    emailTo:           emailTo    || '',
    emailSubject:      emailSubject || 'Automation Report - {{date}}',
    webhookUrl:        webhookUrl  || '',
    lastRun:           null,
    lastResult:        null,
    lastResultPreview: null,
    createdAt:         Date.now()
  };
  customAutomations.push(automation);
  saveCustomAutomations();
  scheduleCustomAutomation(automation);
  res.json({ automation });
});

app.put('/api/custom-automations/:id', requireLogin, (req, res) => {
  const idx = customAutomations.findIndex(a => a.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Automation not found' });
  const allowed = ['name','enabled','trigger','triggerHour','triggerDayOfWeek','prompt','action','emailTo','emailSubject','webhookUrl'];
  allowed.forEach(k => { if (req.body[k] !== undefined) customAutomations[idx][k] = req.body[k]; });
  customAutomations[idx].updatedAt = Date.now();
  saveCustomAutomations();
  scheduleCustomAutomation(customAutomations[idx]);
  res.json({ automation: customAutomations[idx] });
});

app.delete('/api/custom-automations/:id', requireLogin, (req, res) => {
  const automation = customAutomations.find(a => a.id === req.params.id);
  if (!automation) return res.status(404).json({ error: 'Automation not found' });
  if (activeCustomCronJobs[req.params.id]) {
    activeCustomCronJobs[req.params.id].stop();
    delete activeCustomCronJobs[req.params.id];
  }
  customAutomations = customAutomations.filter(a => a.id !== req.params.id);
  saveCustomAutomations();
  res.json({ success: true });
});

app.post('/api/custom-automations/:id/run', requireLogin, async (req, res) => {
  const automation = customAutomations.find(a => a.id === req.params.id);
  if (!automation) return res.status(404).json({ error: 'Automation not found' });
  try {
    const { result, actionResult } = await runCustomAutomation(automation);
    const idx = customAutomations.findIndex(a => a.id === automation.id);
    if (idx >= 0) {
      customAutomations[idx].lastRun = Date.now();
      customAutomations[idx].lastResult = actionResult;
      customAutomations[idx].lastResultPreview = result.substring(0, 300);
      saveCustomAutomations();
    }
    res.json({ success: true, result, actionResult });
  } catch (err) {
    const idx = customAutomations.findIndex(a => a.id === automation.id);
    if (idx >= 0) { customAutomations[idx].lastRun = Date.now(); customAutomations[idx].lastResult = 'Error: ' + err.message; saveCustomAutomations(); }
    res.status(500).json({ error: formatError(err) });
  }
});

// Incoming webhook trigger (no auth — token IS the auth)
app.post('/webhooks/:token', async (req, res) => {
  const automation = customAutomations.find(a => a.trigger === 'webhook' && a.webhookToken === req.params.token && a.enabled);
  if (!automation) return res.status(404).json({ error: 'Webhook not found or disabled' });
  log('INFO', 'Incoming webhook trigger for automation: ' + automation.name);
  res.json({ success: true, message: 'Automation "' + automation.name + '" triggered' });
  try {
    const { result, actionResult } = await runCustomAutomation(automation);
    const idx = customAutomations.findIndex(a => a.id === automation.id);
    if (idx >= 0) { customAutomations[idx].lastRun = Date.now(); customAutomations[idx].lastResult = actionResult; customAutomations[idx].lastResultPreview = result.substring(0, 300); saveCustomAutomations(); }
  } catch (err) {
    log('ERROR', 'Webhook automation "' + automation.name + '" failed: ' + err.message);
    const idx = customAutomations.findIndex(a => a.id === automation.id);
    if (idx >= 0) { customAutomations[idx].lastRun = Date.now(); customAutomations[idx].lastResult = 'Error: ' + err.message; saveCustomAutomations(); }
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

async function processTaskAsync(taskId, prompt, requestId) {
  updateTask(taskId, { status: TaskStatus.PROCESSING });
  log('INFO', `Processing async task: ${taskId}`, requestId);

  try {
    const response = await callGemini(prompt);
    updateTask(taskId, { status: TaskStatus.COMPLETED, response, ai: 'gemini' });
    log('INFO', `Async task completed: ${taskId}`, requestId);
  } catch (error) {
    log('ERROR', `Async task failed: ${taskId} - ${error.message}`, requestId);
    updateTask(taskId, { status: TaskStatus.FAILED, error: error.message });
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
  console.log(`   ${RENDER_API_KEY ? '🟢' : '🔴'} Render: ${RENDER_API_KEY ? 'Ready' : 'Not Configured'}`);
  console.log(`   ${NOTION_API_KEY ? '🟢' : '🔴'} Notion: ${NOTION_API_KEY ? 'Ready' : 'Not Configured'}`);
  console.log('');
  console.log('🎯 AI:');
  console.log('   🔵 Gemini: All requests');
  console.log('📡 API Endpoints:');
  console.log('   POST /chat - Public chat endpoint');
  console.log('   GET /health - Health check (requires auth)');
  console.log('');
  console.log('⏱️  Timeouts:');
  console.log('   Gemini: 30 seconds');
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
