// Rank-up announcements. Never DMs anyone.
// rankup.postIn: "source" = post in the channel/thread where the XP was earned (falls back to
// rankup.channelId), "channel" = always post in rankup.channelId.
// rankup.deleteAfterSeconds > 0 deletes each announcement after that long.
// Increases for the same member that land within rankup.coalesceSeconds are merged into one
// post ("74 → 77 OVR"), so a burst of reactions doesn't spam the channel.
import { EmbedBuilder } from 'discord.js';
import { CARD_FILE_NAME, renderCardAttachment } from './card/index.js';
import { getConfig } from './config.js';
import { getUser } from './db.js';
import { log } from './logger.js';
import { tierIndexForRating } from './rating.js';
import { fillTemplate, formatNumber } from './util.js';

const pending = new Map(); // userId -> { guild, fromRating, toRating, sourceChannelId, timer }

/**
 * Record a rating change. Increases start (or extend) a pending announcement; any change,
 * including a drop, updates the target of a pending one so it never announces a stale rating.
 */
export function recordRatingChange(guild, userId, oldRating, newRating, { announce = true, sourceChannelId = null } = {}) {
  const entry = pending.get(userId);
  if (entry) {
    entry.toRating = newRating;
    if (sourceChannelId) entry.sourceChannelId = sourceChannelId; // announce where the latest XP came from
    return;
  }
  const cfg = getConfig().rankup;
  const hasTarget = cfg.channelId || (cfg.postIn === 'source' && sourceChannelId);
  if (!announce || newRating <= oldRating || !hasTarget) return;

  const item = { guild, fromRating: oldRating, toRating: newRating, sourceChannelId, timer: null };
  pending.set(userId, item);
  item.timer = setTimeout(() => flushUser(userId), cfg.coalesceSeconds * 1000);
}

async function flushUser(userId) {
  const entry = pending.get(userId);
  if (!entry) return;
  pending.delete(userId);
  clearTimeout(entry.timer);
  if (entry.toRating <= entry.fromRating) return; // dropped back down before we posted
  try {
    await announce(entry.guild, userId, entry.fromRating, entry.toRating, entry.sourceChannelId);
  } catch (err) {
    log.warn(`Rank-up announcement for ${userId} failed: ${err.message}`);
  }
}

/** Post everything still waiting (used on shutdown). */
export async function flushAllRankUps() {
  await Promise.allSettled([...pending.keys()].map(flushUser));
}

async function resolveChannel(guild, rc, sourceChannelId) {
  const fetch = (id) => (id ? guild.client.channels.fetch(id).catch(() => null) : null);
  if (rc.postIn === 'source') {
    const source = await fetch(sourceChannelId);
    if (source?.isTextBased() && !source.archived) return source;
  }
  return fetch(rc.channelId);
}

/** Send, then (optionally) delete the message after rankup.deleteAfterSeconds. */
async function post(channel, payload, rc) {
  const message = await channel.send(payload);
  if (rc.deleteAfterSeconds > 0) {
    setTimeout(() => message.delete().catch(() => {}), rc.deleteAfterSeconds * 1000);
  }
}

async function announce(guild, userId, from, to, sourceChannelId) {
  const cfg = getConfig();
  const rc = cfg.rankup;
  const channel = await resolveChannel(guild, rc, sourceChannelId);
  if (!channel?.isTextBased()) {
    log.warn('No channel to post the rank-up in (check rankup.postIn / rankup.channelId).');
    return;
  }

  const member = await guild.members.fetch(userId).catch(() => null);
  const user = member?.user ?? (await guild.client.users.fetch(userId).catch(() => null));
  const fromTier = tierIndexForRating(from, cfg);
  const toTier = tierIndexForRating(to, cfg);
  const tier = cfg.tiers[toTier];
  const vars = {
    mention: `<@${userId}>`,
    username: user?.username ?? 'unknown',
    displayName: member?.displayName ?? user?.displayName ?? 'unknown',
    oldRating: from,
    newRating: to,
    tierName: tier.name,
    tierEmoji: tier.emoji,
    oldTierName: cfg.tiers[fromTier].name,
    xp: formatNumber(getUser(userId)?.xp ?? 0),
  };

  // A promotion = entering any tier flagged announcePromotion. If several tiers were skipped
  // in one jump, the embed is styled after the highest tier reached.
  const promoted = cfg.tiers.slice(fromTier + 1, toTier + 1).some((t) => t.announcePromotion);

  if (promoted) {
    const embed = new EmbedBuilder()
      .setColor(tier.color)
      .setTitle(fillTemplate(rc.promotion.title, vars))
      .setDescription(fillTemplate(rc.promotion.description, vars))
      .setTimestamp();
    const files = [];
    if (rc.promotion.attachCard && user) {
      const card = await renderCardAttachment({ user, member, guild });
      if (card) {
        files.push(card);
        embed.setImage(`attachment://${CARD_FILE_NAME}`);
      }
    }
    if (!files.length && user) embed.setThumbnail((member ?? user).displayAvatarURL({ size: 256 }));

    const content = fillTemplate(rc.promotion.content, vars).trim();
    await post(channel, {
      content: content || undefined,
      embeds: [embed],
      files,
      allowedMentions: { users: rc.pingOnPromotion ? [userId] : [] },
    }, rc);
  } else {
    const template = to - from > 1 ? rc.multiBumpMessage : rc.bumpMessage;
    await post(channel, {
      content: fillTemplate(template, vars),
      // With pinging off the mention still renders, it just doesn't notify.
      allowedMentions: { users: rc.pingOnBump ? [userId] : [] },
    }, rc);
  }
}
