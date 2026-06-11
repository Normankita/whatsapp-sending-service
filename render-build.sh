#!/usr/bin/env bash
set -o errexit

npm install

export PUPPETEER_CACHE_DIR=/opt/render/.cache/puppeteer
mkdir -p $PUPPETEER_CACHE_DIR

echo "Installing Chrome..."
npx puppeteer browsers install chrome

echo "Finding Chrome executable..."
find /opt/render/.cache/puppeteer -name "chrome" -type f 2>/dev/null
find /opt/render/.cache/puppeteer -name "chrome-linux64" -type d 2>/dev/null

echo "Cache contents:"
ls -la /opt/render/.cache/puppeteer/ 2>/dev/null || echo "Cache dir empty"
ls -la /opt/render/.cache/puppeteer/chrome/ 2>/dev/null || echo "Chrome dir empty"