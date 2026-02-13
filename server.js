// AI Automation Assistant - COMPLETELY FIXED VERSION
// Dual AI System: Gemini (fast/free) + Manus (powerful/paid)
const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MANUS_API_KEY = process.env.MANUS_API_KEY;
const RENDER_API_KEY = process.env.RENDER_API_KEY;
const NOTION_API_KEY = process.env.NOTION_API_KEY;

console.log('🔑 Gemini:', GEMINI_API_KEY ? 'Ready ✅' : 'Missing ❌');
console.log('🔑 Manus:', MANUS_API_KEY ? 'Ready ✅' : 'Missing ❌');
console.log('🔑 Render:', RENDER_API_KEY ? 'Ready ✅' : 'Missing ❌');
console.log('🔑 Notion:', NOTION_API_KEY ? 'Ready ✅' : 'Missing ❌');

app.use(express.json());

// ============================================
// SMART ROUTING LOGIC - ENHANCED FOR TASK EXECUTION
// ============================================
function chooseAI(prompt) {
  const lower = prompt.toLowerCase().trim();

  // Short greetings/thanks only (≤ 3 words) default to Gemini
  const wordCount = prompt.trim().split(/\s+/).length;
  if (wordCount <= 3) {
    const greetings = ['hi', 'hello', 'hey', 'thanks', 'thank you', 'goodbye', 'bye'];
    if (greetings.some(g => lower === g || lower.startsWith(g + ' '))) {
      return 'gemini';
    }
  }

  // GEMINI TRIGGERS - Check these FIRST for simple Q&A
  const geminiTriggers = [
    'what is', 'what are', 'what does',
    'how does', 'how do', 'how can',
    'explain', 'why', 'who is', 'define',
    'tell me about', 'can you explain',
    'when', 'where', 'who wrote', 'who invented'
  ];

  for (const trigger of geminiTriggers) {
    if (lower.includes(trigger)) {
      return 'gemini';
    }
  }

  // MANUS TRIGGERS - Tasks that require DOING WORK (execution, not just explanation)
  const manusTriggers = [
    // Data processing & analysis
    'calculate', 'compute', 'sum', 'total', 'average', 'count',
    'parse', 'process', 'analyze data', 'csv', 'spreadsheet',

    // Research & information gathering
    'find', 'search for', 'look up', 'compare', 'pricing',
    'summarize', 'summary', 'research', 'investigate',

    // Content creation
    'create', 'write', 'draft', 'compose', 'generate',
    'build', 'design', 'develop', 'make',

    // Complex analysis
    'analyze', 'evaluate', 'assess', 'review',
    'plan', 'strategy', 'roadmap',

    // Email/data access tasks
    'my emails', 'my calendar', 'my data',
    'access my', 'check my', 'get my',

    // Business tasks
    'proposal', 'report', 'presentation',
    'competitive analysis', 'market research',

    // Technical tasks
    'implement', 'optimize', 'debug', 'fix', 'refactor'
  ];

  for (const trigger of manusTriggers) {
    if (lower.includes(trigger)) {
      return 'manus';
    }
  }

  // DEFAULT: If unclear, use Manus (better to do the work than just explain)
  // This ensures automation tasks are actually executed
  return 'manus';
}

