import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 10000; // Render uses 10000 by default

app.use(cors());
app.use(express.json());

app.post('/api/proxy', async (req, res) => {
    try {
        // Updated to the correct .ai domain
        const TARGET_URL = 'https://api.manus.ai/v1/agent'; 
        
        const response = await fetch(TARGET_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': req.headers['x-api-key']
            },
            body: JSON.stringify(req.body)
        });

        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ 
            error: { 
                message: "Proxy Error: Could not reach Manus AI API.",
                details: error.message 
            } 
        });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
