#!/usr/bin/env bash
set -o errexit

npm install

echo "Installing system Chrome..."
wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
apt-get install -y /tmp/chrome.deb 2>/dev/null || dpkg -i /tmp/chrome.deb 2>/dev/null || true
apt-get install -f -y 2>/dev/null || true

echo "Chrome location:"
which google-chrome-stable 2>/dev/null || \
which google-chrome 2>/dev/null || \
ls /usr/bin/google-chrome* 2>/dev/null || \
echo "Chrome not found in PATH"