const https = require('https');
const http  = require('http');
const crypto = require('crypto');

// ── CONFIG ────────────────────────────────────────────────────────
const CLIENT_ID     = process.env.CLIENT_ID     || 'phzjmjiuw45a3z5dx56gaoo6ug4fsn';
const CLIENT_SECRET = process.env.CLIENT_SECRET || 'isz32c8saws75v4f29p7vk2i4p70vx';
const BROADCASTER_ID = '716266770';
const PORT          = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'asiandiva-secret-2024';

// ── CORS HEADERS ──────────────────────────────────────────────────
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── GET APP ACCESS TOKEN ──────────────────────────────────────────
let appToken = null;
let tokenExpiry = 0;

async function getAppToken() {
  if(appToken && Date.now() < tokenExpiry) return appToken;
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'client_credentials'
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'id.twitch.tv',
      path: '/oauth2/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        const json = JSON.parse(data);
        appToken = json.access_token;
        tokenExpiry = Date.now() + (json.expires_in - 60) * 1000;
        resolve(appToken);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── SUBSCRIBE TO EVENTSUB ─────────────────────────────────────────
async function subscribe(token, type, condition, callbackUrl) {
  const body = JSON.stringify({
    type,
    version: '1',
    condition,
    transport: { method: 'webhook', callback: callbackUrl, secret: WEBHOOK_SECRET }
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.twitch.tv',
      path: '/helix/eventsub/subscriptions',
      method: 'POST',
      headers: {
        'Client-Id': CLIENT_ID,
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        console.log('Subscribe', type, res.statusCode, data.slice(0, 100));
        resolve(JSON.parse(data));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── STORE RECENT EVENTS FOR SSE ───────────────────────────────────
const clients = new Set();
let recentEvents = [];

function broadcast(event) {
  recentEvents.push(event);
  if(recentEvents.length > 50) recentEvents.shift();
  const data = 'data: ' + JSON.stringify(event) + '\n\n';
  clients.forEach(client => {
    try { client.write(data); } catch(e) { clients.delete(client); }
  });
  console.log('📡 Broadcast:', event.type, event.user, event.bits || event.tier || '');
}

// ── VERIFY TWITCH SIGNATURE ───────────────────────────────────────
function verifySignature(req, body) {
  const msgId        = req.headers['twitch-eventsub-message-id'] || '';
  const timestamp    = req.headers['twitch-eventsub-message-timestamp'] || '';
  const signature    = req.headers['twitch-eventsub-message-signature'] || '';
  const hmac = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET)
    .update(msgId + timestamp + body).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signature));
}

// ── HTTP SERVER ───────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  setCORS(res);

  if(req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // SSE endpoint - overlay connects here to receive events
  if(req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('data: {"type":"connected"}\n\n');
    clients.add(res);
    // send recent events on connect
    recentEvents.forEach(e => res.write('data: ' + JSON.stringify(e) + '\n\n'));
    req.on('close', () => clients.delete(res));
    return;
  }

  // Health check
  if(req.url === '/health') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ status:'ok', clients: clients.size, events: recentEvents.length }));
    return;
  }

  // EventSub webhook
  if(req.url === '/webhook' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      // verify signature
      if(!verifySignature(req, body)) {
        res.writeHead(403); res.end('Forbidden'); return;
      }

      const msg = JSON.parse(body);
      const msgType = req.headers['twitch-eventsub-message-type'];

      // Handle verification challenge
      if(msgType === 'webhook_callback_verification') {
        console.log('✅ Verified:', msg.subscription.type);
        res.writeHead(200, {'Content-Type':'text/plain'});
        res.end(msg.challenge);
        return;
      }

      // Handle notification
      if(msgType === 'notification') {
        const type = msg.subscription.type;
        const ev   = msg.event;

        if(type === 'channel.cheer') {
          broadcast({ type:'bits', user: ev.user_name||'Anonymous', bits: ev.bits });
        }
        if(type === 'extension.bits_transaction.create') {
          broadcast({ type:'bits', user: ev.user_name||'Anonymous', bits: ev.bits_used, source:'blerp' });
        }
        if(type === 'channel.subscribe' && !ev.is_gift) {
          broadcast({ type:'sub', user: ev.user_name, tier: ev.tier });
        }
        if(type === 'channel.subscription.message') {
          broadcast({ type:'resub', user: ev.user_name, tier: ev.tier, months: ev.cumulative_months });
        }
        if(type === 'channel.subscription.gift') {
          broadcast({ type:'giftsub', user: ev.user_name||'Anonymous', tier: ev.tier, count: ev.total });
        }

        res.writeHead(204); res.end();
        return;
      }

      res.writeHead(200); res.end();
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ── STARTUP ───────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log('🚀 Server running on port', PORT);
  const token = await getAppToken();
  console.log('✅ App token obtained');

  const callbackUrl = (process.env.RENDER_EXTERNAL_URL || 'https://asiandiva-bits-tracker.onrender.com') + '/webhook';
  console.log('📌 Callback URL:', callbackUrl);

  // Subscribe to all events
  const events = [
    ['channel.cheer',                    { broadcaster_user_id: BROADCASTER_ID }],
    ['extension.bits_transaction.create',{ broadcaster_user_id: BROADCASTER_ID, extension_client_id: CLIENT_ID }],
    ['channel.subscribe',                { broadcaster_user_id: BROADCASTER_ID }],
    ['channel.subscription.message',     { broadcaster_user_id: BROADCASTER_ID }],
    ['channel.subscription.gift',        { broadcaster_user_id: BROADCASTER_ID }],
  ];

  for(const [type, condition] of events) {
    try { await subscribe(token, type, condition, callbackUrl); }
    catch(e) { console.error('Failed to subscribe to', type, e.message); }
  }

  console.log('✅ All subscriptions registered');
});
