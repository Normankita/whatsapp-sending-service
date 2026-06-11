const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const KEYS_FILE = path.join(__dirname, '../keys.json');

function readKeys() {
  try {
    return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
  } catch {
    return { keys: [] };
  }
}

function writeKeys(data) {
  fs.writeFileSync(KEYS_FILE, JSON.stringify(data, null, 2));
}

function generateKey() {
  return 'wh_live_' + crypto.randomBytes(24).toString('hex');
}

function createKey(name) {
  const store = readKeys();
  const newKey = {
    id: crypto.randomUUID(),
    key: generateKey(),
    name: name || 'Unnamed App',
    createdAt: new Date().toISOString(),
    lastUsed: null,
    usageCount: 0,
    active: true,
  };
  store.keys.push(newKey);
  writeKeys(store);
  return newKey;
}

function validateKey(key) {
  const store = readKeys();
  const found = store.keys.find(k => k.key === key && k.active);
  if (found) {
    found.lastUsed = new Date().toISOString();
    found.usageCount++;
    writeKeys(store);
    return true;
  }
  return false;
}

function getAllKeys() {
  return readKeys().keys;
}

function revokeKey(id) {
  const store = readKeys();
  const key = store.keys.find(k => k.id === id);
  if (key) {
    key.active = false;
    writeKeys(store);
    return true;
  }
  return false;
}

function deleteKey(id) {
  const store = readKeys();
  store.keys = store.keys.filter(k => k.id !== id);
  writeKeys(store);
  return true;
}

module.exports = { createKey, validateKey, getAllKeys, revokeKey, deleteKey, generateKey };
