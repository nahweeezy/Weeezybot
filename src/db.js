// SQLite storage: user XP, the full XP event log, the per-pair 24h locks and reaction stats.
// better-sqlite3 is synchronous, so each transaction below is atomic within the process.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ROOT_DIR, getConfig } from './config.js';
import { normalizeEmoji } from './emoji.js';
import { ratingForXp } from './rating.js';

export function databasePath() {
  return process.env.DATABASE_PATH || path.join(ROOT_DIR, 'data', 'weeezybot.db');
}

// Each entry upgrades the schema by one version (tracked with PRAGMA user_version).
const MIGRATIONS = [
  `
  CREATE TABLE users (
    user_id     TEXT PRIMARY KEY,
    xp          INTEGER NOT NULL DEFAULT 0,
    rating      INTEGER NOT NULL,          -- cached rating, kept in sync with xp + the configured curve
    username    TEXT,                      -- last known name, for leaderboard display if they leave
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX idx_users_rank ON users (xp DESC, updated_at ASC, user_id ASC);

  -- Every XP change: reaction grants and admin corrections alike.
  CREATE TABLE xp_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,             -- reaction | admin_add | admin_remove | admin_set | admin_reset
    giver_id    TEXT,                      -- the reacting member, or the admin who made the change
    receiver_id TEXT NOT NULL,
    message_id  TEXT,
    channel_id  TEXT,
    emoji       TEXT,
    amount      INTEGER NOT NULL,          -- signed change actually applied
    xp_after    INTEGER NOT NULL,
    reason      TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX idx_events_receiver ON xp_events (receiver_id, created_at);
  CREATE INDEX idx_events_giver_message ON xp_events (giver_id, message_id);

  -- The "one grant per giver -> receiver per rolling window" lock.
  CREATE TABLE pair_locks (
    giver_id      TEXT NOT NULL,
    receiver_id   TEXT NOT NULL,
    last_grant_at INTEGER NOT NULL,
    PRIMARY KEY (giver_id, receiver_id)
  ) WITHOUT ROWID;

  -- Every distinct eligible reaction (granting or not), for the card's reaction stats.
  CREATE TABLE reactions_seen (
    message_id  TEXT NOT NULL,
    giver_id    TEXT NOT NULL,
    emoji       TEXT NOT NULL,
    receiver_id TEXT NOT NULL,
    channel_id  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (message_id, giver_id, emoji)
  ) WITHOUT ROWID;
  CREATE INDEX idx_seen_receiver_giver ON reactions_seen (receiver_id, giver_id);
  CREATE INDEX idx_seen_receiver_emoji ON reactions_seen (receiver_id, emoji);
  `,
  `
  -- Every reaction anywhere in the server (not just XP channels), for the weekly recap.
  -- Rows are removed when the reaction is removed.
  CREATE TABLE message_reactions (
    message_id         TEXT NOT NULL,
    user_id            TEXT NOT NULL,
    emoji              TEXT NOT NULL,      -- stable key (unicode char or custom emoji ID)
    emoji_display      TEXT NOT NULL,
    channel_id         TEXT NOT NULL,
    author_id          TEXT NOT NULL,
    message_created_at INTEGER NOT NULL,
    created_at         INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
  ) WITHOUT ROWID;
  CREATE INDEX idx_mr_message_time ON message_reactions (message_created_at);

  -- Small key/value store (e.g. when the last weekly recap was posted).
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  `,
];

let db = null;
let stmts = null;
let tx = null;

function migrate(conn) {
  const version = conn.pragma('user_version', { simple: true });
  for (let v = version; v < MIGRATIONS.length; v++) {
    conn.transaction(() => {
      conn.exec(MIGRATIONS[v]);
      conn.pragma(`user_version = ${v + 1}`);
    })();
  }
}

