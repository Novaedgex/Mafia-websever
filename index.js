require('dotenv').config();
const express   = require('express');
const crypto    = require('crypto');
const http      = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { createClient } = require('@supabase/supabase-js');

const app      = express();
const server   = http.createServer(app);
const wss      = new WebSocketServer({ server });
const PORT     = process.env.PORT || 3000;
const SECRET   = process.env.TRANSCRIPT_SECRET;
const DASH_PW  = process.env.DASHBOARD_SECRET || SECRET;
const supabase = createClient(process.env.supabaseUrl, process.env.supabaseKey);

if (!SECRET)                                              { console.error('❌ TRANSCRIPT_SECRET not set!'); process.exit(1); }
if (!process.env.supabaseUrl || !process.env.supabaseKey) { console.error('❌ Supabase env vars not set!'); process.exit(1); }

app.use(express.json({ limit: '10mb' }));

let visitCount  = 0;
const serverStart = Date.now();
const logBuffer   = [];
const alertBuffer = [];
const MAX_BUF     = 500;

function pushLog(e)   { logBuffer.push(e);   if (logBuffer.length   > MAX_BUF) logBuffer.shift(); }
function pushAlert(e) { alertBuffer.push(e); if (alertBuffer.length > MAX_BUF) alertBuffer.shift(); }

function broadcast(type, payload) {
    const msg = JSON.stringify({ type, payload });
    for (const ws of wss.clients)
        if (ws.readyState === WebSocket.OPEN && ws._role === 'dashboard') ws.send(msg);
}

function broadcastAll(type, payload) {
    const msg = JSON.stringify({ type, payload });
    for (const ws of wss.clients)
        if (ws.readyState === WebSocket.OPEN && ws._role) ws.send(msg);
}

wss.on('connection', (ws) => {
    ws._role = null; // 'dashboard' | 'bot'
    ws.on('message', (raw) => {
        try {
            const { type, payload } = JSON.parse(raw);
            if (type === 'auth') {
                if (payload?.secret === DASH_PW) {
                    ws._role = 'dashboard';
                    ws.send(JSON.stringify({ type: 'catchup_logs',   payload: logBuffer   }));
                    ws.send(JSON.stringify({ type: 'catchup_alerts', payload: alertBuffer }));
                    ws.send(JSON.stringify({ type: 'auth_ok', role: 'dashboard' }));
                } else if (payload?.secret === SECRET) {
                    ws._role = 'bot';
                    ws.send(JSON.stringify({ type: 'auth_ok', role: 'bot' }));
                } else {
                    ws.send(JSON.stringify({ type: 'auth_fail' }));
                    ws.close();
                }
            }
            // Bot sends control results back
            if (type === 'control_result' && ws._role === 'bot') {
                broadcast('control_result', payload);
            }
        } catch {}
    });
});

app.post('/log', (req, res) => {
    if (req.headers['authorization'] !== `Bearer ${SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
    const { level = 'info', msg } = req.body;
    if (!msg) return res.status(400).json({ error: 'Missing msg' });
    const entry = { ts: new Date().toISOString(), level, msg };
    pushLog(entry);
    broadcast('log', entry);
    res.json({ ok: true });
});

app.post('/alert', (req, res) => {
    if (req.headers['authorization'] !== `Bearer ${SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
    const { severity = 'medium', msg } = req.body;
    if (!msg) return res.status(400).json({ error: 'Missing msg' });
    const entry = { ts: new Date().toISOString(), severity, msg };
    pushAlert(entry);
    broadcast('alert', entry);
    res.json({ ok: true });
});

app.get('/admin', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(require('fs').readFileSync(__dirname + '/dashboard.html', 'utf8'));
});

app.get('/api/warnings', async (req, res) => {
    if (req.headers['authorization'] !== `Bearer ${DASH_PW}`) return res.status(401).json({ error: 'Unauthorized' });
    const { data, error } = await supabase.from('Warnings').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data ?? []);
});

