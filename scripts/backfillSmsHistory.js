require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NEXTSMS_TOKEN = process.env.NEXTSMS_API_TOKEN;
const BASE_URL = process.env.NEXTSMS_BASE_URL || 'https://messaging-service.co.tz';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const BATCHES_FILE = path.join(DATA_DIR, 'sms-batches.json');

function getAuthHeader() {
  return `Bearer ${NEXTSMS_TOKEN}`;
}

function parseNextSmsDate(dateStr) {
  if (!dateStr) return new Date();
  // NextSMS returns "YYYY-MM-DD HH:mm:ss" — convert to ISO-like so Date() parses it reliably
  const isoLike = dateStr.replace(' ', 'T');
  const parsed = new Date(isoLike);
  return isNaN(parsed.getTime()) ? new Date() : parsed;
}

async function fetchAllLogs() {
  const allLogs = [];
  let offset = 0;
  const limit = 200; // NextSMS appears to cap pages at 200 regardless of requested limit
  const MAX_PAGES = 50; // safety cap: up to 10,000 logs
  let page = 0;

  while (page < MAX_PAGES) {
    const url = `${BASE_URL}/api/v2/logs?limit=${limit}&offset=${offset}`;
    const res = await fetch(url, {
      headers: {
        Authorization: getAuthHeader(),
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      console.error(`Failed to fetch logs page ${page}: HTTP ${res.status}`);
      const body = await res.text().catch(() => '');
      console.error(body);
      break;
    }

    const data = await res.json();
    const results = data?.results || [];

    console.log(`Page ${page + 1}: fetched ${results.length} logs (offset ${offset})`);

    if (results.length === 0) {
      console.log('Reached end of logs (empty page).');
      break;
    }

    allLogs.push(...results);
    offset += results.length; // advance by actual count received, not assumed limit
    page++;

    // Small delay to be polite to the API
    await new Promise(r => setTimeout(r, 300));
  }

  if (page >= MAX_PAGES) {
    console.warn(`Warning: Hit MAX_PAGES safety cap (${MAX_PAGES}). There may be more logs not fetched.`);
  }

  return allLogs;
}

function groupLogsByBatch(logs) {
  // Group by: same sender + sent within 30 minutes of each other
  const sorted = [...logs].sort(
    (a, b) => parseNextSmsDate(a.sentAt) - parseNextSmsDate(b.sentAt)
  );

  const batches = [];
  let currentBatch = null;

  const messageText = '[Maudhui ya ujumbe hayapo kwenye historia ya NextSMS]';

  for (const log of sorted) {
    const sentAt = parseNextSmsDate(log.sentAt);
    const sender = log.from || 'UNKNOWN';

    const shouldStartNewBatch =
      !currentBatch ||
      currentBatch.senderId !== sender ||
      sentAt - new Date(currentBatch.lastSeenAt) > 30 * 60 * 1000;

    if (shouldStartNewBatch) {
      if (currentBatch) batches.push(currentBatch);
      currentBatch = {
        id: crypto.randomUUID(),
        createdAt: sentAt.toISOString(),
        lastSeenAt: sentAt.toISOString(),
        cardType: sender === 'MICHANGO' ? 'contribution' : 'invitation',
        senderId: sender,
        messageTemplate: messageText,
        recipients: [],
        imported: true, // marks this as a backfilled batch, not a live send
      };
    }

    const statusName = (log.status?.name || log.status?.groupName || log.delivery || '').toUpperCase();

    currentBatch.lastSeenAt = sentAt.toISOString();
    currentBatch.recipients.push({
      name: log.to || 'Unknown',
      phone: log.to || '',
      message: messageText,
      status: ['DELIVERED', 'SENT', 'ACCEPTED'].includes(statusName) ? 'sent' : 'failed',
      reason: log.status?.name || log.delivery || null,
      messageId: log.messageId || null,
      smsCount: log.smsCount || 1,
    });
  }

  if (currentBatch) batches.push(currentBatch);

  return batches.map((b) => ({
    ...b,
    totalContacts: b.recipients.length,
    sentCount: b.recipients.filter((r) => r.status === 'sent').length,
    failedCount: b.recipients.filter((r) => r.status === 'failed').length,
  }));
}

async function run() {
  if (!NEXTSMS_TOKEN) {
    console.error('NEXTSMS_API_TOKEN is not set in .env. Aborting.');
    process.exit(1);
  }

  console.log('Fetching SMS history from NextSMS...');
  const logs = await fetchAllLogs();
  console.log(`Total logs fetched: ${logs.length}`);

  if (logs.length === 0) {
    console.log('No logs found. Check your API token and account history.');
    return;
  }

  console.log('Grouping logs into batches...');
  const importedBatches = groupLogsByBatch(logs);
  console.log(`Grouped into ${importedBatches.length} batches`);

  let existing = { batches: [] };
  try {
    existing = JSON.parse(fs.readFileSync(BATCHES_FILE, 'utf8'));
  } catch {
    console.log('No existing sms-batches.json found, creating new one.');
  }

  const previousImportedCount = existing.batches.filter(b => b.imported).length;
  if (previousImportedCount > 0) {
    console.log(`Removing ${previousImportedCount} previously imported batch(es) before re-importing fresh data...`);
  }

  // Keep only batches that were NOT imported (live, real sends made through the app)
  const liveBatches = existing.batches.filter(b => !b.imported);
  existing.batches = [...importedBatches, ...liveBatches];
  existing.batches.sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );

  fs.writeFileSync(BATCHES_FILE, JSON.stringify(existing, null, 2));
  console.log(`Backfill complete. ${importedBatches.length} historical batches added.`);
  console.log(`Total batches now: ${existing.batches.length}`);
}

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
