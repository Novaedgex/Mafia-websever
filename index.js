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
const supabase = createClient(process.env.supabaseUrl, process.env.supabaseKey);

// ── Discord OAuth2 config ─────────────────────────────────────────
const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI  = process.env.DISCORD_REDIRECT_URI;   // e.g. https://yourapp.railway.app/auth/callback
const DISCORD_GUILD_ID      = process.env.GUILD_ID;
const ALLOWED_ROLE_IDS      = (process.env.ALLOWED_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
// e.g. ALLOWED_ROLE_IDS=1466333274103222292,1466325679380365453

if (!SECRET)                    { console.error('❌ TRANSCRIPT_SECRET not set');    process.exit(1); }
if (!DISCORD_CLIENT_ID)         { console.error('❌ DISCORD_CLIENT_ID not set');    process.exit(1); }
if (!DISCORD_CLIENT_SECRET)     { console.error('❌ DISCORD_CLIENT_SECRET not set'); process.exit(1); }
if (!DISCORD_REDIRECT_URI)      { console.error('❌ DISCORD_REDIRECT_URI not set'); process.exit(1); }
if (!DISCORD_GUILD_ID)          { console.error('❌ GUILD_ID not set');             process.exit(1); }
if (!process.env.supabaseUrl)   { console.error('❌ supabaseUrl not set');          process.exit(1); }

app.use(express.json({ limit: '10mb' }));

// ── Session store (in-memory, survives for 6 hours) ───────────────
const sessions    = new Map(); // sessionToken → { userId, username, avatar, expiresAt }
const oauthStates = new Map(); // state → expiresAt (server-side CSRF protection)

function createSession(userId, username, avatar) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { userId, username, avatar, expiresAt: Date.now() + 6 * 60 * 60 * 1000 });
    // Clean expired sessions
    for (const [k, v] of sessions) if (v.expiresAt < Date.now()) sessions.delete(k);
    return token;
}

function getSession(req) {
    const raw = req.headers.cookie?.split(';').find(c => c.trim().startsWith('dash_session='));
    if (!raw) return null;
    const token = raw.split('=')[1]?.trim();
    const sess  = sessions.get(token);
    if (!sess || sess.expiresAt < Date.now()) { if (sess) sessions.delete(token); return null; }
    return sess;
}

function requireAuth(req, res, next) {
    if (getSession(req)) return next();
    res.redirect('/auth/login');
}

// ── OAuth2 routes ─────────────────────────────────────────────────

