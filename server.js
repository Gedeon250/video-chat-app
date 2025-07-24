const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Serve static files
app.use(express.static(__dirname));

// API endpoint to get client-safe config
app.get('/api/config', (req, res) => {
    res.json({
        apiKey: process.env.STREAM_API_KEY,
        appId: process.env.STREAM_APP_ID
        // Note: Never send secret key to frontend
    });
});

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Video chat app running on http://localhost:${PORT}`);
});
