import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

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
                agentProfile: "manus-1.6"
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            console.log('Manus error:', data);
            return res.status(response.status).json(data);
        }
        
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

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'Server is running' });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
