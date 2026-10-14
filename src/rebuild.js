// Rebuild XP from the reactions that are still visible on Discord (used by scripts/rebuild-xp.js).
//
// 1. Scan: read every message from the last `days` days in the XP channels (plus their threads
//    and forum posts), and every reaction on them. Messages in other channels are read for the
//    last recap.lookbackDays days so the weekly recap has data too.
// 2. Replay: feed those reactions through the normal XP rules in time order: one grant per
//    giver -> receiver per cooldown window, highest emoji wins, double-XP channels, the 🔥 thread
//    bonus and per-channel post bonuses (e.g. +10 per tactic), each with its cooldown.
// Random message XP can't be recreated, so it isn't part of the rebuild.
//
// Discord doesn't say WHEN a reaction was added, so each reaction is treated as if it happened
// when its message was posted. Reactions that were removed can't be seen and aren't counted.
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { grantPostBonus, multiplied, postBonusFor } from './channelBonuses.js';
import { getConfig } from './config.js';
import * as db from './db.js';
import { emojiDisplay, emojiKey, emojiXpValue, normalizeEmoji } from './emoji.js';
import { isXpChannel, xpChannelIds } from './reactionXp.js';

const DAY = 24 * 60 * 60 * 1000;
const SCANNABLE = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia]);

function canRead(channel) {
  const perms = channel.permissionsFor?.(channel.guild.members.me);
  return Boolean(perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]));
}

/** Every message in `channel` posted at or after `since`, newest first. */
async function* messagesSince(channel, since) {
  let before;
  for (;;) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) return;
    for (const message of batch.values()) {
      if (message.createdTimestamp < since) return;
      yield message;
    }
    before = batch.last().id;
    if (batch.size < 100) return;
  }
}

/** Active + public archived threads (and forum posts) of a channel that were alive after `since`. */
async function threadsOf(channel, since, activeThreads) {
  const threads = [...activeThreads.filter((t) => t.parentId === channel.id).values()];
  if (!channel.threads?.fetchArchived) return threads;
  let before;
  for (;;) {
    const { threads: page, hasMore } = await channel.threads
      .fetchArchived({ type: 'public', limit: 100, ...(before ? { before } : {}) })
      .catch(() => ({ threads: new Map(), hasMore: false }));
    let tooOld = false;
    for (const thread of page.values()) {
      if ((thread.archiveTimestamp ?? Date.now()) < since) tooOld = true;
      else threads.push(thread);
    }
    if (!hasMore || tooOld || !page.size) return threads;
    before = [...page.values()].at(-1);
  }
}

/** All users who added this reaction (Discord returns them 100 at a time). */
async function reactionUsers(reaction) {
  const users = [];
  let after;
  for (;;) {
    const page = await reaction.users.fetch({ limit: 100, ...(after ? { after } : {}) });
    users.push(...page.values());
    if (page.size < 100) return users;
    after = page.lastKey();
  }
}

/**
 * Scan the server and rebuild XP into the (fresh) database.
 * @returns summary numbers for logging
 */
