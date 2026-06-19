require('dotenv').config();
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { createKey, validateKey, getAllKeys, revokeKey, deleteKey } = require('./lib/keyStore');
const { createBatch, getAllBatches, getBatchById, updateBatchMessage, updateRecipientStatuses, getNeverDeliveredRecipients, getAllKnownPhones, getStatusForPhones } = require('./lib/smsBatchStore');

// ─── CHROME PATH RESOLVER ─────────────────────────────────────────────────────

function getChromePath() {
  const { existsSync } = require('fs');

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    if (existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
      console.log(`[Chrome] Using env path: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
      return process.env.PUPPETEER_EXECUTABLE_PATH;
    } else {
      console.log(`[Chrome] Env path not found: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
    }
  }

  const systemPaths = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/snap/bin/chromium',
  ];
  for (const p of systemPaths) {
    if (existsSync(p)) {
      console.log(`[Chrome] Found system browser at: ${p}`);
      return p;
    }
  }

  try {
    const puppeteer = require('puppeteer');
    const p = puppeteer.executablePath();
    if (p && existsSync(p)) {
      console.log(`[Chrome] Using puppeteer bundled: ${p}`);
      return p;
    }
  } catch (e) {
    console.log(`[Chrome] puppeteer not available: ${e.message}`);
  }

  console.log('[Chrome] No browser found — will likely fail');
  return undefined;
}

const CHROME_PATH = getChromePath();

const app = express();
const PORT = process.env.PORT || 3001;

// ─── CORS ────────────────────────────────────────────────────────────────────

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: [
    'Content-Type',
    'x-api-key',
    'x-admin-password',
  ],
}));

app.use(express.json({ limit: '50mb' }));

// ─── WHATSAPP STATE ───────────────────────────────────────────────────────────

let currentQr = null;
let clientReady = false;
let connectedPhone = null;
let client = null;

// ─── PROGRESS TRACKING ───────────────────────────────────────────────────────

// Map<sessionId, { total, sent, failed, progress, currentContact, done, errors, doneAt }>
const sessions = new Map();

// Clean up sessions older than 30 minutes every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, s] of sessions) {
    if (s.done && s.doneAt && s.doneAt < cutoff) {
      sessions.delete(id);
      log(`Session ${id} cleaned up from memory`);
    }
  }
}, 10 * 60 * 1000);

// ─── LOGGING ─────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ─── WHATSAPP CLIENT FACTORY ──────────────────────────────────────────────────

function createClient() {
  const wClient = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      executablePath: CHROME_PATH,
      protocolTimeout: 60000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--mute-audio',
        '--safebrowsing-disable-auto-update',
        '--ignore-certificate-errors',
        '--ignore-ssl-errors',
      ],
    },
  });

  wClient.on('qr', async (qr) => {
    log('WhatsApp QR generated');
    try {
      currentQr = await qrcode.toDataURL(qr);
    } catch (err) {
      log(`QR generation error: ${err.message}`);
    }
    clientReady = false;
  });

  wClient.on('ready', () => {
    const info = wClient.info;
    connectedPhone = info?.wid?.user || null;
    clientReady = true;
    currentQr = null;
    log(`WhatsApp connected — phone: ${connectedPhone}`);
  });

  wClient.on('auth_failure', (msg) => {
    console.error('Auth failure:', msg);
    clientReady = false;
    currentQr = null;
  });

  wClient.on('disconnected', (reason) => {
    log(`WhatsApp disconnected: ${reason}`);
    clientReady = false;
    connectedPhone = null;
    currentQr = null;
    console.log('════════════════════════════════');
    console.log('ACTION NEEDED: Open /admin and');
    console.log('scan QR code to reconnect.');
    console.log('════════════════════════════════');
    setTimeout(() => {
      try { client.initialize(); } catch (e) {}
    }, 5000);
  });

  return wClient;
}

client = createClient();
client.initialize();

setInterval(async () => {
  if (clientReady) {
    try {
      await client.getState();
      console.log(`[${new Date().toISOString()}] Session keepalive OK`);
    } catch (err) {
      console.log(`[${new Date().toISOString()}] Session stale, reinitializing...`);
      clientReady = false;
      try { await client.destroy(); } catch (_) {}
      setTimeout(() => client.initialize(), 3000);
    }
  }
}, 30 * 60 * 1000);

