require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');

const app    = express();
const PORT   = process.env.PORT || 3000;
const SECRET = process.env.TRANSCRIPT_SECRET;

if (!SECRET) {
    console.error('❌ TRANSCRIPT_SECRET env variable is not set!');
    process.exit(1);
}

// In-memory store: token -> { html, expiresAt }
const transcriptStore = new Map();

// Clean up expired transcripts every hour
setInterval(() => {
    const now = Date.now();
    for (const [token, data] of transcriptStore.entries()) {
        if (data.expiresAt < now) transcriptStore.delete(token);
    }
}, 60 * 60 * 1000);

app.use(express.json({ limit: '10mb' }));

// ── POST /transcript — bot sends HTML here ──────────────────────
app.post('/transcript', (req, res) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { html } = req.body;
    if (!html) return res.status(400).json({ error: 'Missing html field' });

    const token    = crypto.randomBytes(24).toString('hex');
    const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
    transcriptStore.set(token, { html, expiresAt });

    console.log(`📄 Transcript stored: ${token} (${transcriptStore.size} total)`);
    return res.json({ token });
});

// ── GET /transcript/:token — anyone views transcript here ───────
app.get('/transcript/:token', (req, res) => {
    const entry = transcriptStore.get(req.params.token);
    if (!entry) {
        return res.status(404).send(`
            <!DOCTYPE html><html><head><title>Not Found</title></head>
            <body style="background:#111;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
                <div style="text-align:center">
                    <h1 style="font-size:48px;margin-bottom:8px">404</h1>
                    <p style="color:#72767d">Transcript not found or has expired.</p>
                </div>
            </body></html>
        `);
    }
    if (entry.expiresAt < Date.now()) {
        transcriptStore.delete(req.params.token);
        return res.status(404).send('Transcript expired.');
    }
    res.setHeader('Content-Type', 'text/html');
    res.send(entry.html);
});

// ── GET / — health check ────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        transcripts: transcriptStore.size,
        uptime: Math.floor(process.uptime()) + 's',
    });
});

app.listen(PORT, () => console.log(`📄 Transcript server running on port ${PORT}`));