export async function rebuildFromGuild(guild, { days, log = console.log }) {
  const cfg = getConfig();
  const now = Date.now();
  const xpSince = now - days * DAY;
  const recapSince = now - cfg.recap.lookbackDays * DAY;
  const xpIds = xpChannelIds(cfg);
  const botId = guild.client.user.id;
  const bonus = cfg.autothread.threadBonus;
  const bonusKey = normalizeEmoji(bonus.emoji);

  log('Loading members...');
  const members = await guild.members.fetch();
  const { threads: activeThreads } = await guild.channels.fetchActiveThreads();

  const reactionBatches = new Map(); // "giver:message" -> { time, candidates[] }
  const bonusEvents = [];
  const postEvents = [];
  const stats = { channels: 0, messages: 0, reactions: 0 };

  async function scanMessage(message, channel, { xp, recap }) {
    stats.messages++;
    const author = message.author;
    if (!author || author.bot || message.webhookId || message.system) return;
    const authorIsMember = members.has(author.id);

    // Post bonus for the message itself (e.g. a new tactic in the tactics forum).
    if (authorIsMember && message.createdTimestamp >= xpSince) {
      const bonus = postBonusFor(message, channel, cfg);
      if (bonus) postEvents.push({ time: message.createdTimestamp, message, bonus });
    }
    if (!message.reactions.cache.size) return;
    let order = 0;

    for (const reaction of message.reactions.cache.values()) {
      const key = emojiKey(reaction.emoji);
      const users = await reactionUsers(reaction);
      for (const user of users) {
        order++;
        if (user.bot) {
          // The bot's own 🔥 on a post that got an auto-thread = the thread bonus.
          if (xp && user.id === botId && bonus.enabled && bonus.xp > 0 && key === bonusKey && cfg.autothread.channels[message.channelId] && authorIsMember) {
            bonusEvents.push({
              time: message.createdTimestamp,
              candidate: {
                giverId: botId,
                receiverId: author.id,
                receiverName: author.username,
                messageId: message.id,
                channelId: message.channelId,
                emojiDisplay: bonus.emoji,
                amount: bonus.xp,
                receivedAt: message.createdTimestamp,
              },
            });
          }
          continue;
        }
        if (user.id === author.id) continue;
        stats.reactions++;

        if (recap && message.createdTimestamp >= recapSince) {
          db.recordMessageReaction({
            messageId: message.id,
            userId: user.id,
            emoji: key,
            emojiDisplay: emojiDisplay(reaction.emoji),
            channelId: message.channelId,
            authorId: author.id,
            messageCreatedAt: message.createdTimestamp,
            now: message.createdTimestamp,
          });
        }
        if (!xp || !authorIsMember) continue;

        db.recordReactionSeen({ messageId: message.id, giverId: user.id, emojiKey: key, receiverId: author.id, channelId: channel.id, now: message.createdTimestamp });
        const batchKey = `${user.id}:${message.id}`;
        if (!reactionBatches.has(batchKey)) reactionBatches.set(batchKey, { time: message.createdTimestamp, candidates: [] });
        reactionBatches.get(batchKey).candidates.push({
          giverId: user.id,
          receiverId: author.id,
          receiverName: author.username,
          messageId: message.id,
          channelId: channel.id,
          emojiDisplay: emojiDisplay(reaction.emoji),
          amount: multiplied(emojiXpValue(reaction.emoji, cfg), channel, cfg),
          receivedAt: message.createdTimestamp + order, // keeps "first emoji wins" ties stable
        });
      }
    }
  }

  // ---- 1. Scan ----
  for (const parent of guild.channels.cache.values()) {
    if (!SCANNABLE.has(parent.type) || !canRead(parent)) continue;
    const parentIsXp = isXpChannel(parent, xpIds);
    const since = parentIsXp ? Math.min(xpSince, recapSince) : recapSince;

    const containers = parent.isTextBased() ? [parent] : []; // forums only hold threads
    containers.push(...(await threadsOf(parent, since, activeThreads)));

    for (const channel of containers) {
      const xp = isXpChannel(channel, xpIds);
      const channelSince = xp ? Math.min(xpSince, recapSince) : recapSince;
      let count = 0;
      try {
        for await (const message of messagesSince(channel, channelSince)) {
          await scanMessage(message, channel, { xp: xp && message.createdTimestamp >= xpSince, recap: true });
          count++;
        }
      } catch (err) {
        log(`  ! skipped #${channel.name}: ${err.message}`);
        continue;
      }
      stats.channels++;
      if (count) log(`  #${channel.name}: ${count} messages${xp ? ' (XP)' : ''}`);
    }
  }

  // ---- 2. Replay in time order ----
  log('Replaying reactions through the XP rules...');
  const events = [
    ...[...reactionBatches.values()].map((b) => ({ ...b, kind: 'reaction' })),
    ...bonusEvents.map((b) => ({ time: b.time, candidates: [b.candidate], kind: 'thread_bonus' })),
    ...postEvents.map((p) => ({ time: p.time, post: p, kind: 'post_bonus' })),
  ].sort((a, b) => a.time - b.time || (a.kind === b.kind ? 0 : a.kind === 'thread_bonus' ? -1 : 1));

  const reactionRules = { cooldownMs: cfg.xp.pairCooldownHours * 60 * 60 * 1000, oncePerMessage: cfg.xp.oncePerMessage };
  const bonusRules = { cooldownMs: bonus.cooldownHours * 60 * 60 * 1000, oncePerMessage: true, kind: 'thread_bonus' };
  let grants = 0;
  let bonuses = 0;
  let posts = 0;
  for (const event of events) {
    if (event.kind === 'post_bonus') {
      if (grantPostBonus(event.post.message, event.post.bonus, event.time)) posts++;
      continue;
    }
    const rules = event.kind === 'thread_bonus' ? bonusRules : reactionRules;
    if (db.tryReactionGrant(event.candidates, { ...rules, now: event.time })) {
      if (event.kind === 'thread_bonus') bonuses++;
      else grants++;
    }
  }

  return { ...stats, grants, bonuses, posts, members: members.size };
}
