// Loads config.json, keeps the live copy in memory, and persists admin edits made
// through /config back to the same file so there is exactly one source of truth.
import './env.js'; // must load .env before CONFIG_PATH is read below
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig } from './configSchema.js';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLED_CONFIG = path.join(ROOT_DIR, 'config.json');

// CONFIG_PATH lets a host keep the live config on a persistent volume next to the database.
export const CONFIG_PATH = path.resolve(process.env.CONFIG_PATH || BUNDLED_CONFIG);

let current = null;
let lastDiskText = null; // file contents as of our last read/write
const listeners = new Set();

// Objects whose keys are user data (channel IDs, emojis, ratings), not settings: never fill these.
const USER_RECORDS = new Set(['xp.emojiValues', 'autothread.channels', 'rating.curve.table']);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Add settings that exist in the repo's config.json but are missing from the live one
 * (new options from an update). Existing values are never changed. Returns true if anything was added.
 */
function fillMissingSettings(live, defaults, prefix = '') {
  let added = false;
  for (const [key, value] of Object.entries(defaults)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in live)) {
      live[key] = structuredClone(value);
      added = true;
    } else if (isPlainObject(value) && isPlainObject(live[key]) && !USER_RECORDS.has(path)) {
      added = fillMissingSettings(live[key], value, path) || added;
    }
  }
  return added;
}

function readFromDisk() {
  if (!fs.existsSync(CONFIG_PATH)) {
    // First boot with a custom CONFIG_PATH: seed it from the repo's config.json.
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.copyFileSync(BUNDLED_CONFIG, CONFIG_PATH);
  }
  let text = fs.readFileSync(CONFIG_PATH, 'utf8');
  const raw = JSON.parse(text);
  if (CONFIG_PATH !== BUNDLED_CONFIG) {
    const defaults = JSON.parse(fs.readFileSync(BUNDLED_CONFIG, 'utf8'));
    if (fillMissingSettings(raw, defaults)) {
      validateConfig(raw);
      text = `${JSON.stringify(raw, null, 2)}\n`;
      fs.writeFileSync(CONFIG_PATH, text, 'utf8');
      console.log(`[config] added new settings from ${path.basename(BUNDLED_CONFIG)} to ${CONFIG_PATH}`);
    }
  }
  const cfg = validateConfig(raw);
  lastDiskText = text;
  return cfg;
}

function writeToDisk(cfg) {
  // Write to a temp file and rename so a crash mid-write can't leave a half-written config.
  const tmp = `${CONFIG_PATH}.tmp`;
  const text = `${JSON.stringify(cfg, null, 2)}\n`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
  lastDiskText = text;
}

function swap(next) {
  const prev = current;
  current = next;
  for (const fn of listeners) {
    try {
      fn(prev, next);
    } catch (err) {
      console.error('[config] change listener failed:', err);
    }
  }
  return next;
}

/** The live config. Always call this at use time (not at import time) so edits apply immediately. */
export function getConfig() {
  if (!current) current = readFromDisk();
  return current;
}

/** Re-read config.json from disk (after a manual edit). Throws and keeps the old config if invalid. */
export function reloadConfig() {
  return swap(readFromDisk());
}

/**
 * Change config safely: the mutator edits a deep copy, the result is validated, written to
 * disk, and only then made live. Throws ConfigError (and changes nothing) if invalid.
 */
export function updateConfig(mutator) {
  getConfig();
  // If config.json was edited by hand (or updated) since we loaded it, build on the file's
  // version instead of our in-memory copy so those edits aren't overwritten.
  let base = current;
  try {
    if (fs.readFileSync(CONFIG_PATH, 'utf8') !== lastDiskText) base = readFromDisk();
  } catch {
    // unreadable/invalid file on disk: keep using the in-memory config
  }
  const draft = structuredClone(base);
  mutator(draft);
  const next = validateConfig(draft);
  writeToDisk(next);
  return swap(next);
}

/** Subscribe to config changes: fn(previousConfig, nextConfig). */
export function onConfigChange(fn) {
  listeners.add(fn);
}
