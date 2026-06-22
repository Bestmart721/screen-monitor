'use strict';

require('dotenv').config();
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const chokidar = require('chokidar');

const app  = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// ── Configuration ─────────────────────────────────────────────────────────────
// Set SCREENSHOTS_DIR in .env, or change the fallback path below.
const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR
  ? path.resolve(process.env.SCREENSHOTS_DIR)
  : path.resolve(__dirname, 'Screenshots');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

// ── State ─────────────────────────────────────────────────────────────────────
// folderNumber (string) → { url: string, mtime: number }
const latestImages = new Map();

// Active SSE response objects
const sseClients = new Set();

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// Serve screenshot files; disable caching so browser always re-fetches
app.use('/screenshots', express.static(SCREENSHOTS_DIR, {
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store');
  },
}));

// ── SSE endpoint ──────────────────────────────────────────────────────────────
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Push current state immediately to the newly connected client
  for (const [folderNumber, { url }] of latestImages) {
    res.write(`data: ${JSON.stringify({ folderNumber, imagePath: url })}\n\n`);
  }

  sseClients.add(res);

  // Keep-alive ping every 25 s (prevents proxy timeouts)
  const ping = setInterval(() => res.write(':ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
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
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) client.write(msg);
}

// ── File watcher ──────────────────────────────────────────────────────────────
let watcherReady = false;

const watcher = chokidar.watch(SCREENSHOTS_DIR, {
  ignored: /(^|[/\\])\../,      // skip hidden files/dirs
  persistent: true,
  ignoreInitial: false,          // process existing files on startup
  ignorePermissionErrors: true,
  awaitWriteFinish: {            // wait for the writing app to finish
    stabilityThreshold: 500,
    pollInterval: 100,
  },
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
      broadcast({ folderNumber, imagePath: url });
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
app.listen(PORT, () => {
  console.log(`Server    http://localhost:${PORT}`);
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    console.warn(`\n[warn] SCREENSHOTS_DIR not found: ${SCREENSHOTS_DIR}`);
    console.warn('       Set SCREENSHOTS_DIR in .env and restart.\n');
  }
});
