require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app      = express();
const PORT     = process.env.PORT || 3000;
const SECRET   = process.env.TRANSCRIPT_SECRET;
const supabase = createClient(process.env.supabaseUrl, process.env.supabaseKey);

if (!SECRET) { console.error('❌ TRANSCRIPT_SECRET not set!'); process.exit(1); }
if (!process.env.supabaseUrl || !process.env.supabaseKey) { console.error('❌ Supabase env vars not set!'); process.exit(1); }

app.use(express.json({ limit: '10mb' }));

// ── POST /transcript — bot sends transcript here ─────────────────
app.post('/transcript', async (req, res) => {
    if (req.headers['authorization'] !== `Bearer ${SECRET}`)
        return res.status(401).json({ error: 'Unauthorized' });

    const { html, ticketNum, ticketType, authorId, authorTag, claimerTag, closedAt } = req.body;
    if (!html) return res.status(400).json({ error: 'Missing html' });

    const token     = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    console.log(`📄 Attempting Supabase insert for ticket #${ticketNum}...`);
    console.log(`   supabaseUrl set: ${!!process.env.supabaseUrl}`);
    console.log(`   supabaseKey set: ${!!process.env.supabaseKey}`);

    let result;
    try {
        result = await supabase.from('Transcripts').insert([{
            token,
            html,
            ticket_num:  ticketNum  || null,
            ticket_type: ticketType || null,
            author_id:   authorId   || null,
            author_tag:  authorTag  || null,
            claimer_tag: claimerTag || null,
            closed_at:   closedAt   || new Date().toISOString(),
            expires_at:  expiresAt,
        }]);
    } catch (err) {
        console.error('❌ Supabase threw an exception:', err.message);
        return res.status(500).json({ error: err.message });
    }

    if (result.error) {
        console.error('❌ Supabase insert error code:', result.error.code);
        console.error('❌ Supabase insert error message:', result.error.message);
        console.error('❌ Supabase insert error details:', result.error.details);
        console.error('❌ Supabase insert error hint:', result.error.hint);
        return res.status(500).json({ error: result.error.message, details: result.error.details, hint: result.error.hint });
    }

    console.log(`✅ Transcript saved: #${ticketNum} (${token})`);
    return res.json({ token });
});

// ── GET /transcript/:token — serve transcript page ───────────────
app.get('/transcript/:token', async (req, res) => {
    const { data, error } = await supabase
        .from('Transcripts')
        .select('html, expires_at')
        .eq('token', req.params.token)
        .single();

    if (error || !data) {
        return res.status(404).send(`<!DOCTYPE html><html><head><title>Not Found</title></head>
        <body style="background:#313338;color:#dcddde;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
            <div style="text-align:center">
                <div style="font-size:64px;margin-bottom:16px">🔍</div>
                <h1 style="font-size:24px;margin-bottom:8px;color:#f2f3f5">Transcript Not Found</h1>
                <p style="color:#72767d">This transcript doesn't exist or has expired.</p>
            </div>
        </body></html>`);
    }

    if (new Date(data.expires_at) < new Date()) {
        await supabase.from('Transcripts').delete().eq('token', req.params.token);
        return res.status(404).send(`<!DOCTYPE html><html><head><title>Expired</title></head>
        <body style="background:#313338;color:#dcddde;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
            <div style="text-align:center">
                <div style="font-size:64px;margin-bottom:16px">⏰</div>
                <h1 style="font-size:24px;margin-bottom:8px;color:#f2f3f5">Transcript Expired</h1>
                <p style="color:#72767d">This transcript is older than 30 days and has been deleted.</p>
            </div>
        </body></html>`);
    }

    res.setHeader('Content-Type', 'text/html');
    res.send(data.html);
});

// ── GET / — health check ─────────────────────────────────────────
app.get('/', async (req, res) => {
    const { count } = await supabase
        .from('Transcripts')
        .select('*', { count: 'exact', head: true })
        .gt('expires_at', new Date().toISOString());
    res.json({ status: 'online', active_transcripts: count ?? 0, uptime: Math.floor(process.uptime()) + 's' });
});

app.listen(PORT, () => console.log(`📄 Transcript server running on port ${PORT}`));
