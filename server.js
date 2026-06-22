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
const DEBOUNCE_MS      = parseInt(process.env.DEBOUNCE_MS || '300', 10);
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
// folderNumber (string) → debounce timer handle
const debounceTimers = new Map();

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

// ── Initial scan ──────────────────────────────────────────────────────────────
/**
 * Fixed-depth scan matching the known structure:
 *   SCREENSHOTS_DIR / folderNumber / session-guid / YYYY-MM-DD / image.jpg
 *
 * Per folder-number this does exactly 3 readdirSync calls:
 *   1. list guid dirs  → stat each to pick the newest one
 *   2. list date dirs  → sort by name desc (ISO dates are lexicographic)
 *   3. list files in newest date dir → stat images to pick newest
 * No recursion, no scanning of old files.
 */
function initialScan(dir) {
  let level1;
  try { level1 = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

  for (const l1 of level1) {
    if (l1.name.startsWith('.') || !l1.isDirectory()) continue;
    const folderNumber = l1.name;
    const l1dir = path.join(dir, folderNumber);

    // Level 2: session-guid dirs — stat each, keep only the newest
    let level2;
    try { level2 = fs.readdirSync(l1dir, { withFileTypes: true }); } catch { continue; }
    let newestGuid = null;
    for (const l2 of level2) {
      if (l2.name.startsWith('.') || !l2.isDirectory()) continue;
      const full = path.join(l1dir, l2.name);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (!newestGuid || stat.mtimeMs > newestGuid.mtime) {
        newestGuid = { full, mtime: stat.mtimeMs };
      }
    }
    if (!newestGuid) continue;

    // Level 3: date dirs — sort by name desc (YYYY-MM-DD sorts lexicographically)
    let level3;
    try { level3 = fs.readdirSync(newestGuid.full, { withFileTypes: true }); } catch { continue; }
    const newestDate = level3
      .filter(e => !e.name.startsWith('.') && e.isDirectory())
      .map(e => e.name)
      .sort()
      .at(-1);
    if (!newestDate) continue;
    const dateDir = path.join(newestGuid.full, newestDate);

    // Level 4: pick newest image in that date dir
    let files;
    try { files = fs.readdirSync(dateDir, { withFileTypes: true }); } catch { continue; }
    let bestImage = null;
    for (const f of files) {
      if (f.isDirectory() || f.name.startsWith('.')) continue;
      const full = path.join(dateDir, f.name);
      if (!isImageFile(full)) continue;
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (!bestImage || stat.mtimeMs > bestImage.mtime) {
        bestImage = { full, mtime: stat.mtimeMs };
      }
    }

    if (bestImage) {
      latestImages.set(folderNumber, { url: toImageUrl(bestImage.full), mtime: bestImage.mtime });
    }
  }
}

if (fs.existsSync(SCREENSHOTS_DIR)) {
  initialScan(SCREENSHOTS_DIR);
}
console.log(`Startup   ${latestImages.size} folder(s) discovered`);

// ── File watcher ──────────────────────────────────────────────────────────────
const watcher = chokidar.watch(SCREENSHOTS_DIR, {
  ignored: /(^|[/\\])\../,      // skip hidden files/dirs
  persistent: true,
  ignoreInitial: true,           // initial state already populated by initialScan
  ignorePermissionErrors: true,  awaitWriteFinish: {
    stabilityThreshold: DEBOUNCE_MS,   // ms file must be stable before firing
    pollInterval: 100,
  },});

watcher.on('add', (filePath, stats) => {
  if (!isImageFile(filePath)) return;

  const folderNumber = getFolderNumber(filePath);
  const mtime = stats ? stats.mtimeMs : Date.now();
  const current = latestImages.get(folderNumber);

  // Only promote this file if it is at least as new as the current latest
  if (!current || mtime >= current.mtime) {
    latestImages.set(folderNumber, { url: toImageUrl(filePath), mtime });

    // Debounce broadcast per folder — coalesces bursts into one emit
    clearTimeout(debounceTimers.get(folderNumber));
    debounceTimers.set(folderNumber, setTimeout(() => {
      debounceTimers.delete(folderNumber);
      const latest = latestImages.get(folderNumber);
      if (latest) {
        console.log(`[+] folder=${folderNumber}  ${path.basename(latest.url)}`);
        broadcast({ folderNumber, imagePath: latest.url, mtime: latest.mtime });
      }
    }, DEBOUNCE_MS));
  }
});

watcher.on('ready', () => {
  console.log(`Watching  "${SCREENSHOTS_DIR}"`);
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
