'use strict';

require('dotenv').config();
const express  = require('express');
const http     = require('http');
const path     = require('path');
const fs       = require('fs');
const chokidar = require('chokidar');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = parseInt(process.env.PORT || '3000', 10);

// ── Configuration ─────────────────────────────────────────────────────────────
// Set SCREENSHOTS_DIR in .env, or change the fallback path below.
const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR
  ? path.resolve(process.env.SCREENSHOTS_DIR)
  : path.resolve(__dirname, 'Screenshots');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const FLASH_SECONDS    = parseInt(process.env.FLASH_SECONDS || '5', 10);
const ALLOWED_IPS      = process.env.ALLOWED_IPS
  ? process.env.ALLOWED_IPS.split(',').map(ip => ip.trim()).filter(Boolean)
  : [];

// Strip IPv4-mapped IPv6 prefix (e.g. "::ffff:192.168.1.1" → "192.168.1.1")
function normalizeIp(ip) {
  return ip ? ip.replace(/^::ffff:/, '') : '';
}

function isAllowedIp(ip) {
  if (ALLOWED_IPS.length === 0) return true;
  return ALLOWED_IPS.includes(normalizeIp(ip));
}

// ── State ─────────────────────────────────────────────────────────────────────
// folderNumber (string) → { url: string, mtime: number }
const latestImages = new Map();

// Socket.IO handles client tracking internally

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// Serve screenshot files; disable caching so browser always re-fetches
app.use('/screenshots', express.static(SCREENSHOTS_DIR, {
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store');
  },
}));

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const clientIp = socket.handshake.address;
  if (!isAllowedIp(clientIp)) {
    console.log(`[ws] rejected ip=${clientIp}`);
    socket.disconnect(true);
    return;
  }
  console.log(`[ws] client connected  id=${socket.id}  ip=${normalizeIp(clientIp)}`);

  // Send config to client (alertOnly: clients in ALLOWED_IPS get alert-only mode)
  socket.emit('config', { flashSeconds: FLASH_SECONDS, alertOnly: ALLOWED_IPS.length > 0 });

  // Push current state immediately to the newly connected client
  for (const [folderNumber, { url, mtime }] of latestImages) {
    socket.emit('init', { folderNumber, imagePath: url, mtime });
  }

  socket.on('disconnect', () => {
    console.log(`[ws] client disconnected id=${socket.id}`);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function isImageFile(filePath) {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Returns the first path segment under SCREENSHOTS_DIR.
 * e.g. "…/Screenshots/9/guid/2026-05-24/shot.jpg"  →  "9"
 */
function getFolderNumber(filePath) {
  return path.relative(SCREENSHOTS_DIR, filePath).split(path.sep)[0];
}

/**
 * Converts an absolute file path to a browser-safe URL rooted at /screenshots/.
 */
function toImageUrl(filePath) {
  const segments = path.relative(SCREENSHOTS_DIR, filePath).split(path.sep);
  return '/screenshots/' + segments.map(encodeURIComponent).join('/');
}

function broadcast(data) {
  io.emit('image', data);
}

// ── File watcher ──────────────────────────────────────────────────────────────
let watcherReady = false;

const watcher = chokidar.watch(SCREENSHOTS_DIR, {
  ignored: /(^|[/\\])\../,      // skip hidden files/dirs
  persistent: true,
  ignoreInitial: false,          // process existing files on startup
  ignorePermissionErrors: true,
});

watcher.on('add', (filePath, stats) => {
  if (!isImageFile(filePath)) return;

  const folderNumber = getFolderNumber(filePath);
  const mtime = stats ? stats.mtimeMs : Date.now();
  const current = latestImages.get(folderNumber);

  // Only promote this file if it is at least as new as the current latest
  if (!current || mtime >= current.mtime) {
    const url = toImageUrl(filePath);
    latestImages.set(folderNumber, { url, mtime });

    if (watcherReady) {
      console.log(`[+] folder=${folderNumber}  ${path.basename(filePath)}`);
      broadcast({ folderNumber, imagePath: url, mtime });
    }
  }
});

watcher.on('ready', () => {
  watcherReady = true;
  console.log(`Watching  "${SCREENSHOTS_DIR}"`);
  console.log(`Startup   ${latestImages.size} folder(s) discovered`);
});

watcher.on('error', err => console.error('Watcher error:', err.message));

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Server    http://localhost:${PORT}`);
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    console.warn(`\n[warn] SCREENSHOTS_DIR not found: ${SCREENSHOTS_DIR}`);
    console.warn('       Set SCREENSHOTS_DIR in .env and restart.\n');
  }
});
