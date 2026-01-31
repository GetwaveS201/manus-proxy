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
        
        // This part extracts your message text to make sure 'prompt' is never empty
        const userPrompt = req.body.prompt || 
                           (req.body.messages && req.body.messages[req.body.messages.length - 1].content) || 
                           "Hello";

        const response = await fetch(TARGET_URL, {
            method: 'POST',
            headers: {
                'accept': 'application/json',
                'content-type': 'application/json',
                'API_KEY': req.headers['x-api-key'] 
            },
            body: JSON.stringify({
                prompt: userPrompt // Manus strictly requires this field
            })
        });

        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ 
            error: { 
                message: "Proxy failed to reach Manus.",
                details: error.message 
            } 
        });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