function init() {
  const file = databasePath();
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  migrate(db);

  stmts = {
    getUser: db.prepare('SELECT * FROM users WHERE user_id = ?'),
    upsertUser: db.prepare(`
      INSERT INTO users (user_id, xp, rating, username, created_at, updated_at)
      VALUES (@userId, @xp, @rating, @username, @now, @now)
      ON CONFLICT (user_id) DO UPDATE SET
        xp = excluded.xp,
        rating = excluded.rating,
        username = COALESCE(excluded.username, users.username),
        updated_at = excluded.updated_at`),
    insertEvent: db.prepare(`
      INSERT INTO xp_events (kind, giver_id, receiver_id, message_id, channel_id, emoji, amount, xp_after, reason, created_at)
      VALUES (@kind, @giverId, @receiverId, @messageId, @channelId, @emoji, @amount, @xpAfter, @reason, @now)`),
    getLock: db.prepare('SELECT last_grant_at FROM pair_locks WHERE giver_id = ? AND receiver_id = ?'),
    upsertLock: db.prepare(`
      INSERT INTO pair_locks (giver_id, receiver_id, last_grant_at) VALUES (?, ?, ?)
      ON CONFLICT (giver_id, receiver_id) DO UPDATE SET last_grant_at = excluded.last_grant_at`),
    hasGrantForMessage: db.prepare(
      "SELECT 1 FROM xp_events WHERE giver_id = ? AND message_id = ? AND kind = 'reaction' LIMIT 1",
    ),
    insertSeen: db.prepare(`
      INSERT OR IGNORE INTO reactions_seen (message_id, giver_id, emoji, receiver_id, channel_id, created_at)
      VALUES (@messageId, @giverId, @emoji, @receiverId, @channelId, @now)`),
    reactionStats: db.prepare(`
      SELECT COUNT(*) AS total, COUNT(DISTINCT giver_id) AS fans, COALESCE(SUM(emoji = @hot), 0) AS hot
      FROM reactions_seen WHERE receiver_id = @userId`),
    rankOf: db.prepare(`
      SELECT COUNT(*) + 1 AS rank FROM users
      WHERE xp > @xp OR (xp = @xp AND (updated_at < @updatedAt OR (updated_at = @updatedAt AND user_id < @userId)))`),
    leaderboard: db.prepare(`
      SELECT user_id, xp, rating, username FROM users WHERE xp > 0
      ORDER BY xp DESC, updated_at ASC, user_id ASC LIMIT ? OFFSET ?`),
    countRanked: db.prepare('SELECT COUNT(*) AS n FROM users WHERE xp > 0'),
    recentEvents: db.prepare('SELECT * FROM xp_events WHERE receiver_id = ? ORDER BY id DESC LIMIT ?'),
    allUsers: db.prepare('SELECT user_id, xp, rating FROM users'),
    setRating: db.prepare('UPDATE users SET rating = ? WHERE user_id = ?'),
    addMessageReaction: db.prepare(`
      INSERT OR IGNORE INTO message_reactions
        (message_id, user_id, emoji, emoji_display, channel_id, author_id, message_created_at, created_at)
      VALUES (@messageId, @userId, @emoji, @emojiDisplay, @channelId, @authorId, @messageCreatedAt, @now)`),
    removeMessageReaction: db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'),
    removeMessageEmoji: db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND emoji = ?'),
    removeMessageAll: db.prepare('DELETE FROM message_reactions WHERE message_id = ?'),
    topMessages: db.prepare(`
      SELECT message_id, channel_id, author_id, COUNT(*) AS total, COUNT(DISTINCT user_id) AS people
      FROM message_reactions WHERE message_created_at >= ?
      GROUP BY message_id ORDER BY total DESC, people DESC, MIN(created_at) ASC LIMIT ?`),
    messageReactors: db.prepare(
      'SELECT user_id FROM message_reactions WHERE message_id = ? GROUP BY user_id ORDER BY MIN(created_at)',
    ),
    messageEmojis: db.prepare(`
      SELECT emoji_display, COUNT(*) AS n FROM message_reactions WHERE message_id = ?
      GROUP BY emoji ORDER BY n DESC, MIN(created_at)`),
    pruneMessageReactions: db.prepare('DELETE FROM message_reactions WHERE message_created_at < ?'),
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    ),
  };

  tx = {
    changeXp: db.transaction((opts) => changeXp(opts)),
    grantReaction: db.transaction((candidates, opts) => grantReaction(candidates, opts)),
    recalc: db.transaction(() => recalcRatings()),
  };
}

