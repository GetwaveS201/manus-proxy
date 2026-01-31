import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// Main proxy endpoint - creates task
app.post('/api/proxy', async (req, res) => {
    try {
        const TARGET_URL = 'https://api.manus.ai/v1/tasks'; 
        
        // Extract message from multiple possible formats
        let userPrompt = null;
        
        if (req.body.prompt) {
            userPrompt = req.body.prompt;
        } else if (req.body.message) {
            userPrompt = req.body.message;
        } else if (req.body.messages && Array.isArray(req.body.messages)) {
            const lastMessage = req.body.messages[req.body.messages.length - 1];
            userPrompt = lastMessage.content || lastMessage.text;
        } else if (req.body.text) {
            userPrompt = req.body.text;
        }
        
        // If still no message, reject
        if (!userPrompt) {
            console.log('Request body received:', JSON.stringify(req.body));
            return res.status(400).json({ 
                error: "No message found in request.",
                receivedData: req.body 
            });
        }
        
        // Get API key from header
        const apiKey = req.headers['x-api-key'] || req.headers['api-key'];
        
        if (!apiKey) {
            return res.status(401).json({ error: "API key missing" });
        }
        
        console.log('Sending to Manus:', userPrompt);
        
        const response = await fetch(TARGET_URL, {
            method: 'POST',
            headers: {
                'accept': 'application/json',
                'content-type': 'application/json',
                'API_KEY': apiKey
            },
            body: JSON.stringify({
                prompt: userPrompt,
                agentProfile: req.body.mode === 'nano-banana' ? 'nano-banana-pro' : 'manus-1.6'
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            console.log('Manus error:', data);
            return res.status(response.status).json(data);
        }
        
        console.log('Task created:', data.task_id);
        res.json(data);
        
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ 
            error: { 
                message: "Proxy failed to reach Manus.",
                details: error.message 
            } 
        });
    }
});

// New endpoint - check task status
app.get('/api/task-status/:taskId', async (req, res) => {
    try {
        const { taskId } = req.params;
        const apiKey = req.headers['x-api-key'] || req.headers['api-key'];
        
        if (!apiKey) {
            return res.status(401).json({ error: "API key missing" });
        }
        
        console.log('Checking task status:', taskId);
        
        const response = await fetch(`https://api.manus.ai/v1/tasks/${taskId}`, {
            method: 'GET',
            headers: {
                'accept': 'application/json',
                'API_KEY': apiKey
            }
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            console.log('Task status error:', errorData);
            return res.status(response.status).json(errorData);
        }
        
        const data = await response.json();
        console.log('Task status:', data.status);
        console.log('Full task data:', JSON.stringify(data, null, 2));
        
        res.json(data);
        
    } catch (error) {
        console.error('Task status check error:', error);
        res.status(500).json({ 
            error: { 
                message: "Failed to check task status",
                details: error.message 
            } 
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'Server is running' });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
