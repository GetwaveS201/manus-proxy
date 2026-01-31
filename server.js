import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

app.post('/api/proxy', async (req, res) => {
    try {
        // Updated to the official Manus Agent endpoint
        const TARGET_URL = 'https://api.manus.ai/v1/chat/completions'; 
        
        console.log("Attempting to connect to Manus...");

        const response = await fetch(TARGET_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${req.headers['x-api-key']}`
            },
            body: JSON.stringify(req.body)
        });

        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error("Proxy Error:", error.message);
        res.status(500).json({ 
            error: { 
                message: "Proxy failed to reach Manus.",
                details: error.message 
            } 
        });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