// ─── PHONE NUMBER FORMATTER ───────────────────────────────────────────────────

function formatPhone(raw) {
  const digits = raw.replace(/\D/g, '');
  let international;
  if (digits.startsWith('255')) {
    international = digits;
  } else if (digits.startsWith('0') && digits.length === 10) {
    international = `255${digits.slice(1)}`;
  } else if (digits.length === 9) {
    international = `255${digits}`;
  } else {
    international = digits;
  }
  return { chatId: `${international}@c.us`, international };
}

// ─── MESSAGE BUILDER ──────────────────────────────────────────────────────────

function buildMessage(name, info) {
  return (
    `Ndugu *${name}*,\n\n` +
    `${info.family} wanakualika wewe mpendwa wetu kwenye ` +
    `sherehe ya ndoa ya *${info.groomName} & ${info.brideName}*.\n\n` +
    `📅 *${info.weddingDate}*\n` +
    `📍 *${info.venue}*\n\n` +
    `Tafadhali angalia kadi iliyoambatishwa hapo juu.\n\n` +
    `_Karibuni sana!_ 🌸`
  );
}

// ─── RANDOM DELAY ─────────────────────────────────────────────────────────────

function delay(min = 3500, max = 5500) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── SEND WITH RETRY ──────────────────────────────────────────────────────────

async function sendWithRetry(chatId, content, options = {}, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await client.sendMessage(chatId, content, options);
      return true;
    } catch (err) {
      const isDetached =
        err.message?.includes('detached Frame') ||
        err.message?.includes('Execution context') ||
        err.message?.includes('Target closed');
      if (isDetached && attempt < retries) {
        log(`Detached frame error, retrying in 2s...`);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      throw err;
    }
  }
}

// ─── BULK SEND LOGIC (IMAGES / WEDDING CARDS) ────────────────────────────────

async function sendCards(sessionId, contacts, cardImageBase64, weddingInfo) {
  const session = sessions.get(sessionId);
  log(`Bulk send started — sessionId: ${sessionId}, total: ${contacts.length}`);

  for (let i = 0; i < contacts.length; i++) {
    // Abort cleanly if WhatsApp disconnects mid-send
    if (!clientReady) {
      const remaining = contacts.slice(i);
      for (const c of remaining) {
        session.errors.push({ name: c.name, phone: c.phone, reason: 'WhatsApp disconnected' });
        session.failed++;
      }
      session.progress = contacts.length;
      session.done = true;
      session.doneAt = Date.now();
      log(`Bulk send aborted mid-way — WhatsApp disconnected (sessionId: ${sessionId})`);
      return;
    }

    const contact = contacts[i];
    session.progress = i;
    session.currentContact = contact.name;

    const { chatId } = formatPhone(contact.phone);
    const message = buildMessage(contact.name, weddingInfo);
    const activeImage = contact.cardImageBase64 || cardImageBase64;

    if (!activeImage) {
      session.errors.push({ name: contact.name, phone: contact.phone, reason: 'Picha ya kadi haikupatikana' });
      session.failed++;
      log(`FAIL ${contact.name} (${contact.phone}) — Picha ya kadi haikupatikana`);
      continue;
    }

    const media = new MessageMedia(
      'image/png',
      activeImage.replace(/^data:image\/png;base64,/, ''),
      'kadi-ya-harusi.png'
    );

    try {
      const isRegistered = await client.isRegisteredUser(chatId);
      if (!isRegistered) {
        session.errors.push({ name: contact.name, phone: contact.phone, reason: 'Hana WhatsApp' });
        session.failed++;
        log(`SKIP ${contact.name} (${contact.phone}) — Hana WhatsApp`);
      } else {
        await sendWithRetry(chatId, media, { caption: message });
        session.sent++;
        log(`SENT ${contact.name} (${contact.phone})`);
      }
    } catch (err) {
      session.errors.push({ name: contact.name, phone: contact.phone, reason: err.message });
      session.failed++;
      log(`FAIL ${contact.name} (${contact.phone}) — ${err.message}`);
    }

    // Protective delay — keeps WhatsApp number safe; do not remove
    if (i < contacts.length - 1) {
      await delay(5000, 7000);
    }
  }

  session.progress = contacts.length;
  session.currentContact = null;
  session.done = true;
  session.doneAt = Date.now();
  log(`Bulk send complete — sent: ${session.sent}, failed: ${session.failed} (sessionId: ${sessionId})`);
}

