#!/usr/bin/env bash
set -o errexit

npm install

echo "Downloading Chrome binary directly..."
mkdir -p /opt/render/chrome

# Download Chrome for Linux
wget -q "https://storage.googleapis.com/chrome-for-testing-public/120.0.6099.109/linux64/chrome-linux64.zip" \
  -O /tmp/chrome.zip

echo "Extracting Chrome..."
unzip -q /tmp/chrome.zip -d /opt/render/chrome/
chmod +x /opt/render/chrome/chrome-linux64/chrome

echo "Verifying Chrome..."
/opt/render/chrome/chrome-linux64/chrome --version 2>/dev/null || echo "Version check failed"
ls -la /opt/render/chrome/chrome-linux64/chrome