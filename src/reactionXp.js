// Feature 1: reaction-based XP.
//
// Flow for every reaction added:
//   1. Ignore bots, bot/webhook/system messages, self-reactions, other servers, non-XP channels.
//   2. Record the reaction for card stats (deduplicated per message + giver + emoji).
//   3. If this giver already granted XP to this author inside the cooldown window, stop.
//   4. Otherwise hold it briefly (xp.simultaneousReactionWindowMs) in case the giver adds more
//      emojis at the same moment, then grant once using the highest-value emoji.
// Removing a reaction is deliberately not handled: XP already granted stays granted.
import { getConfig } from './config.js';
import * as db from './db.js';
import { emojiDisplay, emojiKey, emojiXpValue } from './emoji.js';
import { guildId } from './env.js';
import { log } from './logger.js';
import { applyRatingChange } from './progression.js';

const batches = new Map(); // "giverId:receiverId" -> { guild, candidates: [], timer }

const cooldownMs = (cfg) => cfg.xp.pairCooldownHours * 60 * 60 * 1000;

/** Channel/category IDs where reactions earn XP: the explicit list plus (optionally) auto-thread channels. */
export function xpChannelIds(cfg = getConfig()) {
  const ids = new Set(cfg.xp.channels);
  if (cfg.xp.includeAutothreadChannels) for (const id of Object.keys(cfg.autothread.channels)) ids.add(id);
  return ids;
}

/**
 * A channel earns XP if it is listed, if it's a thread/forum post whose parent is listed,
 * or if its category is listed.
 */
export function isXpChannel(channel, ids = xpChannelIds()) {
  if (!channel) return false;
  if (ids.has(channel.id)) return true;
  if (channel.isThread?.()) {
    if (ids.has(channel.parentId)) return true;
    const category = channel.parent?.parentId;
    return Boolean(category && ids.has(category));
  }
  return Boolean(channel.parentId && ids.has(channel.parentId));
}

export async function handleReactionAdd(reaction, user) {
  const receivedAt = Date.now();
  let message;
  try {
    // Partials: reactions on messages from before the last restart arrive half-empty.
    if (user.partial) user = await user.fetch();
    if (user.bot) return;
    if (reaction.partial) reaction = await reaction.fetch();
    message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
  } catch {
    return; // the message or reaction was deleted before we could read it
  }

  if (!message.inGuild() || message.guildId !== guildId()) return;
  const author = message.author;
  if (!author || author.bot || message.webhookId || message.system) return;
  if (author.id === user.id) return;

  const cfg = getConfig();
  let channel = message.channel;
  if (!channel || channel.partial) channel = await message.client.channels.fetch(message.channelId).catch(() => null);
  if (!isXpChannel(channel, xpChannelIds(cfg))) return;

  // Only current members earn XP (keeps people who left off the leaderboard).
  const receiver = await message.guild.members.fetch(author.id).catch(() => null);
  if (!receiver) return;

  db.recordReactionSeen({
    messageId: message.id,
    giverId: user.id,
    emojiKey: emojiKey(reaction.emoji),
    receiverId: author.id,
    channelId: channel.id,
    now: receivedAt,
  });

  // Cheap early exit; the grant transaction re-checks this atomically.
  if (db.isPairLocked(user.id, author.id, cooldownMs(cfg), receivedAt)) return;

  enqueue(message.guild, {
    giverId: user.id,
    receiverId: author.id,
    receiverName: author.username,
    messageId: message.id,
    channelId: channel.id,
    emojiDisplay: emojiDisplay(reaction.emoji),
    amount: emojiXpValue(reaction.emoji, cfg),
    receivedAt,
  });
}

function enqueue(guild, candidate) {
  const key = `${candidate.giverId}:${candidate.receiverId}`;
  let batch = batches.get(key);
  if (!batch) {
    batch = { guild, candidates: [], timer: null };
    batches.set(key, batch);
    batch.timer = setTimeout(() => flushBatch(key), getConfig().xp.simultaneousReactionWindowMs);
  }
  batch.candidates.push(candidate);
}

function flushBatch(key) {
  const batch = batches.get(key);
  if (!batch) return Promise.resolve();
  batches.delete(key);
  clearTimeout(batch.timer);

  const cfg = getConfig();
  let result;
  try {
    result = db.tryReactionGrant(batch.candidates, {
      cooldownMs: cooldownMs(cfg),
      oncePerMessage: cfg.xp.oncePerMessage,
    });
  } catch (err) {
    log.error('XP grant failed:', err);
    return Promise.resolve();
  }
  if (!result) return Promise.resolve();

  const g = result.grant;
  log.debug(`XP +${g.amount} ${g.emojiDisplay} ${g.giverId} -> ${g.receiverId} (msg ${g.messageId}) = ${result.newXp} XP`);
  return applyRatingChange(batch.guild, result, { sourceChannelId: g.channelId }).catch((err) => log.warn(`Post-grant update failed: ${err.message}`));
}

/** Grant everything still inside its batching window (used on shutdown so nothing is lost). */
export async function flushAllReactionBatches() {
  await Promise.allSettled([...batches.keys()].map(flushBatch));
}