// ─── BULK SEND LOGIC (TEXT) ───────────────────────────────────────────────────

async function sendBulkText(sessionId, contacts, messageTemplate) {
  const session = sessions.get(sessionId);
  log(`Bulk text send started — sessionId: ${sessionId}, total: ${contacts.length}`);

  for (let i = 0; i < contacts.length; i++) {
    if (!clientReady) {
      const remaining = contacts.slice(i);
      for (const c of remaining) {
        session.errors.push({ name: c.name, phone: c.phone, reason: 'WhatsApp disconnected' });
        session.failed++;
      }
      session.progress = contacts.length;
      session.done = true;
      session.doneAt = Date.now();
      log(`Bulk text send aborted — WhatsApp disconnected (sessionId: ${sessionId})`);
      return;
    }

    const contact = contacts[i];
    session.progress = i;
    session.currentContact = contact.name;

    const { chatId } = formatPhone(contact.phone);
    const message = messageTemplate.replace(/\{\{name\}\}/g, contact.name);

    try {
      const isRegistered = await client.isRegisteredUser(chatId);
      if (!isRegistered) {
        session.errors.push({ name: contact.name, phone: contact.phone, reason: 'Not on WhatsApp' });
        session.failed++;
        log(`SKIP ${contact.name} (${contact.phone}) — Not on WhatsApp`);
      } else {
        await sendWithRetry(chatId, message);
        session.sent++;
        log(`SENT ${contact.name} (${contact.phone})`);
      }
    } catch (err) {
      session.errors.push({ name: contact.name, phone: contact.phone, reason: err.message });
      session.failed++;
      log(`FAIL ${contact.name} (${contact.phone}) — ${err.message}`);
    }

    // Protective delay — keeps WhatsApp number safe; do not remove
    if (i < contacts.length - 1) {
      await delay(5000, 7000);
    }
  }

  session.progress = contacts.length;
  session.currentContact = null;
  session.done = true;
  session.doneAt = Date.now();
  log(`Bulk text send complete — sent: ${session.sent}, failed: ${session.failed} (sessionId: ${sessionId})`);
}

// ─── FIRST-RUN KEY SEED ───────────────────────────────────────────────────────

if (getAllKeys().length === 0) {
  const seedKey = createKey('Default (Auto-generated)');
  console.log('═══════════════════════════════════');
  console.log('  FIRST RUN — API KEY GENERATED');
  console.log('  Save this key — shown only once:');
  console.log(`  ${seedKey.key}`);
  console.log('  Access admin panel at: /admin');
  console.log('═══════════════════════════════════');
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────

const apiKeyAuth = (req, res, next) => {
  const key = req.headers['x-api-key'];
  if (!key) {
    return res.status(401).json({ success: false, error: 'Unauthorized - invalid or missing API key' });
  }
  // Check keys.json; fall back to .env master key for backward compatibility
  if (validateKey(key) || (process.env.WHATSAPP_API_KEY && key === process.env.WHATSAPP_API_KEY)) {
    return next();
  }
  return res.status(401).json({ success: false, error: 'Unauthorized - invalid or missing API key' });
};

const adminAuth = (req, res, next) => {
  const password = req.headers['x-admin-password'] ||
    req.headers.authorization?.replace('Bearer ', '');
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Admin access denied' });
  }
  next();
};

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Public routes — no auth required
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    whatsapp: clientReady,
    timestamp: new Date().toISOString(),
  });
});

app.get('/status', (_req, res) => {
  res.json({
    connected: clientReady,
    qr: currentQr || null,
    phone: connectedPhone || null,
  });
});

// ─── ADMIN UI & API ───────────────────────────────────────────────────────────

// Serve admin UI — auth is handled client-side via password gate
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'admin/index.html'));
});