app.get('/api/chart/:type', async (req, res) => {
    if (req.headers['authorization'] !== `Bearer ${DASH_PW}`) return res.status(401).json({ error: 'Unauthorized' });
    const type  = req.params.type;
    const now   = new Date();
    const days  = 30;
    const since = new Date(now - days * 86400000).toISOString();
    const labels = [];
    for (let i = days-1; i >= 0; i--) {
        const d = new Date(now); d.setDate(d.getDate() - i);
        labels.push(d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }));
    }
    function bucket(rows, field) {
        const c = new Array(days).fill(0);
        for (const r of (rows||[])) { const idx = days-1-Math.floor((now-new Date(r[field]))/86400000); if (idx>=0&&idx<days) c[idx]++; }
        return c;
    }
    try {
        if (type === 'joins') {
            const [{ data: j },{ data: l }] = await Promise.all([
                supabase.from('Member Events').select('created_at').eq('event_type','join').gte('created_at',since),
                supabase.from('Member Events').select('created_at').eq('event_type','leave').gte('created_at',since),
            ]);
            return res.json({ labels, datasets: [
                { label:'Joins',  data:bucket(j,'created_at'), borderColor:'#23d18b', backgroundColor:'rgba(35,209,139,0.15)', fill:true, tension:0.4, pointBackgroundColor:'#23d18b' },
                { label:'Leaves', data:bucket(l,'created_at'), borderColor:'#e06c75', backgroundColor:'rgba(224,108,117,0.15)', fill:true, tension:0.4, pointBackgroundColor:'#e06c75' },
            ]});
        }
        if (type === 'tickets') {
            const { data: t } = await supabase.from('Tickets').select('created_at').gte('created_at',since);
            return res.json({ labels, datasets: [{ label:'Tickets', data:bucket(t,'created_at'), borderColor:'#61afef', backgroundColor:'rgba(97,175,239,0.15)', fill:true, tension:0.4, pointBackgroundColor:'#61afef' }] });
        }
        if (type === 'messages') {
            const { data: m } = await supabase.from('Message Stats').select('created_at').gte('created_at',since);
            return res.json({ labels, datasets: [{ label:'Messages', data:bucket(m,'created_at'), borderColor:'#c678dd', backgroundColor:'rgba(198,120,221,0.15)', fill:true, tension:0.4, pointBackgroundColor:'#c678dd' }] });
        }
        if (type === 'warnings') {
            const { data: w } = await supabase.from('Warnings').select('created_at').gte('created_at',since);
            return res.json({ labels, datasets: [{ label:'Warnings', data:bucket(w,'created_at'), borderColor:'#e5c07b', backgroundColor:'rgba(229,192,123,0.15)', fill:true, tension:0.4, pointBackgroundColor:'#e5c07b' }] });
        }
        res.status(400).json({ error: 'Unknown chart type' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/transcript', async (req, res) => {
    if (req.headers['authorization'] !== `Bearer ${SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
    const { html, ticketNum, ticketType, authorId, authorTag, claimerTag, closedAt } = req.body;
    if (!html) return res.status(400).json({ error: 'Missing html' });
    const token     = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 30*24*60*60*1000).toISOString();
    let result;
    try { result = await supabase.from('Transcripts').insert([{ token, html, ticket_num:ticketNum||null, ticket_type:ticketType||null, author_id:authorId||null, author_tag:authorTag||null, claimer_tag:claimerTag||null, closed_at:closedAt||new Date().toISOString(), expires_at:expiresAt }]); }
    catch (err) { return res.status(500).json({ error: err.message }); }
    if (result.error) return res.status(500).json({ error: result.error.message });
    console.log(`✅ Transcript saved: #${ticketNum} (${token})`);
    return res.json({ token });
});

app.get('/transcript/:token', async (req, res) => {
    visitCount++;
    supabase.from('Settings').select('id,transcript_views').limit(1).then(({data})=>{ if(data?.[0]) supabase.from('Settings').update({transcript_views:(data[0].transcript_views||0)+1}).eq('id',data[0].id).catch(()=>{}); }).catch(()=>{});
    const { data, error } = await supabase.from('Transcripts').select('html,expires_at').eq('token',req.params.token).single();
    if (error||!data) return res.status(404).send(notFoundPage('Transcript Not Found',"This transcript doesn't exist or has expired."));
    if (new Date(data.expires_at)<new Date()) { await supabase.from('Transcripts').delete().eq('token',req.params.token); return res.status(404).send(notFoundPage('Transcript Expired','This transcript is older than 30 days.')); }
    res.setHeader('Content-Type','text/html'); res.send(data.html);
});

app.get('/', async (req, res) => {
    const { count } = await supabase.from('Transcripts').select('*',{count:'exact',head:true}).gt('expires_at',new Date().toISOString());
    res.json({ status:'online', active_transcripts:count??0, transcript_views:visitCount, uptime_seconds:Math.floor(process.uptime()), started_at:new Date(serverStart).toISOString() });
});

function notFoundPage(title,msg) {
    return `<!DOCTYPE html><html><head><title>${title}</title></head><body style="background:#313338;color:#dcddde;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><div style="font-size:64px;margin-bottom:16px">🔍</div><h1 style="font-size:24px;margin-bottom:8px;color:#f2f3f5">${title}</h1><p style="color:#72767d">${msg}</p></div></body></html>`;
}

app.post('/warning', (req, res) => {
    if (req.headers['authorization'] !== `Bearer ${SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
    const entry = req.body;
    if (!entry?.user_id) return res.status(400).json({ error: 'Missing user_id' });
    broadcast('warning_new', entry);
    res.json({ ok: true });
});

// ── Control panel — bot command relay ────────────────────────────
// The dashboard POSTs here, server forwards to bot via WS broadcast
// Bot must listen for 'control' WS messages (handled in bot.js)

app.post('/control', (req, res) => {
    if (req.headers['authorization'] !== `Bearer ${DASH_PW}`)
        return res.status(401).json({ error: 'Unauthorized' });
    const { action, payload } = req.body;
    if (!action) return res.status(400).json({ error: 'Missing action' });

    // Forward to bot WS clients only
    const msg = JSON.stringify({ type: 'control', payload: { action, payload } });
    let sent = 0;
    for (const ws of wss.clients) {
        if (ws.readyState === WebSocket.OPEN && ws._role === 'bot') {
            ws.send(msg);
            sent++;
        }
    }
    if (sent === 0) return res.status(503).json({ error: 'Bot not connected' });
    res.json({ ok: true, action });
});

// GET /api/channels — bot pushes channel list here on startup, cached
let channelCache = [];
app.post('/api/channels', (req, res) => {
    if (req.headers['authorization'] !== `Bearer ${SECRET}`)
        return res.status(401).json({ error: 'Unauthorized' });
    channelCache = req.body.channels || [];
    broadcast('channels', channelCache);
    res.json({ ok: true });
});
app.get('/api/channels', (req, res) => {
    if (req.headers['authorization'] !== `Bearer ${DASH_PW}`)
        return res.status(401).json({ error: 'Unauthorized' });
    res.json(channelCache);
});

server.listen(PORT, () => console.log(`📄 Server running on port ${PORT}`));
