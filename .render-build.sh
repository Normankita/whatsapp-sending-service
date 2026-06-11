#!/usr/bin/env bash
set -e
npm install
npx puppeteer browsers install chrome
echo "Chrome installation complete"