app.use('/admin/assets', express.static(path.join(__dirname, 'admin/assets')));

app.get('/admin/keys', adminAuth, (_req, res) => {
  const keys = getAllKeys().map(k => ({
    ...k,
    key: `wh_live_...${k.key.slice(-8)}`,
  }));
  res.json({ keys });
});

app.post('/admin/keys', adminAuth, (req, res) => {
  const { name } = req.body;
  const newKey = createKey(name);
  res.json({ success: true, key: newKey }); // full key — only time it's shown
});

app.delete('/admin/keys/:id', adminAuth, (req, res) => {
  const success = revokeKey(req.params.id);
  if (!success) return res.status(404).json({ success: false, error: 'Key not found' });
  res.json({ success: true });
});

app.delete('/admin/keys/:id/permanent', adminAuth, (req, res) => {
  deleteKey(req.params.id);
  res.json({ success: true });
});

app.get('/admin/status', adminAuth, (_req, res) => {
  const keys = getAllKeys();
  res.json({
    whatsapp: { connected: clientReady, qr: !!currentQr },
    keys: { total: keys.length, active: keys.filter(k => k.active).length },
    uptime: process.uptime(),
  });
});

// All message routes below require a valid x-api-key header
app.use(apiKeyAuth);

// ─── SINGLE MESSAGE ROUTES ────────────────────────────────────────────────────

app.post('/message/text', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) {
    return res.status(400).json({ success: false, error: 'to and message are required' });
  }
  if (!clientReady) {
    return res.status(503).json({ success: false, error: 'WhatsApp is not connected. Scan the QR code first.' });
  }
  const { chatId, international } = formatPhone(to);
  try {
    const isRegistered = await client.isRegisteredUser(chatId);
    if (!isRegistered) {
      return res.status(422).json({ success: false, error: `${international} is not on WhatsApp` });
    }
    await sendWithRetry(chatId, message);
    res.json({ success: true, to: international, message });
  } catch (err) {
    log(`/message/text error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/message/image', async (req, res) => {
  const { to, imageBase64, caption = '', filename = 'image.png' } = req.body;
  if (!to || !imageBase64) {
    return res.status(400).json({ success: false, error: 'to and imageBase64 are required' });
  }
  if (!clientReady) {
    return res.status(503).json({ success: false, error: 'WhatsApp is not connected. Scan the QR code first.' });
  }
  const { chatId, international } = formatPhone(to);
  const mimeType = imageBase64.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png';
  const base64Data = imageBase64.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
  const media = new MessageMedia(mimeType, base64Data, filename);
  try {
    const isRegistered = await client.isRegisteredUser(chatId);
    if (!isRegistered) {
      return res.status(422).json({ success: false, error: `${international} is not on WhatsApp` });
    }
    await sendWithRetry(chatId, media, { caption });
    res.json({ success: true, to: international });
  } catch (err) {
    log(`/message/image error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── BULK MESSAGE ROUTES ──────────────────────────────────────────────────────

app.post('/message/bulk-text', (req, res) => {
  const { contacts, message, sessionId } = req.body;
  if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ success: false, error: 'contacts array is required and must not be empty' });
  }
  if (!message) {
    return res.status(400).json({ success: false, error: 'message is required' });
  }
  if (!sessionId) {
    return res.status(400).json({ success: false, error: 'sessionId is required' });
  }
  if (!clientReady) {
    return res.status(503).json({ success: false, error: 'WhatsApp is not connected. Scan the QR code first.' });
  }

  sessions.set(sessionId, {
    total: contacts.length,
    sent: 0,
    failed: 0,
    progress: 0,
    currentContact: null,
    done: false,
    doneAt: null,
    errors: [],
  });

  sendBulkText(sessionId, contacts, message).catch((err) => {
    log(`Unhandled error in sendBulkText (sessionId: ${sessionId}): ${err.message}`);
    const s = sessions.get(sessionId);
    if (s && !s.done) {
      s.done = true;
      s.doneAt = Date.now();
    }
  });

  res.json({ success: true, sessionId, total: contacts.length });
});

