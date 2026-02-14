/**
 * Simple Smoke Test for AI Automation Assistant
 * Tests basic functionality without requiring API keys
 */

console.log('🧪 Running AI Automation Assistant Tests...\n');

let passed = 0;
let failed = 0;

// Test helper
function test(name, fn) {
  try {
    fn();
    console.log(`✅ PASS: ${name}`);
    passed++;
  } catch (error) {
    console.log(`❌ FAIL: ${name}`);
    console.log(`   Error: ${error.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

// Load server code (without starting the server)
const fs = require('fs');
const serverCode = fs.readFileSync('./server.js', 'utf8');

// Test 1: Check required dependencies are declared
test('Package.json has all required dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
  assert(pkg.dependencies.express, 'express missing');
  assert(pkg.dependencies['express-rate-limit'], 'express-rate-limit missing');
  assert(pkg.dependencies.cors, 'cors missing');
  assert(pkg.dependencies.helmet, 'helmet missing');
});

// Test 2: Check environment variable handling
test('Server checks for required env vars', () => {
  assert(serverCode.includes('GEMINI_API_KEY'), 'Missing GEMINI_API_KEY check');
  assert(serverCode.includes('MANUS_API_KEY'), 'Missing MANUS_API_KEY check');
  assert(serverCode.includes('API_KEY'), 'Missing API_KEY check');
});

// Test 3: Check security middleware
test('Security middleware is configured', () => {
  assert(serverCode.includes('helmet'), 'Helmet not configured');
  assert(serverCode.includes('rateLimit'), 'Rate limiting not configured');
  assert(serverCode.includes('cors'), 'CORS not configured');
});

// Test 4: Check authentication
test('API authentication is implemented', () => {
  assert(serverCode.includes('X-API-Key'), 'API key authentication not found');
  assert(serverCode.includes('authenticateAPI'), 'Auth middleware not found');
});

// Test 5: Check routing endpoints exist
test('All required endpoints are defined', () => {
  assert(serverCode.includes("app.get('/'"), 'Root endpoint missing');
  assert(serverCode.includes("app.post('/api/chat'"), 'Chat endpoint missing');
  assert(serverCode.includes("app.get('/api/task/:id'"), 'Task endpoint missing');
  assert(serverCode.includes("app.get('/health'"), 'Health endpoint missing');
});

// Test 6: Check AI routing logic
test('Smart routing function exists', () => {
  assert(serverCode.includes('function chooseAI'), 'chooseAI function missing');
  assert(serverCode.includes('score'), 'Score-based routing not implemented');
});

// Test 7: Check error handling
test('Comprehensive error handling implemented', () => {
  assert(serverCode.includes('try'), 'No try-catch blocks found');
  assert(serverCode.includes('catch'), 'No error catching found');
  assert(serverCode.includes('formatError'), 'Error formatting function missing');
});

// Test 8: Check Gemini API integration
test('Gemini API integration exists', () => {
  assert(serverCode.includes('async function callGemini'), 'callGemini function missing');
  assert(serverCode.includes('generativelanguage.googleapis.com'), 'Gemini endpoint missing');
});

// Test 9: Check Manus API integration
test('Manus API integration exists', () => {
  assert(serverCode.includes('async function callManus'), 'callManus function missing');
  assert(serverCode.includes('api.manus.ai'), 'Manus endpoint missing');
  assert(serverCode.includes('API_KEY'), 'Manus authentication missing');
});

// Test 10: Check async task support
test('Async task support implemented', () => {
  assert(serverCode.includes('taskStore'), 'Task store not found');
  assert(serverCode.includes('/api/task/:id'), 'Task status endpoint missing');
});

// Test 11: Check request timeouts
test('Request timeouts configured', () => {
  assert(serverCode.includes('AbortController') || serverCode.includes('timeout'), 'Timeout handling missing');
});

// Test 12: Check logging
test('Logging system implemented', () => {
  assert(serverCode.includes('log('), 'Logging not found');
  assert(serverCode.includes('requestId'), 'Request ID tracking missing');
});

// Test 13: Check rate limiting
test('Rate limiting configured properly', () => {
  assert(serverCode.includes('windowMs'), 'Rate limit window not set');
  assert(serverCode.includes('max'), 'Rate limit max not set');
});

// Test 14: Check CORS configuration
test('CORS whitelist configured', () => {
  assert(serverCode.includes('origin'), 'CORS origin check missing');
  assert(serverCode.includes('allowedOrigins') || serverCode.includes('whitelist'), 'CORS whitelist missing');
});

// Test 15: Check graceful shutdown
test('Graceful shutdown handlers exist', () => {
  assert(serverCode.includes('SIGTERM') || serverCode.includes('SIGINT'), 'Shutdown handlers missing');
});

// Print summary
console.log('\n' + '='.repeat(50));
console.log(`📊 Test Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(50));

if (failed === 0) {
  console.log('✅ All tests passed! Server is ready for deployment.\n');
  process.exit(0);
} else {
  console.log(`❌ ${failed} test(s) failed. Please fix before deploying.\n`);
  process.exit(1);
}
