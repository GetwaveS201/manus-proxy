import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.post('/api/proxy', async (req, res) => {
    try {
        const response = await fetch('https://api.manus.app/v1/agent', {
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
        res.status(500).json({ error: { message: error.message } });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
