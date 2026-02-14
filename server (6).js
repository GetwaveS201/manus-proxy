// Dual AI System - FINAL VERSION
const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MANUS_API_KEY = process.env.MANUS_API_KEY;

console.log('🔑 Gemini:', GEMINI_API_KEY ? 'Ready ✅' : 'Missing ❌');
console.log('🔑 Manus:', MANUS_API_KEY ? 'Ready ✅' : 'Missing ❌');

app.use(express.json());

// Smart routing
function chooseAI(prompt) {
  const lower = prompt.toLowerCase().trim();
  
  // Short messages (< 6 words) default to Gemini
  const wordCount = prompt.trim().split(/\s+/).length;
  if (wordCount <= 5) {
    return 'gemini';
  }
  
  // Gemini keywords
  const geminiTriggers = [
    'gmail', 'email', 'google docs', 'google doc', 'google sheet', 
    'google calendar', 'calendar', 'google drive', 'drive', 'google',
    'what is', 'how does', 'explain', 'why', 'who is', 'define',
    'tell me about', 'how to', 'can you explain', 'what are',
    'when', 'where', 'who'
  ];
  
  for (const trigger of geminiTriggers) {
    if (lower.includes(trigger)) {
      return 'gemini';
    }
  }
  
  // Manus triggers (complex tasks)
  const manusTriggers = [
    'create', 'write', 'build', 'research', 'analyze', 'plan',
    'strategy', 'proposal', 'report', 'presentation'
  ];
  
  for (const trigger of manusTriggers) {
    if (lower.includes(trigger)) {
      return 'manus';
    }
  }
  
  // Default to Gemini for everything else
  return 'gemini';
}

// Frontend
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
        </div>
        <div class="chat-area" id="chat">
            <div class="empty-state">
                <h2>How can I help you?</h2>
                <p>Powered by Gemini + Manus AI</p>
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
            }
            
            const textNode = document.createTextNode(text);
            msg.appendChild(textNode);
            
            chat.appendChild(msg);
            chat.scrollTop = chat.scrollHeight;
        }
        
        async function send() {
            const userInput = input.value.trim();
            if (!userInput) return;
            
            addMsg('user', userInput);
            input.value = '';
            sendBtn.disabled = true;
            sendBtn.textContent = 'Thinking...';
            
            try {
                const res = await fetch('/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt: userInput })
                });
                
                if (!res.ok) {
                    const error = await res.json();
                    throw new Error(error.error || 'Failed');
                }
                
                const data = await res.json();
                addMsg('bot', data.response, data.ai);
                
            } catch (error) {
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

// Main chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { prompt } = req.body;
    
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt required' });
    }
    
    const ai = chooseAI(prompt);
    console.log(`📝 "${prompt.substring(0, 50)}..." → ${ai.toUpperCase()}`);
    
    let response;
    
    if (ai === 'gemini') {
      response = await callGemini(prompt);
    } else {
      response = await callManus(prompt);
    }
    
    res.json({ response, ai });
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Gemini API
async function callGemini(prompt) {
  if (!GEMINI_API_KEY) {
    throw new Error('Gemini API key not configured');
  }
  
  console.log('🔵 Calling Gemini...');
  
  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': GEMINI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }]
        }]
      })
    }
  );
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error('❌ Gemini error response:', errorText);
    console.error('❌ Gemini status:', response.status);
    throw new Error(`Gemini API error: ${response.status}`);
  }
  
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  
  if (!text) {
    throw new Error('No response from Gemini');
  }
  
  console.log('✅ Gemini responded');
  return text;
}

// Manus API - COMPLETELY REWRITTEN
async function callManus(prompt) {
  if (!MANUS_API_KEY) {
    throw new Error('Manus API key not configured');
  }
  
  console.log('🟣 Creating Manus task...');
  
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
    console.error('❌ Manus create error:', errorText);
    throw new Error('Manus API error');
  }
  
  const { task_id, share_url } = await createRes.json();
  console.log('📋 Task ID:', task_id);
  
  // Poll for completion
  let attempts = 0;
  const maxAttempts = 60; // 3 minutes max
  
  while (attempts < maxAttempts) {
    await sleep(3000);
    
    const statusRes = await fetch(`https://api.manus.ai/v1/tasks/${task_id}`, {
      headers: { 'API_KEY': MANUS_API_KEY }
    });
    
    if (!statusRes.ok) {
      throw new Error('Failed to check task status');
    }
    
    const task = await statusRes.json();
    console.log('Status:', task.status);
    
    if (task.status === 'completed') {
      // Extract ALL text from response
      let fullText = '';
      
      // Method 1: Try output array
      if (task.output && Array.isArray(task.output)) {
        for (const block of task.output) {
          if (block.content && Array.isArray(block.content)) {
            for (const part of block.content) {
              if (part.type === 'text' && part.text) {
                fullText += part.text + '\n';
              }
            }
          }
        }
      }
      
      // Method 2: Try result field
      if (!fullText && task.result) {
        fullText = task.result;
      }
      
      // Method 3: Try response field
      if (!fullText && task.response) {
        fullText = task.response;
      }
      
      fullText = fullText.trim();
      
      if (!fullText) {
        // If still no text, return the share URL
        return `Task completed! View full results: ${share_url || 'Check Manus dashboard'}`;
      }
      
      console.log('✅ Manus completed:', fullText.substring(0, 100));
      return fullText;
    }
    
    if (task.status === 'failed') {
      const error = task.error || 'Task failed';
      console.error('❌ Manus failed:', error);
      throw new Error(error);
    }
    
    attempts++;
  }
  
  throw new Error('Task timeout - check Manus dashboard');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    gemini: !!GEMINI_API_KEY,
    manus: !!MANUS_API_KEY
  });
});

app.listen(PORT, () => {
  console.log('🚀 AI Assistant LIVE');
  console.log('📍 Port:', PORT);
  console.log('🔵 Gemini:', GEMINI_API_KEY ? 'Ready ✅' : 'Missing ❌');
  console.log('🟣 Manus:', MANUS_API_KEY ? 'Ready ✅' : 'Missing ❌');
});