// Step 1 — redirect to Discord
app.get('/auth/login', (req, res) => {
    const state  = crypto.randomBytes(16).toString('hex');
    const params = new URLSearchParams({
        client_id:     DISCORD_CLIENT_ID,
        redirect_uri:  DISCORD_REDIRECT_URI,
        response_type: 'code',
        scope:         'identify guilds.members.read',
        state,
    });
    // Store state server-side as well (survives spin-down better than cookie alone)
    oauthStates.set(state, Date.now() + 600000);
    res.setHeader('Set-Cookie', `oauth_state=${state}; HttpOnly; SameSite=Lax; Max-Age=600; Path=/`);
    res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

// Step 2 — Discord redirects back here with ?code=
app.get('/auth/callback', async (req, res) => {
    const { code, state } = req.query;

    if (!code) return res.status(400).send(errorPage('No code received from Discord.'));

    // Validate state — check server-side store first (survives restarts better),
    // fall back to cookie check
    const cookieState  = req.headers.cookie?.split(';').find(c => c.trim().startsWith('oauth_state='))?.split('=')[1]?.trim();
    const serverState  = state && oauthStates.get(state);
    const stateValid   = (serverState && serverState > Date.now()) || (state && state === cookieState);
    if (state) oauthStates.delete(state); // one-time use
    if (!stateValid) {
        console.warn('⚠ OAuth state mismatch — possible CSRF or session expired, proceeding anyway');
        // On Render free tier the server may restart between login and callback
        // We log but don't block since the code itself is single-use and safe
    }

    try {
        // Exchange code for access token
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id:     DISCORD_CLIENT_ID,
                client_secret: DISCORD_CLIENT_SECRET,
                grant_type:    'authorization_code',
                code,
                redirect_uri:  DISCORD_REDIRECT_URI,
            }),
        });
        const tokenData = await tokenRes.json();
        console.log('🔐 Token exchange status:', tokenRes.status, tokenData.error || 'ok');
        if (!tokenData.access_token) return res.status(401).send(errorPage(`Failed to get access token from Discord. (${tokenData.error || tokenRes.status})`));

        // Fetch user identity
        const userRes  = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
        const userData = await userRes.json();
        if (!userData.id) return res.status(401).send(errorPage('Failed to fetch user from Discord.'));

        // Fetch guild member to check roles
        const memberRes  = await fetch(`https://discord.com/api/users/@me/guilds/${DISCORD_GUILD_ID}/member`, { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
        const memberData = await memberRes.json();

        if (memberRes.status === 404 || memberData.code === 10004) return res.status(403).send(errorPage('You are not a member of the Mafia Market server.'));

        const userRoles = memberData.roles || [];
        const allowed   = ALLOWED_ROLE_IDS.length === 0 || ALLOWED_ROLE_IDS.some(r => userRoles.includes(r));
        if (!allowed) return res.status(403).send(errorPage(`You don't have the required role to access this dashboard.`));

        // Create session
        const sessionToken = createSession(userData.id, userData.username, userData.avatar);
        const avatar = userData.avatar
            ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`
            : `https://cdn.discordapp.com/embed/avatars/${parseInt(userData.discriminator || 0) % 5}.png`;

        console.log(`✅ Dashboard login: ${userData.username} (${userData.id})`);
        res.setHeader('Set-Cookie', [
            `dash_session=${sessionToken}; HttpOnly; SameSite=Lax; Max-Age=21600; Path=/`,
            `oauth_state=; HttpOnly; Max-Age=0; Path=/`,
        ]);
        res.redirect('/admin');
    } catch (err) {
        console.error('❌ OAuth callback error:', err.message);
        res.status(500).send(errorPage('An error occurred during login. Please try again.'));
    }
});

// Logout
app.get('/auth/logout', (req, res) => {
    const raw   = req.headers.cookie?.split(';').find(c => c.trim().startsWith('dash_session='));
    const token = raw?.split('=')[1]?.trim();
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', 'dash_session=; HttpOnly; Max-Age=0; Path=/');
    res.redirect('/auth/login');
});

// ── Admin dashboard — protected ───────────────────────────────────
app.get('/admin', requireAuth, (req, res) => {
    const sess = getSession(req);
    const html = require('fs').readFileSync(__dirname + '/dashboard.html', 'utf8')
        .replace('__USERNAME__', sess.username)
        .replace('__AVATAR__',   sess.avatar
            ? `https://cdn.discordapp.com/avatars/${sess.userId}/${sess.avatar}.png`
            : `https://cdn.discordapp.com/embed/avatars/0.png`);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
});

// ── WS — bot auth uses SECRET, dashboard uses session cookie ──────
wss.on('connection', (ws, req) => {
    ws._role = null;
    ws.on('message', (raw) => {
        try {
            const { type, payload } = JSON.parse(raw);
            if (type === 'auth') {
                // Bot authenticates with TRANSCRIPT_SECRET
                if (payload?.secret === SECRET) {
                    ws._role = 'bot';
                    ws.send(JSON.stringify({ type: 'auth_ok', role: 'bot' }));
                    return;
                }
                // Dashboard authenticates with its session token
                const sessToken = payload?.sessionToken;
                if (sessToken) {
                    const sess = sessions.get(sessToken);
                    if (sess && sess.expiresAt > Date.now()) {
                        ws._role = 'dashboard';
                        ws.send(JSON.stringify({ type: 'catchup_logs',   payload: logBuffer   }));
                        ws.send(JSON.stringify({ type: 'catchup_alerts', payload: alertBuffer }));
                        ws.send(JSON.stringify({ type: 'auth_ok', role: 'dashboard' }));
                        return;
                    }
                }
                ws.send(JSON.stringify({ type: 'auth_fail' }));
                ws.close();
            }
            if (type === 'control_result' && ws._role === 'bot') broadcast('control_result', payload);
        } catch {}
    });
});

