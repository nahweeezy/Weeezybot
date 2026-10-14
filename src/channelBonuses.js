// Per-channel XP rules:
//  • postBonus: flat XP for posting in a channel (e.g. +10 for a tactic, +5 for a pack pull),
//    each with its own cooldown per member. In forums only a new post counts, not replies.
//    `requires: "media"` = the message needs a picture/video, "any" = any message.
//  • channelMultipliers: XP multiplier for reactions received and message XP in a channel,
//    its threads and forum posts (e.g. 2 = double XP). Category IDs work too.
import { hasMedia } from './autothread.js';
import { getConfig } from './config.js';
import { isPairLocked, tryReactionGrant } from './db.js';
import { guildId } from './env.js';
import { applyRatingChange } from './progression.js';

const HOUR = 60 * 60 * 1000;

/** XP multiplier for a channel: its own setting, else its parent's (threads, forum posts), else its category's. */
export function channelMultiplier(channel, cfg = getConfig()) {
  const m = cfg.channelMultipliers;
  if (!channel) return 1;
  for (const id of [channel.id, channel.parentId, channel.parent?.parentId]) {
    if (id && m[id] !== undefined) return m[id];
  }
  return 1;
}

/** XP after applying a channel's multiplier (whole numbers only). */
export function multiplied(amount, channel, cfg = getConfig()) {
  return Math.round(amount * channelMultiplier(channel, cfg));
}

/**
 * Which post bonus (if any) a message qualifies for, ignoring cooldowns.
 * Returns { key, xp, cooldownMs } where key identifies the bonus for its cooldown lock.
 */
export function postBonusFor(message, channel, cfg = getConfig()) {
  let channelId = message.channelId;
  let rule = cfg.postBonus[channelId];
  if (!rule && channel?.isThread?.()) {
    // Forum post (or thread) under a bonus channel: only the opening message counts as "a post".
    if (message.id !== channel.id) return null;
    channelId = channel.parentId;
    rule = cfg.postBonus[channelId];
  }
  if (!rule || rule.xp <= 0) return null;
  if (rule.requires === 'media' && !hasMedia(message, cfg)) return null;
  return { key: `post:${channelId}`, channelId, xp: rule.xp, cooldownMs: rule.cooldownHours * HOUR };
}

/** Grant a post bonus inside the cooldown rules. `now` lets the rebuild replay old posts. */
export function grantPostBonus(message, bonus, now = Date.now()) {
  return tryReactionGrant(
    [{
      giverId: bonus.key,
      receiverId: message.author.id,
      receiverName: message.author.username,
      messageId: message.id,
      channelId: message.channelId,
      emojiDisplay: null,
      amount: bonus.xp,
      receivedAt: now,
    }],
    { cooldownMs: bonus.cooldownMs, oncePerMessage: true, kind: 'post_bonus', now },
  );
}

export async function handlePostBonus(message) {
  if (!message.inGuild() || message.guildId !== guildId()) return null;
  if (message.author.bot || message.webhookId || message.system) return null;
  const bonus = postBonusFor(message, message.channel);
  if (!bonus || isPairLocked(bonus.key, message.author.id, bonus.cooldownMs)) return null;
  const result = grantPostBonus(message, bonus);
  if (result) await applyRatingChange(message.guild, result, { sourceChannelId: message.channelId });
  return result;
}