function handleSendBulk(req, res) {
  const { contacts, cardImageBase64, weddingInfo, sessionId } = req.body;

  if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ success: false, error: 'contacts array is required and must not be empty' });
  }

  const hasRootImage = !!cardImageBase64;
  const allContactsHaveImages = contacts.every(c => !!c.cardImageBase64);
  if (!hasRootImage && !allContactsHaveImages) {
    return res.status(400).json({ success: false, error: 'cardImageBase64 is required (either at root or inside each contact)' });
  }
  if (!weddingInfo || !weddingInfo.family || !weddingInfo.groomName || !weddingInfo.brideName || !weddingInfo.weddingDate || !weddingInfo.venue) {
    return res.status(400).json({ success: false, error: 'weddingInfo with family, groomName, brideName, weddingDate, venue is required' });
  }
  if (!sessionId) {
    return res.status(400).json({ success: false, error: 'sessionId is required' });
  }
  if (!clientReady) {
    return res.status(503).json({ success: false, error: 'WhatsApp is not connected. Scan the QR code first.' });
  }

  sessions.set(sessionId, {
    total: contacts.length,
    sent: 0,
    failed: 0,
    progress: 0,
    currentContact: null,
    done: false,
    doneAt: null,
    errors: [],
  });

  // Fire-and-forget — respond immediately
  sendCards(sessionId, contacts, cardImageBase64, weddingInfo).catch((err) => {
    log(`Unhandled error in sendCards (sessionId: ${sessionId}): ${err.message}`);
    const s = sessions.get(sessionId);
    if (s && !s.done) {
      s.done = true;
      s.doneAt = Date.now();
    }
  });

  res.json({ success: true, sessionId, total: contacts.length });
}

app.post('/send-bulk', handleSendBulk);
app.post('/message/bulk-image', handleSendBulk);

app.get('/progress/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json({
    total: session.total,
    sent: session.sent,
    failed: session.failed,
    progress: session.progress,
    currentContact: session.currentContact,
    done: session.done,
    errors: session.errors,
  });
});

// ─── SMS BATCH ROUTES ─────────────────────────────────────────────────────────

app.get('/sms/batches', (_req, res) => {
  const batches = getAllBatches().map(({ id }) => {
    const b = getBatchById(id);
    const recipients = b.recipients || [];
    return {
      id: b.id,
      createdAt: b.createdAt,
      cardType: b.cardType || null,
      senderId: b.senderId || null,
      totalContacts: b.totalContacts ?? recipients.length,
      sentCount: b.sentCount ?? recipients.filter(r => r.status === 'sent').length,
      failedCount: b.failedCount ?? recipients.filter(r => r.status === 'failed').length,
      imported: b.imported || false,
    };
  });
  res.json({ batches });
});

app.get('/sms/batches/:id', (req, res) => {
  const batch = getBatchById(req.params.id);
  if (!batch) return res.status(404).json({ success: false, error: 'Batch not found' });
  res.json(batch);
});

app.patch('/sms/batches/:id/message', (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ success: false, error: 'message is required' });
  const batch = updateBatchMessage(req.params.id, message);
  if (!batch) return res.status(404).json({ success: false, error: 'Batch not found' });
  res.json({ success: true, batch });
});

app.get('/sms/recipients/never-delivered', (_req, res) => {
  const result = getNeverDeliveredRecipients();
  res.json(result);
});

app.get('/sms/recipients/known-phones', (_req, res) => {
  const phones = getAllKnownPhones();
  res.json({ phones, total: phones.length });
});

app.post('/sms/recipients/status-lookup', (req, res) => {
  const { phones } = req.body;
  if (!phones || !Array.isArray(phones)) {
    return res.status(400).json({ error: 'phones array is required' });
  }
  const results = getStatusForPhones(phones);
  res.json({ results });
});

app.post('/sms/batches', (req, res) => {
  const { message, recipients } = req.body;
  if (!message) return res.status(400).json({ success: false, error: 'message is required' });
  if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ success: false, error: 'recipients array is required and must not be empty' });
  }
  const batch = createBatch({ message, recipients });
  res.status(201).json({ success: true, batch });
});

// ─── START ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  log(`Server started on port ${PORT}`);
});
