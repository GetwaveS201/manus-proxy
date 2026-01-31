import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.post('/api/proxy', async (req, res) => {
    try {
        // Try manus.ai if manus.app fails, as they recently updated their branding
        const TARGET_URL = 'https://api.manus.ai/v1/agent'; 
        
        console.log(`Forwarding request to: ${TARGET_URL}`);

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
        console.error("Fetch Error:", error.message);
        res.status(500).json({ 
            error: { 
                message: "The proxy couldn't reach Manus. Check if api.manus.ai is correct.",
                details: error.message 
            } 
        });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