// ============================================
// FRONTEND HTML
// ============================================
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Automation Assistant</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            width: 100%;
            max-width: 900px;
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            overflow: hidden;
            display: flex;
            flex-direction: column;
            height: 90vh;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 25px;
            text-align: center;
        }
        .header h1 { font-size: 24px; font-weight: 600; }
        .header p { font-size: 12px; opacity: 0.9; margin-top: 5px; }
        .chat-area {
            flex: 1;
            overflow-y: auto;
            padding: 20px;
            background: #f8f9fa;
        }
        .empty-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: #6c757d;
        }
        .empty-state h2 { font-size: 2rem; margin-bottom: 10px; }
        .message {
            margin-bottom: 15px;
            padding: 12px 16px;
            border-radius: 12px;
            max-width: 80%;
            word-wrap: break-word;
            white-space: pre-wrap;
        }
        .user {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            margin-left: auto;
        }
        .bot {
            background: white;
            border: 1px solid #ddd;
        }
        .bot.gemini { border-left: 4px solid #4285f4; }
        .bot.manus { border-left: 4px solid #764ba2; }
        .ai-badge {
            display: inline-block;
            padding: 3px 8px;
            border-radius: 5px;
            font-size: 11px;
            font-weight: 600;
            margin-bottom: 5px;
        }
        .ai-badge.gemini { background: #4285f4; color: white; }
        .ai-badge.manus { background: #764ba2; color: white; }
        .thinking {
            background: #fff3cd;
            border: 1px solid #ffc107;
            color: #856404;
            font-style: italic;
        }
        .error {
            background: #f8d7da;
            border: 1px solid #f5c6cb;
            color: #721c24;
        }
        .input-area {
            padding: 20px;
            background: white;
            border-top: 1px solid #ddd;
            display: flex;
            gap: 10px;
        }
        input {
            flex: 1;
            padding: 12px;
            border: 2px solid #ddd;
            border-radius: 10px;
            font-size: 14px;
        }
        input:focus { outline: none; border-color: #667eea; }
        button {
            padding: 12px 24px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 10px;
            font-weight: 600;
            cursor: pointer;
        }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-thumb { background: #ddd; border-radius: 4px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 AI Automation Assistant</h1>
            <p>Powered by Gemini (fast) + Manus (powerful)</p>
        </div>
        <div class="chat-area" id="chat">
            <div class="empty-state">
                <h2>👋 How can I help you?</h2>
                <p>Ask me anything - I'll choose the best AI for your task!</p>
            </div>
        </div>
        <div class="input-area">
            <input type="text" id="input" placeholder="Type your message..." onkeypress="if(event.key==='Enter')send()">
            <button onclick="send()" id="send-btn">Send</button>
        </div>
    </div>
    <script>
        const chat = document.getElementById('chat');
        const input = document.getElementById('input');
        const sendBtn = document.getElementById('send-btn');

        function addMsg(type, text, aiType) {
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

            const textNode = document.createTextNode(text);
            msg.appendChild(textNode);

            chat.appendChild(msg);
            chat.scrollTop = chat.scrollHeight;
            return msg;
        }

        async function send() {
            const userInput = input.value.trim();
            if (!userInput) return;

            addMsg('user', userInput);
            input.value = '';
            sendBtn.disabled = true;
            sendBtn.textContent = 'Thinking...';

            const thinkingMsg = addMsg('thinking', 'Processing your request...');

            try {
                const res = await fetch('/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: userInput })
                });

                if (!res.ok) {
                    const error = await res.json();
                    throw new Error(error.error || 'Failed to get response');
                }

                const data = await res.json();

                // Remove thinking message
                thinkingMsg.remove();

                // Add bot response
                addMsg('bot', data.response, data.ai);

            } catch (error) {
                thinkingMsg.remove();
                addMsg('error', 'Error: ' + error.message);
            } finally {
                sendBtn.disabled = false;
                sendBtn.textContent = 'Send';
            }
        }
    </script>
</body>
</html>`);
});

// ============================================
// MAIN CHAT ENDPOINT
// ============================================
app.post('/api/chat', async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt required' });
    }

    let ai = chooseAI(prompt);
    console.log(`📝 "${prompt.substring(0, 50)}..." → ${ai.toUpperCase()}`);

    let response;
    let actualAI = ai;

    try {
      if (ai === 'gemini') {
        response = await callGemini(prompt);
      } else {
        response = await callManus(prompt);
      }
    } catch (error) {
      // If Manus fails due to credit limit, fall back to Gemini
      if (error.message === 'MANUS_CREDITS_EXCEEDED' && ai === 'manus') {
        console.log('⚠️ Manus credits exceeded, falling back to Gemini');
        response = await callGemini(prompt);
        actualAI = 'gemini';
        // Add notice to response
        response = `⚠️ Note: Manus AI credits exhausted. Using Gemini as fallback.\n\n${response}`;
      } else {
        throw error;
      }
    }

    res.json({ response, ai: actualAI });

  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// GEMINI API - FIXED
// ============================================
async function callGemini(prompt) {
  if (!GEMINI_API_KEY) {
    throw new Error('Gemini API key not configured');
  }

  console.log('🔵 Calling Gemini...');

  // Try latest models first (gemini-2.5-flash is most reliable)
  const models = [
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-2.5-pro'
  ];

  for (const model of models) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            contents: [{
              parts: [{ text: prompt }]
            }]
          })
        }
      );

      if (response.ok) {
        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

        if (text) {
          console.log(`✅ Gemini (${model}) responded`);
          return text;
        }
      }

      console.log(`⚠️ Model ${model} failed, trying next...`);

    } catch (err) {
      console.log(`⚠️ Model ${model} error:`, err.message);
      continue;
    }
  }

  // If all Gemini models fail, throw error (don't fallback to Manus here)
  // Let the main handler decide what to do
  throw new Error('All Gemini models failed - API key may be invalid or models unavailable');
}

// ============================================
// MANUS API - COMPLETELY FIXED
// ============================================
async function callManus(prompt) {
  if (!MANUS_API_KEY) {
    throw new Error('Manus API key not configured');
  }

  console.log('🟣 Creating Manus task...');

  // FIXED: Correct endpoint is api.manus.ai (not api.manus.im)
  // FIXED: Use API_KEY header (not Authorization Bearer)
  const createRes = await fetch('https://api.manus.ai/v1/tasks', {
    method: 'POST',
    headers: {
      'API_KEY': MANUS_API_KEY,  // FIXED: Custom header format
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
    console.error('❌ Manus create error:', errorText);

    // Check if it's a credit limit error
    try {
      const errorJson = JSON.parse(errorText);
      if (errorJson.message && errorJson.message.includes('credit limit exceeded')) {
        throw new Error('MANUS_CREDITS_EXCEEDED');
      }
    } catch (e) {
      // If JSON parsing fails, check raw text
      if (errorText.includes('credit limit exceeded')) {
        throw new Error('MANUS_CREDITS_EXCEEDED');
      }
    }

    throw new Error('Failed to create Manus task');
  }

  const createData = await createRes.json();
  const task_id = createData.task_id;  // FIXED: Use task_id (not id)
  const share_url = createData.share_url;

  console.log('📋 Task ID:', task_id);

  // Poll for completion (max 3 minutes)
  let attempts = 0;
  const maxAttempts = 60;

  while (attempts < maxAttempts) {
    await sleep(3000);  // Poll every 3 seconds

    const statusRes = await fetch(`https://api.manus.ai/v1/tasks/${task_id}`, {
      headers: { 'API_KEY': MANUS_API_KEY }
    });

    if (!statusRes.ok) {
      throw new Error('Failed to check task status');
    }

    const task = await statusRes.json();
    console.log(`⏳ Status: ${task.status} (${attempts + 1}/${maxAttempts})`);

    if (task.status === 'completed') {
      // FIXED: Enhanced multi-layer extraction with correct structure
      let fullText = '';

      // Method 1: Extract from output array (NEW CORRECT FORMAT)
      // Find assistant role messages with output_text type
      if (task.output && Array.isArray(task.output)) {
        for (const block of task.output) {
          // Look for assistant messages
          if (block.role === 'assistant' && block.content && Array.isArray(block.content)) {
            for (const part of block.content) {
              if (part.type === 'output_text' && part.text) {
                fullText += part.text + '\n';
              }
            }
          }
        }
      }

      // Method 2: Old format fallback (for backwards compatibility)
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

      // Method 3: Try result field
      if (!fullText && task.result) {
        fullText = typeof task.result === 'string' ? task.result : JSON.stringify(task.result);
      }

      // Method 4: Try response field
      if (!fullText && task.response) {
        fullText = typeof task.response === 'string' ? task.response : JSON.stringify(task.response);
      }

      // Method 5: Try output_text field
      if (!fullText && task.output_text) {
        fullText = task.output_text;
      }

      fullText = fullText.trim();

      if (!fullText) {
        // Last resort: provide share URL
        return `Task completed! View full results here: ${share_url || 'https://app.manus.ai'}`;
      }

      console.log('✅ Manus completed:', fullText.substring(0, 100) + '...');
      return fullText;
    }

    if (task.status === 'failed') {
      const error = task.error || 'Task failed';
      console.error('❌ Manus failed:', error);
      throw new Error(error);
    }

    attempts++;
  }

  // Timeout
  throw new Error(`Task timeout after ${maxAttempts * 3} seconds. Check Manus dashboard: ${share_url || 'https://app.manus.ai'}`);
}

// ============================================
// UTILITY FUNCTIONS
// ============================================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// HEALTH CHECK ENDPOINT
// ============================================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    gemini: !!GEMINI_API_KEY,
    manus: !!MANUS_API_KEY,
    render: !!RENDER_API_KEY,
    notion: !!NOTION_API_KEY
  });
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log('🚀 AI Automation Assistant LIVE!');
  console.log('📍 Port:', PORT);
  console.log('🔵 Gemini:', GEMINI_API_KEY ? 'Ready ✅' : 'Missing ❌');
  console.log('🟣 Manus:', MANUS_API_KEY ? 'Ready ✅' : 'Missing ❌');
  console.log('');
  console.log('💡 Smart Routing:');
  console.log('   - Gemini: Fast queries, Google services, questions (FREE)');
  console.log('   - Manus: Complex tasks, research, analysis (PAID)');
});
