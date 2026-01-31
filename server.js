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
        
        // This line makes sure we find the message text no matter how it's sent
        const userPrompt = req.body.prompt || 
                           (req.body.messages && req.body.messages[req.body.messages.length - 1].content);

        if (!userPrompt) {
            return res.status(400).json({ error: "No message found in request." });
        }

        const response = await fetch(TARGET_URL, {
            method: 'POST',
            headers: {
                'accept': 'application/json',
                'content-type': 'application/json',
                'API_KEY': req.headers['x-api-key'] // Sent from your browser settings
            },
            body: JSON.stringify({
                prompt: userPrompt, // This must be a string, not an array
                agentProfile: "manus-1.6" // Optional: helps specify the agent
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