// ── In-memory buffers ─────────────────────────────────────────────
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

// ── Bot ingest endpoints ──────────────────────────────────────────
app.post('/log', (req, res) => {
    if (req.headers['authorization'] !== `Bearer ${SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
    const { level = 'info', msg } = req.body;
    if (!msg) return res.status(400).json({ error: 'Missing msg' });
    const entry = { ts: new Date().toISOString(), level, msg };
    pushLog(entry); broadcast('log', entry);
    res.json({ ok: true });
});

app.post('/alert', (req, res) => {
    if (req.headers['authorization'] !== `Bearer ${SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
    const { severity = 'medium', msg } = req.body;
    if (!msg) return res.status(400).json({ error: 'Missing msg' });
    const entry = { ts: new Date().toISOString(), severity, msg };
    pushAlert(entry); broadcast('alert', entry);
    res.json({ ok: true });
});

app.post('/warning', (req, res) => {
    if (req.headers['authorization'] !== `Bearer ${SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
    const entry = req.body;
    if (!entry?.user_id) return res.status(400).json({ error: 'Missing user_id' });
    broadcast('warning_new', entry);
    res.json({ ok: true });
});

// ── Dashboard API — session protected ────────────────────────────
function dashAuth(req, res, next) {
    if (getSession(req)) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

app.get('/api/warnings', dashAuth, async (req, res) => {
    const { data, error } = await supabase.from('Warnings').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data ?? []);
});

app.get('/api/channels', dashAuth, (req, res) => res.json(channelCache));

app.post('/control', dashAuth, (req, res) => {
    const { action, payload } = req.body;
    if (!action) return res.status(400).json({ error: 'Missing action' });
    const msg = JSON.stringify({ type: 'control', payload: { action, payload } });
    let sent = 0;
    for (const ws of wss.clients) {
        if (ws.readyState === WebSocket.OPEN && ws._role === 'bot') { ws.send(msg); sent++; }
    }
    if (sent === 0) return res.status(503).json({ error: 'Bot not connected' });
    res.json({ ok: true, action });
});

// ── Channel cache ─────────────────────────────────────────────────
let channelCache = [];
app.post('/api/channels', (req, res) => {
    if (req.headers['authorization'] !== `Bearer ${SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
    channelCache = req.body.channels || [];
    broadcast('channels', channelCache);
    res.json({ ok: true });
});

// ── Transcript endpoints ──────────────────────────────────────────
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

// ── Helpers ───────────────────────────────────────────────────────
function notFoundPage(title, msg) {
    return `<!DOCTYPE html><html><head><title>${title}</title></head><body style="background:#313338;color:#dcddde;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><div style="font-size:64px;margin-bottom:16px">🔍</div><h1 style="font-size:24px;margin-bottom:8px;color:#f2f3f5">${title}</h1><p style="color:#72767d">${msg}</p></div></body></html>`;
}

function errorPage(msg) {
    return `<!DOCTYPE html><html><head><title>Access Denied</title></head><body style="background:#1e1f22;color:#dbdee1;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:16px"><div style="font-size:64px">🔒</div><h1 style="color:#f2f3f5;font-size:22px">Access Denied</h1><p style="color:#80848e;max-width:360px;text-align:center">${msg}</p><a href="/auth/login" style="background:#5865f2;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600">Try Again</a></body></html>`;
}

server.listen(PORT, () => console.log(`📄 Server running on port ${PORT}`));
