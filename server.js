const https = require('https');
const http  = require('http');
const crypto = require('crypto');

const CLIENT_ID      = process.env.CLIENT_ID      || 'phzjmjiuw45a3z5dx56gaoo6ug4fsn';
const CLIENT_SECRET  = process.env.CLIENT_SECRET  || 'isz32c8saws75v4f29p7vk2i4p70vx';
const USER_TOKEN     = process.env.USER_TOKEN      || '';
const BROADCASTER_ID = '716266770';
const PORT           = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'asiandiva-secret-2024';

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function getAppToken() {
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
      res.on('end', () => { try { resolve(JSON.parse(data).access_token); } catch(e) { reject(e); } });
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function subscribe(token, clientId, type, condition, callbackUrl) {
  const body = JSON.stringify({
    type, version: '1', condition,
    transport: { method: 'webhook', callback: callbackUrl, secret: WEBHOOK_SECRET }
  });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.twitch.tv',
      path: '/helix/eventsub/subscriptions',
      method: 'POST',
      headers: {
        'Client-Id': clientId,
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        console.log('Subscribe', type, res.statusCode);
        resolve(res.statusCode);
      });
    });
    req.setTimeout(10000, () => { req.destroy(); console.log('Timeout:', type); resolve(0); });
    req.on('error', (e) => { console.log('Error:', type, e.message); resolve(0); });
    req.write(body);
    req.end();
  });
}

const clients = new Set();
let recentEvents = [];

function broadcast(event) {
  recentEvents.push(event);
  if(recentEvents.length > 50) recentEvents.shift();
  const data = 'data: ' + JSON.stringify(event) + '\n\n';
  clients.forEach(client => {
    try { client.write(data); } catch(e) { clients.delete(client); }
  });
  console.log('📡 Broadcast:', event.type, event.user);
}

function verifySignature(req, body) {
  const msgId     = req.headers['twitch-eventsub-message-id'] || '';
  const timestamp = req.headers['twitch-eventsub-message-timestamp'] || '';
  const signature = req.headers['twitch-eventsub-message-signature'] || '';
  const hmac = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET)
    .update(msgId + timestamp + body).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signature)); }
  catch(e) { return false; }
}

const server = http.createServer((req, res) => {
  setCORS(res);
  if(req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if(req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write('data: {"type":"connected"}\n\n');
    clients.add(res);
    recentEvents.forEach(e => res.write('data: ' + JSON.stringify(e) + '\n\n'));
    req.on('close', () => clients.delete(res));
    return;
  }

  if(req.url === '/health') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ status:'ok', clients: clients.size }));
    return;
  }

  if(req.url === '/webhook' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      if(!verifySignature(req, body)) { res.writeHead(403); res.end('Forbidden'); return; }
      const msg     = JSON.parse(body);
      const msgType = req.headers['twitch-eventsub-message-type'];

      if(msgType === 'webhook_callback_verification') {
        console.log('✅ Verified:', msg.subscription.type);
        res.writeHead(200, {'Content-Type':'text/plain'});
        res.end(msg.challenge);
        return;
      }

      if(msgType === 'notification') {
        const type = msg.subscription.type;
        const ev   = msg.event;
        if(type === 'channel.cheer')
          broadcast({ type:'bits', user: ev.user_name||'Anonymous', bits: ev.bits });
        if(type === 'extension.bits_transaction.create')
          broadcast({ type:'bits', user: ev.user_name||'Anonymous', bits: ev.bits_used, source:'blerp' });
        if(type === 'channel.subscribe' && !ev.is_gift)
          broadcast({ type:'sub', user: ev.user_name, tier: ev.tier });
        if(type === 'channel.subscription.message')
          broadcast({ type:'resub', user: ev.user_name, tier: ev.tier, months: ev.cumulative_months });
        if(type === 'channel.subscription.gift')
          broadcast({ type:'giftsub', user: ev.user_name||'Anonymous', tier: ev.tier, count: ev.total });
        res.writeHead(204); res.end();
        return;
      }
      res.writeHead(200); res.end();
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ── START SERVER FIRST then subscribe in background ───────────────
server.listen(PORT, () => {
  console.log('🚀 Server running on port', PORT);
  // Do subscriptions in background so server starts immediately
  setupSubscriptions();
});

async function deleteAllSubs(token, clientId) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.twitch.tv',
      path: '/helix/eventsub/subscriptions',
      method: 'GET',
      headers: { 'Client-Id': clientId, 'Authorization': 'Bearer ' + token }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', async () => {
        try {
          const json = JSON.parse(data);
          const subs = json.data || [];
          console.log('Deleting', subs.length, 'existing subscriptions');
          for(const s of subs) {
            await deleteSub(token, clientId, s.id);
          }
        } catch(e) {}
        resolve();
      });
    });
    req.setTimeout(10000, () => { req.destroy(); resolve(); });
    req.on('error', () => resolve());
    req.end();
  });
}

async function deleteSub(token, clientId, id) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.twitch.tv',
      path: '/helix/eventsub/subscriptions?id=' + id,
      method: 'DELETE',
      headers: { 'Client-Id': clientId, 'Authorization': 'Bearer ' + token }
    }, (res) => { res.on('data', ()=>{}); res.on('end', resolve); });
    req.setTimeout(5000, () => { req.destroy(); resolve(); });
    req.on('error', () => resolve());
    req.end();
  });
}

async function setupSubscriptions() {
  try {
    const callbackUrl = (process.env.RENDER_EXTERNAL_URL || 'https://asiandiva-bits-tracker.onrender.com') + '/webhook';
    console.log('📌 Callback URL:', callbackUrl);

    const appTok = await getAppToken();
    console.log('✅ App token obtained');

    // Clean up old subs first
    await deleteAllSubs(appTok, CLIENT_ID);

    // Extension bits with app token
    await subscribe(appTok, CLIENT_ID, 'extension.bits_transaction.create',
      { broadcaster_user_id: BROADCASTER_ID, extension_client_id: CLIENT_ID }, callbackUrl);

    // Channel events with app token (webhook requires app token)
    await subscribe(appTok, CLIENT_ID, 'channel.cheer',                { broadcaster_user_id: BROADCASTER_ID }, callbackUrl);
    await subscribe(appTok, CLIENT_ID, 'channel.subscribe',            { broadcaster_user_id: BROADCASTER_ID }, callbackUrl);
    await subscribe(appTok, CLIENT_ID, 'channel.subscription.message', { broadcaster_user_id: BROADCASTER_ID }, callbackUrl);
    await subscribe(appTok, CLIENT_ID, 'channel.subscription.gift',    { broadcaster_user_id: BROADCASTER_ID }, callbackUrl);
    console.log('✅ Channel subscriptions done');

    console.log('✅ All subscriptions done');
  } catch(e) {
    console.error('Subscription error:', e.message);
  }
}