function ensure() {
  if (!db) init();
}

/** Open the database (creating/migrating it if needed). Safe to call more than once. */
export function openDb() {
  ensure();
  return db;
}

export function closeDb() {
  if (db) db.close();
  db = null;
  stmts = null;
  tx = null;
}

/** Copy the live database to `destination` (safe while the bot is running). */
export function backupDb(destination) {
  ensure();
  return db.backup(destination);
}

// ---------------------------------------------------------------------------
// XP changes
// ---------------------------------------------------------------------------

/**
 * Apply an XP change and log it. Must run inside a transaction.
 * Pass `delta` for relative changes or `set` for an absolute value. XP never drops below 0.
 */
function changeXp({ receiverId, delta, set, kind, giverId = null, messageId = null, channelId = null, emoji = null, reason = null, username = null, now = Date.now() }) {
  const cfg = getConfig();
  const row = stmts.getUser.get(receiverId);
  const oldXp = row?.xp ?? 0;
  const oldRating = row?.rating ?? ratingForXp(0, cfg);
  const newXp = Math.max(0, set !== undefined ? set : oldXp + delta);
  const newRating = ratingForXp(newXp, cfg);

  stmts.upsertUser.run({ userId: receiverId, xp: newXp, rating: newRating, username, now });
  stmts.insertEvent.run({
    kind,
    giverId,
    receiverId,
    messageId,
    channelId,
    emoji,
    amount: newXp - oldXp,
    xpAfter: newXp,
    reason,
    now,
  });
  return { userId: receiverId, oldXp, newXp, oldRating, newRating };
}

/** Admin/manual XP change (add, remove, set, reset). Returns { oldXp, newXp, oldRating, newRating }. */
export function adjustXp(opts) {
  ensure();
  return tx.changeXp(opts);
}

/**
 * From reactions that arrived together for the same giver -> receiver pair, choose the one
 * that grants: highest XP value wins, ties go to whichever reaction came first.
 */
export function pickBestCandidate(candidates) {
  return [...candidates].sort((a, b) => b.amount - a.amount || a.receivedAt - b.receivedAt)[0];
}

function grantReaction(candidates, { cooldownMs, oncePerMessage, now, kind }) {
  const { giverId, receiverId } = candidates[0];

  // Core rule: one grant per giver -> receiver per rolling cooldown window, across all messages.
  const lock = stmts.getLock.get(giverId, receiverId);
  if (lock && now - lock.last_grant_at < cooldownMs) return null;

  let eligible = candidates.filter((c) => c.amount > 0);
  // Optional: a giver can never grant XP twice for the same message, even after the window expires.
  if (oncePerMessage) eligible = eligible.filter((c) => !stmts.hasGrantForMessage.get(giverId, c.messageId));
  if (!eligible.length) return null;

  const best = pickBestCandidate(eligible);
  stmts.upsertLock.run(giverId, receiverId, now);
  const result = changeXp({
    receiverId,
    delta: best.amount,
    kind,
    giverId,
    messageId: best.messageId,
    channelId: best.channelId,
    emoji: best.emojiDisplay,
    username: best.receiverName ?? null,
    now,
  });
  return { ...result, grant: best };
}

/**
 * Try to turn a batch of reactions (same giver, same receiver) into a single XP grant.
 * Each candidate: { giverId, receiverId, messageId, channelId, emojiDisplay, amount, receivedAt, receiverName? }.
 * Returns null when nothing is granted (pair still locked, 0-XP emoji, already granted for that message).
 */
export function tryReactionGrant(candidates, { cooldownMs, oncePerMessage, now = Date.now(), kind = 'reaction' }) {
  ensure();
  if (!candidates.length) return null;
  return tx.grantReaction(candidates, { cooldownMs, oncePerMessage, now, kind });
}

