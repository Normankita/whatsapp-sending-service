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

module.exports = { createBatch, getAllBatches, getBatchById, updateBatchMessage, updateRecipientStatuses };
