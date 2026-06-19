const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const BATCHES_FILE = path.join(
  process.env.DATA_DIR || path.join(__dirname, '..'),
  'sms-batches.json'
);

function readBatches() {
  try {
    return JSON.parse(fs.readFileSync(BATCHES_FILE, 'utf8'));
  } catch {
    return { batches: [] };
  }
}

function writeBatches(data) {
  fs.writeFileSync(BATCHES_FILE, JSON.stringify(data, null, 2));
}

function createBatch({ message, recipients }) {
  const store = readBatches();
  const batch = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    message,
    recipients: recipients.map(r => ({
      name: r.name,
      phone: r.phone,
      status: r.status || 'pending',
      reason: r.reason || null,
    })),
  };
  store.batches.push(batch);
  writeBatches(store);
  return batch;
}

function getAllBatches() {
  return readBatches().batches.map(b => ({
    id: b.id,
    createdAt: b.createdAt,
    message: b.message,
    total: b.recipients.length,
    sent: b.recipients.filter(r => r.status === 'sent').length,
    failed: b.recipients.filter(r => r.status === 'failed').length,
    pending: b.recipients.filter(r => r.status === 'pending').length,
  }));
}

function getBatchById(id) {
  const store = readBatches();
  return store.batches.find(b => b.id === id) || null;
}

function updateBatchMessage(id, message) {
  const store = readBatches();
  const batch = store.batches.find(b => b.id === id);
  if (!batch) return null;
  batch.message = message;
  writeBatches(store);
  return batch;
}

// updates: [{ phone, status, reason? }]
function updateRecipientStatuses(id, updates) {
  const store = readBatches();
  const batch = store.batches.find(b => b.id === id);
  if (!batch) return null;
  for (const update of updates) {
    const recipient = batch.recipients.find(r => r.phone === update.phone);
    if (recipient) {
      recipient.status = update.status;
      if (update.reason !== undefined) recipient.reason = update.reason;
    }
  }
  writeBatches(store);
  return batch;
}

function getNeverDeliveredRecipients() {
  const { batches } = readBatches();

  // phone -> { everSucceeded, attempts: [], names: Set }
  const phoneMap = new Map();

  for (const batch of batches) {
    for (const recipient of batch.recipients || []) {
      const phone = recipient.phone;
      if (!phone) continue;

      if (!phoneMap.has(phone)) {
        phoneMap.set(phone, {
          everSucceeded: false,
          attempts: [],
          names: new Set(),
        });
      }

      const entry = phoneMap.get(phone);

      if (recipient.status === 'sent') {
        entry.everSucceeded = true;
      }

      // Only track a name if it's not just the phone number repeated
      // (common in imported batches where NextSMS gave us no real name)
      if (recipient.name && recipient.name !== phone) {
        entry.names.add(recipient.name);
      }

      entry.attempts.push({
        batchId: batch.id,
        batchCreatedAt: batch.createdAt,
        cardType: batch.cardType,
        status: recipient.status,
        reason: recipient.reason || null,
      });
    }
  }

  const neverDelivered = [];
  const totalUniquePhonesSeen = phoneMap.size;

  for (const [phone, entry] of phoneMap.entries()) {
    if (entry.everSucceeded) continue;

    const sortedAttempts = [...entry.attempts].sort(
      (a, b) => new Date(b.batchCreatedAt) - new Date(a.batchCreatedAt)
    );

    const bestName = entry.names.size > 0 ? [...entry.names][0] : phone;

    neverDelivered.push({
      phone,
      name: bestName,
      attemptCount: sortedAttempts.length,
      lastAttemptAt: sortedAttempts[0]?.batchCreatedAt || null,
      lastReason: sortedAttempts[0]?.reason || null,
      batches: sortedAttempts,
    });
  }

  neverDelivered.sort(
    (a, b) => new Date(b.lastAttemptAt) - new Date(a.lastAttemptAt)
  );

  return {
    neverDelivered,
    totalNeverDelivered: neverDelivered.length,
    totalUniquePhonesSeen,
  };
}

module.exports = { createBatch, getAllBatches, getBatchById, updateBatchMessage, updateRecipientStatuses, getNeverDeliveredRecipients };