export function isPairLocked(giverId, receiverId, cooldownMs, now = Date.now()) {
  ensure();
  const lock = stmts.getLock.get(giverId, receiverId);
  return Boolean(lock && now - lock.last_grant_at < cooldownMs);
}

/** Remember an eligible reaction for stats. Re-adding the same emoji on the same message is ignored. */
export function recordReactionSeen({ messageId, giverId, emojiKey, receiverId, channelId, now = Date.now() }) {
  ensure();
  stmts.insertSeen.run({ messageId, giverId, emoji: emojiKey, receiverId, channelId, now });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getUser(userId) {
  ensure();
  return stmts.getUser.get(userId) ?? null;
}

/** Stats for /card. Users with no row yet get the starting values. */
export function getProfile(userId) {
  ensure();
  const cfg = getConfig();
  const row = stmts.getUser.get(userId);
  const xp = row?.xp ?? 0;
  const stats = stmts.reactionStats.get({ userId, hot: normalizeEmoji(cfg.card.hotEmoji) });
  const rank = row && row.xp > 0 ? stmts.rankOf.get({ xp: row.xp, updatedAt: row.updated_at, userId }).rank : null;
  return {
    xp,
    rating: row?.rating ?? ratingForXp(0, cfg),
    reactionsReceived: stats.total,
    uniqueReactors: stats.fans,
    hotReactions: stats.hot,
    rank,
  };
}

export function getLeaderboard(offset, limit) {
  ensure();
  return stmts.leaderboard.all(limit, offset);
}

export function countRanked() {
  ensure();
  return stmts.countRanked.get().n;
}

export function getRecentEvents(userId, limit) {
  ensure();
  return stmts.recentEvents.all(userId, limit);
}

/** userId -> cached rating for everyone with a row. */
export function getAllRatings() {
  ensure();
  return new Map(stmts.allUsers.all().map((r) => [r.user_id, r.rating]));
}

function recalcRatings() {
  const cfg = getConfig();
  const changed = [];
  for (const row of stmts.allUsers.all()) {
    const rating = ratingForXp(row.xp, cfg);
    if (rating !== row.rating) {
      stmts.setRating.run(rating, row.user_id);
      changed.push({ userId: row.user_id, oldRating: row.rating, newRating: rating });
    }
  }
  return changed;
}

/** Re-derive every cached rating from XP (after the curve changes). Returns who changed. */
export function recalculateRatings() {
  ensure();
  return tx.recalc();
}

// ---------------------------------------------------------------------------
// Server-wide reaction tracking (weekly recap)
// ---------------------------------------------------------------------------

export function recordMessageReaction({ messageId, userId, emoji, emojiDisplay, channelId, authorId, messageCreatedAt, now = Date.now() }) {
  ensure();
  stmts.addMessageReaction.run({ messageId, userId, emoji, emojiDisplay, channelId, authorId, messageCreatedAt, now });
}

/** Forget a removed reaction. Pass userId + emoji for one reaction, emoji alone for "remove emoji", neither for "remove all". */
export function removeMessageReactions(messageId, { userId, emoji } = {}) {
  ensure();
  if (userId && emoji) stmts.removeMessageReaction.run(messageId, userId, emoji);
  else if (emoji) stmts.removeMessageEmoji.run(messageId, emoji);
  else stmts.removeMessageAll.run(messageId);
}

/** Most-reacted messages posted since `since` (ms), with who reacted and an emoji breakdown. */
export function getTopMessages(since, limit) {
  ensure();
  return stmts.topMessages.all(since, limit).map((row) => ({
    ...row,
    reactors: stmts.messageReactors.all(row.message_id).map((r) => r.user_id),
    emojis: stmts.messageEmojis.all(row.message_id),
  }));
}

export function pruneMessageReactions(before) {
  ensure();
  return stmts.pruneMessageReactions.run(before).changes;
}

export function getMeta(key) {
  ensure();
  return stmts.getMeta.get(key)?.value ?? null;
}

export function setMeta(key, value) {
  ensure();
  stmts.setMeta.run(key, String(value));
}
