# WhatsApp Messaging Microservice

A standalone Node.js / Express service that sends WhatsApp messages via [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js). Any app (Next.js, PHP, Python, etc.) can send text messages or images by making authenticated HTTP requests.

## Requirements

- Node.js 18+
- Google Chrome or Chromium installed (used by Puppeteer)

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Create your .env file
cp .env.example .env
# Edit .env: set WHATSAPP_API_KEY and ALLOWED_ORIGINS

# 3. Start the server
node index.js          # production
npm run dev            # development (auto-restart on file change)
```

## Connecting WhatsApp

When the server starts it exposes the QR code via `GET /status` (`qr` field is a base64 PNG data URL). Display it in a browser and scan with WhatsApp → Linked Devices → Link a Device.

Once connected:
```
WhatsApp connected — phone: 255XXXXXXXXX
```

Session credentials are saved in `.wwebjs_auth/` — you won't need to scan again unless you log out or delete that folder.

---

## Authentication

All routes **except** `/health` and `/status` require an `x-api-key` header:

```
x-api-key: your_secret_key_here
```

Set the key in `.env`:
```
WHATSAPP_API_KEY=your_secret_key_here
```

Requests without a valid key receive `401 Unauthorized`.

---

## Phone Number Formats Accepted

| Input | Becomes |
|-------|---------|
| `0712345678` (10 digits, starts with 0) | `255712345678` |
| `255712345678` | `255712345678` |
| `712345678` (9 digits) | `255712345678` |

---

## API Reference

### `GET /health`
No auth required.
```json
{ "status": "ok", "uptime": 42.1 }
```

### `GET /status`
No auth required. Returns current WhatsApp session state.
```json
{
  "connected": true,
  "qr": null,
  "phone": "255712345678"
}
```
`qr` is a `data:image/png;base64,...` string while waiting to scan; `null` after connection.

---

### `POST /message/text`
Send a plain text message to a single number.

**Request**
```json
{
  "to": "0712345678",
  "message": "Hello, world!"
}
```

**Response**
```json
{ "success": true, "to": "255712345678", "message": "Hello, world!" }
```

---

### `POST /message/image`
Send an image (PNG or JPEG) with an optional caption.

**Request**
```json
{
  "to": "0712345678",
  "imageBase64": "data:image/png;base64,iVBORw0KGgo...",
  "caption": "Here is your image",
  "filename": "photo.png"
}
```
`caption` and `filename` are optional. Default filename is `image.png`.

**Response**
```json
{ "success": true, "to": "255712345678" }
```

---

### `POST /message/bulk-text`
Send a text message to multiple numbers. Runs in the background — poll `/progress/:sessionId` for status.

Supports a `{{name}}` placeholder that is replaced with each contact's name.

**Request**
```json
{
  "contacts": [
    { "name": "Amina Juma", "phone": "0712345678" },
    { "name": "Hassan Ali",  "phone": "0787654321" }
  ],
  "message": "Habari {{name}}, umealikwa kwenye tukio letu!",
  "sessionId": "unique-session-id-abc"
}
```

**Response** (immediate)
```json
{ "success": true, "sessionId": "unique-session-id-abc", "total": 2 }
```

---

### `POST /message/bulk-image` (alias: `POST /send-bulk`)
Send a wedding card image to multiple numbers. Runs in the background.

**Request**
```json
{
  "contacts": [
    { "name": "Amina Juma", "phone": "0712345678" }
  ],
  "cardImageBase64": "data:image/png;base64,iVBORw0KGgo...",
  "weddingInfo": {
    "family": "Familia ya Juma",
    "groomName": "Ali",
    "brideName": "Fatuma",
    "weddingDate": "Jumamosi, 15 Juni 2026",
    "venue": "Ukumbi wa Golden Tulip, Dar es Salaam"
  },
  "sessionId": "unique-session-id-xyz"
}
```
Each contact can also include its own `cardImageBase64` to override the root image.

**Response** (immediate)
```json
{ "success": true, "sessionId": "unique-session-id-xyz", "total": 1 }
```

---

### `GET /progress/:sessionId`
Poll for bulk-send progress.

```json
{
  "total": 100,
  "sent": 47,
  "failed": 2,
  "progress": 49,
  "currentContact": "Hassan Mwangi",
  "done": false,
  "errors": [
    { "name": "John Doe", "phone": "0700000000", "reason": "Not on WhatsApp" }
  ]
}
```

---

## Usage Examples

### Next.js

```js
const BASE = 'https://your-wa-service.example.com';
const HEADERS = {
  'Content-Type': 'application/json',
  'x-api-key': process.env.WA_API_KEY,
};

// Send a text message
await fetch(`${BASE}/message/text`, {
  method: 'POST',
  headers: HEADERS,
  body: JSON.stringify({ to: '0712345678', message: 'Hello from Next.js!' }),
});

// Send an image
await fetch(`${BASE}/message/image`, {
  method: 'POST',
  headers: HEADERS,
  body: JSON.stringify({
    to: '0712345678',
    imageBase64: 'data:image/png;base64,...',
    caption: 'Your receipt',
  }),
});
```

### PHP

```php
<?php
$base = 'https://your-wa-service.example.com';
$apiKey = 'your_secret_key_here';

$ch = curl_init("$base/message/text");
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST           => true,
    CURLOPT_HTTPHEADER     => [
        'Content-Type: application/json',
        "x-api-key: $apiKey",
    ],
    CURLOPT_POSTFIELDS => json_encode([
        'to'      => '0712345678',
        'message' => 'Hello from PHP!',
    ]),
]);
$response = json_decode(curl_exec($ch), true);
curl_close($ch);
```

### Python

```python
import requests

BASE = "https://your-wa-service.example.com"
HEADERS = {
    "Content-Type": "application/json",
    "x-api-key": "your_secret_key_here",
}

# Send a text message
resp = requests.post(f"{BASE}/message/text", json={
    "to": "0712345678",
    "message": "Hello from Python!",
}, headers=HEADERS)
print(resp.json())

# Send an image
import base64
with open("image.png", "rb") as f:
    img_b64 = "data:image/png;base64," + base64.b64encode(f.read()).decode()

resp = requests.post(f"{BASE}/message/image", json={
    "to": "0712345678",
    "imageBase64": img_b64,
    "caption": "Your document",
}, headers=HEADERS)
print(resp.json())
```

---

## Notes

- A **5 – 7 second random delay** is enforced between each message in bulk sends. Do not remove it — it protects your WhatsApp number from being banned.
- If WhatsApp disconnects mid-send, remaining contacts are marked failed and the server automatically reconnects after 5 seconds.
- A keepalive ping runs every 30 minutes to detect and recover from stale Puppeteer sessions.
- Session progress data is purged from memory 30 minutes after completion.
- Never commit `.wwebjs_auth/` or `.env` — both are in `.gitignore`.
# whatsapp-sending-service
